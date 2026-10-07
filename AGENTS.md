# Agent guide to Waypoint

Read this before changing or operating Waypoint. Background on what Waypoint is: [README.md](README.md) and [docs/glossary.md](docs/glossary.md).

## Where it runs

|                   |                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production writer | `https://waypoint.tail7aca06.ts.net`, reachable **only on the Tailscale tailnet**                                                                                                                                                                                           |
| Public reader     | Cloudflare Worker `waypoint-reader` at `https://waypoint.pingstash.com` (public; serves only what share links allow). Deployed from agent-1 after the writer.                                                                                                               |
| Dev reader        | Cloudflare Worker `waypoint-reader-dev` at `https://waypoint-dev.pingstash.com` (dev DB and bucket)                                                                                                                                                                         |
| PR previews       | `https://pr-<number>-waypoint-reader.seancassiere.workers.dev`, Worker Previews of `waypoint-reader` with production data read-only. `*-waypoint-reader.seancassiere.workers.dev` and `waypoint-reader.seancassiere.workers.dev` are behind Cloudflare Access (owner only). |
| Host              | `agent-1`, Docker Compose project `waypoint` ([deploy/compose.yaml](deploy/compose.yaml))                                                                                                                                                                                   |
| Containers        | `waypoint-writer-1` (the writer) and `waypoint-ts-waypoint-1` (Tailscale sidecar; its own tailnet node `waypoint`, `tag:waypoint`)                                                                                                                                          |
| Data              | `~/.local/share/waypoint/prod` on agent-1 (local DB, queue, blob cache). Durable copies live in Turso (`waypoint-prod`) and R2 (`waypoint-prod`).                                                                                                                           |
| Secrets           | `~/.config/waypoint/prod.env` (writer), `ts.env` (sidecar), `cloudflare.env` (Workers deploy token) and `reader-<env>.env` (reader read-only credentials). Mode 600, passed at runtime only.                                                                                |
| Dev writer        | Not deployed. Run a writer locally with `~/.config/waypoint/dev.env` on `http://127.0.0.1:7411` (see [Developing](#developing)).                                                                                                                                            |

The writer publishes **no host port**. It's reachable only through the sidecar's tailnet HTTPS endpoint, not from the plain LAN.

## Trust model

Before changing anything that affects access, credentials, share links, or content serving, read [docs/trust-model.md](docs/trust-model.md) and keep it up to date.

## agent-1 must stay up

agent-1 runs the user's other agent workloads, including T3 Code on the host's own Tailscale `:443`. When operating Waypoint:

- Never restart the Docker daemon or the host's `tailscaled`, and never change the host's `tailscale serve` config.
- Never reboot, log out, or require a re-login. If a shell lacks Docker group access, use `sg docker -c 'docker …'`.
- Only touch containers, images, and volumes that belong to the `waypoint` project or are tagged `waypoint-writer:*`. Never run a global `docker system prune` or `docker image prune -a`.

## How updates reach production

**Merging to `main` deploys.** Don't deploy by hand unless the pipeline is broken.

1. Open a PR. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs these as parallel jobs:
   - `lint` (format check, lint, core import guard)
   - `typecheck`
   - `test`
   - `build-reader` (reader dry run and deploy-script dry runs)
   - `build-writer-image`
   - `mcp-smoke`
   - `browser`

   `ci-ok` passes only if every one of them succeeds.

2. The **Preview** workflow ([.github/workflows/preview.yml](.github/workflows/preview.yml)) uploads the PR's reader as a Worker Preview of the prod reader, at `https://pr-<number>-waypoint-reader.seancassiere.workers.dev`, and comments the URL on the PR.
   - It serves production data, read-only, behind Cloudflare Access (owner only). Without signing in, the URL answers 302 to the Access login, which is the expected state.
   - It updates on every push and is deleted when the PR closes.
   - It runs only for same-repo PRs pushed by the owner, on the self-hosted runner. See [deploy/README.md](deploy/README.md#pr-previews) and [docs/trust-model.md](docs/trust-model.md#deploy-pipeline).
3. Merge to `main`. CI runs again on `main`.
4. When CI on `main` succeeds, the **Deploy** workflow ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs on the self-hosted runner `agent-1-waypoint` (label `waypoint-deploy`, systemd user unit `waypoint-gh-runner.service`), for that exact commit, in order:
   1. **Writer** (job `deploy`): [deploy/deploy.sh](deploy/deploy.sh)
      - builds the image `waypoint-writer:<sha>` locally (no registry)
      - recreates only the writer container
      - waits for the container health check, then for `https://waypoint.tail7aca06.ts.net/healthz` through the tailnet
      - **on failure, rolls back** to `waypoint-writer:previous` and fails the workflow
   2. **Reader** (job `reader`, only if the writer succeeded): builds the reader, then runs [deploy/deploy-reader.sh](deploy/deploy-reader.sh) `dev` and then `prod`. Each run:
      - uploads the read-only secrets and deploys
      - smoke-tests `/healthz`, `/healthz/deep`, an unknown share URL and `/robots.txt`
      - **on failure, rolls back** to the previous Worker version
5. Confirm with `gh run list --workflow Deploy --limit 1`, `curl -fsS https://waypoint.tail7aca06.ts.net/healthz` and `curl -fsS https://waypoint.pingstash.com/healthz/deep`.

Manual deploy, rollback, logs, and stopping: [deploy/README.md](deploy/README.md).

**After a deploy that bumps `RENDERER_VERSION`**, re-render existing markdown with the step-by-step procedure in [deploy/README.md](deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade). It stops the deploy runner and the writer, so follow it exactly and restart both at the end.

Things that need care when changing code:

- **Schema changes are additive only** (new tables, columns, indexes; never rename or drop). Turso Sync has bugs with destructive DDL. See [docs/data-model.md](docs/data-model.md#migrations).
- **Renderer output changes** (dependencies, CSS, template, language set) require bumping `RENDERER_VERSION`; a golden-hash test enforces it.
- **The writer is the only path to the cloud.** A deploy that leaves the writer unhealthy is rolled back. Queued writes survive restarts in `queue.db`.

## The MCP server and how it updates

Agents use Waypoint through a stdio MCP server started with `npx`. It's configured **once** per machine with the stable URL:

```
npx --prefer-offline -y https://waypoint.tail7aca06.ts.net/mcp/waypoint-mcp.tgz      (env WAYPOINT_URL=https://waypoint.tail7aca06.ts.net)
```

The writer's `/mcp` page has copy-paste snippets for Claude Code and Codex, plus skill install commands.

How updates work, so configs never need to change:

- The tarball is a small **launcher**. npx caches it indefinitely, so the launcher is deliberately tiny and must stay backward-compatible.
- Each time the MCP server starts, the launcher fetches the current server bundle from the writer (`/mcp/server.mjs`, ETag-cached and sha256-verified) and runs it. A new deploy reaches agents the **next time they start a session**.
- If the writer is unreachable, it runs the last cached bundle, or else the copy embedded in the launcher.
- `waypoint_status` reports `mcp.update_available` when the running bundle is older than the writer's.
- **`--prefer-offline` matters.** Without it, npx retries the tarball URL for about 70 s when the writer is down, which exceeds MCP startup timeouts. With it, npx reuses its cached launcher immediately, and the launcher still checks the writer for a newer server bundle on every start.
- **Hashed URLs (pre-launcher configs):** `/mcp/waypoint-mcp-<hash>.tgz` now serves the current launcher, so it never returns 404. But a machine that **already installed** an old hashed tarball keeps running that old full server until its npx cache entry is cleared. Migrate such machines once: switch the config to the stable URL above (a new URL means a fresh install).
- The embedded fallback is only as new as the machine's first launcher install. It's a last resort when the writer is unreachable and nothing is cached.

When changing `packages/mcp`:

- Changes to the server bundle ship automatically with the next deploy.
- Changes to the **launcher** reach machines only after their npx cache is cleared. Avoid them. If unavoidable, keep `LAUNCHER_API` compatible.
- The MCP server must never write to stdout except MCP protocol messages.

Agent-facing usage guidance lives in the skill [skills/waypoint/SKILL.md](skills/waypoint/SKILL.md), which is also served at `/mcp/skill/SKILL.md`. Install it in `~/.codex/skills/waypoint/` or `~/.claude/skills/waypoint/`.

## Developing

- Node 24, pnpm 11. Run `pnpm install`, `pnpm check` (oxfmt, type-aware oxlint, typecheck, tests), and `pnpm build`.
- Real-Chromium tests run after `pnpm build`: `pnpm test:browser` (writer viewer) and `pnpm test:browser:reader` (public reader shell). They use Playwright's Chromium (`pnpm exec playwright install --only-shell chromium`), or `CHROME_PATH` if set. CI runs both in its `browser` job.
- Sync tests need a local Turso sync server: `bash scripts/fetch-tursodb.sh`, then set `TURSODB_BIN` to the extracted `tursodb` binary.
- Local writer without any cloud: set `WAYPOINT_SYNC=off` (refused when `WAYPOINT_ENV=prod`).
- Local writer against the **dev** cloud: `set -a; . ~/.config/waypoint/dev.env; set +a; node apps/writer/dist/main.js serve`. `scripts/live-smoke.ts` exercises it end to end and refuses prod.
- Specs live in [docs/](docs/). Update them in the same PR when behavior changes; [docs/decisions.md](docs/decisions.md) records why things are the way they are.
- Lint config is `oxlint.config.ts`; formatting is `oxfmt.config.ts`. No blanket lint disables.

## Provisioning

How to create or rotate every external credential (Turso, R2, Cloudflare, Tailscale), for the local writer and the cloud reader: [docs/provisioning.md](docs/provisioning.md).

## Secrets

- Never print, log, commit, or bake into images anything from `~/.config/waypoint/`. Load env files only inside the command that needs them (`set -a; . file; set +a`).
- Never run `scripts/live-smoke.ts` or tests against `prod.env`.
