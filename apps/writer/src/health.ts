import type { SyncState } from "@waypoint/core";

import { LocalSyncClient } from "./db.ts";
import type { HttpServices } from "./http.ts";
import { sourceHost } from "./read-model.ts";
import { cloudLastOkAt } from "./status-data.ts";
import { plural } from "./viewer/format.ts";

/** Writer health for the pill, the popover, Needs attention and Status (spec §4.2). */
export type HealthState =
  | "blocked"
  | "failed"
  | "offline"
  | "off"
  | "stalled"
  | "uploading"
  | "synced";
/** One queued revision's sync health (OW-06): the one rule every surface uses. */
export type RevisionHealth = "failed" | "waiting" | "stalled" | "uploading";
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
  state: "pending" | "failed";
  first_attempt_at: number | null;
  attempts: number;
  next_attempt_at: number | null;
  parent_revision_id: string | null;
  /** The parent's queue state when the parent is itself queued, else null. */
  parent_state: "pending" | "failed" | null;
  /** `syncStateOf(this, now)` at getHealth time (never `stalled` with sync off). */
  sync: RevisionHealth;
}
/** A revision of a collection with queued work; structurally a lineage row (FD1). */
export interface HealthRevision {
  id: string;
  public_id: string;
  parent_revision_id: string | null;
  display_number: number;
  sync_state: SyncState;
}
export interface CollectionHealth {
  collection_id: string;
  collection_public_id: string | null;
  collection_title: string | null;
  /** Queued revisions of this collection, newest first. */
  items: HealthItem[];
  /** Every revision of the collection, oldest first (display-number order). */
  rows: HealthRevision[];
  worst: RevisionHealth;
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
  /** Every `state='pending'` item, including waiting and stalled ones. */
  pending: HealthItem[];
  /** Pending items with `sync === "stalled"`, newest first. */
  stalled: HealthItem[];
  /** Pending items with `sync === "waiting"`, newest first. */
  waiting: HealthItem[];
  /** One entry per collection with a queued revision, worst first, then newest first. */
  collections: CollectionHealth[];
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
/** Cloud-error row on Home (OW-06b replaces its use). */
export const STUCK_AFTER_MS = 10 * 60_000;
/** No progress for this long (an error, or never picked up) makes a pending revision stalled. */
export const STALLED_AFTER_MS = 10 * 60_000;

const byNewest = (a: HealthItem, b: HealthItem) => b.created_at - a.created_at;
const rank: Record<RevisionHealth, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };

/**
 * OW-06's rule, first match wins: failed; waiting (its parent is itself pending in the queue);
 * stalled (no progress for STALLED_AFTER_MS since the first attempt, or since creation if never
 * attempted, with an error recorded or never picked up); else uploading. A pending child of a
 * failed parent isn't waiting: the committer will fail it as `parent_failed`.
 */
export function syncStateOf(
  item: Pick<
    HealthItem,
    "state" | "parent_state" | "first_attempt_at" | "created_at" | "last_error"
  >,
  now: number,
): RevisionHealth {
  if (item.state === "failed") return "failed";
  if (item.parent_state === "pending") return "waiting";
  const anchor = item.first_attempt_at ?? item.created_at;
  if (
    now - anchor >= STALLED_AFTER_MS &&
    (item.last_error !== null || item.first_attempt_at === null)
  )
    return "stalled";
  return "uploading";
}

/**
 * Where the failed or stalled revisions are, seen from one collection (OW-10). Null for a
 * writer-wide condition (blocked, offline, sync off), when nothing is wrong, or without a
 * collection; an item with no collection public ID counts as elsewhere.
 */
export function scopeFor(
  health: Health,
  collectionPub: string | null | undefined,
): "here" | "elsewhere" | "mixed" | null {
  if (collectionPub === null || collectionPub === undefined) return null;
  if (health.state === "blocked" || health.state === "offline" || health.state === "off")
    return null;
  let here = false;
  let elsewhere = false;
  for (const item of [...health.failed, ...health.pending]) {
    if (item.sync !== "failed" && item.sync !== "stalled") continue;
    if (item.collection_public_id === collectionPub) here = true;
    else elsewhere = true;
  }
  return here && elsewhere ? "mixed" : here ? "here" : elsewhere ? "elsewhere" : null;
}

/** This collection's queued revisions and lineage rows, if it has any queued (OW-10b). */
export function collectionHealth(
  health: Health,
  collectionPub: string | null | undefined,
): CollectionHealth | undefined {
  if (collectionPub === null || collectionPub === undefined) return undefined;
  return health.collections.find((entry) => entry.collection_public_id === collectionPub);
}

