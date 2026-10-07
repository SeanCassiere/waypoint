import { WaypointError, type ShareLink } from "@waypoint/core";

import type { HttpServices } from "./http.js";
import type { RevisionRow } from "./read-model.js";

export type ShareRow = Pick<
  ShareLink,
  "id" | "collection_id" | "revision_id" | "label" | "expires_at" | "revoked_at" | "created_at"
>;
export const SHARE_COLUMNS = "id,collection_id,revision_id,label,expires_at,revoked_at,created_at";
/** The reader caches link lookups for up to 30 s and the writer pushes about once a minute. */
export const SETTLE_MS = 60_000;
export interface ShareCollection {
  id: string;
  public_id: string;
  title: string;
  deleted: boolean;
}
export type ShareView = ShareLink & { collection: ShareCollection };

/** Derived lifecycle state (B3). */
export function shareState(
  row: ShareRow,
  lastPushAt: number | null,
  now: number,
): ShareLink["state"] {
  if (row.revoked_at !== null)
    return lastPushAt === null || lastPushAt < row.revoked_at || now - row.revoked_at < SETTLE_MS
      ? "revoking"
      : "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return lastPushAt === null || row.created_at > lastPushAt ? "activating" : "active";
}

/** Views for any number of links in five queries (B3). */
export async function shareViews(s: HttpServices, rows: readonly ShareRow[]): Promise<ShareView[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.collection_id))];
  const [index, collections] = await Promise.all([
    s.reads.revisionIndex(ids),
    s.reads.collectionsById(ids),
  ]);
  const now = Date.now();
  const lastPushAt = s.syncLoop?.lastPushAt ?? null;
  return rows.map((row) => {
    const revisions: RevisionRow[] = index.get(row.collection_id) ?? [];
    const collection = collections.get(row.collection_id);
    const deleted = collection?.deleted ?? true;
    const pinned = row.revision_id
      ? revisions.find((item) => item.id === row.revision_id)
      : undefined;
    const latest = revisions.findLast((item) => item.sync_state !== "failed");
    const newestSynced = revisions.findLast((item) => item.sync_state === "synced");
    const status: ShareLink["status"] =
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at !== null && row.expires_at <= now
          ? "expired"
          : "active";
    const target = row.revision_id ? pinned : latest;
    const sees = row.revision_id
      ? pinned?.sync_state === "synced"
        ? pinned
        : undefined
      : newestSynced;
    return {
      ...row,
      mode: row.revision_id ? "pinned" : "latest",
      status,
      publicly_available: status === "active" && !deleted && target?.sync_state === "synced",
      state: shareState(row, lastPushAt, now),
      revision_display_number: pinned?.display_number ?? null,
      public_sees:
        status === "active" && !deleted && sees
          ? { revision_id: sees.id, display_number: sees.display_number ?? 0 }
          : null,
      collection: collection ?? { id: row.collection_id, public_id: "", title: "", deleted: true },
    };
  });
}
export function withoutCollection(view: ShareView): ShareLink {
  const { collection, ...link } = view;
  void collection;
  return link;
}

export async function collectionLinks(s: HttpServices, collectionId: string): Promise<ShareView[]> {
  const rows = await s.waypoint.all<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links WHERE collection_id=? ORDER BY created_at DESC`,
    [collectionId],
  );
  return shareViews(s, rows);
}
export type LinkFilter = "active" | "expired" | "revoked";
export const inFilter = (view: ShareLink, filter: LinkFilter): boolean =>
  filter === "active"
    ? view.state === "active" || view.state === "activating"
    : filter === "expired"
      ? view.state === "expired"
      : view.state === "revoked" || view.state === "revoking";
export async function allLinks(s: HttpServices): Promise<ShareView[]> {
  return shareViews(
    s,
    await s.waypoint.all<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM share_links ORDER BY created_at DESC`,
    ),
  );
}

/** Revokes every unrevoked link of a collection, under its lock, with a snapshot rewrite. */
export async function revokeAll(s: HttpServices, collectionId: string): Promise<number> {
  return s.ingest.withCollectionLock(collectionId, async () => {
    const open = await s.waypoint.all<{ id: string }>(
      "SELECT id FROM share_links WHERE collection_id=? AND revoked_at IS NULL",
      [collectionId],
    );
    if (!open.length) return 0;
    await s.queue.run(
      "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
      [collectionId, Date.now()],
    );
    const result = await s.waypoint.run(
      "UPDATE share_links SET revoked_at=? WHERE collection_id=? AND revoked_at IS NULL",
      [Date.now(), collectionId],
    );
    s.ingest.committer.wake();
    s.syncLoop?.triggerPush();
    return result.changes;
  });
}

/** Moves an active link's expiry later (never earlier), with a snapshot rewrite. */
export async function extendLink(
  s: HttpServices,
  id: string,
  expiresAt: number,
): Promise<ShareView> {
  const found = await s.waypoint.get<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links WHERE id=?`,
    [id],
  );
  if (!found) throw new WaypointError("not_found", "Share link not found");
  await s.ingest.withCollectionLock(found.collection_id, async () => {
    const row = await s.waypoint.get<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM share_links WHERE id=?`,
      [id],
    );
    if (!row) throw new WaypointError("not_found", "Share link not found");
    const now = Date.now();
    if (row.revoked_at !== null) throw new WaypointError("conflict", "Share link is revoked");
    if (row.expires_at === null) throw new WaypointError("conflict", "Share link never expires");
    if (row.expires_at <= now) throw new WaypointError("conflict", "Share link has expired");
    if (expiresAt <= row.expires_at)
      throw new WaypointError("validation_failed", "Expiry can only move later");
    await s.queue.run(
      "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
      [row.collection_id, now],
    );
    await s.waypoint.run("UPDATE share_links SET expires_at=? WHERE id=? AND revoked_at IS NULL", [
      expiresAt,
      id,
    ]);
    s.ingest.committer.wake();
    s.syncLoop?.triggerPush();
  });
  const updated = await s.waypoint.get<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links WHERE id=?`,
    [id],
  );
  const [view] = await shareViews(s, updated ? [updated] : []);
  if (!view) throw new WaypointError("not_found", "Share link not found");
  return view;
}
