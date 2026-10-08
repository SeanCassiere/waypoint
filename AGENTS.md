# Agent guide to Waypoint

Read this before changing Waypoint's code or docs. It's written for coding agents and works just as well for people; [CONTRIBUTING.md](CONTRIBUTING.md) is the shorter human version. Background on what Waypoint is: [README.md](README.md) and [docs/glossary.md](docs/glossary.md).

## Where things are

| Path                       | What                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`            | Runtime-agnostic domain logic (IDs, paths, manifests, URLs, API types, route handlers). Web APIs only                                                  |
| `packages/render`          | The markdown renderer (renditions); `RENDERER_VERSION` lives here                                                                                      |
| `packages/ui`              | UI shared by the writer viewer and the reader: tokens, escaping, the public shell. Web APIs only                                                       |
| `packages/mcp`             | The stdio MCP server bundle and the launcher tarball (`src/launcher.ts`, which must stay backward-compatible)                                          |
| `apps/writer`              | The writer (Node): API, viewer, queue, committer, sync, restore, rerender; `Dockerfile`; `src/config.ts` reads every setting                           |
| `apps/reader`              | The public reader (Cloudflare Worker); `wrangler.jsonc` is a generic template that each deploy renders per instance                                    |
| `deploy/`                  | `upgrade.sh` and its library, `instance.env.example`, the Compose files, the ops workflow template, the runbook ([deploy/README.md](deploy/README.md)) |
| `skills/waypoint/SKILL.md` | Agent-facing usage guidance, also served by every writer at `/mcp/skill/SKILL.md`                                                                      |
| `scripts/`                 | Dev helpers, CI checks and release tooling                                                                                                             |
| `tests/`                   | Cross-package tests, checks of built artifacts, real-Chromium browser checks                                                                           |
| `docs/`                    | The specs. Start with the [glossary](docs/glossary.md); [decisions.md](docs/decisions.md) records why things are the way they are                      |

## Trust model

Before changing anything that affects access, credentials, share links, content serving, the deploy tooling or the release pipeline, read [docs/trust-model.md](docs/trust-model.md) and keep it up to date in the same PR.

## How changes ship

1. Open a PR. Its title must be a conventional commit (`type(scope): subject`, `!` for a breaking change), checked by [.github/workflows/pr-title.yml](.github/workflows/pr-title.yml): PRs are squash-merged, and release-please builds the version and changelog from those titles. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs these as parallel jobs, through Turborepo with a shared remote cache, so a check whose inputs haven't changed is restored rather than rerun:
   - `lint` (format check, lint, core import guard, shellcheck of every script, and `scripts/check-owner-strings.sh`: no tracked file may name a particular instance's hosts, domains, machines or accounts)
   - `typecheck`
   - `test`
   - `build-reader` (the reader build, then `upgrade.sh --dry-run` with two reader targets: [scripts/deploy-dry-run.sh](scripts/deploy-dry-run.sh))
   - `build-writer-image`
   - `install-test` (the real `upgrade.sh`: install, upgrade, rollback hop to the merge base and back, broken-image and interrupt rollback, convergence after a killed run, rerender (its count, its lock, its refusal of changed settings), a reader deploy killed midway, idempotence behind a sidecar: [scripts/install-test.sh](scripts/install-test.sh))
   - `mcp-smoke`
   - `browser`
   - `release-dry-run` (actionlint, the release-please config, oxfmt leaving release-please's `CHANGELOG.md` alone, the dispatch target check, the release bundle, and `upgrade.sh`'s release mode against a fake release with stand-in attestations: [scripts/release-dry-run.sh](scripts/release-dry-run.sh))

   `ci-ok` passes only if every one of them succeeds. CI also runs on release-please's branch, started by the release workflow (`workflow_dispatch`). Dependabot ([.github/dependabot.yml](.github/dependabot.yml)) opens grouped weekly update PRs that go through the same CI.

2. Merge to `main`. CI runs again on `main`, and release-please updates its release PR.
3. Merging the release PR publishes a release ([docs/releasing.md](docs/releasing.md), D56): the attested multi-arch writer image `ghcr.io/seancassiere/waypoint-writer:X.Y.Z` and the attested deploy bundle `waypoint-deploy-X.Y.Z.tgz`, and dispatches the deploy workflow of an ops repository if one is configured.
4. Each instance deploys releases with the bundle's `upgrade.sh` ([docs/self-hosting.md](docs/self-hosting.md), [deploy/README.md](deploy/README.md)), by hand or from its own ops repository.

**Transitional, until the repository goes public:** attestations and environments don't work in a private repository, so release PRs aren't merged yet, and every merge to `main` still deploys the maintainer's instance through [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (`upgrade.sh current-checkout` on a self-hosted runner, after CI on `main` succeeds). Treat a merge as a production deploy until then.

## Things that need care

- **Schema changes are additive only** (new tables, columns, indexes; never rename or drop). Turso Sync has bugs with destructive DDL, and an older release must run on a database a newer one migrated (the rollback window). See [docs/data-model.md](docs/data-model.md#migrations).
- **Renderer output changes** (dependencies, CSS, template, language set) require bumping `RENDERER_VERSION`; a golden-hash test enforces it. If a change shouldn't affect output and the hash moved, find the cause rather than bumping it. After a release that bumps it, instances run `upgrade.sh rerender` once ([deploy/README.md](deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade)).
- **The writer is the only path to the cloud.** A deploy that leaves the writer unhealthy is rolled back. Queued writes survive restarts in `queue.db`.
- **The deploy hand-off between releases is a fixed contract** (an old `upgrade.sh` starts every newer one): [deploy/README.md](deploy/README.md#deploying). New releases may add options and `instance.env` keys, never change or remove them.
- **Third-party code a bundle inlines keeps its license text.** [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) is generated by `scripts/third-party-notices.ts` (`pnpm notices`) from the installed packages, and ships with every artifact (the writer image, the release bundle, the MCP launcher package, the head of the MCP server bundle). The packages each bundle inlines are listed in `scripts/inlined-packages.json`. When the reader or the MCP bundles start inlining another npm package, add it there and run `pnpm notices`: the MCP server build fails on an unlisted package (tsdown's `deps.onlyBundle`), `tests/inlined-packages.test.ts` fails when the reader bundle's source map doesn't match its list, and CI (`pnpm notices:check`) fails when the notices are stale or a package's license text changes.
- **No instance-specific values in the repository:** use `example.com`, `example.test`, `<tailnet>` and similar placeholders. `scripts/check-owner-strings.sh` scans every tracked file in CI; its few allowances are the published image (`ghcr.io/seancassiere/...`), the upstream repository slug (`SeanCassiere/waypoint`), the owner's handle in `.github/CODEOWNERS`, `.github/FUNDING.yml` and `CODE_OF_CONDUCT.md`, and release-please's `CHANGELOG.md`.

## The MCP server and how it updates

Agents use Waypoint through a stdio MCP server started with `npx`. It's configured **once** per machine with the writer's stable URL (`<writer>` is the writer's base URL, for example `https://waypoint.<tailnet>.ts.net` or `http://127.0.0.1:7410`):

