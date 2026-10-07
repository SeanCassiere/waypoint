# Roadmap

## Phase 0: setup and spikes (before writing product code)

> **Results, 2026-10-07:** S1, S2 (Linux), S3, and S4 are done. See [`spikes/RESULTS.md`](../spikes/RESULTS.md). Still unverified:
> - Turso Sync on macOS arm64
> - a read-only Turso token with the serverless client
> - the serverless client inside the Workers runtime
> - whether R2 bills for 412 responses
> - undelete races between writers

Each spike is a short, throwaway experiment whose result goes back into these docs.

| Spike | Question | Affects |
|---|---|---|
| **S1: Turso Sync multi-writer** | With two local replicas, using `tursodb --sync-server`: <ul><li>Is last-push-wins decided per row or per column?</li><li>What happens when a pushed insert violates a `UNIQUE` index on the other side?</li><li>Do deletes (purge, undelete) propagate correctly?</li><li>Do identical inserts from two writers merge cleanly?</li><li>Do pulls apply rows in an order that satisfies foreign keys, and does the sync layer respect `PRAGMA foreign_keys`?</li><li>Purge races: writer B commits a revision for a collection that writer A has purged; B pushes a title update after the purge; A's blob GC deletes a hash that B's queue still references.</li></ul> | Tombstone design, `UNIQUE(public_id)`, FK policy, multi-writer purge |
| **S2: Turso platform check** | <ul><li>Does `@tursodatabase/sync` run under Node 24 on agent-1 (Linux x64) and on the MacBook Air (macOS arm64)?</li><li>How do bootstrap, `checkpoint()`, and a push while offline behave?</li><li>Can `@tursodatabase/serverless` with a `--read-only` token query a `--tursodb` (Sync) database? The reader depends on this.</li></ul> | Writer runtime, reader feasibility |
| **S3: R2 conditional PUT** | Using `@aws-sdk/client-s3` against R2: does `If-None-Match: *` return 412 for an existing key, and does that 412 count as a billable Class A operation?<br>**2026-10-07: the 412 is confirmed** (AWS CLI 2.37.9, `--if-none-match '*'` → `PreconditionFailed`). Whether it is billed is still unknown. | Commit procedure |
| **S4: Migration rehearsal harness** | A script that applies a migration on two replicas and checks they converge. It is reused for every future migration. | Migration discipline |

Also in phase 0:
- Provision the **dev** environment ([infrastructure.md](infrastructure.md), the P1 items).
- Set up the repo scaffold: pnpm workspace, TypeScript, lint and format, and the core/writer/reader/mcp layout.

## Phase 1: MVP (tailnet writer + cloud durability)

> **Done, 2026-10-07.** Production writer: `https://waypoint.tail7aca06.ts.net`. Verified:
> - **End to end:** the MCP server, installed via `npx` from the production writer, ran `create_collection` with a `source_dir`, then `add_revision` (merge), then `read_file`.
> - **Live:** writes against dev and prod R2 and Turso reach `synced`. Bucket garbage collection after purge works against real R2.
> - **Disaster recovery:** wiping a writer's data directory and restarting restored every collection, revision, public ID and sync state identically. Content was refetched from R2.
> - **Deploys:** automatic, via the self-hosted runner after CI on `main`, with health checks and rollback. agent-1's host Tailscale config and T3 Code are untouched.
> - **Still open:** setting up the MCP server on the MacBook Air needs a local step there (see `/mcp` on the writer). Turso Sync on macOS arm64 is still untested (only relevant if the Mac ever runs a writer).

- **Writer:**
  - Data directory: `waypoint.db`, `queue.db`, and the local blob store
  - Environment guard, startup migrations
- **Ingest:**
  - Validation, local blob store, manifest merge/replace, no-op detection
  - Self-contained markdown renditions with inlined CSS and render-time syntax highlighting. No Mermaid yet.
- **Committer:** conditional upload to R2, DR manifests and collection snapshots, row insert, the 5–10 min retry loop with a 72 h give-up, `failed` handling, pending-collection edits and deletes, a resumable single-writer purge
- **Sync states:** `pending`, `committed`, `synced`, and `failed`, exposed in every `WriteResult` and on the status page
- **Turso Sync:** push, pull, and checkpoint timers
- **HTTP API:** the complete phase-1 surface in [api-and-mcp.md](api-and-mcp.md), including multipart
- **MCP server:** stdio, `npx`-runnable, with all phase-1 tools
- **Viewer:**
  - Collection list, collection view (file sidebar, revision picker with `#N` and fork display, iframe content)
  - Raw routes, Trash view
  - Status page: queue, failed items, retry and drop
- **Restore:** bootstrapping a fresh writer from the cloud, `waypoint-writer restore --from-bucket`, and `--merge`, all **exercised in a test**
- **Prod environment provisioned;** writer running on agent-1 as a service (systemd)
- **MCP server configured** on agent-1 and the MacBook Air

**Done when:** an agent on the MacBook Air can create a collection and add revisions over MCP, the URL opens on any tailnet device, and wiping agent-1's data directory followed by a restart loses nothing that had reached `synced`. Anything that was only `committed` is recovered with `restore --merge`.

## Phase 2: public reader

- The `share_links` table, with share and revoke in the writer's API and viewer. The viewer's share button creates a following link from "latest" and a pinned link from a pinned revision.
- The Worker reader on `waypoint.pingstash.com`, with all safeguards in [public-reader.md](public-reader.md)
- Access events written to Analytics Engine
- The prod Worker, bindings, and custom domain provisioned

## Later (unscheduled)

- Bulk "retry all failed" for the queue
- Mermaid diagrams in renditions, as a versioned script under `/assets/`
- Multi-writer-safe purge: purge markers that survive sync, plus a grace period before blob GC. Required before a second writer goes live.
- A CLI, a thin wrapper over the HTTP API, if it turns out to be useful
- Grants beyond share links: passwords and audiences
- Comments
- Single-file redaction
- Search
- Pruning the local blob cache
- Owner-facing collection edits beyond the current viewer
- Multiple writers in practice: a second writer machine, or Kubernetes

## Open questions

- **Renderer details:** which markdown library and highlighter, and the default styling for rendered markdown.
- **Viewer shell/iframe URL syncing:** confirm that same-origin iframe navigation tracking works smoothly with the browser's back and forward buttons.
