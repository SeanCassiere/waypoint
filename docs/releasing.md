# Releasing

How Waypoint versions are cut and published, what a release contains, the repository settings and
secrets it needs, how forks publish their own, and how a release reaches a deployment. Deploying a
release: [deploy/README.md](../deploy/README.md). Why it works this way: decision D56. Who can do
what: [trust-model.md](trust-model.md#deploy-pipeline).

Instances deploy releases, never merges: merging a pull request to `main` publishes and deploys
nothing until the release PR that includes it is merged, and no workflow in this repository runs
on a self-hosted runner (D58). CI's `release-dry-run` job tests everything in the release path
that can run without publishing.

## Versions and the release PR

Waypoint has one version for the whole repository: the root `package.json` `version`, also
`WAYPOINT_VERSION` in `packages/core/src/version.ts` (a core test checks they match), which the
writer and the reader report on their health endpoints. Workspace packages aren't published.

[release-please](https://github.com/googleapis/release-please) maintains it from the conventional
commits on `main` ([release-please-config.json](../release-please-config.json),
[.release-please-manifest.json](../.release-please-manifest.json)):

1. PRs are squash-merged, so the **PR title** is the commit release-please reads. The squash
   commit's body is left blank (the repository's default squash message): release-please also
   parses commit bodies for `BREAKING CHANGE:` and `Release-As:` footers, and a PR description, or
   the upstream release notes a Dependabot PR quotes, must not change the version or the changelog
   by accident. The PR title check
   ([.github/workflows/pr-title.yml](../.github/workflows/pr-title.yml)) requires
   `type(scope): subject`, with `!` after the type or scope for a breaking change. Types: `feat`,
   `fix`, `perf`, `refactor`, `revert`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `spike`.
   Scopes are free-form (`writer`, `reader`, `viewer`, `mcp`, `render`, `deploy`, `deps`, ...).
   Its check, `conventional-title`, isn't a required status check: `ci-ok` is the only one. It
   runs on `pull_request` events only, so on the release PR only once its runs are approved
   (step 3), and the release PR's title is release-please's own.
2. Every push to `main` runs [.github/workflows/release.yml](../.github/workflows/release.yml).
   Its first job, `release-please`, only creates releases (below). The second, `release-pr`, runs
   release-please again to keep one open **release PR**, `chore(main): release X.Y.Z`, up to date: the
   version bump in `package.json`, the manifest and `version.ts` (through its
   `x-release-please-version` annotation), and `CHANGELOG.md` (features, fixes, performance,
   reverts, refactors, docs and build changes; CI, tests, chores, style and spikes are left out).
   release-please owns `CHANGELOG.md` and writes it in its own style, so oxfmt ignores it (else the
   release PR's format check would fail on every update). The two are separate jobs (release-please's
   `skip-github-pull-request` and `skip-github-release`) so that a failure opening or updating the
   PR (for instance with the Actions PR setting below off) fails the run without skipping the
   publishing jobs of a release the first job created: nothing that publishes depends on
   `release-pr`.
3. release-please opens and updates the release PR with GITHUB_TOKEN, so GitHub creates the PR's
   `pull_request` runs (CI and PR title) **awaiting approval** instead of starting them: the PR's
   merge box shows "Approve workflows to run", and until someone with write access approves, the
   PR has no `ci-ok` and branch protection blocks it. The next job, `release-pr-checks`
   ([scripts/release-pr-approve.sh](../scripts/release-pr-approve.sh)), approves them through the
   API with the job's token (`actions: write`): it polls for up to two minutes for the runs
   awaiting approval on the PR's head commit, and approves only runs of the release branch in this
   repository, never a fork's. GitHub doesn't document whether GITHUB_TOKEN may approve runs of a
   PR it opened itself. If it refuses, or no run turns up, the job still succeeds but leaves a
   warning on the run (and in its summary) with the PR's URL and the command that approves the
   runs by hand ([below](#cutting-a-release)). Once approved, they're ordinary `pull_request`
   runs, and their `ci-ok` is the check branch protection counts (D59).
4. **Merging the release PR is the release.** The next `release.yml` run tags `vX.Y.Z`, creates the
   GitHub release with the changelog, and publishes it (below).

CI started by hand (`gh workflow run ci.yml --ref <branch>`, which CI keeps for that) doesn't help
a PR: GitHub doesn't associate workflow_dispatch runs with a PR, so their `ci-ok` never satisfies
its branch protection, even on the PR's head commit.

Versioning before 1.0: a `feat` bumps the minor version, a `fix` the patch version, and a breaking
change the minor version (`bump-minor-pre-major`). The first release is **0.1.0**: the manifest
starts at 0.0.0, no `v0.0.0` tag exists, so release-please treats it as a first release and uses
`initial-version`, which it ignores once a release exists, so nothing needs removing afterwards. To
force a version, add a `Release-As: X.Y.Z` footer to the commit message in the squash-merge
dialog of the PR you merge.

## Cutting a release

1. Open the release PR, `chore(main): release X.Y.Z`, and read its `CHANGELOG.md` entry and
   version bump: that's what will be published.
2. Check its checks. Normally the latest `release.yml` run approved its runs, and CI is running or
   done. If the merge box still says **Approve workflows to run** (the run's `release-pr-checks`
   job then has a warning, "Release PR checks need approval" or "Release PR checks not found"),
   select it, or approve them from a terminal with the command the warning gives, which is:

   ```bash
   gh run list --repo <repo> --commit <head commit> --branch <release branch> --status action_required \
     --json databaseId --jq '.[].databaseId' | xargs -I{} gh api -X POST repos/<repo>/actions/runs/{}/approve
   ```

   Each update of the release PR (every merge to `main`) is a new head commit, whose runs need
   approving again; the release workflow does it on each update.
3. When `ci-ok` passes, squash-merge it. The release run that follows publishes the release
   ([below](#what-a-release-publishes)) and, if configured, dispatches the deploy.

## What a release publishes

All from the release commit, in the run that created the release:

| Job | Publishes |
|---|---|
| `image-build` | The writer image (`apps/writer/Dockerfile`, `WAYPOINT_BUILD_SHA` = the release commit), built natively on `ubuntu-latest` (amd64) and `ubuntu-24.04-arm` (arm64) and pushed by digest. Always from source: no Turborepo cache. Each is then pulled by its digest and started on its own architecture (local-only, on a scratch data directory) until `/healthz` reports the release's version and commit, so an image whose native modules don't load (Turso's) fails the release before the index names it. |
| `image` | The multi-arch index `ghcr.io/<owner>/waypoint-writer`, tagged `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`, after checking that it holds both platforms, each built from the release commit. A build provenance attestation on the **index digest** (actions/attest-build-provenance), stored by GitHub and pushed to the registry. |
| `reader` | The reader Worker build, with read-only permissions (it runs the package installs). |
| `bundle` | `waypoint-deploy-X.Y.Z.tgz` from [scripts/build-release-bundle.sh](../scripts/build-release-bundle.sh), naming the image's index digest in `IMAGE_DIGEST`, checked for owner-specific strings, attested, and attached to the release with its `.sha256`. |
| `dispatch` | Starts the deploy workflow of an ops repository, when one is configured (below). |

The bundle is one directory, `waypoint-deploy-X.Y.Z/`: `upgrade.sh` and `lib/`, the Compose files,
`serve.json`, `instance.env.example`, `make-instance-env.sh`, the runbook (`README.md`),
`docs/self-hosting.md`, `ops/deploy.yml.example`, `reader/index.js` (the prebuilt Worker),
`reader/wrangler.jsonc` (the config template), `reader/WRANGLER_VERSION`, `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `VERSION`, `BUILD_SHA`, `IMAGE_DIGEST` and `SHA256SUMS`. The tarball is reproducible: the same commit gives the same bytes.

To check a release by hand (gh 2.102.0 or later; `upgrade.sh` runs the same checks):

```bash
gh attestation verify waypoint-deploy-X.Y.Z.tgz --repo SeanCassiere/waypoint \
  --signer-workflow SeanCassiere/waypoint/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
gh attestation verify oci://ghcr.io/seancassiere/waypoint-writer@$(cat waypoint-deploy-X.Y.Z/IMAGE_DIGEST) \
  --repo SeanCassiere/waypoint --signer-workflow SeanCassiere/waypoint/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

If a publishing job fails, **re-run the failed jobs** of that run: the release and tag already
exist, so a later push won't publish it again, and a re-run keeps the first job's outputs. Every
publishing step can be repeated (tags are moved to the same index, the asset is replaced, and an
extra attestation is harmless). Meanwhile instances don't deploy it: GitHub marks the release
"latest" as soon as it's created, but `upgrade.sh latest` and the ops workflow take the newest
release that isn't a draft or prerelease and already has its `waypoint-deploy-X.Y.Z.tgz`, and
log the newer ones they skip. The bundle is attached last, after the image, so a release with a
bundle has both.

## Settings and secrets

| What | Where | Why |
|---|---|---|
| "Allow GitHub Actions to create and approve pull requests" | Settings → Actions → General → Workflow permissions | release-please opens the release PR with GITHUB_TOKEN. Without it the `release-pr` job fails (releases still publish). |
| A public repository (or GitHub Enterprise Cloud) | | Artifact attestations, environments with branch rules, and the free arm64 runners. |
| Branch protection on `main` requiring `ci-ok` | Settings → Branches | The release PR merges only after CI passed on it, in its approved `pull_request` run (above). Require `ci-ok` only. |
| The `waypoint-writer` package public | the package's settings, during the first release ([below](#the-first-release)) | GHCR creates a package as private on its first push; instances pull without credentials. |
| `DEPLOY_DISPATCH_REPO` (variable) | repository variables | `owner/repo` of the ops repository. Unset: no dispatch. |
| `DEPLOY_DISPATCH_WORKFLOW` (variable, optional) | repository variables | The ops workflow file, default `deploy.yml`. |
| `DEPLOY_APP_CLIENT_ID` (variable) | repository variables | The dispatching GitHub App's client ID. |
| `release` environment, deployment branches: `main` only | Settings → Environments | Holds the App key; only runs on `main` can read it. |
| `DEPLOY_APP_PRIVATE_KEY` (secret) | the `release` environment | The App's private key (PEM). |

Every workflow declares its own least-privilege `permissions:`; the repository default can stay
read-only. The release workflow needs no other secret: the image is pushed and attested with
GITHUB_TOKEN, and nothing uses the Turborepo remote cache.

## The first release

GHCR creates the `waypoint-writer` package as **private** when the first release pushes it, and
the same run would dispatch the deploy straight away, which then can't pull the image. Package
visibility can only be changed in the web UI, once the package exists. So the first release goes
out without the dispatch, and its deploy is started by hand once the package is public. With
`<repo>` for the publishing repository (for example `you/waypoint`), `<image>` for its image
(`ghcr.io/<owner, lowercased>/waypoint-writer`) and `<ops>` for the ops repository:

1. Make sure `DEPLOY_DISPATCH_REPO` isn't set yet (the `dispatch` job is then skipped):
   `gh variable list --repo <repo>`; if it's there,
   `gh variable delete DEPLOY_DISPATCH_REPO --repo <repo>`.
2. Merge the release PR and wait for the release run to pass:
   `gh run watch --repo <repo> "$(gh run list --repo <repo> --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"`.
3. Make the package public: github.com → your profile (or organization) → Packages →
   `waypoint-writer` → Package settings → Danger Zone → Change visibility → Public. Check that it
   pulls anonymously (`<owner>` lowercased, as in the image name):

   ```bash
   token="$(curl -fsS 'https://ghcr.io/token?scope=repository:<owner>/waypoint-writer:pull' | jq -r .token)"
   curl -fsS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $token" \
     -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
     -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
     https://ghcr.io/v2/<owner>/waypoint-writer/manifests/X.Y.Z   # 200; fails while private
   ```

4. Turn the dispatch on for every later release:
   `gh variable set DEPLOY_DISPATCH_REPO --repo <repo> --body <ops>`.
5. Start the first deploy by hand (no `version` input: it deploys the latest release) and follow it:
   `gh workflow run deploy.yml --repo <ops>`, then
   `gh run watch --repo <ops> "$(gh run list --repo <ops> --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"`.

Start that deploy by hand rather than by re-running the release run: re-running all its jobs runs
release-please again, which doesn't report a release that already exists, so `dispatch` would
still be skipped. An instance that deploys by hand just runs `upgrade.sh X.Y.Z` after step 3.

## Forks

A fork publishes its own releases with no edits, once Actions and the PR setting above are on:
the image goes to `ghcr.io/<fork owner>/waypoint-writer` (the owner, lowercased), its bundle
names that image's digest, and both are attested by the fork's own release workflow. Instances of
the fork set `IMAGE=ghcr.io/<fork owner>/waypoint-writer` in `instance.env`, and `RELEASE_REPO`
too if the fork isn't named `waypoint`, so `upgrade.sh` fetches and verifies the fork's releases.
Without `DEPLOY_DISPATCH_REPO`, the dispatch job is skipped.

## Deploy dispatch

The maintainer's instance deploys every release automatically, and any instance can do the same,
through a private ops repository whose only workflow is [deploy/ops/deploy.yml.example](../deploy/ops/deploy.yml.example), run by a
self-hosted runner on the instance's host that is registered to the ops repository only, never to
this one ([self-hosting](self-hosting.md#optional-automatic-deploys-on-release)).

After the image and the bundle are published, the `dispatch` job (environment `release`, so only
on `main`) mints a token for the dispatching GitHub App (`DEPLOY_APP_CLIENT_ID`) with
actions/create-github-app-token, limited to the ops repository and `actions: write`, and calls
`POST /repos/<DEPLOY_DISPATCH_REPO>/actions/workflows/<workflow>/dispatches` with `ref: main` and
no inputs, retrying a few times and failing the run if it can't. The ops workflow then resolves
the latest release itself and verifies it before deploying, so the dispatch carries no data to
trust.

The App has one permission, Actions: write, on the ops repository only. Its key can start that
workflow, re-run or cancel its runs, disable or enable it, and delete its runs, logs and
artifacts. It can't read code or secrets, push, or choose a version (the workflow honours a
`version` input only from its admin login). So a leaked key can start or cancel deploys of the
latest attested release, or stop automatic deploys (by disabling the workflow) and erase their
history on GitHub, but it can't deploy anything else. A cancelled deploy still finishes on its own
(it runs detached from its job), and each deploy's log also stays on the runner host, under
`WAYPOINT_DEPLOY_WORK`. If the key leaks, rotate it (below) and check that the workflow is
enabled.

### Rotating the App key

1. In the App's settings (GitHub → Settings → Developer settings → GitHub Apps → the dispatch
   App), generate a new private key.
2. Store it: `gh secret set DEPLOY_APP_PRIVATE_KEY --env release --repo <repo> < key.pem`.
3. Delete the old key in the App's settings, then delete `key.pem`.
4. Check it with the next release, or by re-running the `dispatch` job of the last release run.

## Testing the pipeline without publishing

CI's `release-dry-run` job ([scripts/release-dry-run.sh](../scripts/release-dry-run.sh)) runs
actionlint on every workflow and the ops template, validates the release-please config against
its schema, builds and checks a bundle, and runs `upgrade.sh`'s release mode against a fake
release with stand-in attestations, and tests the `dispatch` job's target check
([scripts/release-dispatch-target.sh](../scripts/release-dispatch-target.sh)), the
`release-pr-checks` job's approvals against a stand-in gh (approved, refused, none found), and
oxfmt's handling of `CHANGELOG.md`. Locally, after `pnpm --filter "@waypoint/reader..." build`:

```bash
bash scripts/build-release-bundle.sh --out /tmp/release   # the bundle for this commit
bash scripts/release-dry-run.sh                           # everything the CI job checks
```
