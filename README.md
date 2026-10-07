# Waypoint

Waypoint stores and serves the artifacts that AI-agent-driven development produces: HTML and markdown plans, screenshots, research documents, and the multi-file output of runs. These can be viewed from any machine on the tailnet, and individual items can be shared publicly when needed.

- **Writers** run on the Tailscale tailnet. They are trusted: full read/write, no auth. Agents push content to them over MCP or HTTP.
- **The reader** runs on Cloudflare Workers at `waypoint.pingstash.com`. It is read-only forever, and it serves only what a share link allows.
- **Durability** comes from the cloud: Turso (SQLite) holds metadata and Cloudflare R2 holds file contents.

> Status: **design phase**. No code yet. Start with the [glossary](docs/glossary.md), then the [overview](docs/overview.md).

## Docs

| Doc | What it covers |
|---|---|
| [Glossary](docs/glossary.md) | What a collection, revision, blob, writer, etc. are. Read this first. |
| [Overview](docs/overview.md) | Goals, non-goals, trust model, core principles |
| [Architecture](docs/architecture.md) | Components, runtimes, how data flows |
| [Data model](docs/data-model.md) | Schema, IDs, invariants, migrations |
| [Write path & sync](docs/write-path-and-sync.md) | Ingest, local queue, R2 upload, Turso Sync, retries, restore |
| [API & MCP](docs/api-and-mcp.md) | HTTP API and MCP tools for agents |
| [Public reader](docs/public-reader.md) | Phase 2: Workers reader, share links, safeguards |
| [Infrastructure](docs/infrastructure.md) | Turso, R2, Cloudflare, and Tailscale setup checklist |
| [Roadmap](docs/roadmap.md) | Phases, spikes, deferred work |
| [Decisions](docs/decisions.md) | Decision log with rationale |
