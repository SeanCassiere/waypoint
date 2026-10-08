# Waypoint

Waypoint is a self-hosted store for the artifacts AI coding agents produce: HTML and markdown
plans, research documents, screenshots, and the multi-file output of runs. Agents publish to it
over MCP (or plain HTTP) and get back a stable URL. You open that URL from any of your machines,
browse every revision, and, when you choose to, share a collection publicly with a revocable link.

It's for people who run coding agents across one or more machines and are tired of plans and
screenshots scattered across disks and chat logs: one durable place to put them, with history,
that agents can also read back to pick up each other's work.

## Features

- **Agents publish with no friction.** A local stdio MCP server (started with `npx`) reads files
  by path, uploads only what the writer doesn't have yet, and returns URLs. Tools cover creating
  collections, adding revisions (merge or replace), reading files back, searching, and waiting for
  another agent's next revision. There's an HTTP API, including multipart uploads, for everything
  else.
- **Revisions are immutable and kept forever.** Content-addressed blobs, so unchanged files cost
  nothing; a revision picker, rendered diffs between revisions, and an image gallery.
- **Markdown renders on write** into self-contained, deterministic HTML (syntax highlighting,
  GitHub alerts, contents, light and dark), so documents display instantly and offline.
- **A fast viewer** for the writer ("Folio"): recent collections with search, the document frame,
  history, changes, public links, trash, and a status page.
- **Optional cloud durability.** Metadata syncs to Turso, file contents go to Cloudflare R2 or any
  S3-compatible store; a writer can rebuild its whole data directory from them.
- **Optional public sharing.** A read-only Cloudflare Worker serves only what a share link allows:
  follow-latest or pinned links, expiry, revocation within seconds, sandboxed content, one uniform
  404 for everything else. The public side can never write.
- **One deploy path.** A published, multi-arch, provenance-attested image and a deploy bundle with
  `upgrade.sh`: install, upgrade, health-gated rollback, all from one `instance.env`.

## How it fits together

```
 agents on your machines ── MCP (stdio, local files) or HTTP
        │
        ▼
 ┌──────────── your private network (loopback, or a Tailscale tailnet) ────────────┐
 │  Writer (Docker): API, viewer, renditions, local DB, queue, blob store            │
 └───────┬───────────────────────────────────────────────────────────┬──────────────┘
         │ optional: push and pull (Turso Sync)                       │ optional: blobs (S3 API)
         ▼                                                            ▼
   Turso cloud DB (metadata)                                R2 / S3-compatible bucket
         ▲ read-only token                                            ▲ read-only key
         └──────────────┐                              ┌──────────────┘
                 ┌──────┴──────────────────────────────┴──────┐
                 │  optional: public reader (Cloudflare Worker) │ ◀── share links, public internet
                 └─────────────────────────────────────────────┘
```

The **writer** has no login: being able to reach it is the credential, so it only ever listens on
a network you trust. Start with the tier you need and add the others later
([self-hosting guide](docs/self-hosting.md)):

| Tier | What you get | What you need |
|---|---|---|
| 0. Local-only | The writer on `127.0.0.1`, for agents on the same machine | Docker |
| 1. Tailscale | The writer at `https://waypoint.<tailnet>.ts.net` for every device on your tailnet | A Tailscale account |
| 2. Cloud sync | The host is no longer the only copy | A Turso database, an R2 or S3-compatible bucket |
| 3. Public reader | Read-only share links on your own domain | Cloudflare Workers and a zone |

## Quickstart

Run a local-only writer from the published image (the writer runs as uid 1000, which must own its
data directory):

```bash
mkdir -p ~/.local/share/waypoint/local   # if your uid isn't 1000: sudo chown 1000:1000 it
docker run -d --name waypoint --restart unless-stopped \
  -p 127.0.0.1:7410:7410 \
  -e WAYPOINT_ENV=prod -e WAYPOINT_SYNC=off \
  -e WAYPOINT_HOST=0.0.0.0 -e WAYPOINT_DATA_DIR=/data \
  -v "$HOME/.local/share/waypoint/local:/data" \
  ghcr.io/seancassiere/waypoint-writer:latest
```

Open <http://127.0.0.1:7410>. Local-only mode keeps everything in that directory (back it up);
the status page says so.

**Connect an agent:** open <http://127.0.0.1:7410/mcp>. It has copy-paste setup for Claude Code
and Codex, and the commands that install the agent skill
([skills/waypoint/SKILL.md](skills/waypoint/SKILL.md)). The MCP config is the same everywhere:

