import {
  deriveShareToken,
  hashShareToken,
  shareShellUrl,
  WaypointError,
  type ShareLink,
} from "@waypoint/core";

import { inSeries } from "./db.ts";
import type { HttpServices } from "./http.ts";
import type { RevisionRow } from "./read-model.ts";

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

/** Link IDs per token-hash query, well under SQLite's bound-parameter limit. */
const HASH_CHUNK = 500;
const marks = (items: readonly unknown[]): string => items.map(() => "?").join(",");
/** The stored token hashes of these links only (never every link of a collection). */
async function tokenHashesOf(
  s: HttpServices,
  rows: readonly ShareRow[],
): Promise<{ id: string; token_hash: string }[]> {
  const chunks: ShareRow[][] = [];
  for (let at = 0; at < rows.length; at += HASH_CHUNK) chunks.push(rows.slice(at, at + HASH_CHUNK));
  const found = await Promise.all(
    chunks.map((chunk) =>
      s.waypoint.all<{ id: string; token_hash: string }>(
        `SELECT id,token_hash FROM share_links WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk.map((row) => row.id),
      ),
    ),
  );
  return found.flat();
}

/**
 * The facts a link's status is derived from, beyond its own columns: whether its collection is
 * in Trash (tombstoned, or trashed while still pending), and whether its target is in
 * waypoint.db's `revisions` (sync state committed or synced): the pinned revision, in the same
 * collection, or for Latest any revision of the collection.
 */
export interface LinkFacts {
  tombstoned: boolean;
  pendingTrashed: boolean;
  targetCommitted: boolean;
}
/**
 * The live rule's JS form, the reader's own (OW-05): one status per link, the first matching
 * row wins. revoked, then expired (expiring at exactly `now` is expired), then paused (the
 * collection is in Trash), then waiting (the target hasn't committed), else active (live: the
 * reader serves it). liveLinkWhere and friends are the same table in SQL.
 */
export function linkStatus(
  row: Pick<ShareRow, "revoked_at" | "expires_at">,
  facts: LinkFacts,
  now: number,
): ShareLink["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  if (facts.tombstoned || facts.pendingTrashed) return "paused";
  if (!facts.targetCommitted) return "waiting";
  return "active";
}
/** Whether the public reader serves the link right now. */
export function isLive(view: Pick<ShareLink, "status">): boolean {
  return view.status === "active";
}
/** Unrevoked and unexpired, on a collection in Trash: a restore can turn it back on. */
export function isPaused(view: Pick<ShareLink, "status">): boolean {
  return view.status === "paused";
}
/** Unrevoked and unexpired (live, waiting or paused): the link keeps its actions. */
export function isOpen(view: Pick<ShareLink, "status">): boolean {
  return view.status === "active" || view.status === "waiting" || view.status === "paused";
}
/** A revision in waypoint.db (the SQL form's `revisions` table): committed or synced. */
const inWaypointDb = (row: RevisionRow): boolean =>
  row.sync_state === "committed" || row.sync_state === "synced";

/**
 * Views for any number of links in six queries (B3): five for revisions and collections, and
 * one per 500 links for the stored token hashes that decide whether each link's URL is
 * recoverable. The hashes never leave this function. Callers that don't show URLs (bulk
 * revoke, Trash) pass `urls: false` and skip the hashes and HMACs (url is then null). Status
 * facts come from the revisions and collections already loaded (no extra queries).
 */
export async function shareViews(
  s: HttpServices,
  rows: readonly ShareRow[],
  options: { urls?: boolean; now?: number } = {},
): Promise<ShareView[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.collection_id))];
  const sharing = options.urls === false ? undefined : sharingConfig(s);
  const [index, collections, hashes] = await Promise.all([
    s.reads.revisionIndex(ids),
    s.reads.collectionsById(ids),
    sharing ? tokenHashesOf(s, rows) : Promise.resolve([]),
  ]);
  const tokenHashes = new Map(hashes.map((row) => [row.id, row.token_hash]));
  const now = options.now ?? Date.now();
  const pushes = s.syncLoop;
  return Promise.all(
    rows.map(async (row): Promise<ShareView> => {
      const revisions: RevisionRow[] = index.get(row.collection_id) ?? [];
      const collection = collections.get(row.collection_id);
      const pinned = row.revision_id
        ? revisions.find((item) => item.id === row.revision_id)
        : undefined;
      const latest = revisions.findLast((item) => item.sync_state !== "failed");
      const newestSynced = revisions.findLast((item) => item.sync_state === "synced");
      // The two Trash facts stay apart (a pending row doesn't hide a tombstone), as in SQL. A
      // missing collection isn't paused (the SQL form has no clause for it): it ends up waiting.
      const status = linkStatus(
        row,
        {
          tombstoned: collection?.tombstoned === true,
          pendingTrashed: collection?.pendingTrashed === true,
          targetCommitted: row.revision_id
            ? pinned !== undefined && inWaypointDb(pinned)
            : revisions.some(inWaypointDb),
        },
        now,
      );
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
        publicly_available: status === "active" && target?.sync_state === "synced",
        state: shareState(row, pushes, now),
        revocation_pushed:
          row.revoked_at === null ? null : (pushes?.pushedAt(row.revoked_at) ?? null) !== null,
        revision_display_number: pinned?.display_number ?? null,
        public_sees:
          status === "active" && sees
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
        // A missing collection isn't in Trash (its link is waiting, not paused).
        collection: collection
          ? {
              id: collection.id,
              public_id: collection.public_id,
              title: collection.title,
              deleted: collection.deleted,
            }
          : { id: row.collection_id, public_id: "", title: "", deleted: false },
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
/** A boolean SQL expression and its bound arguments. */
export interface SqlWhere {
  sql: string;
  args: (string | number)[];
}
const OPEN_SQL = "s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)";
const TOMBSTONED_SQL =
  "EXISTS (SELECT 1 FROM collection_tombstones t WHERE t.collection_id = s.collection_id)";
/** The reader's revision clause: the pinned revision in the same collection, or any for Latest. */
const TARGET_SQL =
  "CASE WHEN s.revision_id IS NULL THEN EXISTS (SELECT 1 FROM revisions r WHERE r.collection_id = s.collection_id) ELSE EXISTS (SELECT 1 FROM revisions r WHERE r.id = s.revision_id AND r.collection_id = s.collection_id) END";
/**
 * `s.collection_id [NOT] IN (…)` over the pending-trashed IDs, chunked under SQLite's bound
 * parameter limit. Undefined for an empty list: never `IN ()`, the caller omits the clause.
 */
function pendingClause(trashedPending: readonly string[], negate: boolean): SqlWhere | undefined {
  if (!trashedPending.length) return undefined;
  const parts: string[] = [];
  for (let at = 0; at < trashedPending.length; at += HASH_CHUNK) {
    const chunk = trashedPending.slice(at, at + HASH_CHUNK);
    parts.push(`s.collection_id ${negate ? "NOT IN" : "IN"} (${marks(chunk)})`);
  }
  return { sql: parts.join(negate ? " AND " : " OR "), args: [...trashedPending] };
}
/** Unrevoked, unexpired, and not in Trash: the shared start of live and waiting. */
function openOutsideTrash(now: number, trashedPending: readonly string[]): SqlWhere {
  const pending = pendingClause(trashedPending, true);
  return {
    sql: `${OPEN_SQL} AND NOT ${TOMBSTONED_SQL}${pending ? ` AND ${pending.sql}` : ""}`,
    args: [now, ...(pending?.args ?? [])],
  };
}
/**
 * The live rule's SQL form (linkStatus is the JS form): boolean SQL over the alias `s`
 * (share_links) in waypoint.db, true exactly for the links the public reader serves.
 * trashedPending: ids from trashedPendingIds().
 */
export function liveLinkWhere(now: number, trashedPending: readonly string[]): SqlWhere {
  const open = openOutsideTrash(now, trashedPending);
  return { sql: `${open.sql} AND ${TARGET_SQL}`, args: open.args };
}
/** Status paused in SQL: unrevoked, unexpired, and the collection is in Trash. */
export function pausedLinkWhere(now: number, trashedPending: readonly string[]): SqlWhere {
  const pending = pendingClause(trashedPending, false);
  return {
    sql: `${OPEN_SQL} AND (${TOMBSTONED_SQL}${pending ? ` OR ${pending.sql}` : ""})`,
    args: [now, ...(pending?.args ?? [])],
  };
}
/** Status waiting in SQL: unrevoked, unexpired, not in Trash, and the target isn't committed. */
export function waitingLinkWhere(now: number, trashedPending: readonly string[]): SqlWhere {
  const open = openOutsideTrash(now, trashedPending);
  return { sql: `${open.sql} AND NOT ${TARGET_SQL}`, args: open.args };
}
/** Collections trashed while still pending (queue.db); usually none. */
export async function trashedPendingIds(s: Pick<HttpServices, "queue">): Promise<string[]> {
  const rows = await s.queue.all<{ id: string }>(
    "SELECT id FROM pending_collections WHERE deleted_at IS NOT NULL ORDER BY id",
  );
  return rows.map((row) => row.id);
}
const EXPIRED_SQL = "s.revoked_at IS NULL AND s.expires_at IS NOT NULL AND s.expires_at <= ?";
const REVOKED_SQL = "s.revoked_at IS NOT NULL";
/** `SUM(CASE WHEN … THEN 1 ELSE 0 END) AS name` for each named condition. */
function sums(parts: [name: string, where: SqlWhere][]): SqlWhere {
  return {
    sql: parts
      .map(([name, where]) => `SUM(CASE WHEN ${where.sql} THEN 1 ELSE 0 END) AS ${name}`)
      .join(","),
    args: parts.flatMap(([, where]) => where.args),
  };
}
/** One query: live, paused and waiting counts across all links. */
export async function linkCounts(
  s: HttpServices,
  now: number,
  trashedPending: readonly string[],
): Promise<{ live: number; paused: number; waiting: number }> {
  const select = sums([
    ["live", liveLinkWhere(now, trashedPending)],
    ["paused", pausedLinkWhere(now, trashedPending)],
    ["waiting", waitingLinkWhere(now, trashedPending)],
  ]);
  const row = await s.waypoint.get<{
    live: number | null;
    paused: number | null;
    waiting: number | null;
  }>(`SELECT ${select.sql} FROM share_links s`, select.args);
  return { live: row?.live ?? 0, paused: row?.paused ?? 0, waiting: row?.waiting ?? 0 };
}
/** /links and GET /api/share-links filters; `active` means live. */
export type LinkFilter = "active" | "paused" | "waiting" | "expired" | "revoked" | "inactive";
/** A filter in SQL over the alias `s`, at `now`. */
function filterWhere(filter: LinkFilter, now: number, trashedPending: readonly string[]): SqlWhere {
  if (filter === "active") return liveLinkWhere(now, trashedPending);
  if (filter === "paused") return pausedLinkWhere(now, trashedPending);
  if (filter === "waiting") return waitingLinkWhere(now, trashedPending);
  if (filter === "expired") return { sql: EXPIRED_SQL, args: [now] };
  if (filter === "revoked") return { sql: REVOKED_SQL, args: [] };
  return {
    sql: "(s.revoked_at IS NOT NULL OR (s.expires_at IS NOT NULL AND s.expires_at <= ?))",
    args: [now],
  };
}
/** Links per /links page. */
export const LINKS_PAGE = 50;
export interface LinkPage {
  views: ShareView[];
  /** Every status's count; `active` counts live links only. */
  counts: Record<"active" | "paused" | "waiting" | "expired" | "revoked", number>;
  /** Links of this listing after this page, and the cursor that shows them. */
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
/** The page's keyset over the alias `s`: rows after the cursor, newest first. */
function keysetWhere(after: [number, string] | undefined): SqlWhere {
  return after
    ? { sql: " AND (s.created_at<? OR (s.created_at=? AND s.id<?))", args: [after[0], ...after] }
    : { sql: "", args: [] };
}
/** The /links Active listing: live and waiting links. */
function openListing(now: number, trashedPending: readonly string[]): SqlWhere {
  const live = liveLinkWhere(now, trashedPending);
  const waiting = waitingLinkWhere(now, trashedPending);
  return { sql: `((${live.sql}) OR (${waiting.sql}))`, args: [...live.args, ...waiting.args] };
}
/**
 * One page of links in a filter, newest first, with every status's count: up to four queries
 * plus shareViews' six for the page, whatever the number of links. The `active` listing shows
 * live and waiting links (a waiting link sits with the live ones until it opens) while
 * `counts.active` counts live links only; `remaining` and `next` follow the listing.
 */
export async function linkPage(
  s: HttpServices,
  filter: LinkFilter,
  cursor: string | undefined,
  now: number = Date.now(),
  trashedPending?: readonly string[],
): Promise<LinkPage> {
  const pending = trashedPending ?? (await trashedPendingIds(s));
  const after = cursor ? decodeLinkCursor(cursor) : undefined;
  const where = filter === "active" ? openListing(now, pending) : filterWhere(filter, now, pending);
  const keyset = keysetWhere(after);
  const select = sums([
    ["active", liveLinkWhere(now, pending)],
    ["paused", pausedLinkWhere(now, pending)],
    ["waiting", waitingLinkWhere(now, pending)],
    ["expired", { sql: EXPIRED_SQL, args: [now] }],
    ["revoked", { sql: REVOKED_SQL, args: [] }],
  ]);
  const [counts, rows] = await Promise.all([
    s.waypoint.get<Record<keyof LinkPage["counts"], number | null>>(
      `SELECT ${select.sql} FROM share_links s`,
      select.args,
    ),
    s.waypoint.all<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM share_links s WHERE ${where.sql}${keyset.sql} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
      [...where.args, ...keyset.args, LINKS_PAGE],
    ),
  ]);
  const last = rows.at(-1);
  const rest = last ? keysetWhere([last.created_at, last.id]) : keyset;
  const remaining =
    rows.length === LINKS_PAGE && last
      ? ((
          await s.waypoint.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM share_links s WHERE ${where.sql}${rest.sql}`,
            [...where.args, ...rest.args],
          )
        )?.n ?? 0)
      : 0;
  return {
    views: await shareViews(s, rows, { now }),
    counts: {
      active: counts?.active ?? 0,
      paused: counts?.paused ?? 0,
      waiting: counts?.waiting ?? 0,
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
 * One page of links for the API, newest first, optionally in one filter (the same SQL as
 * /links; `active` is live only): two queries plus shareViews' six, whatever the number of
 * links. An unreadable cursor is a validation error.
 */
export async function listLinks(
  s: HttpServices,
  options: { filter?: LinkFilter | undefined; cursor?: string | undefined; limit: number },
  now: number = Date.now(),
): Promise<{ views: ShareView[]; next: string | null }> {
  const after = options.cursor === undefined ? undefined : decodeLinkCursor(options.cursor);
  if (options.cursor !== undefined && !after)
    throw new WaypointError("validation_failed", "Invalid cursor");
  const where: SqlWhere = options.filter
    ? filterWhere(options.filter, now, await trashedPendingIds(s))
    : { sql: "1=1", args: [] };
  const keyset = keysetWhere(after);
  // One extra row says whether another page follows.
  const rows = await s.waypoint.all<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links s WHERE ${where.sql}${keyset.sql} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
    [...where.args, ...keyset.args, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    views: await shareViews(s, page, { now }),
    next: rows.length > options.limit && last ? encodeLinkCursor(last) : null,
  };
}

/**
 * Revokes exactly these IDs of one collection (still unrevoked and unexpired at `now`), under
 * its lock, with a snapshot rewrite, committer wake and push trigger; returns rows changed.
 * Global revoke-all passes the live links only (OW-05).
 */
export async function revokeLinks(
  s: HttpServices,
  collectionId: string,
  ids: readonly string[],
): Promise<number> {
  if (!ids.length) return 0;
  return s.ingest.withCollectionLock(collectionId, async () => {
    const chunks: string[][] = [];
    for (let at = 0; at < ids.length; at += HASH_CHUNK) chunks.push(ids.slice(at, at + HASH_CHUNK));
    const open = "collection_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)";
    const now = Date.now();
    const found = await Promise.all(
      chunks.map((chunk) =>
        s.waypoint.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM share_links WHERE ${open} AND id IN (${marks(chunk)})`,
          [collectionId, now, ...chunk],
        ),
      ),
    );
    if (!found.some((row) => (row?.n ?? 0) > 0)) return 0;
    await s.queue.run(
      "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
      [collectionId, now],
    );
    let changes = 0;
    await inSeries(chunks, async (chunk) => {
      const result = await s.waypoint.run(
        `UPDATE share_links SET revoked_at=? WHERE ${open} AND id IN (${marks(chunk)})`,
        [now, collectionId, now, ...chunk],
      );
      changes += result.changes;
    });
    s.ingest.committer.wake();
    s.syncLoop?.triggerPush();
    return changes;
  });
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
