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
export async function getStatus(s: HttpServices): Promise<ViewerStatus> {
  const rows = await s.queue.all<{
    id: string;
    collection_id: string;
    state: string;
    created_at: number;
    last_error: string | null;
    error_kind: string | null;
  }>("SELECT id,collection_id,state,created_at,last_error,error_kind FROM pending_revisions");
  const [pendingCollections, committedCollections, uploads, lastPush] = await Promise.all([
    s.queue.all<{ id: string; public_id: string }>("SELECT id,public_id FROM pending_collections"),
    s.waypoint.all<{ id: string; public_id: string }>("SELECT id,public_id FROM collections"),
    s.waypoint.get<{ last_upload_at: number | null }>(
      "SELECT MAX(uploaded_at) AS last_upload_at FROM blobs",
    ),
    s.waypoint.get<{ value: string }>("SELECT value FROM meta WHERE key='last_push_at'"),
  ]);
  const collectionIds = new Map(
    [...committedCollections, ...pendingCollections].map((row) => [row.id, row.public_id]),
  );
  const pending = rows.filter((row) => row.state === "pending");
  const failed = rows.filter((row) => row.state === "failed");
  const pushTime = lastPush ? Number(lastPush.value) : null;
  return {
    queue: {
      pending_collections: pendingCollections.length,
      pending_revisions: pending.length,
      failed_revisions: failed.length,
      pending_blobs: (await s.queue.all("SELECT hash FROM pending_blobs")).length,
      pending_renditions: (await s.queue.all("SELECT source_hash FROM pending_renditions")).length,
      pending_snapshots: (await s.queue.all("SELECT collection_id FROM pending_snapshots")).length,
      pending_r2_deletes: (await s.queue.all("SELECT key FROM pending_r2_deletes")).length,
      pending_purges: (await s.queue.all("SELECT collection_id FROM pending_purges")).length,
      unpushed: (await s.queue.all("SELECT revision_id FROM unpushed")).length,
    },
    oldest_pending_age_ms: pending.length
      ? Date.now() - Math.min(...pending.map((row) => row.created_at))
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
    last_upload_at: uploads?.last_upload_at ?? null,
    last_push_at: pushTime !== null && Number.isFinite(pushTime) ? pushTime : null,
    last_pull_at: s.ingest.sync.lastPullAt,
    last_error:
      rows
        .filter((row) => row.last_error !== null)
        .toSorted(
          (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )[0]?.last_error ?? null,
    sync_verified: Boolean(s.ingest.sync.verified),
    sync_enabled: !(s.ingest.sync instanceof LocalSyncClient),
  };
}
