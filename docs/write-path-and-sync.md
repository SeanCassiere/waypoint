# Write path & sync

## Overview

```
ingest (request time)                 commit (committer, retried)               sync (timers)
─────────────────────                 ───────────────────────────               ─────────────
validate → store blobs locally   ──▶  upload blobs + renditions to bucket  ──▶  push() to cloud DB
render renditions                     write DR manifest (+ snapshot)            pull() from cloud DB
record pending revision in queue      insert rows into waypoint.db              checkpoint()
wake committer, wait ≤ 5 s            clear queue rows
return result (viewable now)
```

Ingest never depends on the internet. It wakes the committer and waits up to about 5 seconds. In the common case the agent gets back `committed`; if the commit doesn't finish in time, it gets `pending`.

## Writer data directory

`WAYPOINT_DATA_DIR` (default `~/.local/share/waypoint/<environment>/`):

```
waypoint.db               Turso Sync local replica (synced)
queue.db                  queued work (local only)
blobs/sha256/ab/<hex>     local blob store (also the read cache)
```

Exactly one writer process owns a data directory. Within that process:
- **A single committer** processes the queue, so there is no double-uploading or double-committing.
- **Mutations are serialized per collection** with an in-process lock. This covers ingest, edits, delete and undelete, purge, queue retry and drop, and the committer's collection-commit step. Two agents calling `add_revision` with the default parent at the same moment get chained revisions instead of a fork.
  - Ingest releases the lock after the queue transaction (step 8), before it waits for the commit (step 9), so a slow commit never serializes other writes.
- **Each database connection is serialized.** A transaction holds the connection exclusively, so statements from other requests can never interleave with, or be rolled back by, someone else's transaction.

## Ingest