/**
 * One query when nothing is queued; six when something is (the pending scan, pending and
 * committed collection titles, and revisionIndex's three), constant in queue size.
 */
export async function getHealth(s: HttpServices, now = Date.now()): Promise<Health> {
  const rows = await s.queue.all<{
    id: string;
    public_id: string;
    collection_id: string;
    parent_revision_id: string | null;
    state: "pending" | "failed";
    created_at: number;
    first_attempt_at: number | null;
    attempts: number;
    next_attempt_at: number | null;
    last_error: string | null;
    error_kind: string | null;
    message: string | null;
    metadata: string;
  }>(
    "SELECT id,public_id,collection_id,parent_revision_id,state,created_at,first_attempt_at,attempts,next_attempt_at,last_error,error_kind,message,metadata FROM pending_revisions",
  );
  const collectionIds = [...new Set(rows.map((row) => row.collection_id))];
  const marks = collectionIds.map(() => "?").join(",");
  const [pendingCollections, committedCollections, index] = collectionIds.length
    ? await Promise.all([
        s.queue.all<{ id: string; public_id: string; title: string }>(
          `SELECT id,public_id,title FROM pending_collections WHERE id IN (${marks})`,
          collectionIds,
        ),
        s.waypoint.all<{ id: string; public_id: string; title: string }>(
          `SELECT id,public_id,title FROM collections WHERE id IN (${marks})`,
          collectionIds,
        ),
        s.reads.revisionIndex(collectionIds),
      ])
    : [[], [], new Map<string, never[]>()];
  const collections = new Map(
    [...committedCollections, ...pendingCollections].map((row) => [row.id, row]),
  );
  // revisionIndex lists committed rows and then queued ones; sort so rows follow display numbers.
  const revisions = new Map<string, HealthRevision[]>();
  const numbers = new Map<string, number>();
  for (const [collectionId, list] of index) {
    const sorted = list.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    revisions.set(
      collectionId,
      sorted.map((row) => {
        // revisionIndex numbers and classifies every row it returns.
        if (row.display_number === undefined || row.sync_state === undefined)
          throw new Error(`revisionIndex left ${row.id} unnumbered`);
        numbers.set(row.id, row.display_number);
        return {
          id: row.id,
          public_id: row.public_id,
          parent_revision_id: row.parent_revision_id,
          display_number: row.display_number,
          sync_state: row.sync_state,
        };
      }),
    );
  }
  const queued = new Map(rows.map((row) => [row.id, row.state]));
  const syncEnabled = !(s.ingest.sync instanceof LocalSyncClient);
  const item = (row: (typeof rows)[number]): HealthItem => {
    const collection = collections.get(row.collection_id);
    const base = {
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
      state: row.state,
      first_attempt_at: row.first_attempt_at,
      attempts: row.attempts,
      next_attempt_at: row.next_attempt_at,
      parent_revision_id: row.parent_revision_id,
      parent_state: row.parent_revision_id ? (queued.get(row.parent_revision_id) ?? null) : null,
    };
    const sync = syncStateOf(base, now);
    // Sync off: nothing uploads, so nothing is stalled.
    return { ...base, sync: sync === "stalled" && !syncEnabled ? "uploading" : sync };
  };
  const items = rows.map(item).toSorted(byNewest);
  const failed = items.filter((row) => row.state === "failed");
  const pending = items.filter((row) => row.state === "pending");
  const stalled = pending.filter((row) => row.sync === "stalled");
  const waiting = pending.filter((row) => row.sync === "waiting");
  const grouped = new Map<string, HealthItem[]>();
  for (const row of items) {
    const list = grouped.get(row.collection_id) ?? [];
    list.push(row);
    grouped.set(row.collection_id, list);
  }
  const collectionHealths = [...grouped].map(([collectionId, list]): CollectionHealth => {
    const first = list[0];
    return {
      collection_id: collectionId,
      collection_public_id: first?.collection_public_id ?? null,
      collection_title: first?.collection_title ?? null,
      items: list,
      rows: revisions.get(collectionId) ?? [],
      worst: list.reduce<RevisionHealth>(
        (worst, row) => (rank[row.sync] < rank[worst] ? row.sync : worst),
        "waiting",
      ),
    };
  });
  const byWorst = collectionHealths.toSorted(
    (a, b) =>
      rank[a.worst] - rank[b.worst] ||
      (b.items[0]?.created_at ?? 0) - (a.items[0]?.created_at ?? 0),
  );
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
  } else if (stalled.length) {
    state = "stalled";
    label = `${stalled.length} stalled`;
    aria = `Writer status: ${plural(stalled.length, "revision")} stalled`;
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
    stalled,
    waiting,
    collections: byWorst,
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