```
npx --prefer-offline -y <writer>/mcp/waypoint-mcp.tgz      (env WAYPOINT_URL=<writer>)
```

The writer's `/mcp` page has copy-paste snippets for Claude Code and Codex, plus skill install commands.

How updates work, so configs never need to change:

- The tarball is a small **launcher**. npx caches it indefinitely, so the launcher is deliberately tiny and must stay backward-compatible.
- Each time the MCP server starts, the launcher fetches the current server bundle from the writer (`/mcp/server.mjs`, ETag-cached and sha256-verified) and runs it. A writer upgrade reaches agents the **next time they start a session**.
- If the writer is unreachable, it runs the last cached bundle, or else the copy embedded in the launcher.
- `waypoint_status` reports `mcp.update_available` when the running bundle is older than the writer's.
- **`--prefer-offline` matters.** Without it, npx retries the tarball URL for about 70 s when the writer is down, which exceeds MCP startup timeouts. With it, npx reuses its cached launcher immediately, and the launcher still checks the writer for a newer server bundle on every start.
- **Hashed URLs (pre-launcher configs):** `/mcp/waypoint-mcp-<hash>.tgz` now serves the current launcher, so it never returns 404. But a machine that **already installed** an old hashed tarball keeps running that old full server until its npx cache entry is cleared. Migrate such machines once: switch the config to the stable URL above (a new URL means a fresh install).
- The embedded fallback is only as new as the machine's first launcher install. It's a last resort when the writer is unreachable and nothing is cached.

