# API & MCP

Agents are the main writers, so **MCP is the primary interface**. The HTTP API underneath can also be used directly with `curl`. Both exist only on writers, which means only on the tailnet. The reader has no API.

Conventions:
- Things are referenced by **ID** (`col_…`, `rev_…`).
- Responses include URLs.
- `resolve_url` turns a pasted URL back into IDs.

## Request safety

The writer has no auth (the tailnet is trusted). A website open in a browser on the tailnet could still try cross-site requests (CSRF), so:
- JSON endpoints require `Content-Type: application/json`.
- Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) is rejected with `403` if it comes from a browser on another origin. The check is `Sec-Fetch-Site` of `cross-site` or `same-site`, or an `Origin` header that isn't the writer's own origin.
- Requests without these headers (MCP, curl) are allowed.

`create_collection`'s `metadata` is stored on both the collection and its first revision. `add_revision`'s `metadata` is stored on the new revision only.

## Response shapes

Read responses use the types exported by `@waypoint/core` (`api.ts`). They contain public fields only; queue bookkeeping and stored JSON columns are not returned.

- `CollectionSummary`: `id`, `public_id`, `title`, parsed `metadata`, `created_at`, `deleted`, `latest_revision` (`RevisionSummary | null`), and `latest_url`.
- `CollectionDetail`: a collection summary plus `revision` (`RevisionDetail | null`) for the latest revision.
- `RevisionSummary`: `id`, `public_id`, `collection_id`, `parent_revision_id`, `display_number`, `head_path`, `message`, parsed `metadata`, `created_at`, `sync_state`, and pinned `url`.
- `RevisionDetail`: a revision summary plus `files`, an array of `{ path, hash, mime, size, url }`. Each file URL is pinned to that revision's raw route.
- `GET /api/collections` returns `{ collections: CollectionSummary[] }`; `GET /api/collections/:id` returns `CollectionDetail`; `GET /api/collections/:id/revisions` returns `{ revisions: RevisionSummary[] }`; `GET /api/revisions/:id` returns `RevisionDetail`.
- `POST /api/resolve` returns `{ collection_id, revision_id?, path? }`.
- `GET /api/status` returns `queue` counts, `oldest_pending_age_ms`, `failed_items` (`id`, `created_at`, `last_error`), `last_upload_at`, `last_push_at`, `last_pull_at`, `last_error`, and `sync_verified`. Timestamps are Unix milliseconds or `null`.
- `PATCH /api/collections/:id`, `DELETE /api/collections/:id`, and `POST /api/collections/:id/undelete` return `CollectionDetail`.
- `POST /api/collections/:id/purge` returns `{ purged: true }` for a pending collection or `{ queued: true }` for a committed one, with status 202.
- `POST /api/queue/:revision_id/retry` returns `{ retried: string[] }`; `DELETE /api/queue/:revision_id` returns `{ dropped: string[] }`.
- `PUT /api/blobs/:hash` returns `{ hash: string, size: number }`.

## WriteResult

Every write returns the same shape: both MCP tools, both HTTP endpoints, and the ingest step.

```ts
type WriteResult = {
  collection_id: string        // col_…
  revision_id: string          // rev_…  (the parent's ID when unchanged = true)
  display_number: number       // #N
  url: string                  // pinned URL of this revision
  latest_url: string           // collection URL that follows latest
  sync_state: "pending" | "committed" | "synced" | "failed"
  unchanged: boolean           // true = nothing changed; no revision created
}
```

`url` is the pinned URL of the revision just written, and `latest_url` follows the latest revision. Give humans `latest_url` unless they asked for a snapshot. Both work on the tailnet immediately, whatever the `sync_state`.

```json
{
  "collection_id": "col_01j9qz7x2bm4d8vk3np6rt9hcs",
  "revision_id":   "rev_01j9qz8k7cfyva3xr6m2hg5e4n",
  "display_number": 4,
  "url":        "https://waypoint.tail7aca06.ts.net/c/7f3k9m2qxv8h/r/k2m9x4p7c1ab/",
  "latest_url": "https://waypoint.tail7aca06.ts.net/c/7f3k9m2qxv8h/",
  "sync_state": "committed",
  "unchanged": false
}
```

