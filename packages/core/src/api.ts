export type SyncState = "pending" | "committed" | "synced" | "failed";
export interface ShareLink {
  id: string;
  collection_id: string;
  revision_id: string | null;
  label: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  mode: "latest" | "pinned";
  status: "active" | "revoked" | "expired";
  publicly_available: boolean;
  /**
   * Lifecycle as the public experiences it (B3): "activating" until the writer pushes the
   * link to the cloud, "revoking" until a revocation has been pushed and the reader's
   * lookup cache (about 60 s) has expired.
   */
  state: "activating" | "active" | "expired" | "revoking" | "revoked";
  /** Display number of the pinned revision, or null for a link that follows latest. */
  revision_display_number: number | null;
  /** The revision the reader serves right now (latest = newest synced), or null for none. */
  public_sees: { revision_id: string; display_number: number } | null;
  /**
   * The link's public URL (no file path, so the reader opens the head file), or null when it
   * can't be recovered: the link was created before deterministic tokens, the token key has
   * changed since, or sharing isn't configured.
   */
  url: string | null;
}
export interface CreateShareLinkResult {
  share_link: ShareLink;
  url: string;
  token: string;
}
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
/** File-level change counts relative to the parent revision (all files are "added" for a root). */
export interface RevisionChanges {
  added: number;
  modified: number;
  removed: number;
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
  changes?: RevisionChanges | undefined;
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
      > & {
        file_count: number;
        changes?: RevisionChanges | null | undefined;
        source_host?: string | null | undefined;
      })
    | null;
  latest_url: string;
  match: "id" | "title" | "metadata" | null;
  /** Queue counts for the collection's revisions that haven't committed yet. */
  queue?: { pending: number; failed: number } | undefined;
  /** Active public links (B4). Null when the collection has none. */
  share?: { active: number; follows_latest: boolean } | null | undefined;
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
  /**
   * Queued renditions no queued revision references (the `rerender` backlog). Unlike
   * `pending_renditions`, it doesn't count renditions waiting on a pending or failed revision.
   */
  rerender_pending?: number | undefined;
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
  /** Last successful cloud push or pull (B6b). */
  cloud_last_ok_at?: number | null | undefined;
  /** Last sync-loop error while the most recent attempt is failing. */
  cloud_error?: string | null | undefined;
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