```jsonc
{ "mcpServers": { "waypoint": {
    "command": "npx",
    "args": ["--prefer-offline", "-y", "http://127.0.0.1:7410/mcp/waypoint-mcp.tgz"],
    "env": { "WAYPOINT_URL": "http://127.0.0.1:7410" } } } }
```

Then ask your agent to publish its plan to Waypoint. The launcher fetches the current MCP server
from the writer on every start, so upgrading the writer upgrades every agent's next session.

For a lasting install, use the deploy bundle and `upgrade.sh` instead, which add health-gated
upgrades and rollback, verify each release's provenance, and add Tailscale, cloud sync and the
public reader when you want them: [docs/self-hosting.md](docs/self-hosting.md).

## Documentation

| Doc | What it covers |
|---|---|
| [Self-hosting](docs/self-hosting.md) | Run your own instance: local-only, Tailscale, cloud sync, public reader; upgrading and rolling back |
| [Operating an instance](deploy/README.md) | The `upgrade.sh` runbook: what a deploy does, state, rollback, logs, re-rendering |
| [Configuration](docs/configuration.md) | Every writer, MCP and reader setting, with defaults |
| [Provisioning](docs/provisioning.md) | Step by step: every account, token, bucket and DNS item for cloud sync and the public reader |
| [Infrastructure](docs/infrastructure.md) | The checklist of what a full deployment has |
| [Trust model](docs/trust-model.md) | Who can do what: zones, credentials, share links, untrusted content, the release pipeline, accepted risks |
| [Glossary](docs/glossary.md) | What a collection, revision, blob, writer, etc. are. Read this first |
| [Overview](docs/overview.md) | Goals, non-goals, core principles |
| [Architecture](docs/architecture.md) | Components, runtimes, builds, how data flows |
| [Data model](docs/data-model.md) | Schema, IDs, invariants, migrations |
| [Write path & sync](docs/write-path-and-sync.md) | Ingest, local queue, bucket upload, Turso Sync, retries, restore |
| [API & MCP](docs/api-and-mcp.md) | HTTP API and MCP tools for agents |
| [Public reader](docs/public-reader.md) | The Workers reader, share links, safeguards |
| [Releasing](docs/releasing.md) | How releases are cut and published, settings and secrets, forks, deploy dispatch |
| [Roadmap](docs/roadmap.md) | What's done and what's next |
| [Turso Sync notes](docs/turso-sync-notes.md) | Findings on Turso Sync, the Turso clients and R2 |
| [Decisions](docs/decisions.md) | Decision log with rationale |

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Runtime-agnostic domain logic: IDs, public IDs, paths, manifests, errors, URLs, API types |
| `packages/render` | Markdown renditions (deterministic, self-contained HTML) |
| `packages/ui` | Runtime-agnostic UI shared by the writer and the reader: design tokens, escaping, the public shell |
| `packages/mcp` | Stdio MCP server for agents, and the launcher tarball the writer serves |
| `apps/writer` | The writer: API, viewer, queue, committer, sync, restore; its Dockerfile |
| `apps/reader` | The public read-only reader (Cloudflare Worker) and its Wrangler config template |
| `deploy/` | `upgrade.sh` (install, upgrade, rollback), `instance.env.example`, the Compose files (writer, Tailscale overlay), the ops deploy workflow template, the operator runbook |
| `skills/waypoint` | The agent skill: when and how agents should use Waypoint (also served at `/mcp/skill/SKILL.md`) |
| `scripts/` | Dev helpers (`fetch-tursodb.sh`, `demo-writer.ts`, `live-smoke.ts`); CI checks (`check-core-imports.mjs`, `check-owner-strings.sh`, `check-hosted-runners.sh`, `install-test.sh`, `deploy-dry-run.sh`); third-party notices (`third-party-notices.ts`: `pnpm notices`, `pnpm notices:check`; `inlined-packages.json`, the packages each bundle inlines, checked by the MCP build and `tests/inlined-packages.test.ts`; `license-texts/`); release tooling (`build-release-bundle.sh`, `release-dispatch-target.sh`, `release-dry-run.sh`) |
| `tests/` | `@waypoint/integration-tests`: cross-package tests, checks of built artifacts, and the real-Chromium browser checks. Each package's own tests are in its `tests/` |

## Contributing

Development needs Node 24 and pnpm 11, and no secrets: `pnpm install`, `pnpm check` (format,
lint, typecheck, tests) and `pnpm build`. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup,
the rules and how PRs and releases work; [AGENTS.md](AGENTS.md) is the detailed guide to the
codebase. Please report security issues privately: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Bundled third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