## MCP server

The MCP server is a local stdio process on each agent machine:

```jsonc
// e.g. Claude Code MCP config
{ "mcpServers": { "waypoint": {
    "command": "npx", "args": ["-y", "@waypoint/mcp"],
    "env": { "WAYPOINT_URL": "https://waypoint.tail7aca06.ts.net" } } } }
```

For each write it:
1. reads files from the agent's local disk and hashes them
2. asks the writer which blobs it's missing (`POST /api/blobs/check`)
3. uploads only those (`PUT /api/blobs/:hash`)
4. submits the revision with JSON

File contents never travel through tool arguments, except small inline text passed as `content`.

### File inputs

Write tools take a `files` list, a `source_dir`, or both. When a path appears in both, the explicit `files` entry wins.

```ts
type FileInput = {
  path: string            // path inside the revision, e.g. "img/shot-1.png"
  source_path?: string    // absolute path on this machine's disk
  content?: string        // inline UTF-8 text (small text files only, ≤ 1 MB)
  mime?: string           // inferred from extension when omitted
}
// exactly one of source_path | content

type SourceDir = {
  dir: string             // absolute directory; files become paths relative to it
  exclude?: string[]      // extra glob patterns, added to the defaults
}
```

`source_dir` details:
- **Excluded by default:** `.git/**`, `node_modules/**`, and dotfiles.
- **Symlinks** are not followed.
- **Revision limits** apply, so pointing at a project root fails loudly rather than uploading everything: 2,000 files, 500 MB total, and 50 MB per file. All three are configurable.

### Tools

| Tool | Input | Output |
|---|---|---|
| `create_collection` | `title`, `files?`, `source_dir?`, `head_path?`, `message?`, `metadata?` | `WriteResult` |
| `add_revision` | `collection_id`, `files?`, `source_dir?`, `remove?: string[]`, `head_path?`, `message?`, `metadata?`, `mode?: "merge" \| "replace"` (default `merge`), `parent_revision_id?` (default: latest) | `WriteResult` |
| `get_collection` | `collection_id`, `revision_id?` | collection; the selected revision (default latest) with its manifest, URLs, and sync state |
| `list_collections` | `query?` (title substring), `limit?` (default 50), `include_deleted?` | collections, newest first, each with a latest-revision summary and `latest_url` |
| `list_revisions` | `collection_id` | revisions with display number, message, parent, and sync state |
| `read_file` | `collection_id`, `path`, `revision_id?` | text content for text files; metadata and URL for images and other binaries |
| `resolve_url` | `url` | `{ collection_id, revision_id?, path? }` |
| `waypoint_status` | — | queue counts, oldest pending age, failed items, last successful bucket upload, push, and pull, and the last error |

