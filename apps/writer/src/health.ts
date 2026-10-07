import { displayNumbers, parseId } from "@waypoint/core";

import { LocalSyncClient } from "./db.js";
import type { HttpServices } from "./http.js";
import { sourceHost } from "./read-model.js";
import { cloudLastOkAt } from "./status-data.js";
import { plural } from "./viewer/format.js";

/** Writer health for the pill, the popover, Needs attention and Status (spec §4.2). */
export type HealthState = "blocked" | "failed" | "offline" | "off" | "uploading" | "synced";
export interface HealthItem {
  id: string;
  public_id: string;
  collection_id: string;
  collection_public_id: string | null;
  collection_title: string | null;
  display_number: number | null;
  message: string | null;
  created_at: number;
  last_error: string | null;
  error_kind: string | null;
  source_host: string | null;
}
export interface Health {
  state: HealthState;
  /** Pill text: one word, or a count of one unit. */
  label: string;
  /** Short phone label (dot plus the first word). */
  short: string;
  /** Full spoken state for aria-label. */
  aria: string;
  failed: HealthItem[];
  pending: HealthItem[];
  oldestPendingAt: number | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  cloudLastOkAt: number | null;
  cloudError: string | null;
  blockedReason: string | null;
  environment: "dev" | "prod";
  syncEnabled: boolean;
}
export const OFFLINE_AFTER_MS = 2 * 60_000;
export const STUCK_AFTER_MS = 10 * 60_000;

const byNewest = (a: HealthItem, b: HealthItem) => b.created_at - a.created_at;

/** Two queries when nothing is queued; four when something is (constant in queue size). */
export async function getHealth(s: HttpServices, now = Date.now()): Promise<Health> {
  const rows = await s.queue.all<{
    id: string;
    public_id: string;
    collection_id: string;
    state: "pending" | "failed";
    created_at: number;
    last_error: string | null;
    error_kind: string | null;
    message: string | null;
    metadata: string;
  }>(
    "SELECT id,public_id,collection_id,state,created_at,last_error,error_kind,message,metadata FROM pending_revisions",
  );
  const collectionIds = [...new Set(rows.map((row) => row.collection_id))];
  const marks = collectionIds.map(() => "?").join(",");
  const [pendingCollections, committedCollections, committedRevisions] = collectionIds.length
    ? await Promise.all([
        s.queue.all<{ id: string; public_id: string; title: string }>(
          `SELECT id,public_id,title FROM pending_collections WHERE id IN (${marks})`,
          collectionIds,
        ),
        s.waypoint.all<{ id: string; public_id: string; title: string }>(
          `SELECT id,public_id,title FROM collections WHERE id IN (${marks})`,
          collectionIds,
        ),
        s.waypoint.all<{ id: string; collection_id: string }>(
          `SELECT id,collection_id FROM revisions WHERE collection_id IN (${marks})`,
          collectionIds,
        ),
      ])
    : [[], [], []];
  const collections = new Map(
    [...committedCollections, ...pendingCollections].map((row) => [row.id, row]),
  );
  const numbers = new Map<string, number>();
  for (const collectionId of collectionIds) {
    const ids = new Set([
      ...committedRevisions.filter((row) => row.collection_id === collectionId).map((r) => r.id),
      ...rows.filter((row) => row.collection_id === collectionId).map((row) => row.id),
    ]);
    const assigned = displayNumbers([...ids].toSorted().map((id) => parseId(id, "rev")));
    for (const [id, number] of Object.entries(assigned)) numbers.set(id, number);
  }
  const item = (row: (typeof rows)[number]): HealthItem => {
    const collection = collections.get(row.collection_id);
    return {
      id: row.id,
      public_id: row.public_id,
      collection_id: row.collection_id,
      collection_public_id: collection?.public_id ?? null,
      collection_title: collection?.title ?? null,
      display_number: numbers.get(row.id) ?? null,
      message: row.message,
      created_at: row.created_at,
      last_error: row.last_error,
      error_kind: row.error_kind,
      source_host: sourceHost(row.metadata),
    };
  };
  const failed = rows
    .filter((row) => row.state === "failed")
    .map(item)
    .toSorted(byNewest);
  const pending = rows
    .filter((row) => row.state === "pending")
    .map(item)
    .toSorted(byNewest);
  const syncEnabled = !(s.ingest.sync instanceof LocalSyncClient);
  const blockedReason = s.committer?.accountError
    ? `Bucket account paused: ${s.committer.accountError}`
    : s.syncLoop?.blocked
      ? (s.syncLoop.lastError ?? "Sync is blocked")
      : (s.ingest.sync.blockedReason ?? null);
  const lastOk = cloudLastOkAt(s);
  const offline =
    syncEnabled &&
    Boolean(s.syncLoop?.lastAttemptFailed) &&
    (lastOk === null || now - lastOk > OFFLINE_AFTER_MS);
  let state: HealthState;
  let label: string;
  let aria: string;
  if (syncEnabled && blockedReason) {
    state = "blocked";
    label = "Sync blocked";
    aria = `Writer status: sync is blocked. ${blockedReason}`;
  } else if (failed.length) {
    state = "failed";
    label = `${failed.length} failed`;
    aria = `Writer status: ${plural(failed.length, "revision")} failed to sync`;
  } else if (offline) {
    state = "offline";
    label = "Offline · writes queued";
    aria = "Writer status: can't reach the cloud; writes are queued here";
  } else if (!syncEnabled) {
    state = "off";
    label = "Sync off";
    aria = "Writer status: cloud sync is off on this writer";
  } else if (pending.length) {
    state = "uploading";
    label = "Uploading";
    aria = `Writer status: ${plural(pending.length, "revision")} uploading`;
  } else {
    state = "synced";
    label = "Synced";
    aria = "Writer status: everything is synced";
  }
  return {
    state,
    label,
    short: label.split(" · ")[0] ?? label,
    aria,
    failed,
    pending,
    // A loop, not Math.min(...spread): the queue can hold more rows than the argument limit.
    oldestPendingAt: pending.reduce<number | null>(
      (oldest, row) => (oldest === null || row.created_at < oldest ? row.created_at : oldest),
      null,
    ),
    lastPushAt: s.syncLoop?.lastPushAt ?? null,
    lastPullAt: s.ingest.sync.lastPullAt,
    cloudLastOkAt: lastOk,
    cloudError: s.syncLoop?.lastAttemptFailed ? s.syncLoop.lastError : null,
    blockedReason,
    environment: s.environment ?? "dev",
    syncEnabled,
  };
}