1. **Validate** the request: paths, limits, and IDs ([data-model.md](data-model.md#minting-and-validating-client-generated-ids)).
   - The collection must exist, either committed or pending. It must not be purged.
   - A path listed in both `files` and `remove` is a `validation_failed` error.
2. **Resolve the parent** (`add_revision` only).
   - If `parent_revision_id` is given, use it. It must exist and must not be failed.
   - Otherwise, if the last successful pull is more than 30 s old, try a pull with a 2 s timeout. A failed pull isn't an error. Then use the [latest revision](data-model.md#derived-values-never-stored).
   - If the newest revision overall is `failed`, return `parent_failed` with that revision's ID instead of building on it.
3. **Mint a revision ID** if the client didn't send one, using the minting rule.
4. **Store blobs.**
   - Hash each file (sha256) and write it to the local blob store if it isn't already there.
   - Verify each hash against the client's claim.
   - Add a `pending_blobs` row for any hash that has no `blobs` row yet.
5. **Build the manifest.**
   - In merge mode, start from the parent's manifest. The parent may itself still be pending. In replace mode, start empty.
   - Apply `remove`, then `files`.
   - Resolve the head path: the explicit one, or the parent's if it still exists, or the inferred one. Otherwise return `head_path_missing` or `head_path_ambiguous`.
6. **Skip no-op writes.** If the manifest and head path equal the parent's, return the parent with `unchanged: true` and create nothing.
7. **Render.** Every markdown file gets a rendition at the current renderer version, reused if one already exists. Rendition outputs are ordinary blobs: they go into the local store and get `pending_blobs` rows.
8. **Queue.** In one `queue.db` transaction, insert:
   - the `pending_revisions` row
   - its `pending_renditions` rows
   - the `pending_collections` row, if the collection is new
9. **Wake the committer** and wait up to about 5 s for this revision to commit.
10. **Respond** with a `WriteResult` ([api-and-mcp.md](api-and-mcp.md#writeresult)).

The URLs work on the tailnet as soon as step 8 completes. They never change, because IDs and public IDs are fixed at ingest.

## Queue

`queue.db` is local only:

```sql
pending_collections (id, public_id, title, metadata, created_at, deleted_at NULL)
pending_revisions   (id, public_id, collection_id, parent_revision_id, head_path, message,
                     metadata, manifest_json, created_at,
                     state            TEXT,     -- 'pending' | 'failed'
                     attempts         INTEGER,
                     first_attempt_at INTEGER,
                     next_attempt_at  INTEGER,
                     last_error       TEXT,
                     error_kind       TEXT)     -- 'transient' | 'permanent'
pending_blobs       (hash PRIMARY KEY, size)                     -- incl. rendition outputs
pending_renditions  (source_hash, renderer, renderer_version, output_hash, output_mime, created_at)
pending_snapshots   (collection_id PRIMARY KEY, requested_at)    -- collections/<id>.json rewrites
pending_r2_deletes  (key PRIMARY KEY, requested_at)              -- bucket objects to delete
pending_purges      (collection_id PRIMARY KEY, requested_at, step)
unpushed            (revision_id PRIMARY KEY, committed_at)      -- committed, not yet pushed
```

### Pending collections

A collection that has been created but not committed exists only in `pending_collections`. Operations on it work entirely locally:
- **Edit (`PATCH`)** updates the `pending_collections` row.
- **Soft delete** sets `pending_collections.deleted_at`. It becomes a tombstone row when the collection commits.
- **Undelete** clears `deleted_at`.
- **Purge** drops the collection's queue rows and any local blobs that nothing else references. No cloud access is needed.

### Commit procedure

The committer processes pending revisions in ID order (oldest first). For each one:

1. **Check the parent.**
   - If the parent is still pending, skip this revision for now.
   - If the parent has failed, mark this revision failed with `error_kind = 'permanent'` and reason `parent_failed`.
2. **Check the collection.** If it is neither in `waypoint.db` nor in `pending_collections` (it was purged), mark the revision failed (permanent, `collection_purged`).
3. **Upload blobs.** Upload every blob in `pending_blobs` that this revision or its renditions reference. Key: `blobs/sha256/<hex>`. Use `PutObject` with `If-None-Match: *`. A `412` means the object already exists and counts as success. Retry a `429` once.
4. **Write to the bucket.**
   - The DR manifest `manifests/<revision id>.json`: the revision row, its files, and its renditions.
   - If the collection is still pending, its snapshot `collections/<collection id>.json`.
   **Re-verification under the lock.** After steps 3–4, the committer takes the collection lock and re-checks four things: the revision is still pending, its parent is committed, its collection exists, and no purge is queued for it. If anything changed, it aborts this attempt. The `blobs` rows inserted are exactly the hashes uploaded in this attempt, and after the transaction every referenced hash must have a `blobs` row.
5. **Insert rows** into `waypoint.db` in one transaction, using `INSERT OR IGNORE`:
   - if the collection is pending, the `collections` row, plus a tombstone if `deleted_at` is set
   - `blobs`
   - `renditions`
   - `revisions`
   - `revision_files`
6. **Clean up the queue** in one `queue.db` transaction:
   - delete the `pending_revisions` row
   - delete the `pending_collections` row, if this was the collection's commit
   - delete the `pending_blobs` and `pending_renditions` rows that now have rows in `waypoint.db`
   - insert an `unpushed` row

   If the process dies between steps 5 and 6, the next pass finds the revision already in `waypoint.db` and only performs step 6.
7. **Trigger a push.**

### Other queued work

These are idempotent and **never give up**:
- **Collection snapshots** (`pending_snapshots`): written whenever the title, metadata, or tombstone of a *committed* collection changes. Those changes themselves are written directly to `waypoint.db`, because there is nothing to upload first. The `pending_snapshots` row is written **before** the `waypoint.db` change, so a crash can only cause a harmless extra snapshot, never a lost one. Deleting an already-deleted collection keeps the original `deleted_at`.
- **Bucket deletes** (`pending_r2_deletes`). For example, dropping a revision from the queue deletes its DR manifest, if one was already written. That way a restore from the bucket can't bring the revision back.
- **Purges** (`pending_purges`); see [Purge](#purge).

### Retry policy

- **Committer schedule.** It runs right away when ingest wakes it. After that, each pending item is retried after a random delay of 5–10 minutes, over and over.
- **Transient errors** (network failures, timeouts, 5xx, 429, R2's `RequestTimeout` and `ConditionalRequestConflict`, and local `EMFILE`/`EBUSY` and similar) are retried until 72 hours have passed since the first attempt. The limit is set by `WAYPOINT_QUEUE_GIVE_UP_HOURS`, default 72. After that the revision becomes `failed`.
- **Permanent errors** mark the revision `failed` immediately. Examples: a blob missing from the local store, a purged collection, a failed parent, a validation error.
- **Failed revisions** stay in `queue.db`, and their blobs stay on disk. You can still view them on the tailnet, and they appear in the revision picker marked as failed and in `/api/status`.
  - **Retrying a failed revision** re-queues it along with its failed descendants.
  - **Dropping a failed revision** removes it and its descendants, and queues deletion of any DR manifests already written.
  - A bulk "retry all failed" operation is planned for later.
- Snapshots, bucket deletes, and purges follow the same 5–10 minute schedule but are never marked failed. Each has its own `next_attempt_at`, `attempts`, and `last_error` (an additive `queue.db` migration). Their errors appear in `/api/status`.
- **An account-level 403 from the bucket** (bad or revoked credentials) pauses the committer and is reported in status. It doesn't fail every queued revision.

### Sync state of a revision

| State | Condition |
|---|---|
| `pending` | In `pending_revisions` with `state = 'pending'` |
| `failed` | In `pending_revisions` with `state = 'failed'` |
| `committed` | In `waypoint.db`, and either in `unpushed` or still in `pending_revisions` (the crash window between commit steps 5 and 6) |
| `synced` | In `waypoint.db` and not in `unpushed`. This includes every revision pulled from other writers. |

An `unpushed` row is deleted after a push succeeds, provided that push *started* after the row's `committed_at`.

## Purge

Purge is a queued operation (`pending_purges`) that resumes after crashes or outages, in this order:

1. Delete the collection's DR manifests and snapshot from the bucket.
2. Delete its `revision_files`, `revisions`, `collection_tombstones`, and `collections` rows from `waypoint.db`, and push.
3. **Blob garbage collection.** Find blobs and rendition outputs that no remaining `revision_files` or `renditions` row references. Exclude any hash still referenced by this writer's queue. Delete the rest from the bucket, the local store, and the `blobs`/`renditions` rows. Then push.

GC also skips:
- hashes held by in-flight ingests
- rendition outputs whose source hash is still referenced by a queued revision
- local blob files modified in the last 15 minutes

GC runs under a writer-wide barrier that ingest also takes, as a shared lock. Purge also **drops the collection's queued revisions** and deletes their local blobs that nothing else references, so a leaked secret doesn't linger in the queue. Phase 1 assumes a single writer; see [data-model.md](data-model.md#deletion).

## Turso Sync

- `waypoint.db` is opened with `@tursodatabase/sync` (`connect({ path, url, authToken })`) against the environment's cloud DB. `queue.db` is opened with `@tursodatabase/database`, the same engine without sync, as a separate file and connection in the same process (confirmed in spike S2).
- **First start needs the cloud.** In 0.8.2, `bootstrapIfEmpty: false` is ignored (S1), so a writer with an empty data directory must reach the cloud DB to start. After that it works offline.
- **Push:** after every commit, and on a 60 s timer that also retries failed pushes. Turso Sync doesn't retry on its own. Committed data stays durable locally and recoverable from the bucket, so a failed push is harmless. An offline push rejects cleanly, and local writes made during the outage are pushed later (S1).
- **Push failure caused by a constraint** (for example a `UNIQUE` violation; S1 saw `BATCH_STEP_ERROR`) blocks the whole push. The writer pulls and then retries the push. If it fails again with the same constraint error, the writer reports it in `/api/status` and keeps the affected revisions out of `synced`. A pull can replace the conflicting local row with the remote one, so this must never be ignored. With derived public IDs it should only happen on a true hash collision.
- **Pull:** on a 30 s timer, and opportunistically during ingest (see step 2).
- **Push coalescing.** A push requested while another is in flight runs again once it finishes, and the request resolves only after a push that *started after the request* has completed. Purge step 2 relies on this.
- **Neither push nor pull holds the application's DB statement mutex during network I/O.** "Database is locked/busy" errors from the engine during a pull are retried locally with a short backoff; they are never treated as transient commit failures.
- **Timeouts:** bucket requests have connect and request timeouts. Push and pull have timeouts too. A hung request never stalls the committer.
- **Checkpoint:** after each successful push, to keep the local WAL bounded.
- **Conflicts** resolve as last-push-wins, observed in spike S1:
  - Updates to *different columns* of the same row **merge**. Updates to the same column: the last push wins.
  - A delete beat a concurrent update; only one push order was tested.
  - For the same primary key with different values (even with `INSERT OR IGNORE`), the last push wins. Identical rows converge cleanly.
  - So insert-only rows with globally unique keys don't conflict. Identical rows from two writers (the same blob, or the same derived public ID) resolve harmlessly. The only real conflicts are edits to a collection's title or metadata, where the last push wins per column. That is acceptable here.

### Outage matrix

| Situation | Effect |
|---|---|
| Bucket down, cloud DB up | Revisions wait as `pending`. They are viewable locally. |
| Bucket up, cloud DB down | Revisions become `committed` and wait to be pushed. They are viewable locally. |
| Internet down | Both of the above. Agents can still write and view on the tailnet. |
| Writer down | Nothing can be written. There is deliberately no direct-to-cloud fallback. |
| Writer's disk lost | `pending` and `failed` work is lost. `committed` revisions are recoverable from the bucket (`restore --merge`). `synced` revisions are unaffected. |

## Multiple writers

- Each writer has its own data directory, queue, and local replica. They converge through the cloud DB.
- A writer's queue is invisible to the other writers. Its revisions appear elsewhere only once they are `synced` and the other writer has pulled.
- Two writers revising the same parent produce a [fork](glossary.md#content), not a conflict.
- Phase 1 runs a single writer. Purge is the only operation that isn't multi-writer-safe yet.

## Environment guard

On startup and before every push, the writer compares three values: `WAYPOINT_ENV`, `meta.environment` in the local `waypoint.db`, and `meta.environment` in the cloud DB. If any differ, it refuses to sync. When it bootstraps an empty cloud DB for the first time, the writer writes `meta.environment` itself.
- The guard runs **before migrations**.
- **Only a first start needs the cloud.** If the local `meta.environment` already exists and matches `WAYPOINT_ENV`, an unreachable cloud at startup isn't fatal. The writer starts with sync marked *unverified*, then performs the remote check before its first push. A first start, with no local `meta`, still requires the cloud.

## Restore / disaster recovery

`waypoint-writer restore` is an operator subcommand of the writer. It isn't the deferred agent-facing CLI.

| Lost | Recovery |
|---|---|
| A writer machine | Start a writer on any tailnet machine with an empty data directory. Turso Sync bootstraps `waypoint.db` from the cloud. The local blob store refills lazily from the bucket as files are read. |
| Committed but unpushed rows (disk lost during a cloud DB outage) | `waypoint-writer restore --merge` replays DR manifests and snapshots from the bucket that are missing from the cloud DB. |
| The cloud DB | Create a new Turso Sync DB and run `waypoint-writer restore --from-bucket`. It replays every `collections/*.json` and `manifests/*.json`. A manifest is ignored if its collection snapshot is missing or its parent's manifest is missing (this applies down the chain). Restore is the only time Waypoint lists the bucket. |
| The bucket | Not recoverable. This is the durability floor. If that ever matters, add R2 replication or a second bucket. |

Phase 1 builds restore and **tests** it; it doesn't stay theoretical.
