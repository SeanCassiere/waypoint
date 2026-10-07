# Turso Sync notes (phase 0 findings)

Before any product code, four throwaway spikes checked how Turso Sync, the Turso clients and R2 actually behave. The spike code is gone; these are the findings that still shape the design. Other docs and [decisions.md](decisions.md) cite them as S1–S4.

Versions tested (2026-10-07, Linux x64, Node 24): `@tursodatabase/sync` and `@tursodatabase/database` 0.8.2, `@tursodatabase/serverless` 1.4.1, `tursodb` 0.8.2. Re-check anything below after upgrading these packages.

| Spike | Question |
|---|---|
| **S1** | Multi-writer sync semantics: two replicas against a local `tursodb --sync-server` |
| **S2** | Platform: does the sync client run on Node 24, against the dev cloud DB, alongside a local-only DB? Does the serverless client read a Sync DB? |
| **S3** | R2 conditional PUT (`If-None-Match: *`) |
| **S4** | Rehearsing an additive migration across two replicas |

## Sync semantics (S1)

- **Last-push-wins is per column, not per row.** Two writers updating *different* columns of the same row both survive. For the same column, the last push wins.
- **A delete beat a concurrent update** in the order tested (delete pushed first, then the update). The opposite order wasn't tested.
- **`INSERT OR IGNORE` is not a cross-writer first-wins guard.** Two writers inserting the same primary key with different values: the later push wins everywhere. Identical rows converge cleanly.
- **A `UNIQUE` violation fails the whole push** (`UNIQUE constraint failed`, `BATCH_STEP_ERROR`). A following `pull()` replaces the local conflicting row with the remote one, and a retried push then succeeds. So a constraint failure is a real durability event and must be surfaced (D35), never silently retried.
- **Pulls bypass foreign-key enforcement.** With `PRAGMA foreign_keys=ON` reporting `1`, a pull still applied a child row before its parent existed. Hence FKs are off on `waypoint.db` and the committer enforces invariants (D33).
- **Purge races leave orphans.** Writer A deletes a parent and pushes; writer B, holding an unpushed child, pulls and then pushes it. The cloud ends with the child and no parent. This is why purge is single-writer until purge markers and a blob-GC grace period exist.
- **Offline writes are safe.** With the server down, local writes succeed and `push()` rejects with a fetch error. After reconnecting, the same `push()` succeeds and other replicas pull the rows.
- **`checkpoint()` after a successful push** empties the WAL (53 KB to 0 in the test), and sync keeps working afterwards.
- **`bootstrapIfEmpty: false` is ignored** in 0.8.2: the JS wrapper never passes it to the engine, so a new replica always bootstraps from the remote. A writer with an empty data directory therefore needs the cloud on first start.

## Clients and platform (S2)

- **Node 24 on Linux x64** installs and runs the native sync package with pnpm 11, against both a local sync server and the dev cloud DB. Turso Sync on macOS arm64 is still untested; it matters only if the Mac ever runs a writer.
- **`queue.db` uses `@tursodatabase/database`**, the same engine without sync, in its own file and connection in the same process as the synced `waypoint.db` (D34). `node:sqlite` also worked and is the fallback.
- **The serverless client reads a Sync DB.** `@tursodatabase/serverless` accepts the `turso://` URL directly (it normalizes to HTTPS) or an explicit `https://` URL. The reader depends on this; read-only tokens and the Workers runtime were verified later, in phase 2.
- **API shape** (0.8.2): `connect({ path, url, authToken })`, `await db.prepare(sql)`, `push()`, `pull()` (returns whether anything changed), `checkpoint()`, `close()`.

## R2 conditional PUT (S3)

`PutObject` with `If-None-Match: *` on an existing key returns **412 `PreconditionFailed`**, so the committer can upload blobs without overwriting. Whether R2 bills a 412 as a Class A operation is unknown.

## Migration rehearsal (S4)

An additive migration (guarded `ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, recorded in `schema_migrations`) applied on replica A, pushed, pulled by replica B, and re-run on both, converged: identical schema, one migration row, and data written by each side under the new schema. This validates **serialized** rollout (one writer migrates first). Simultaneous DDL from two writers was not tested. `tests/sync.test.ts` now repeats the two-replica check for the real migration set; see [data-model.md](data-model.md#migrations).

## Still unverified

- Turso Sync on macOS arm64
- Whether R2 bills 412 responses
- Undelete races between writers (tombstone delete vs. a concurrent re-delete)
- A delete racing an update in the other push order
