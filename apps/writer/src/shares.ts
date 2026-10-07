import {
  deriveShareToken,
  hashShareToken,
  shareShellUrl,
  WaypointError,
  type ShareLink,
} from "@waypoint/core";

import type { HttpServices } from "./http.js";
import type { RevisionRow } from "./read-model.js";

type SharingServices = Pick<HttpServices, "publicBaseUrl" | "shareTokenKey">;
/**
 * Links exist for the reader at WAYPOINT_PUBLIC_BASE_URL. Listing, revoking and extending
 * them needs only that; creating links and showing their URLs also needs the key that
 * derives tokens (D50). Without the base URL every share-link endpoint answers 409.
 */
export function linksEnabled(s: SharingServices): boolean {
  return Boolean(s.publicBaseUrl);
}
/** Whether new links can be created (and URLs shown): the base URL and the token key. */
export function sharingEnabled(s: SharingServices): boolean {
  return sharingConfig(s) !== undefined;
}
function sharingConfig(s: SharingServices): { base: string; key: Uint8Array } | undefined {
  return s.publicBaseUrl && s.shareTokenKey
    ? { base: s.publicBaseUrl, key: s.shareTokenKey }
    : undefined;
}
/** Answers 409 conflict unless share links are configured (list, revoke, extend). */
export function requireLinks(s: SharingServices): void {
  if (!linksEnabled(s)) throw new WaypointError("conflict", "Sharing is not configured");
}
/** Answers 409 conflict unless links can be created (create, and a link's URL). */
export function requireSharing(s: SharingServices): { base: string; key: Uint8Array } {
  const sharing = sharingConfig(s);
  if (!sharing)
    throw new WaypointError(
      "conflict",
      s.publicBaseUrl
        ? "Sharing is not configured: WAYPOINT_SHARE_TOKEN_KEY is not set"
        : "Sharing is not configured",
    );
  return sharing;
}
/** Why a link has no URL (the 409 from /url and the viewer's tooltip). */
export const URL_UNAVAILABLE =
  "URL unavailable: this link was created before links became copyable, or under a different share token key. It still works for whoever has it. Create a new link to get a copyable URL.";
/**
 * A link's stable public URL, without a file path (the reader opens the head file). Null when
 * the token derived from the link ID doesn't hash to the stored token_hash: the link predates
 * deterministic tokens, or the key changed since.
 */
async function recoverUrl(
  sharing: { base: string; key: Uint8Array },
  row: ShareRow,
  tokenHash: string | undefined,
  collectionPublicId: string | undefined,
  pinnedPublicId: string | undefined,
): Promise<string | null> {
  if (!tokenHash || !collectionPublicId || (row.revision_id && !pinnedPublicId)) return null;
  const token = await deriveShareToken(sharing.key, row.id);
  if ((await hashShareToken(token)) !== tokenHash) return null;
  return shareShellUrl(
    sharing.base,
    token,
    collectionPublicId,
    row.revision_id ? pinnedPublicId : undefined,
  );
}

export type ShareRow = Pick<
  ShareLink,
  "id" | "collection_id" | "revision_id" | "label" | "expires_at" | "revoked_at" | "created_at"
>;
export const SHARE_COLUMNS = "id,collection_id,revision_id,label,expires_at,revoked_at,created_at";
/**
 * How long a revocation stays "revoking" after the push that carried it finished: the reader
 * caches a live link for at most 5 s (denials are never cached), so 10 s covers it.
 */
export const SETTLE_MS = 10_000;
/** When a change committed at a time reached the cloud (SyncLoop.pushedAt). */
export interface PushTimes {
  pushedAt(at: number): number | null;
}
export interface ShareCollection {
  id: string;
  public_id: string;
  title: string;
  deleted: boolean;
}
export type ShareView = ShareLink & { collection: ShareCollection };

/**
 * Derived lifecycle state (B3). "activating" until a push that started after the link was
 * created has finished; "revoking" until a push that started after the revocation has
 * finished and SETTLE_MS more have passed.
 */
