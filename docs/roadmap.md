# Roadmap

What's done, what's next, and what's deliberately deferred. Why things are the way they are:
[decisions.md](decisions.md).

## Done

### Phase 0: setup and spikes (2026-10-07)

Four throwaway spikes (S1–S4) checked Turso Sync, the Turso clients and R2 before any product code was written. The spike code has since been removed. Findings, in short (details in [turso-sync-notes.md](turso-sync-notes.md)):
- **Turso Sync merges per column**, last push wins; a `UNIQUE` violation fails the whole push and a pull replaces the local row (so constraint failures are surfaced, D35).
- **Pulls bypass foreign keys**, so FKs are off on `waypoint.db` and the committer enforces invariants (D33). A purge can race an unpushed child row, so purge stays single-writer.
- **Offline pushes fail cleanly** and succeed later; `checkpoint()` after a push keeps the WAL bounded; `bootstrapIfEmpty: false` is ignored in 0.8.2, so a first start needs the cloud.
- **`queue.db` uses `@tursodatabase/database`** alongside the sync DB (D34); the serverless client reads a Sync DB and accepts `turso://` URLs.
- **R2 conditional PUT** (`If-None-Match: *`) returns 412 for an existing key.
- **Additive migrations** converge across two replicas when rolled out one writer at a time.

### Phase 1: MVP, the writer with cloud durability (2026-10-07)

- **Writer:** data directory (`waypoint.db`, `queue.db`, the local blob store), environment guard, startup migrations.
- **Ingest:** validation, local blob store, manifest merge/replace, no-op detection; self-contained markdown renditions with inlined CSS and render-time syntax highlighting.
- **Committer:** conditional upload to the bucket, DR manifests and collection snapshots, row insert, the 5–10 min retry loop with a 72 h give-up, `failed` handling, pending-collection edits and deletes, a resumable single-writer purge.
- **Sync states** `pending`, `committed`, `synced` and `failed`, in every `WriteResult` and on the status page; Turso Sync push, pull and checkpoint timers.
- **HTTP API** ([api-and-mcp.md](api-and-mcp.md)), including multipart, and the **MCP server** (stdio, `npx`-runnable).
- **Viewer:** collection list and view, revision picker with `#N` and fork display, raw routes, Trash, Status (queue, failed items, retry and drop).
- **Restore:** bootstrapping a fresh writer from the cloud, `waypoint-writer restore --from-bucket`, and `--merge`, all exercised in tests.

Verified on a production instance: an MCP client installed with `npx` from the writer created and revised collections from another machine; writes against real Turso and R2 reached `synced`; wiping the writer's data directory and restarting restored every collection, revision, public ID and sync state.

### Phase 2: public reader and Folio (2026-10-08)

- **Share links:** the `share_links` table; create, list, extend and revoke (single and bulk) in the writer API and viewer; following vs. pinned links; expiry; purge revokes immediately; token hashes in collection snapshots, so restore keeps links valid.
- **The reader:** a Cloudflare Worker with every safeguard in [public-reader.md](public-reader.md): deny by default with one uniform 404, per-revision raw capabilities, sandboxed content, hash-only CSP, rate limiting on denials, and access events in Analytics Engine. An adversarial review (enumeration, capability tampering, cross-collection and pinned-revision scope, token leakage, CSP and sandbox escapes) is ported into `tests/reader-probe.test.ts`, `tests/reader-security.test.ts` and the Chromium check `pnpm test:browser:reader`; a 2,000-file shell stays under the Workers CPU budget.
- **Folio:** the redesigned writer viewer (Recent, collection shell, Changes, Gallery, Links, Trash, Status, Connect an agent), the public shell shared through `packages/ui`, and a public preview (`?as=public`) on the writer. Renditions v2 (`RENDERER_VERSION` 2), with `waypoint-writer rerender` for existing markdown.

### Self-hostable and open source

- **Turborepo** (D52) and **tsdown** (D53): cached task graph, signed remote cache in CI, per-package tests from source, a pruned Docker build.
- **Runtime config for any deployment** (D54): any bucket name (environment marker), any S3-compatible store, local-only mode (`WAYPOINT_SYNC=off`), version and commit on `/healthz` and `/status`.
- **One deploy path** (D55): `deploy/upgrade.sh` and an `instance.env` install, upgrade and roll back any instance (local-only, Tailscale overlay, cloud sync, reader targets; [self-hosting.md](self-hosting.md)). CI runs it end to end, with a rollback hop. PR previews were dropped, reversing D49.
- **Releases** (D56): release-please, a multi-arch writer image on GHCR and a deploy bundle, both with build provenance attestations that `upgrade.sh` verifies; optional automatic deploys through a private ops repository ([releasing.md](releasing.md)).
- MIT license, contributor docs, Dependabot, and a CI check that no tracked file names a particular instance.

## Next

- **Pluggable storage:** `WAYPOINT_DB=local|turso` and `WAYPOINT_BLOBS=local|s3`, so cloud metadata and cloud blobs can be chosen independently (for example a local DB with S3 blobs), and a migration from local-only to synced.
- **macOS:** the Turso Sync native module and the sync test server (`tursodb`) on macOS arm64, so a writer and the sync tests run on a Mac.
- **Writer authentication** as an option, for deployments where reaching the writer's network shouldn't be enough (see the tailnet zone in [trust-model.md](trust-model.md)).
- **Tailscale Services** for the writer, instead of a sidecar node per service.

## Deferred (unscheduled)

- **Grants beyond share links:** password-protected links and audience grants (see [public-reader.md](public-reader.md#later))
- **Comments** from share viewers (the first non-read public operation; needs its own design)
- **Multi-writer-safe purge:** purge markers that survive sync, plus a grace period before blob GC. Required before a second writer goes live.
- **Multiple writers in practice:** a second writer machine, or Kubernetes
- Bulk "retry all failed" for the queue
- A CLI, a thin wrapper over the HTTP API, if it turns out to be useful
- Mermaid diagrams in renditions, as a versioned script under `/assets/`
- Single-file redaction
- Pruning the local blob cache
- Owner-facing collection edits beyond the current viewer

## Open questions

- Whether R2 bills a 412 from a conditional PUT as a Class A operation.
- Turso Sync on macOS arm64.
- Undelete races between two writers (untested; see [turso-sync-notes.md](turso-sync-notes.md#still-unverified)).