When changing `packages/mcp`:

- Changes to the server bundle ship automatically with the next writer upgrade.
- Changes to the **launcher** reach machines only after their npx cache is cleared. Avoid them. If unavoidable, keep `LAUNCHER_API` compatible.
- The MCP server must never write to stdout except MCP protocol messages.

Agent-facing usage guidance lives in the skill [skills/waypoint/SKILL.md](skills/waypoint/SKILL.md), which is also served at `/mcp/skill/SKILL.md`. Install it in `~/.codex/skills/waypoint/` or `~/.claude/skills/waypoint/`.

## Developing

- Node 24, pnpm 11. Run `pnpm install`, `pnpm check` (oxfmt, type-aware oxlint, typecheck, tests), and `pnpm build`.
- [Turborepo](https://turborepo.dev) (pinned in the root `package.json`, configured in [turbo.json](turbo.json) and per-package `turbo.json` files) runs every task. The root scripts are thin `turbo run` wrappers, and each task builds what it needs first:
  - `pnpm build` runs each package's `build` script. tsdown builds the libraries (`core`, `ui`, `render`: ESM plus `.d.ts` from oxc, so exports need explicit types under `isolatedDeclarations`), the writer bundle (`dist/main.js` and its worker entries, with `@waypoint/*` inlined) and the MCP server bundle; esbuild builds the MCP launcher (keep it unchanged) and the viewer assets (`build:viewer`); Wrangler bundles the reader. See [docs/architecture.md](docs/architecture.md#builds).
  - Typecheck, lint and tests read workspace packages from source through the `@waypoint/source` export condition, so they need no build. Relative imports name the `.ts` file (`./x.ts`), so Node runs source directly (worker threads in tests).
  - `pnpm typecheck` and `pnpm test` run each package's own script (`tsc` over its `tsconfig.json` files; Vitest over its `tests/`). `pnpm lint` (type-aware oxlint plus the core import guard) and `pnpm format:check` are repo-wide root tasks. Cross-package tests, checks of built artifacts and the browser checks are in `tests/` (`@waypoint/integration-tests`), whose tasks build the writer and the MCP package first (and, for `test`, the reader).
  - `pnpm test` runs every package's `test`, then `pnpm test:timing`: the CPU-budget and wall-clock tests (the `timing` Vitest project in the reader and the writer), one package at a time, so nothing else shares the machine. `pnpm check` runs `format:check lint typecheck` in parallel, then `pnpm notices:check` and `pnpm test`.
  - Turbo doesn't forward arguments to them: `pnpm test <file>` fails with "Could not find task". For one test file, run Vitest in its package, e.g. `pnpm --filter @waypoint/writer exec vitest run tests/compare.test.ts` (add `--project timing` for a timing test). The writer's tests serve the viewer assets, so build them once first: `pnpm turbo run build:viewer --filter=@waypoint/writer`.
- Turbo caches each task by its declared `inputs`, dependencies and `env`, so an unchanged task is restored instead of rerun (`--force` reruns it). When a task starts reading new files or env vars, declare them in `turbo.json`: in strict mode a task sees only the env vars listed there, plus the few turbo always passes (`HOME`, `PATH`, `SHELL`, `CI`, `GITHUB_ACTIONS` and every `TURBO_*` variable, so CI's cache credentials too), and listing a var under `env` makes it part of the cache key. The local cache is `.turbo/cache` in each checkout (`cacheDir` is set, so git worktrees don't write into the main checkout's). CI also uses a signed Vercel remote cache (`TURBO_TOKEN`, `TURBO_TEAM`, `TURBO_REMOTE_CACHE_SIGNATURE_KEY`); without those, turbo uses only the local cache. The writer image always builds from source with every cache off.
- Real-Chromium tests: `pnpm test:browser` (writer viewer, against the built writer) and `pnpm test:browser:reader` (public reader shell, from source). They use Playwright's Chromium (`pnpm exec playwright install --only-shell chromium`), or `CHROME_PATH` if set. CI runs both in its `browser` job.
- Sync tests need a local Turso sync server: `bash scripts/fetch-tursodb.sh`, then set `TURSODB_BIN` to the extracted `tursodb` binary.
- Local writer without any cloud, after `pnpm build`: `WAYPOINT_ENV=dev WAYPOINT_SYNC=off WAYPOINT_DATA_DIR=$(mktemp -d) WAYPOINT_PORT=7411 node apps/writer/dist/main.js serve` (sync off is local-only mode, allowed in dev and prod; always pass a scratch `WAYPOINT_DATA_DIR`, since the default is the real dev writer's `~/.local/share/waypoint/dev`, and a synced data directory refuses to open with sync off). For UI work, `pnpm build && pnpm demo [port]` starts one on port 7421 with seeded collections, history, share links and Trash (tsx runs `scripts/demo-writer.ts` and the writer from source).
- Local writer against the **dev** cloud: `set -a; . ~/.config/waypoint/dev.env; set +a; node apps/writer/dist/main.js serve`. `pnpm live-smoke /path/to/dev.env` (`scripts/live-smoke.ts`) exercises it end to end and refuses prod.
- Every env var, Worker binding and default: [docs/configuration.md](docs/configuration.md). Keep it in step with `apps/writer/src/config.ts`, `apps/reader/src/app.ts` and the MCP packages.
- Specs live in [docs/](docs/). Update them in the same PR when behavior changes; [docs/decisions.md](docs/decisions.md) records why things are the way they are.
- Lint config is `oxlint.config.ts`; formatting is `oxfmt.config.ts`. No blanket lint disables.

## Operating an instance

If you're asked to install, upgrade or operate a Waypoint instance (rather than change the code), follow [docs/self-hosting.md](docs/self-hosting.md) and the runbook [deploy/README.md](deploy/README.md), and the instance operator's own notes. In short:

- Deploy only through `upgrade.sh` with the instance's `instance.env`; it fetches and verifies a release before touching anything, health-gates each component and rolls back on failure. Rolling back is deploying the older version.
- `upgrade.sh` and its `compose` passthrough touch only the instance's own Compose project. Never run global Docker cleanups (`docker system prune`, `docker image prune -a`, `docker volume prune`), never restart the Docker daemon or the host's Tailscale daemon, and never `docker compose down --volumes` with the Tailscale overlay (the state volume holds the node's identity).
- Never print, log, commit, or bake into images the contents of an instance's env files (by default in `~/.config/waypoint/`). `instance.env` holds no secrets, but the files it names do.

## Provisioning

How to create or rotate every external credential (Turso, R2 or another S3-compatible store, Cloudflare, Tailscale, the CI cache, the deploy dispatch App): [docs/provisioning.md](docs/provisioning.md).

## Secrets

- Never print, log, commit, or bake into images anything from `~/.config/waypoint/` (or wherever an instance keeps its env files). Load env files only inside the command that needs them (`set -a; . file; set +a`).
- Never run `scripts/live-smoke.ts` or tests against a production env file; use a dev environment's cloud resources, or a local-only writer with a scratch data directory.
