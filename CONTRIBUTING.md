# Contributing to Waypoint

Thanks for your interest. Bug reports, fixes, docs improvements and well-scoped features are all
welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach
before you spend time on it. Security problems go through [SECURITY.md](SECURITY.md), never a
public issue.

By contributing, you agree that your contributions are licensed under the project's
[MIT license](LICENSE), and to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Getting set up

You need Node 24 and pnpm 11 (the exact versions: `.node-version` and `packageManager` in
`package.json`). No secrets or cloud accounts are needed for development.

```bash
pnpm install
pnpm check      # format check, type-aware lint, typecheck, third-party notices, every test
pnpm build      # every package (tsdown, esbuild, Wrangler's dry run for the reader)
```

- **Sync tests** need a local Turso sync server. On Linux x64:

  ```bash
  bash scripts/fetch-tursodb.sh
  export TURSODB_BIN=$PWD/.tools/turso_cli-x86_64-unknown-linux-gnu/tursodb
  ```

- **Browser tests** run the writer viewer and the public reader shell in a real Chromium, after
  `pnpm build`:

  ```bash
  pnpm exec playwright install --only-shell chromium   # once; or set CHROME_PATH
  pnpm test:browser
  pnpm test:browser:reader
  ```

- **A local writer with seeded content** (collections, history, share links, Trash), for UI work:
  `pnpm build && pnpm demo` (port 7421; `pnpm demo <port>` for another).
- **A local writer without any cloud:** after `pnpm build`,
  `WAYPOINT_ENV=dev WAYPOINT_SYNC=off WAYPOINT_DATA_DIR=$(mktemp -d) WAYPOINT_PORT=7411 node apps/writer/dist/main.js serve`.

[AGENTS.md](AGENTS.md) is the detailed guide to the codebase (it's written for coding agents, and
works just as well for people): the task graph, running one test file, where things live, and
what needs care. The specs are in [docs/](docs/), starting with the [glossary](docs/glossary.md).

## Making a change

- **Keep docs in step.** The specs in `docs/` describe behaviour; update them in the same PR when
  behaviour changes. Record the reason for a design decision in
  [docs/decisions.md](docs/decisions.md). Anything that touches access, credentials, share links or
  content serving updates [docs/trust-model.md](docs/trust-model.md) too.
- **Tests.** New behaviour comes with tests in the package it belongs to (`packages/*/tests`,
  `apps/*/tests`); cross-package and built-artifact checks go in `tests/`.
- **Rules that CI or reviewers enforce:**
  - **Schema changes are additive only:** new tables, columns and indexes; never rename or drop
    anything. Turso Sync has bugs with destructive DDL, and older releases must keep running on a
    database a newer one migrated (the rollback window). See
    [docs/data-model.md](docs/data-model.md#migrations).
  - **Renderer output changes bump `RENDERER_VERSION`.** Any change to the markdown renderer's
    dependencies, CSS, template, options or language set changes renditions, which are
    content-addressed; a golden-hash test fails until the version is bumped. If your change
    shouldn't affect output and the hash moved, find out why rather than bumping it.
  - **The MCP launcher stays backward-compatible.** npx caches the launcher tarball indefinitely,
    so changes to `packages/mcp/src/launcher.ts` reach machines only after their npx cache is
    cleared. Avoid them; if unavoidable, keep `LAUNCHER_API` compatible. The server bundle can
    change freely: agents fetch it from the writer on every start. The MCP server never writes
    anything but protocol messages to stdout.
  - **`core` and `ui` stay runtime-agnostic:** Web APIs only, no `node:*` or native modules
    (`pnpm lint` checks).
  - **Inlined third-party code keeps its license text.** `THIRD_PARTY_NOTICES.md` is generated
    by `pnpm notices` from the installed packages and ships with every artifact. The packages each
    bundle inlines are listed in `scripts/inlined-packages.json`. If the reader or the MCP bundles
    start inlining another npm package, add it there and run `pnpm notices`: the MCP build fails
    on a package that isn't listed, a test (`tests/inlined-packages.test.ts`) fails when the
    reader's list doesn't match its bundle, and CI's `pnpm notices:check` fails when the notices
    are out of date. It also fails when one of the writer's production dependencies (which the
    writer image installs as they are) ships no license file: add its license text from its
    source repository to `scripts/license-texts/`, and the package to `missingLicenseFiles` in
    `scripts/third-party-notices.ts`.
  - **What ships is a `dependency`, tooling a `devDependency`.** A package the writer or the
    reader runs, or the MCP server bundle inlines, goes in `dependencies` (the MCP bundle's
    `tsdown.config.ts` bundles them all, and its build fails if one is left as an import;
    `tests/inlined-packages.test.ts` fails if a package listed in `scripts/inlined-packages.json`
    is a devDependency). Dependabot titles updates to dependencies `fix(deps)`, which makes a
    release, and updates to devDependencies `chore(deps)`, which doesn't.
  - **No blanket lint disables.** Fix the finding, or disable one rule on one line with a reason.
  - **No instance-specific values** (your hostnames, domains, account IDs) anywhere in the
    repository: use `example.com`-style placeholders. CI's `scripts/check-owner-strings.sh` scans
    every tracked file.
  - Shell scripts pass `shellcheck`; workflows pin every action by commit SHA, with the version
    in a comment, and run on GitHub-hosted runners only (`scripts/check-hosted-runners.sh`).
- Formatting is oxfmt (`pnpm format`), lint is oxlint (`oxlint.config.ts`).

## Pull requests

- **PR titles are conventional commits:** `type(scope): subject`, for example
  `fix(reader): return 404 for an expired pinned link`, with `!` after the type or scope for a
  breaking change (`feat(deploy)!: ...`). Types: `feat`, `fix`, `perf`, `refactor`, `revert`,
  `docs`, `test`, `build`, `ci`, `chore`, `style`, `spike`. Scopes are free-form (`writer`,
  `reader`, `viewer`, `mcp`, `render`, `deploy`, `deps`, ...). A check enforces this.
- PRs are **squash-merged**, so the title becomes the commit on `main` that release-please reads
  to pick the next version and write the changelog. Write it for the changelog. The commit body
  stays blank, so nothing in the PR description reaches release-please.
- CI must pass (the `ci-ok` check). Fork PRs run without the remote build cache, so they take a
  little longer.
- **The review bar:** a change is merged when it's correct (including its failure and rollback
  paths), tested, documented, and doesn't widen what an unauthenticated or public party can do
  without a decision recorded for it. Expect questions about edge cases, concurrency between
  writers, and what happens on an older release reading data a newer one wrote.

## Releases

Maintainers cut releases by merging release-please's release PR; it publishes the writer image,
the deploy bundle and their build provenance attestations. Merging any other PR deploys nothing:
instances deploy releases. Contributors don't need to do anything beyond a conventional PR title. Details: [docs/releasing.md](docs/releasing.md).