export function shareState(
  row: ShareRow,
  pushes: PushTimes | undefined,
  now: number,
): ShareLink["state"] {
  if (row.revoked_at !== null) {
    const pushed = pushes?.pushedAt(row.revoked_at) ?? null;
    return pushed === null || now - pushed < SETTLE_MS ? "revoking" : "revoked";
  }
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return (pushes?.pushedAt(row.created_at) ?? null) === null ? "activating" : "active";
}

/**
 * Views for any number of links in six queries (B3): five for revisions and collections, and
 * one for the stored token hashes that decide whether each link's URL is recoverable. The
 * hashes never leave this function.
 */
export async function shareViews(s: HttpServices, rows: readonly ShareRow[]): Promise<ShareView[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.collection_id))];
  const sharing = sharingConfig(s);
  const [index, collections, hashes] = await Promise.all([
    s.reads.revisionIndex(ids),
    s.reads.collectionsById(ids),
    // Only this page's links: never every link of a collection.
    sharing
      ? s.waypoint.all<{ id: string; token_hash: string }>(
          `SELECT id,token_hash FROM share_links WHERE id IN (${rows.map(() => "?").join(",")})`,
          rows.map((row) => row.id),
        )
      : Promise.resolve([]),
  ]);
  const tokenHashes = new Map(hashes.map((row) => [row.id, row.token_hash]));
  const now = Date.now();
  const pushes = s.syncLoop;
  return Promise.all(
    rows.map(async (row): Promise<ShareView> => {
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
        state: shareState(row, pushes, now),
        revocation_pushed:
          row.revoked_at === null ? null : (pushes?.pushedAt(row.revoked_at) ?? null) !== null,
        revision_display_number: pinned?.display_number ?? null,
        public_sees:
          status === "active" && !deleted && sees
            ? { revision_id: sees.id, display_number: sees.display_number ?? 0 }
            : null,
        url: sharing
          ? await recoverUrl(
              sharing,
              row,
              tokenHashes.get(row.id),
              collection?.public_id,
              pinned?.public_id,
            )
          : null,
        collection: collection ?? {
          id: row.collection_id,
          public_id: "",
          title: "",
          deleted: true,
        },
      };
    }),
  );
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
 * shareViews' six for the page, whatever the number of links.
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
/** GET /api/share-links: default and maximum page sizes. */
export const API_LINKS_DEFAULT = 50;
export const API_LINKS_MAX = 200;
/**
 * One page of links for the API, newest first, optionally in one filter: two queries plus
 * shareViews' six, whatever the number of links. An unreadable cursor is a validation error.
 */
export async function listLinks(
  s: HttpServices,
  options: { filter?: LinkFilter | undefined; cursor?: string | undefined; limit: number },
  now = Date.now(),
): Promise<{ views: ShareView[]; next: string | null }> {
  const after = options.cursor === undefined ? undefined : decodeLinkCursor(options.cursor);
  if (options.cursor !== undefined && !after)
    throw new WaypointError("validation_failed", "Invalid cursor");
  const where = options.filter ? filterSql(options.filter) : "1=1";
  const args = options.filter ? filterArgs(options.filter, now) : [];
  const keyset = after ? " AND (created_at<? OR (created_at=? AND id<?))" : "";
  const keyArgs = after ? [after[0], after[0], after[1]] : [];
  // One extra row says whether another page follows.
  const rows = await s.waypoint.all<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links WHERE ${where}${keyset} ORDER BY created_at DESC,id DESC LIMIT ?`,
    [...args, ...keyArgs, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    views: await shareViews(s, page),
    next: rows.length > options.limit && last ? encodeLinkCursor(last) : null,
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
    // Re-checked in the UPDATE with the time now: a link that expired (or was revoked) since the
    // check above stays expired. The queued snapshot rewrite is then a harmless no-op.
    const changed = await s.waypoint.run(
      "UPDATE share_links SET expires_at=? WHERE id=? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at>?",
      [expiresAt, id, Date.now()],
    );
    s.ingest.committer.wake();
    if (changed.changes === 0) {
      const current = await s.waypoint.get<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM share_links WHERE id=?",
        [id],
      );
      if (!current) throw new WaypointError("not_found", "Share link not found");
      if (current.revoked_at !== null) throw new WaypointError("conflict", "Share link is revoked");
      throw new WaypointError("conflict", "Share link has expired");
    }
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
