# Agent guide to Waypoint

Read this before changing or operating Waypoint. Background on what Waypoint is: [README.md](README.md) and [docs/glossary.md](docs/glossary.md).

## Where it runs

|                   |                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production writer | `https://waypoint.tail7aca06.ts.net`, reachable **only on the Tailscale tailnet**                                                                                                                                                            |
| Public reader     | Cloudflare Worker `waypoint-reader` at `https://waypoint.pingstash.com` (public; serves only what share links allow). Deployed from agent-1 after the writer.                                                                                |
| Dev reader        | Cloudflare Worker `waypoint-reader-dev` at `https://waypoint-dev.pingstash.com` (dev DB and bucket)                                                                                                                                          |
| Host              | `agent-1`, Docker Compose project `waypoint` ([deploy/compose.yaml](deploy/compose.yaml) + [compose.tailscale.yaml](deploy/compose.tailscale.yaml)), instance file `~/.config/waypoint/instance.env`                                         |
| Containers        | `waypoint-writer-1` (the writer) and `waypoint-ts-waypoint-1` (Tailscale sidecar; its own tailnet node `waypoint`, `tag:waypoint`)                                                                                                           |
| Data              | `~/.local/share/waypoint/prod` on agent-1 (local DB, queue, blob cache). Durable copies live in Turso (`waypoint-prod`) and R2 (`waypoint-prod`).                                                                                            |
| Secrets           | `~/.config/waypoint/prod.env` (writer), `ts.env` (sidecar), `cloudflare.env` (Workers deploy token) and `reader-<env>.env` (reader read-only credentials). Mode 600, passed at runtime only. `instance.env` names them and holds no secrets. |
| Dev writer        | Not deployed. Run a writer locally with `~/.config/waypoint/dev.env` on `http://127.0.0.1:7411` (see [Developing](#developing)).                                                                                                             |

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

1. Open a PR. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs these as parallel jobs, through Turborepo with a shared remote cache, so a check whose inputs haven't changed is restored rather than rerun:
   - `lint` (format check, lint, core import guard, shellcheck of every script, and `scripts/check-owner-strings.sh`: nothing in `deploy/` may name an instance)
   - `typecheck`
   - `test`
   - `build-reader` (the reader build, then `upgrade.sh --dry-run` with two reader targets: [scripts/deploy-dry-run.sh](scripts/deploy-dry-run.sh))
   - `build-writer-image`
   - `install-test` (the real `upgrade.sh`: install, upgrade, rollback hop to the merge base and back, broken-image and interrupt rollback, convergence after a killed run, rerender and its lock, idempotence behind a sidecar: [scripts/install-test.sh](scripts/install-test.sh))
   - `mcp-smoke`
   - `browser`

   `ci-ok` passes only if every one of them succeeds. There are no PR previews (D55).

2. Merge to `main`. CI runs again on `main`.
3. When CI on `main` succeeds, the **Deploy** workflow ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs on the self-hosted runner `agent-1-waypoint` (label `waypoint-deploy`, systemd user unit `waypoint-gh-runner.service`), for that exact commit. It installs the reader's dependencies and runs the same path every instance uses:

   ```
   deploy/upgrade.sh --instance ~/.config/waypoint/instance.env current-checkout
   ```

   1. Builds the writer image `waypoint-writer:waypoint-<sha>` (no registry, commit as `WAYPOINT_BUILD_SHA`) and the reader, before touching anything running.
   2. **Writer:** recreates only the writer container, waits for its health check, checks that `/healthz` reports this version and commit, then that `https://waypoint.tail7aca06.ts.net/healthz` does through the tailnet. **On failure, rolls back** to `waypoint-writer:waypoint-previous` and fails the workflow.
   3. **Readers,** `dev` then `prod`: uploads the read-only secrets, deploys with a generated Wrangler config, smoke-tests `/healthz` (with the version headers), `/healthz/deep`, an unknown share URL and `/robots.txt`. **On failure, rolls back** to the previous Worker version.

   A rerun of the same commit only repeats the checks; a rerun after a partial deploy finishes it. Details: [deploy/README.md](deploy/README.md).

4. Confirm with `gh run list --workflow Deploy --limit 1`, `curl -fsS https://waypoint.tail7aca06.ts.net/healthz` and `curl -fsS https://waypoint.pingstash.com/healthz/deep`, or `bash deploy/upgrade.sh status` on agent-1.

Manual deploy, rollback, logs, and stopping: [deploy/README.md](deploy/README.md). The owner's runner and instance values: [docs/infrastructure.md](docs/infrastructure.md#deployment-p1).

**After a deploy that bumps `RENDERER_VERSION`**, re-render existing markdown on agent-1 with `bash deploy/upgrade.sh rerender` ([deploy/README.md](deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade)). It holds the instance lock, so a deploy that starts meanwhile waits for it, for at most 30 minutes; a Deploy run that times out changes nothing, so re-run it (`gh run rerun <id>`) after the rerender. It restarts the writer if anything fails.

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
- [Turborepo](https://turborepo.dev) (pinned in the root `package.json`, configured in [turbo.json](turbo.json) and per-package `turbo.json` files) runs every task. The root scripts are thin `turbo run` wrappers, and each task builds what it needs first:
  - `pnpm build` runs each package's `build` script. tsdown builds the libraries (`core`, `ui`, `render`: ESM plus `.d.ts` from oxc, so exports need explicit types under `isolatedDeclarations`), the writer bundle (`dist/main.js` and its worker entries, with `@waypoint/*` inlined) and the MCP server bundle; esbuild builds the MCP launcher (keep it unchanged) and the viewer assets (`build:viewer`); Wrangler bundles the reader. See [docs/architecture.md](docs/architecture.md#builds).
  - Typecheck, lint and tests read workspace packages from source through the `@waypoint/source` export condition, so they need no build. Relative imports name the `.ts` file (`./x.ts`), so Node runs source directly (worker threads in tests).
  - `pnpm typecheck` and `pnpm test` run each package's own script (`tsc` over its `tsconfig.json` files; Vitest over its `tests/`). `pnpm lint` (type-aware oxlint plus the core import guard) and `pnpm format:check` are repo-wide root tasks. Cross-package tests, checks of built artifacts and the browser checks are in `tests/` (`@waypoint/integration-tests`), whose tasks build the writer and the MCP package first.
  - `pnpm test` runs every package's `test`, then `pnpm test:timing`: the CPU-budget and wall-clock tests (the `timing` Vitest project in the reader and the writer), one package at a time, so nothing else shares the machine. `pnpm check` runs `format:check lint typecheck` in parallel, then `pnpm test`.
  - Turbo doesn't forward arguments to them: `pnpm test <file>` fails with "Could not find task". For one test file, run Vitest in its package, e.g. `pnpm --filter @waypoint/writer exec vitest run tests/compare.test.ts` (add `--project timing` for a timing test). The writer's tests serve the viewer assets, so build them once first: `pnpm turbo run build:viewer --filter=@waypoint/writer`.
- Turbo caches each task by its declared `inputs`, dependencies and `env`, so an unchanged task is restored instead of rerun (`--force` reruns it). When a task starts reading new files or env vars, declare them in `turbo.json`: in strict mode a task sees only the env vars listed there, plus the few turbo always passes (`HOME`, `PATH`, `SHELL`, `CI`, `GITHUB_ACTIONS` and every `TURBO_*` variable, so CI's cache credentials too), and listing a var under `env` makes it part of the cache key. The local cache is `.turbo/cache` in each checkout (`cacheDir` is set, so git worktrees don't write into the main checkout's). CI also uses a signed Vercel remote cache (`TURBO_TOKEN`, `TURBO_TEAM`, `TURBO_REMOTE_CACHE_SIGNATURE_KEY`); without those, turbo uses only the local cache. The writer image always builds from source with every cache off.
- Real-Chromium tests: `pnpm test:browser` (writer viewer, against the built writer) and `pnpm test:browser:reader` (public reader shell, from source). They use Playwright's Chromium (`pnpm exec playwright install --only-shell chromium`), or `CHROME_PATH` if set. CI runs both in its `browser` job.
- Sync tests need a local Turso sync server: `bash scripts/fetch-tursodb.sh`, then set `TURSODB_BIN` to the extracted `tursodb` binary.
- Local writer without any cloud, after `pnpm build`: `WAYPOINT_ENV=dev WAYPOINT_SYNC=off WAYPOINT_DATA_DIR=$(mktemp -d) WAYPOINT_PORT=7411 node apps/writer/dist/main.js serve` (sync off is local-only mode, allowed in dev and prod; always pass a scratch `WAYPOINT_DATA_DIR`, since the default is the real dev writer's `~/.local/share/waypoint/dev`, and a synced data directory refuses to open with sync off). For UI work, `pnpm build && pnpm demo [port]` starts one on port 7421 with seeded collections, history, share links and Trash (tsx runs `scripts/demo-writer.ts` and the writer from source).
- Local writer against the **dev** cloud: `set -a; . ~/.config/waypoint/dev.env; set +a; node apps/writer/dist/main.js serve`. `pnpm live-smoke /path/to/dev.env` (`scripts/live-smoke.ts`) exercises it end to end and refuses prod.
- Every env var, Worker binding and default: [docs/configuration.md](docs/configuration.md). Keep it in step with `apps/writer/src/config.ts`, `apps/reader/src/app.ts` and the MCP packages.
- Specs live in [docs/](docs/). Update them in the same PR when behavior changes; [docs/decisions.md](docs/decisions.md) records why things are the way they are.
- Lint config is `oxlint.config.ts`; formatting is `oxfmt.config.ts`. No blanket lint disables.

## Provisioning

How to create or rotate every external credential (Turso, R2, Cloudflare, Tailscale), for the local writer and the cloud reader: [docs/provisioning.md](docs/provisioning.md).

## Secrets

- Never print, log, commit, or bake into images anything from `~/.config/waypoint/`. Load env files only inside the command that needs them (`set -a; . file; set +a`).
- Never run `scripts/live-smoke.ts` or tests against `prod.env`.
