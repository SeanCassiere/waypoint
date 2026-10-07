# API & MCP

Agents are the main writers, so **MCP is the primary interface**. The HTTP API underneath can also be used directly with `curl`. Both exist only on writers, which means only on the tailnet. The reader has no API.

Conventions:
- Things are referenced by **ID** (`col_…`, `rev_…`).
- Responses include URLs.
- `resolve_url` turns a pasted URL back into IDs.

## Viewer routes

`/` (Recent; `?q=` searches, and an exact collection or revision ID, public ID, or Waypoint URL redirects to it; tokens `project:` `tag:` `host:` `is:shared` `is:unsynced` `is:pending` `in:trash`), `/c/<pub>/[r/<rpub>/][path]` (`?panel=history|links`, `?as=public` previews the public shell: the newest synced revision for a latest URL, or the pinned one; when that hasn't synced, the owner gets a "not public yet" explanation instead), `/c/<pub>/r/<rpub>/changes[?base=][&file=][&view=source]`, `/c/<pub>/r/<rpub>/gallery/<dir>/`, `/links`, `/trash`, `/status`, and `/mcp` (HTML for browsers; the markdown setup notes stay at `/mcp` for other clients and at `/mcp.md`).

## Request safety

Part of the [trust model](trust-model.md).

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
- `POST /api/collections/:id/share-links` returns `CreateShareLinkResult` with the token and URL once. `GET /api/collections/:id/share-links` returns `{ share_links: ShareLink[] }`; `POST /api/share-links/:id/revoke` returns `ShareLink`. List and revoke responses never contain tokens or hashes.

`ShareLink` contains `id`, `collection_id`, `revision_id` (null for a following link), `label`, `expires_at`, `revoked_at`, `created_at`, `mode` (`latest` or `pinned`), `status` (`active`, `revoked`, or `expired`), and `publicly_available`. The latter is true only while the link is active and its target revision is synced; a new link to an unsynced target becomes reachable after sync. `CreateShareLinkResult` contains `{ share_link, url, token }`. Timestamps are Unix milliseconds.

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
    "command": "npx", "args": ["--prefer-offline", "-y", "https://waypoint.tail7aca06.ts.net/mcp/waypoint-mcp.tgz"],
    "env": { "WAYPOINT_URL": "https://waypoint.tail7aca06.ts.net" } } } }
