export type SyncState = "pending" | "committed" | "synced" | "failed";
export interface WriteResult {
  collection_id: string;
  revision_id: string;
  display_number: number;
  url: string;
  latest_url: string;
  sync_state: SyncState;
  unchanged: boolean;
}
export interface RequestFile {
  path: string;
  hash: string;
  mime?: string;
}
export interface CreateCollectionRequest {
  collection_id?: string;
  revision_id?: string;
  title: string;
  head_path?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  files: RequestFile[];
}
export interface AddRevisionRequest {
  revision_id?: string;
  parent_revision_id?: string;
  mode?: "merge" | "replace";
  head_path?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  files?: RequestFile[];
  remove?: string[];
}
export interface RevisionSummary {
  id: string;
  public_id: string;
  collection_id: string;
  parent_revision_id: string | null;
  display_number: number;
  head_path: string;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  sync_state: SyncState;
  url: string;
}
export interface ManifestFileEntry {
  path: string;
  hash: string;
  mime: string;
  size: number;
  url: string;
}
export interface RevisionDetail extends RevisionSummary {
  files: ManifestFileEntry[];
}
export interface CollectionSummary {
  id: string;
  public_id: string;
  title: string;
  metadata: Record<string, unknown>;
  created_at: number;
  deleted: boolean;
  latest_revision: RevisionSummary | null;
  latest_url: string;
}
export interface CollectionDetail extends CollectionSummary {
  revision: RevisionDetail | null;
  head?:
    | {
        path: string;
        mime: string;
        text: string | null;
        truncated: boolean;
        url: string;
        unavailable?: boolean | undefined;
      }
    | null
    | undefined;
}
export interface CollectionSearchResult {
  id: string;
  public_id: string;
  title: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  revision_count: number;
  latest_revision:
    | (Pick<
        RevisionSummary,
        "id" | "display_number" | "message" | "created_at" | "sync_state" | "head_path"
      > & { file_count: number })
    | null;
  latest_url: string;
  match: "id" | "title" | "metadata" | null;
}
export interface SearchCollectionsResponse {
  collections: CollectionSearchResult[];
  next_cursor: string | null;
}
export interface WaitForRevisionResponse {
  changed: boolean;
  revisions: RevisionSummary[];
}
export interface ListCollectionsResponse {
  collections: CollectionSummary[];
}
export interface ListRevisionsResponse {
  revisions: RevisionSummary[];
}
export interface QueueCounts {
  pending_collections: number;
  pending_revisions: number;
  failed_revisions: number;
  pending_blobs: number;
  pending_renditions: number;
  pending_snapshots: number;
  pending_r2_deletes: number;
  pending_purges: number;
  unpushed: number;
}
export interface FailedItem {
  id: string;
  created_at: number;
  last_error: string | null;
  error_kind?: string | null;
  collection_public_id?: string | null;
}
export interface StatusResponse {
  environment: "dev" | "prod";
  queue: QueueCounts;
  oldest_pending_age_ms: number | null;
  failed_items: FailedItem[];
  pending_items: { id: string; collection_public_id: string | null }[];
  sync_enabled: boolean;
  queue_errors: { kind: string; id: string; last_error: string }[];
  last_upload_at: number | null;
  last_push_at: number | null;
  last_pull_at: number | null;
  last_error: string | null;
  sync_verified: boolean;
  sync_blocked: boolean;
  account_paused: boolean;
  account_error: string | null;
}
export const MCP_LAUNCHER_API = 1;
export interface McpVersionResponse {
  server_sha256: string;
  package_sha256: string;
  launcher_sha256: string;
  launcher_api: number;
}
export interface McpRuntimeStatus {
  running_sha256: string | null;
  source: "fresh" | "cache" | "embedded";
  latest_sha256: string | null;
  update_available: boolean;
}
export type McpStatusResponse = StatusResponse & { mcp: McpRuntimeStatus };
export interface ResolveResponse {
  collection_id: string;
  revision_id?: string;
  path?: string;
}
export interface BlobPutResponse {
  hash: string;
  size: number;
}
export type PatchCollectionResponse = CollectionDetail;
export type DeleteCollectionResponse = CollectionDetail;
export type UndeleteCollectionResponse = CollectionDetail;
export type PurgeCollectionResponse = { purged: true } | { queued: true };
export interface QueueRetryResponse {
  retried: string[];
}
export interface QueueDropResponse {
  dropped: string[];
}
