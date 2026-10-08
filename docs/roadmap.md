# Roadmap

## Phase 0: setup and spikes

> **Done, 2026-10-07.** Four throwaway spikes (S1–S4) checked Turso Sync, the Turso clients and R2 before any product code was written; the repo scaffold and the dev environment were set up. The spike code has since been removed.

Phase 0 findings, in short (details in [turso-sync-notes.md](turso-sync-notes.md)):
- **Turso Sync merges per column**, last push wins; a `UNIQUE` violation fails the whole push and a pull replaces the local row (so constraint failures are surfaced, D35).
- **Pulls bypass foreign keys**, so FKs are off on `waypoint.db` and the committer enforces invariants (D33). A purge can race an unpushed child row, so purge stays single-writer.
- **Offline pushes fail cleanly** and succeed later; `checkpoint()` after a push keeps the WAL bounded; `bootstrapIfEmpty: false` is ignored in 0.8.2, so a first start needs the cloud.
- **`queue.db` uses `@tursodatabase/database`** alongside the sync DB (D34); the serverless client reads a Sync DB and accepts `turso://` URLs.
- **R2 conditional PUT** (`If-None-Match: *`) returns 412 for an existing key.
- **Additive migrations** converge across two replicas when rolled out one writer at a time.

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
- **Prod environment provisioned;** writer running on agent-1 in Docker Compose behind a Tailscale sidecar
- **MCP server configured** on agent-1 and the MacBook Air

**Done when:** an agent on the MacBook Air can create a collection and add revisions over MCP, the URL opens on any tailnet device, and wiping agent-1's data directory followed by a restart loses nothing that had reached `synced`. Anything that was only `committed` is recovered with `restore --merge`.

## Phase 2: public reader and Folio

> **Done, 2026-10-08.** PRs #17 (share links and the reader), #19 (Folio UI, rendition v2), #20 (sharp override), #21 (CI-tolerant CPU budget). Verified:
> - **Live:** the reader Workers serve `https://waypoint.pingstash.com` (prod) and `https://waypoint-dev.pingstash.com` (dev), each on its own custom domain with read-only Turso and R2 credentials. Share links were exercised end to end on the dev reader, and `/healthz/deep` reaches Turso and R2 on both.
> - **Deploys:** one pipeline after CI on `main`: the writer, then the dev reader, then the prod reader. Each reader deploy smoke-tests the live hostname (health, deep health, a uniform 404, the root page, `robots.txt`) and rolls back on failure.
> - **Security:** an adversarial review of the reader (enumeration, capability tampering, cross-collection and pinned-revision scope, token leakage, CSP and sandbox escapes) was ported into `tests/reader-probe.test.ts`, `tests/reader-security.test.ts` and the Chromium check `pnpm test:browser:reader`. A 2,000-file shell stays under the Workers CPU budget (`apps/reader/tests/reader-cpu.test.ts`).
> - **Renditions v2:** `RENDERER_VERSION` is 2 (the Folio reading template with the frame location reporter), and existing markdown on prod was re-rendered with `waypoint-writer rerender`.

- **Share links:** the `share_links` table; create, list, extend and revoke (single and bulk) in the writer API and viewer; following vs. pinned links; expiry; purge revokes immediately; token hashes in collection snapshots, so restore keeps links valid.
- **The reader:** a Cloudflare Worker with every safeguard in [public-reader.md](public-reader.md): deny by default with one uniform 404, per-revision raw capabilities, sandboxed content, hash-only CSP, rate limiting on denials, and access events in Analytics Engine.
- **Folio:** the redesigned writer viewer (Recent, collection shell, Changes, Gallery, Links, Trash, Status, Connect an agent), the public shell shared through `packages/ui`, and a public preview (`?as=public`) on the writer.
- **Provisioned:** both reader Workers, their custom domains, bindings and secrets; see [infrastructure.md](infrastructure.md).

## After phase 2

- **Parallel CI and PR previews** (#22): CI runs lint, typecheck, tests, the reader build, the writer image, the MCP smoke test and the Chromium checks as parallel jobs behind one `ci-ok` gate. Each same-repo PR gets a Worker Preview of the prod reader on `workers.dev`, behind Cloudflare Access and deleted when the PR closes (D49).
- **Turborepo** (D52): `turbo` runs build, lint, typecheck, tests and the browser checks with per-task caching, and CI jobs share a signed Vercel remote cache. Deploys and the writer image never use the cache.

## Next and deferred (unscheduled)

- **Grants beyond share links:** password-protected links and audience grants (see [public-reader.md](public-reader.md#later))
- **Comments** from share viewers (the first non-read public operation; needs its own design)
- **Multi-writer-safe purge:** purge markers that survive sync, plus a grace period before blob GC. Required before a second writer goes live.
- **Multiple writers in practice:** a second writer machine, or Kubernetes
- **Tailscale Services** for the writer, instead of a sidecar node per service
- Bulk "retry all failed" for the queue
- A CLI, a thin wrapper over the HTTP API, if it turns out to be useful
- Mermaid diagrams in renditions, as a versioned script under `/assets/`
- Single-file redaction
- Pruning the local blob cache
- Owner-facing collection edits beyond the current viewer

## Open questions

- Whether R2 bills a 412 from a conditional PUT as a Class A operation.
- Turso Sync on macOS arm64, if the MacBook Air ever runs a writer.
- Undelete races between two writers (untested; see [turso-sync-notes.md](turso-sync-notes.md#still-unverified)).
