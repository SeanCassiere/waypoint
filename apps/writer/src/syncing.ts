import type { DbHandle } from "./db.ts";

export interface SyncingRow {
  since: number;
  until: number;
}
/** A queued revision that can hold a collection's syncing row: not failed. */
export interface QueuedRevision {
  id: string;
  created_at: number;
}
/**
 * Recomputes one collection's `collection_syncing` row (RX-11, owner decision h) from the queue
 * and the committed revisions. Caller holds the collection lock. `waypoint` may be the commit's
 * transaction handle. Writes only when the stored row differs.
 *
 * The row exists while a non-failed queued revision is newer than the newest committed one.
 * Revision IDs sort by creation (the reader's `ORDER BY id DESC` relies on the same order), so a
 * committed revision whose queue row isn't cleaned up yet (`id <= newest`) never counts.
 *
 * With a waypoint transaction handle, this reads `queue` while that transaction is open; a queue
 * transaction may already be waiting on the waypoint connection (Drop's `prunePendingStorage`),
 * which would deadlock both connections. The commit uses `refreshSyncingFrom` there instead.
 */
export async function refreshSyncing(options: {
  waypoint: DbHandle;
  queue: DbHandle;
  collectionId: string;
  giveUpHours: number;
}): Promise<{ row: SyncingRow | null; changed: boolean }> {
  const { queue, collectionId } = options;
  return apply(options, async (newest) => {
    const pending = await queue.get<{ since: number | null }>(
      "SELECT MIN(created_at) AS since FROM pending_revisions WHERE collection_id=? AND state<>'failed' AND id>?",
      [collectionId, newest],
    );
    return pending?.since ?? null;
  });
}
/**
 * The collection's non-failed queued revisions, for `refreshSyncingFrom`. Read it under the
 * collection lock **before** opening the waypoint transaction that will use it: nothing else can
 * change this collection's queue rows while the lock is held.
 */
export function readQueued(queue: DbHandle, collectionId: string): Promise<QueuedRevision[]> {
  return queue.all<QueuedRevision>(
    "SELECT id,created_at FROM pending_revisions WHERE collection_id=? AND state<>'failed'",
    [collectionId],
  );
}
/**
 * `refreshSyncing` for use inside a waypoint transaction (`waypoint` is its handle): the same rule,
 * but the queue facts come from `queued` (see `readQueued`), so the transaction never waits on the
 * queue connection.
 */
export function refreshSyncingFrom(options: {
  waypoint: DbHandle;
  queued: readonly QueuedRevision[];
  collectionId: string;
  giveUpHours: number;
}): Promise<{ row: SyncingRow | null; changed: boolean }> {
  return apply(options, (newest) => {
    let since: number | null = null;
    for (const revision of options.queued)
      if (revision.id > newest && (since === null || revision.created_at < since))
        since = revision.created_at;
    return since;
  });
}
async function apply(
  options: { waypoint: DbHandle; collectionId: string; giveUpHours: number },
  pendingSince: (newest: string) => Promise<number | null> | number | null,
): Promise<{ row: SyncingRow | null; changed: boolean }> {
  const { waypoint, collectionId, giveUpHours } = options;
  let desired: SyncingRow | null = null;
  // Never committed: the collection has no cloud row for the reader (or the FK) to point at.
  const newest = await waypoint.get<{ id: string | null }>(
    "SELECT MAX(id) AS id FROM revisions WHERE collection_id=?",
    [collectionId],
  );
  if (newest?.id) {
    const since = await pendingSince(newest.id);
    if (since !== null) desired = { since, until: since + giveUpHours * 3_600_000 };
  }
  const stored =
    (await waypoint.get<SyncingRow>(
      "SELECT since,until FROM collection_syncing WHERE collection_id=?",
      [collectionId],
    )) ?? null;
  if (
    stored === desired ||
    (stored && desired && stored.since === desired.since && stored.until === desired.until)
  )
    return { row: stored, changed: false };
  if (desired)
    await waypoint.run(
      "INSERT INTO collection_syncing (collection_id,since,until) VALUES (?,?,?) ON CONFLICT(collection_id) DO UPDATE SET since=excluded.since, until=excluded.until",
      [collectionId, desired.since, desired.until],
    );
  else await waypoint.run("DELETE FROM collection_syncing WHERE collection_id=?", [collectionId]);
  return { row: desired, changed: true };
}
