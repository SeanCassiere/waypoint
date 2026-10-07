import type { StatusResponse } from "@waypoint/core";

import { LocalSyncClient } from "./db.js";
import type { HttpServices } from "./http.js";

export interface ViewerStatus extends StatusResponse {
  sync_enabled: boolean;
  pending_items: { id: string; collection_public_id: string | null }[];
  failed_items: (StatusResponse["failed_items"][number] & {
    error_kind: string | null;
    collection_public_id: string | null;
  })[];
}
/**
 * Standalone queued renditions: `pending_renditions` rows whose source no queued revision (pending
 * or failed) references, i.e. the `rerender` backlog. The committer commits or drops each of
 * these on its own, so this reaches 0; rows attached to a failed revision wait for that revision.
 */
const RERENDER_PENDING_SQL =
  "SELECT COUNT(*) AS n FROM pending_renditions r WHERE NOT EXISTS (SELECT 1 FROM pending_revisions p, json_each(p.manifest_json,'$.files') f WHERE json_extract(f.value,'$.hash')=r.source_hash)";

async function count(db: HttpServices["queue"], sql: string): Promise<number> {
  return (await db.get<{ n: number }>(sql))?.n ?? 0;
}

export async function getStatus(s: HttpServices): Promise<ViewerStatus> {
  const rows = await s.queue.all<{
    id: string;
    collection_id: string;
    state: string;
    created_at: number;
    last_error: string | null;
    error_kind: string | null;
  }>("SELECT id,collection_id,state,created_at,last_error,error_kind FROM pending_revisions");
  const [
    pendingCollections,
    committedCollections,
    uploads,
    lastPush,
    snapshotErrors,
    deleteErrors,
    purgeErrors,
  ] = await Promise.all([
    s.queue.all<{ id: string; public_id: string }>("SELECT id,public_id FROM pending_collections"),
    s.waypoint.all<{ id: string; public_id: string }>("SELECT id,public_id FROM collections"),
    s.waypoint.get<{ last_upload_at: number | null }>(
      "SELECT MAX(uploaded_at) AS last_upload_at FROM blobs",
    ),
    s.queue.get<{ finished_at: number }>("SELECT finished_at FROM last_push WHERE id=1"),
    s.queue.all<{ id: string; last_error: string }>(
      "SELECT collection_id AS id,last_error FROM pending_snapshots WHERE last_error IS NOT NULL",
    ),
    s.queue.all<{ id: string; last_error: string }>(
      "SELECT key AS id,last_error FROM pending_r2_deletes WHERE last_error IS NOT NULL",
    ),
    s.queue.all<{ id: string; last_error: string }>(
      "SELECT collection_id AS id,last_error FROM pending_purges WHERE last_error IS NOT NULL",
    ),
  ]);
  const collectionIds = new Map(
    [...committedCollections, ...pendingCollections].map((row) => [row.id, row.public_id]),
  );
  const pending = rows.filter((row) => row.state === "pending");
  const failed = rows.filter((row) => row.state === "failed");
  const queueErrors = [
    ...snapshotErrors.map((row) => ({ kind: "snapshot", ...row })),
    ...deleteErrors.map((row) => ({ kind: "bucket_delete", ...row })),
    ...purgeErrors.map((row) => ({ kind: "purge", ...row })),
  ];
  const latestRevisionError = rows
    .filter((row) => row.last_error !== null)
    .toSorted(
      (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0]?.last_error;
  return {
    environment: s.environment ?? "dev",
    queue: {
      pending_collections: pendingCollections.length,
      pending_revisions: pending.length,
      failed_revisions: failed.length,
      pending_blobs: await count(s.queue, "SELECT COUNT(*) AS n FROM pending_blobs"),
      pending_renditions: await count(s.queue, "SELECT COUNT(*) AS n FROM pending_renditions"),
      rerender_pending: await count(s.queue, RERENDER_PENDING_SQL),
      pending_snapshots: await count(s.queue, "SELECT COUNT(*) AS n FROM pending_snapshots"),
      pending_r2_deletes: await count(s.queue, "SELECT COUNT(*) AS n FROM pending_r2_deletes"),
      pending_purges: await count(s.queue, "SELECT COUNT(*) AS n FROM pending_purges"),
      unpushed: await count(s.queue, "SELECT COUNT(*) AS n FROM unpushed"),
    },
    oldest_pending_age_ms: pending.length
      ? Date.now() - pending.reduce((oldest, row) => Math.min(oldest, row.created_at), Infinity)
      : null,
    pending_items: pending.map((row) => ({
      id: row.id,
      collection_public_id: collectionIds.get(row.collection_id) ?? null,
    })),
    failed_items: failed.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      last_error: row.last_error,
      error_kind: row.error_kind,
      collection_public_id: collectionIds.get(row.collection_id) ?? null,
    })),
    queue_errors: queueErrors,
    last_upload_at: s.committer?.lastUploadAt ?? uploads?.last_upload_at ?? null,
    last_push_at: s.syncLoop?.lastPushAt ?? lastPush?.finished_at ?? null,
    last_pull_at: s.ingest.sync.lastPullAt,
    last_error:
      s.committer?.accountError ??
      (s.syncLoop?.blocked ? s.syncLoop.lastError : null) ??
      latestRevisionError ??
      queueErrors[0]?.last_error ??
      s.syncLoop?.lastError ??
      null,
    sync_verified: Boolean(s.ingest.sync.verified),
    sync_blocked: Boolean(s.syncLoop?.blocked),
    sync_enabled: !(s.ingest.sync instanceof LocalSyncClient),
    account_paused: Boolean(s.committer?.accountError),
    account_error: s.committer?.accountError ?? null,
    cloud_last_ok_at: cloudLastOkAt(s),
    cloud_error: s.syncLoop?.lastAttemptFailed ? s.syncLoop.lastError : null,
  };
}

/** The last successful push or pull, from the sync loop or the sync client's pull time. */
export function cloudLastOkAt(s: HttpServices): number | null {
  const times = [s.syncLoop?.lastOkAt, s.syncLoop?.lastPushAt, s.ingest.sync.lastPullAt].filter(
    (value): value is number => typeof value === "number",
  );
  return times.length ? Math.max(...times) : null;
}
