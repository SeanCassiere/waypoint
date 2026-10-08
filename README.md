# Waypoint

Waypoint stores and serves the artifacts that AI-agent-driven development produces: HTML and markdown plans, screenshots, research documents, and the multi-file output of runs. These can be viewed from any machine on the tailnet, and individual items can be shared publicly when needed.

- **Writers** run on the Tailscale tailnet. They are trusted: full read/write, no auth. Agents push content to them over MCP or HTTP.
- **The reader** runs on Cloudflare Workers at `waypoint.pingstash.com`. It is read-only forever, and it serves only what a share link allows.
- **Durability** comes from the cloud: Turso (SQLite) holds metadata and Cloudflare R2 holds file contents.

> Status: **phase 2 complete** (2026-10-08). The writer runs on agent-1 at **https://waypoint.tail7aca06.ts.net** (tailnet only) with the Folio UI, backed by Turso and Cloudflare R2. Share links are live: the public reader serves them at **https://waypoint.pingstash.com** (prod) and **https://waypoint-dev.pingstash.com** (dev). Agents write through the MCP server; open `/mcp` on the writer for setup snippets. New here? Start with the [glossary](docs/glossary.md), then the [overview](docs/overview.md).

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Runtime-agnostic domain logic: IDs, public IDs, paths, manifests, errors, URLs, API types |
| `packages/render` | Markdown renditions (deterministic, self-contained HTML) |
| `packages/ui` | Runtime-agnostic UI shared by the writer and the reader: design tokens, escaping, the public shell |
| `packages/mcp` | Stdio MCP server for agents, bundled into a tarball the writer serves |
| `apps/writer` | The tailnet writer: API, viewer, queue, committer, sync, restore |
| `apps/reader` | The public read-only reader (Cloudflare Worker) and its Wrangler config |
| `deploy/` | `upgrade.sh` (install, upgrade, rollback), `instance.env.example`, the Compose files (writer, Tailscale overlay), the ops deploy workflow template, operator runbook. Adopters start at [docs/self-hosting.md](docs/self-hosting.md) |
| `scripts/` | Dev helpers: `fetch-tursodb.sh`, `demo-writer.ts` (seeded local writer for UI work), `live-smoke.ts` (dev-cloud smoke test), `check-core-imports.mjs`; CI's deploy checks: `install-test.sh`, `deploy-dry-run.sh`, `check-owner-strings.sh`; releases: `build-release-bundle.sh`, `release-dispatch-target.sh` (the release workflow's dispatch target check), `release-dry-run.sh` |
| `tests/` | `@waypoint/integration-tests`: cross-package tests, checks of built artifacts, and the real-Chromium browser checks. Each package's own tests are in its `tests/` |

Development needs Node 24 and pnpm 11, and no secrets: `pnpm install`, `pnpm check` (format, lint, typecheck, tests), and `pnpm build`. [Turborepo](https://turborepo.dev) runs these tasks (`turbo.json`): it builds what a task needs first and skips anything whose inputs haven't changed, so a second run is a cache hit. tsdown builds the packages; typecheck, lint and tests read workspace packages from source, so they don't wait for a build. CI also shares a signed remote cache; without its credentials (fork PRs, local machines) turbo just uses the local cache. Sync tests also need a local `tursodb`: run `scripts/fetch-tursodb.sh` (Linux x64), then `export TURSODB_BIN=$PWD/.tools/turso_cli-x86_64-unknown-linux-gnu/tursodb`. `pnpm test:browser` and `pnpm test:browser:reader` run the writer viewer and the public reader shell in Chromium. To run a writer locally, see [AGENTS.md](AGENTS.md#developing).

## Docs

| Doc | What it covers |
|---|---|
| [Glossary](docs/glossary.md) | What a collection, revision, blob, writer, etc. are. Read this first. |
| [Overview](docs/overview.md) | Goals, non-goals, core principles |
| [Trust model](docs/trust-model.md) | Who can do what: zones, credentials, share links, untrusted content, deploy pipeline, accepted risks |
| [Architecture](docs/architecture.md) | Components, runtimes, how data flows |
| [Data model](docs/data-model.md) | Schema, IDs, invariants, migrations |
| [Write path & sync](docs/write-path-and-sync.md) | Ingest, local queue, R2 upload, Turso Sync, retries, restore |
| [API & MCP](docs/api-and-mcp.md) | HTTP API and MCP tools for agents |
| [Public reader](docs/public-reader.md) | The Workers reader, share links, safeguards |
| [Configuration](docs/configuration.md) | Every writer, MCP and reader setting, with defaults; local-only mode; version reporting |
| [Self-hosting](docs/self-hosting.md) | Run your own instance: local-only, Tailscale, cloud sync, public reader; upgrading and rolling back |
| [Releasing](docs/releasing.md) | How releases are cut and published (image, bundle, attestations), settings and secrets, forks, the deploy dispatch |
| [Infrastructure](docs/infrastructure.md) | Turso, R2, Cloudflare, and Tailscale setup checklist |
| [Provisioning](docs/provisioning.md) | Step-by-step: obtaining and verifying every account, token, bucket, and DNS item for the writer and the reader |
| [Roadmap](docs/roadmap.md) | Phases, what's next, deferred work |
| [Turso Sync notes](docs/turso-sync-notes.md) | Phase 0 findings on Turso Sync, the Turso clients and R2 |
| [Decisions](docs/decisions.md) | Decision log with rationale |
