# Releasing

How Waypoint versions are cut and published, what a release contains, the repository settings and
secrets it needs, how forks publish their own, and how a release reaches a deployment. Deploying a
release: [deploy/README.md](../deploy/README.md). Why it works this way: decision D56. Who can do
what: [trust-model.md](trust-model.md#deploy-pipeline).

> **Until the repository goes public**, the release path can't run end to end: GitHub artifact
> attestations and environments aren't available to private repositories on this plan. Don't merge
> a release PR before the cutover; until then, every merge to `main` still deploys the owner's
> instance through `.github/workflows/deploy.yml` (see [AGENTS.md](../AGENTS.md#how-updates-reach-production)).
> CI's `release-dry-run` job tests everything that can run without publishing.

## Versions and the release PR

Waypoint has one version for the whole repository: the root `package.json` `version`, also
`WAYPOINT_VERSION` in `packages/core/src/version.ts` (a core test checks they match), which the
writer and the reader report on their health endpoints. Workspace packages aren't published.

[release-please](https://github.com/googleapis/release-please) maintains it from the conventional
commits on `main` ([release-please-config.json](../release-please-config.json),
[.release-please-manifest.json](../.release-please-manifest.json)):

1. PRs are squash-merged, so the **PR title** is the commit release-please reads. The PR title check
   ([.github/workflows/pr-title.yml](../.github/workflows/pr-title.yml)) requires
   `type(scope): subject`, with `!` after the type or scope for a breaking change. Types: `feat`,
   `fix`, `perf`, `refactor`, `revert`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `spike`.
   Scopes are free-form (`writer`, `reader`, `viewer`, `mcp`, `render`, `deploy`, `deps`, ...).
2. Every push to `main` runs [.github/workflows/release.yml](../.github/workflows/release.yml),
   whose first job keeps one open **release PR**, `chore(main): release X.Y.Z`, up to date: the
   version bump in `package.json`, the manifest and `version.ts` (through its
   `x-release-please-version` annotation), and `CHANGELOG.md` (features, fixes, performance,
   reverts, refactors, docs and build changes; CI, tests, chores, style and spikes are left out).
3. A PR that GITHUB_TOKEN opens or updates triggers no `pull_request` workflows, so the same job
   then starts CI on the release branch with `gh workflow run ci.yml --ref <branch>`
   (workflow_dispatch is exempt from that rule). Its `ci-ok` check lands on the branch's head
   commit, which is what branch protection requires.
4. **Merging the release PR is the release.** The next `release.yml` run tags `vX.Y.Z`, creates the
   GitHub release with the changelog, and publishes it (below).

Versioning before 1.0: a `feat` bumps the minor version, a `fix` the patch version, and a breaking
change the minor version (`bump-minor-pre-major`). The first release is **0.1.0**: the manifest
starts at 0.0.0, no `v0.0.0` tag exists, so release-please treats it as a first release and uses
`initial-version`, which it ignores once a release exists, so nothing needs removing afterwards. To
force a version, put `Release-As: X.Y.Z` in a commit body on `main`.

## What a release publishes

All from the release commit, in the run that created the release:

| Job | Publishes |
|---|---|
| `image-build` | The writer image (`apps/writer/Dockerfile`, `WAYPOINT_BUILD_SHA` = the release commit), built natively on `ubuntu-latest` (amd64) and `ubuntu-24.04-arm` (arm64) and pushed by digest. Always from source: no Turborepo cache. |
| `image` | The multi-arch index `ghcr.io/<owner>/waypoint-writer`, tagged `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`, after checking that it holds both platforms, each built from the release commit. A build provenance attestation on the **index digest** (actions/attest-build-provenance), stored by GitHub and pushed to the registry. |
| `reader` | The reader Worker build, with read-only permissions (it runs the package installs). |
| `bundle` | `waypoint-deploy-X.Y.Z.tgz` from [scripts/build-release-bundle.sh](../scripts/build-release-bundle.sh), naming the image's index digest in `IMAGE_DIGEST`, checked for owner-specific strings, attested, and attached to the release with its `.sha256`. |
| `dispatch` | Starts the deploy workflow of an ops repository, when one is configured (below). |

The bundle is one directory, `waypoint-deploy-X.Y.Z/`: `upgrade.sh` and `lib/`, the Compose files,
`serve.json`, `instance.env.example`, `make-instance-env.sh`, the runbook (`README.md`),
`docs/self-hosting.md`, `ops/deploy.yml.example`, `reader/index.js` (the prebuilt Worker),
`reader/wrangler.jsonc` (the config template), `reader/WRANGLER_VERSION`, `VERSION`, `BUILD_SHA`,
`IMAGE_DIGEST` and `SHA256SUMS`. The tarball is reproducible: the same commit gives the same bytes.

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
extra attestation is harmless).

## Settings and secrets

| What | Where | Why |
|---|---|---|
| "Allow GitHub Actions to create and approve pull requests" | Settings → Actions → General → Workflow permissions | release-please opens the release PR with GITHUB_TOKEN. Without it the first job fails. |
| A public repository (or GitHub Enterprise Cloud) | | Artifact attestations, environments with branch rules, and the free arm64 runners. |
| Branch protection on `main` requiring `ci-ok` | Settings → Branches | The release PR merges only after CI passed on its branch. |
| The `waypoint-writer` package public | the package's settings, after the first release | Instances pull without credentials. |
| `DEPLOY_DISPATCH_REPO` (variable) | repository variables | `owner/repo` of the ops repository. Unset: no dispatch. |
| `DEPLOY_DISPATCH_WORKFLOW` (variable, optional) | repository variables | The ops workflow file, default `deploy.yml`. |
| `DEPLOY_APP_CLIENT_ID` (variable) | repository variables | The dispatching GitHub App's client ID. |
| `release` environment, deployment branches: `main` only | Settings → Environments | Holds the App key; only runs on `main` can read it. |
| `DEPLOY_APP_PRIVATE_KEY` (secret) | the `release` environment | The App's private key (PEM). |

Every workflow declares its own least-privilege `permissions:`; the repository default can stay
read-only. The release workflow needs no other secret: the image is pushed and attested with
GITHUB_TOKEN, and nothing uses the Turborepo remote cache.

## Forks

A fork publishes its own releases with no edits, once Actions and the PR setting above are on:
the image goes to `ghcr.io/<fork owner>/waypoint-writer` (the owner, lowercased), its bundle
names that image's digest, and both are attested by the fork's own release workflow. Instances of
the fork set `IMAGE=ghcr.io/<fork owner>/waypoint-writer` in `instance.env`, and `RELEASE_REPO`
too if the fork isn't named `waypoint`, so `upgrade.sh` fetches and verifies the fork's releases.
Without `DEPLOY_DISPATCH_REPO`, the dispatch job is skipped.

## Deploy dispatch

The owner's instance deploys every release automatically, through a private ops repository whose
only workflow is [deploy/ops/deploy.yml.example](../deploy/ops/deploy.yml.example), run by a
self-hosted runner on the instance's host ([self-hosting](self-hosting.md#optional-automatic-deploys-on-release)).

After the image and the bundle are published, the `dispatch` job (environment `release`, so only
on `main`) mints a token for the GitHub App `waypoint-deploy-dispatch` with
actions/create-github-app-token, limited to the ops repository and `actions: write`, and calls
`POST /repos/<DEPLOY_DISPATCH_REPO>/actions/workflows/<workflow>/dispatches` with `ref: main` and
no inputs, retrying a few times and failing the run if it can't. The ops workflow then resolves
the latest release itself and verifies it before deploying, so the dispatch carries no data to
trust.

The App has one permission, Actions: write, on the ops repository only. Its key can start that
workflow (and re-run or cancel its runs), nothing else: it can't read code or secrets, push, or
choose a version (the workflow honours a `version` input only from its admin login). The worst a
leaked key does is start or cancel deploys of the latest attested release; a cancelled deploy
still finishes on its own (it runs detached from its job).

### Rotating the App key

1. In the App's settings (GitHub → Settings → Developer settings → GitHub Apps →
   `waypoint-deploy-dispatch`), generate a new private key.
2. Store it: `gh secret set DEPLOY_APP_PRIVATE_KEY --env release --repo SeanCassiere/waypoint < key.pem`.
3. Delete the old key in the App's settings, then delete `key.pem`.
4. Check it with the next release, or by re-running the `dispatch` job of the last release run.

## Testing the pipeline without publishing

CI's `release-dry-run` job ([scripts/release-dry-run.sh](../scripts/release-dry-run.sh)) runs
actionlint on every workflow and the ops template, validates the release-please config against
its schema, builds and checks a bundle, and runs `upgrade.sh`'s release mode against a fake
release with stand-in attestations. Locally, after `pnpm --filter "@waypoint/reader..." build`:

```bash
bash scripts/build-release-bundle.sh --out /tmp/release   # the bundle for this commit
bash scripts/release-dry-run.sh                           # everything the CI job checks
```
