# Waypoint

Waypoint stores and serves the artifacts that AI-agent-driven development produces: HTML and markdown plans, screenshots, research documents, and the multi-file output of runs. These can be viewed from any machine on the tailnet, and individual items can be shared publicly when needed.

- **Writers** run on the Tailscale tailnet. They are trusted: full read/write, no auth. Agents push content to them over MCP or HTTP.
- **The reader** runs on Cloudflare Workers at `waypoint.pingstash.com`. It is read-only forever, and it serves only what a share link allows.
- **Durability** comes from the cloud: Turso (SQLite) holds metadata and Cloudflare R2 holds file contents.

> Status: **phase 1 complete** (2026-10-07). The writer runs on agent-1 at **https://waypoint.tail7aca06.ts.net** (tailnet only), backed by Turso and Cloudflare R2. Agents write through the MCP server; open `/mcp` on the writer for setup snippets. New here? Start with the [glossary](docs/glossary.md), then the [overview](docs/overview.md).

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Runtime-agnostic domain logic: IDs, public IDs, paths, manifests, errors, URLs, API types |
| `packages/render` | Markdown renditions (deterministic, self-contained HTML) |
| `packages/mcp` | Stdio MCP server for agents, bundled into a tarball the writer serves |
| `apps/writer` | The tailnet writer: API, viewer, queue, committer, sync, restore |
| `deploy/` | Docker Compose (writer + Tailscale sidecar), deploy script, operator runbook |
| `spikes/` | Phase 0 experiments and their results |

Development: `pnpm install`, `pnpm check` (format, lint, typecheck, tests), and `pnpm build`. Sync tests need `scripts/fetch-tursodb.sh` and `TURSODB_BIN`.

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
| [Public reader](docs/public-reader.md) | Phase 2: Workers reader, share links, safeguards |
| [Infrastructure](docs/infrastructure.md) | Turso, R2, Cloudflare, and Tailscale setup checklist |
| [Provisioning](docs/provisioning.md) | Step-by-step: obtaining and verifying every account, token, bucket, and DNS item for the writer and the reader |
| [Roadmap](docs/roadmap.md) | Phases, spikes, deferred work |
| [Decisions](docs/decisions.md) | Decision log with rationale |
