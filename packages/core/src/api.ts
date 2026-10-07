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