**Notes**
- **`create_collection` also creates the first revision.** A collection without a head document has no purpose.
- **Head path.** When it's omitted, it is inferred in this order: `index.html`, `index.md`, `README.md`, the only file. If that's ambiguous, the call fails with `head_path_ambiguous`. In `add_revision`, the parent's head path is inherited unless a new one is given or the old file was removed.
- **Merge mode:** `remove` is applied first, then `files`. A path in both is an error.
- **Safe retries.** The MCP server mints `col_` and `rev_` IDs before the first attempt and reuses them on retries, so a retry after a timeout returns the original result instead of an error. Revision IDs follow the [minting rule](data-model.md#minting-and-validating-client-generated-ids). On `id_before_parent`, the server re-mints using `details.parent_timestamp` and tries again.
- **Not exposed over MCP in phase 1:** collection title and metadata edits, soft delete, undelete, and purge. They're available in the API and the viewer only, so agents can't delete things.

## HTTP API (writer)

Everything is under `/api`, with JSON in and out unless noted otherwise.

### Blobs
| Method & path | Purpose |
|---|---|
| `POST /api/blobs/check` `{ hashes: string[] }` | Returns `{ missing: string[] }`: hashes whose bytes aren't in **this writer's local blob store**. Ingest and rendering need the bytes locally, so a blob that exists only in the bucket counts as missing and is simply re-uploaded. It never calls the bucket. |
| `PUT /api/blobs/:hash` (raw body) | Stores the blob locally after verifying its hash. Idempotent. |

### Collections & revisions
| Method & path | Purpose |
|---|---|
| `POST /api/collections` | Create a collection and its first revision. Body: `{ collection_id?, revision_id?, title, head_path?, message?, metadata?, files: [{ path, hash, mime? }] }`. Every hash must already be present. Returns `WriteResult`. |
| `POST /api/collections/:id/revisions` | Add a revision. Body: `{ revision_id?, parent_revision_id?, mode?, head_path?, message?, metadata?, files?: [{ path, hash, mime? }], remove?: string[] }`. Returns `WriteResult`. |
| `GET /api/collections` | List. Query: `query`, `limit`, `include_deleted` |
| `GET /api/collections/:id` | Collection + latest revision summary |
| `PATCH /api/collections/:id` | Edit `title` and/or `metadata` |
| `DELETE /api/collections/:id` | Soft delete |
| `POST /api/collections/:id/undelete` | Undo soft delete |
| `POST /api/collections/:id/purge` `{ confirm: "<collection id>" }` | Queue a hard purge; returns immediately |
| `GET /api/collections/:id/revisions` | List revisions |
| `GET /api/revisions/:id` | Revision + full manifest |
| `GET /api/revisions/:id/files/*path` | Raw file content. Markdown returns its rendition; add `?source` for the original. |
| `POST /api/resolve` `{ url }` | URL → IDs |

### Multipart (for `curl` without MCP)

`POST /api/collections` and `POST /api/collections/:id/revisions` also accept `multipart/form-data`:
- a `meta` field containing the JSON body without `files`; `remove`, `mode`, and the other fields go here
- one part per file, with field name `file:<path>`. A part `Content-Type` that is missing or `application/octet-stream` means "infer from the path". The `meta` field must come **first**, so an invalid request is rejected before any blob is stored. Parts are streamed into the blob store, and limits are enforced while streaming.

The writer hashes and stores the parts itself.

```bash
curl -F 'meta={"title":"Auth refactor plan","head_path":"plan.html"}' \
     -F 'file:plan.html=@./plan.html' -F 'file:img/flow.png=@./img/flow.png' \
     https://waypoint.tail7aca06.ts.net/api/collections
```

### Queue & status
| Method & path | Purpose |
|---|---|
| `GET /api/status` | Same data as the `waypoint_status` tool |
| `POST /api/queue/:revision_id/retry` | Re-queue a failed revision and its failed descendants |
| `DELETE /api/queue/:revision_id` | Drop a pending or failed revision and its descendants, and queue deletion of their DR manifests |

### Errors

```json
{ "error": { "code": "head_path_missing", "message": "…", "details": { } } }
```

| Code | Meaning |
|---|---|
| `validation_failed` | Malformed request (including a path in both `files` and `remove`) |
| `path_invalid`, `path_case_conflict` | Path rule violations |
| `head_path_missing`, `head_path_ambiguous` | No valid head document |
| `blob_missing`, `blob_hash_mismatch`, `blob_too_large`, `revision_too_large` | Blob and limit problems |
| `clock_skew`, `stale_id`, `id_before_parent` | Client ID rejected; mint a new one (`details.parent_timestamp` on the last) |
| `revision_conflict` (409) | ID reused for a different collection or parent |
| `collection_not_found` (404), `collection_deleted` (410), `collection_purged` (410) | Collection state |
| `parent_not_found` (422), `parent_failed` (422) | Parent problems (`details.revision_id`) |
| `not_found` (404) | Generic read miss: unknown revision, path, or URL |
| `forbidden` (403) | Cross-origin mutation rejected |
| `unsupported_media_type` (415) | JSON endpoint called without `application/json` |
| `conflict` (409) | Operation conflicts with the current state |
| `internal_error` (500) | Unexpected server failure; internal details are not returned |

Validation and path errors are 400. `blob_missing` and `blob_hash_mismatch` are 422. Size-limit errors are 413. ID errors are 400.