```

The writer's `/mcp` page has ready-made snippets for Claude Code and Codex.

### Updates without config changes

The configured URL never changes. The tarball is a small **launcher**. npx caches it indefinitely, so it is kept tiny and backward-compatible (`LAUNCHER_API`). On every start the launcher:
1. fetches the current server bundle from the writer, `GET /mcp/server.mjs`, using an ETag. It verifies the body against `X-Waypoint-Content-SHA256` and caches it under `~/.cache/waypoint-mcp/` (or `$XDG_CACHE_HOME`, or `$WAYPOINT_MCP_CACHE_DIR`).
2. runs the freshest valid bundle: freshly fetched, then the last cached copy if the writer is unreachable, then the copy embedded in the launcher.

A writer deploy therefore reaches every agent the next time it starts the MCP server. `waypoint_status` reports `mcp.update_available` when a running server is older than the writer's bundle. Set `WAYPOINT_MCP_PIN=embedded` to skip fetching, for debugging.

Related writer routes:
- `GET /mcp`: setup page
- `GET /mcp/waypoint-mcp.tgz`: the launcher
- `GET /mcp/server.mjs`: the server bundle
- `GET /mcp/version`: `{ server_sha256, launcher_sha256, launcher_api }`
- `GET /mcp/skill/SKILL.md`: the agent skill
- Legacy hashed URLs `/mcp/waypoint-mcp-<hash>.tgz` serve the current launcher instead of returning 404. A machine that already installed an old hashed tarball keeps it until its npx cache entry is cleared, so switch such configs to the stable URL once.

Always configure with `npx --prefer-offline`. Otherwise npx retries the tarball URL for about 70 s when the writer is down, exceeding MCP startup timeouts. The launcher does its own update check regardless.

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
| `add_revision` | `collection` (ID, public ID, or URL; `collection_id` alias), `files?`, `source_dir?`, `remove?: string[]`, `head_path?`, `message?`, `metadata?`, `mode?: "merge" \| "replace"` (default `merge`), `parent_revision_id?` (default: latest) | `WriteResult` |
| `search_collections` | `query?`, `metadata?`, `updated_after?`, `sort?: "updated" \| "created"` (default `updated`), `include_deleted?`, `limit?` (default 20, max 100), `cursor?` | `{ collections: CollectionSearchResult[], next_cursor }`. See [Finding and handing off collections](#finding-and-handing-off-collections). |
| `get_collection` | `collection` (a `col_` ID, public ID, or Waypoint URL; `collection_id` is accepted as an alias), `revision_id?`, `include_head?` | collection; the selected revision (default latest) with its manifest, URLs, and sync state. With `include_head`, also the head document's text. |
| `list_revisions` | `collection` (ID, public ID, or URL; `collection_id` alias) | revisions with display number, message, parent, and sync state |
| `wait_for_revision` | `collection` (ID, public ID, or URL; `collection_id` alias), `after_revision_id`, `timeout_seconds?` (default 30, max 50) | `{ changed, revisions: RevisionSummary[] }`: revisions newer than `after_revision_id`, returned as soon as one appears |
| `read_file` | `collection` (ID, public ID, or URL; `collection_id` alias), `path`, `revision_id?` | text content for text files; metadata and URL for images and other binaries |
| `resolve_url` | `url` | `{ collection_id, revision_id?, path? }` |
| `waypoint_status` | — | queue counts, oldest pending age, failed items, last successful bucket upload, push, and pull, and the last error |

**Notes**
- **`create_collection` also creates the first revision.** A collection without a head document has no purpose.
- **Head path.** When it's omitted, it is inferred in this order: `index.html`, `index.md`, `README.md`, the only file. If that's ambiguous, the call fails with `head_path_ambiguous`. In `add_revision`, the parent's head path is inherited unless a new one is given or the old file was removed.
- **Merge mode:** `remove` is applied first, then `files`. A path in both is an error.
- **Safe retries.** The MCP server mints `col_` and `rev_` IDs before the first attempt and reuses them on retries, so a retry after a timeout returns the original result instead of an error. Revision IDs follow the [minting rule](data-model.md#minting-and-validating-client-generated-ids). On `id_before_parent`, the server re-mints using `details.parent_timestamp` and tries again.
- **Not exposed over MCP in phase 1:** collection title and metadata edits, soft delete, undelete, and purge. They're available in the API and the viewer only, so agents can't delete things.

### Finding and handing off collections

One agent can build up a collection (research, a plan), and another agent, possibly in a new session or on another machine, can find it and act on it.

**`search_collections`** searches across the writer, committed and pending alike:
- **`query`** is free text, matched case-insensitively as a substring of the **title** and of the **metadata values** (for example `project` or `tags`). If `query` is an exact `col_` ID, a public ID, or a Waypoint URL, that collection is returned first with `match: "id"`.
- **`metadata`** is an object of top-level key → value filters. A filter matches when the collection's metadata value equals the given value, or, when the stored value is an array, contains it. Example: `{ "project": "waypoint", "tags": "research" }`.
- **`updated_after`** (ISO timestamp or Unix ms) returns only collections with a revision newer than this. Use it to look for new work since you last checked.
- Results are sorted by `updated_at` (the newest revision's time) by default, newest first. Pass `cursor` (from `next_cursor`) to page. Paging is a snapshot as of the first page: later pages show values as of that snapshot, and collections created mid-scan are omitted. Cursors expire after 10 minutes or if the writer restarts; start a new search then. Revision timestamps are stamped inside the queue transaction; client-minted IDs may be earlier, and a small interval remains between the timestamp and commit.

```ts
type CollectionSearchResult = {
  id: string; public_id: string; title: string
  metadata: Record<string, unknown>
  created_at: number; updated_at: number      // updated_at = newest revision's time
  deleted: boolean
  revision_count: number
  latest_revision: { id: string; display_number: number; message: string | null
                     created_at: number; sync_state: SyncState
                     head_path: string; file_count: number } | null
  latest_url: string
  match: "id" | "title" | "metadata" | null   // why it matched; null when no query
}
```

**`get_collection`** accepts any identifier: a `col_` ID, a public ID, or a pasted URL. With `include_head: true` it also returns the selected revision's head document text (markdown source for markdown, capped at 64 KB, text types only), so an agent can read a plan in one call. Pass `revision_id` to select an older revision; the HTTP endpoint accepts the same parameter. If the head blob is unavailable, `head.text` is `null` and `head.unavailable` is `true`. Other files are read with `read_file`.

**Watching:** `wait_for_revision` blocks until a revision newer than `after_revision_id` exists, or until the timeout, whichever comes first. It returns `changed: false` on timeout, and the agent may call it again. It sees revisions from any agent on this writer, pending ones included. Pass the latest revision ID you've already seen.

Convention: agents that publish work meant for others to pick up should set `metadata` such as `{ "project": "<repo or topic>", "tags": ["research"] }`, so it can be found by filter.

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
| `GET /api/collections` | Search. Query params: `query`, `metadata` (JSON object, URL-encoded), `updated_after`, `sort`, `limit`, `cursor`, `include_deleted`. Returns `{ collections: CollectionSearchResult[], next_cursor }`. Each result's `latest_revision` also carries `changes` and `source_host`, and `queue: { pending, failed }` counts its uncommitted revisions. `share: { active, follows_latest } \| null` summarizes live public links. |
| `GET /api/collections/:id` | Collection + latest revision summary. `:id` may be a `col_` ID or a public ID. `?include_head=1` adds the head document's text. |
| `PATCH /api/collections/:id` | Edit `title` and/or `metadata` |
| `DELETE /api/collections/:id` | Soft delete |
| `POST /api/collections/:id/undelete` | Undo soft delete |
| `POST /api/collections/:id/purge` `{ confirm: "<collection id>" }` | Queue a hard purge; returns immediately |
| `POST /api/collections/:id/share-links` `{ revision_id?, label?, expires_at? }` | Create a link. Omit `revision_id` to follow latest. The token and URL appear only in this 201 response. `expires_at` is a future Unix millisecond timestamp. Requires `WAYPOINT_PUBLIC_BASE_URL`; otherwise 409 `conflict`. |
| `GET /api/collections/:id/share-links` | List links without tokens or hashes. Each link also carries `state` (`activating` until the writer pushes it, `active`, `expired`, `revoking` until a revocation is pushed and about 60 s have passed, `revoked`), `revision_display_number` (pinned links), and `public_sees: { revision_id, display_number } \| null` (what the reader serves now: the pinned revision once synced, or the newest synced revision). |
| `POST /api/collections/:id/share-links/revoke-all` `{}` | Revoke every unrevoked link of the collection (allowed while it's in Trash). Returns `{ revoked }`. |
| `GET /api/share-links?state=active\|expired\|revoked` | Every link across collections, each with `collection: { id, public_id, title, deleted }`. `active` includes `activating`; `revoked` includes `revoking`. |
| `GET /api/share-links/:id` | `{ share_link }`, for activation polling. |
| `POST /api/share-links/revoke-all?state=active` `{}` | Revoke every active link. Returns `{ revoked }`. |
| `POST /api/share-links/:id/extend` `{ expires_at }` | Move an active, expiring link's expiry later (never earlier; 409 for revoked, expired or never-expiring links). Queues a snapshot rewrite like revocation. Repeating the current `expires_at` succeeds with no change, so retries are safe. |
| `POST /api/share-links/:id/revoke` `{}` | Idempotently revoke a link; preserves its first `revoked_at`. |
| `GET /api/collections/:id/revisions` | List revisions. Each summary includes `changes: { added, modified, removed }` against its parent (file counts; a root revision counts every file as added). With `?after=<rev_id>&wait=<seconds>` (max 50), long-polls until a newer revision exists, then returns only newer ones (without `changes`). |
| `GET /api/revisions/:id` | Revision + full manifest |
| `GET /api/revisions/:id/compare?base=<rev_id>` | Manifest compare against `base` (default: the parent). Returns `{ base, head, head_path_changed, counts: { added, removed, modified, unchanged }, files: [{ path, status, mime, base, head, text }] }`; files come head first, then by path. |
| `GET /api/revisions/:id/compare/*path?base=&mode=blocks\|lines` | One file's diff. `blocks` (Markdown) splits blank-line blocks (a fence is one block; list items and table rows are separate), runs an LCS over blocks, pairs similar delete+insert runs into `replace`, and word-diffs each pair. `lines` is a unified line diff with word highlights. Returns `{ path, status, kind: "text"\|"image"\|"binary", truncated, truncated_reason?, hunks, folded_after, lines? }`. `truncated: true` comes with `truncated_reason`: `size` (a side over 1 MB), `lines` (over 20,000 lines in `lines` mode), `blocks` (over 5,000 blocks), or `complex` (the diff ran out of its edit-length or 1 s time budget). Word highlights are skipped for blocks or lines over 16 KB and once a file's word budget is spent; more than 250,000 removed × added block pairs skip similarity pairing. Inputs over 32 KB are diffed in a worker thread that is stopped after 4 s. Results are cached in memory by content hash (LRU, about 32 MB). |
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
| `GET /api/watchers` | `{ watchers: [{ collection_id, after, since, client }] }`: agents long-polling `wait_for_revision` right now (in memory, cleared on restart). `client` comes from the `X-Waypoint-Client: <agent>/<host>` header the MCP server bundle sends. |
| `GET /api/facets` | `{ projects, tags, hosts: [{ value, count, last_written_at }] }` from collection and revision metadata; cached for 30 s. |
| `GET /api/status` | Same data as the `waypoint_status` tool, plus `cloud_last_ok_at` (last successful push or pull) and `cloud_error` (the sync loop's error while its latest attempt is failing). The viewer shows **Offline** when the latest attempt failed and the last success is more than 2 minutes old. |
| `POST /api/queue/:revision_id/retry` | Re-queue a failed revision and its failed descendants |
| `GET /api/queue/:revision_id/descendants` | `{ ids, display_numbers }`: the revisions a drop would remove (the revision itself first), so a confirmation can name them |
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
