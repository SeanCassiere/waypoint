import { getHealth } from "../health.ts";
import type { HttpServices } from "../http.ts";
import { linkCounts } from "../shares.ts";
import type { Chrome } from "./layout.tsx";

/**
 * Per-request page chrome: health plus the bar's counts, in three small queries. Link counts use
 * the reader's own rule (OW-05); Trash counts tombstoned, pending-trashed and purging
 * collections once each. One queue.db query reads both pending-trashed and purging IDs.
 */
export async function getChrome(s: HttpServices, now: number = Date.now()): Promise<Chrome> {
  const [health, queued, tombstones] = await Promise.all([
    getHealth(s, now),
    s.queue.all<{ id: string; trashed: number }>(
      "SELECT id,1 AS trashed FROM pending_collections WHERE deleted_at IS NOT NULL UNION ALL SELECT collection_id,0 FROM pending_purges",
    ),
    s.waypoint.all<{ collection_id: string }>("SELECT collection_id FROM collection_tombstones"),
  ]);
  // Same list (and order) as trashedPendingIds().
  const trashedPending = queued
    .flatMap((row) => (row.trashed ? [row.id] : []))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const counts = await linkCounts(s, now, trashedPending);
  const trash = new Set([
    ...tombstones.map((row) => row.collection_id),
    ...queued.map((row) => row.id),
  ]);
  return {
    health,
    now,
    host: new URL(s.reads.baseUrl).hostname,
    liveLinkCount: counts.live,
    pausedLinkCount: counts.paused,
    trashCount: trash.size,
    trashedPending,
  };
}
