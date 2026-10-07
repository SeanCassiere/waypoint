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
export type LinkFilter = "active" | "expired" | "revoked" | "inactive";
export const inFilter = (view: ShareLink, filter: LinkFilter): boolean =>
  filter === "active"
    ? view.state === "active" || view.state === "activating"
    : filter === "expired"
      ? view.state === "expired"
      : filter === "revoked"
        ? view.state === "revoked" || view.state === "revoking"
        : view.state !== "active" && view.state !== "activating";
/** The same filters in SQL, at `now` (inFilter's states are derived from these columns). */
function filterSql(filter: LinkFilter): string {
  return filter === "active"
    ? "revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)"
    : filter === "expired"
      ? "revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?"
      : filter === "revoked"
        ? "revoked_at IS NOT NULL AND ?=?"
        : "(revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at<=?))";
}
const filterArgs = (filter: LinkFilter, now: number): number[] =>
  filter === "revoked" ? [now, now] : [now];
/** Links per /links page. */
export const LINKS_PAGE = 50;
export interface LinkPage {
  views: ShareView[];
  counts: Record<"active" | "expired" | "revoked", number>;
  /** Links of this filter after this page, and the cursor that shows them. */
  remaining: number;
  next: string | null;
}
function encodeLinkCursor(row: ShareRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url");
}
function decodeLinkCursor(cursor: string): [number, string] | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      typeof parsed[1] === "string"
    )
      return [parsed[0], parsed[1]];
  } catch {
    // An invalid cursor shows the first page.
  }
  return undefined;
}
/**
 * One page of links in a filter, newest first, with every filter's count: four queries plus
 * shareViews' five for the page, whatever the number of links.
 */
export async function linkPage(
  s: HttpServices,
  filter: LinkFilter,
  cursor: string | undefined,
  now = Date.now(),
): Promise<LinkPage> {
  const after = cursor ? decodeLinkCursor(cursor) : undefined;
  const where = filterSql(filter);
  const args = filterArgs(filter, now);
  const keyset = after ? " AND (created_at<? OR (created_at=? AND id<?))" : "";
  const keyArgs = after ? [after[0], after[0], after[1]] : [];
  const [counts, rows] = await Promise.all([
    s.waypoint.get<{ active: number | null; expired: number | null; revoked: number | null }>(
      "SELECT SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at<=? THEN 1 ELSE 0 END) AS expired,SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked FROM share_links",
      [now, now],
    ),
    s.waypoint.all<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM share_links WHERE ${where}${keyset} ORDER BY created_at DESC,id DESC LIMIT ?`,
      [...args, ...keyArgs, LINKS_PAGE],
    ),
  ]);
  const last = rows.at(-1);
  const remaining =
    rows.length === LINKS_PAGE && last
      ? ((
          await s.waypoint.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM share_links WHERE ${where} AND (created_at<? OR (created_at=? AND id<?))`,
            [...args, last.created_at, last.created_at, last.id],
          )
        )?.n ?? 0)
      : 0;
  return {
    views: await shareViews(s, rows),
    counts: {
      active: counts?.active ?? 0,
      expired: counts?.expired ?? 0,
      revoked: counts?.revoked ?? 0,
    },
    remaining,
    next: remaining && last ? encodeLinkCursor(last) : null,
  };
}
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

/**
 * Moves an active link's expiry later (never earlier), with a snapshot rewrite. Asking for the
 * current expiry again is a no-op success, so retries are idempotent.
 */
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
    // A retry of an extension that already applied succeeds without another snapshot.
    if (expiresAt === row.expires_at) return;
    if (row.expires_at <= now) throw new WaypointError("conflict", "Share link has expired");
    if (expiresAt < row.expires_at)
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
