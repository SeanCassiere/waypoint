#!/usr/bin/env bash
# Checks the release pipeline without publishing anything (the CI job `release-dry-run`):
#
#   1. actionlint on every workflow (.yml and .yaml) and on the ops workflow template
#      (deploy/ops/deploy.yml.example), with shellcheck on each run: script;
#   2. the release-please config against its schema, the versions it keeps in step, and oxfmt
#      leaving the CHANGELOG.md it writes alone (else the release PR's format check fails);
#   3. the release workflow's dispatch target check (scripts/release-dispatch-target.sh), which
#      accepts owner/repo and a workflow file name only;
#   4. the release PR's check approval (scripts/release-pr-approve.sh) against a stand-in gh: the
#      release PR's runs approved as they appear (and a fork's or another commit's left alone); a
#      refused approval, no run within the wait and an unreadable PR each a warning with the fix by
#      hand, never a failure; a closed PR skipped; and a malformed release-please output or a PR
#      whose head isn't this repository's release branch refused before anything is approved;
#   5. publish mode's checks (scripts/release-publish-check.sh) against a stand-in gh and a scratch
#      repository: a valid release (lightweight or annotated tag, squash or merge commit) accepted
#      with release-please's outputs; refused, with no outputs, a run from another ref, a malformed
#      tag, a missing, draft, prerelease or immutable release, one that isn't the newest, a tag whose
#      commit isn't on main's first-parent line (a release PR branch, a merged branch's commit), a
#      commit whose version files don't all say the version or that didn't set it, and a release
#      that already has its bundle (accepted with republish=true, for the newest release only);
#      a merged release PR still labelled `autorelease: pending` a warning;
#   6. scripts/build-release-bundle.sh: the layout upgrade.sh unpacks, SHA256SUMS, a reproducible
#      tarball, and the refusals (another version, a file naming the owner's instance), and the
#      owner-string check itself: each form of the owner's instance refused, the published image
#      and repository allowed;
#   7. upgrade.sh's release mode against a fake release: a stand-in curl serves the bundle and the
#      release list from a local directory, and a stand-in gh answers `gh attestation
#      verify` (recording the policy it was asked for) and refuses the subjects it's told to.
#      `latest` must read every page of the release list (following the Link headers), pick the
#      highest version across all of them, skip newer releases that are drafts, prereleases or
#      have no bundle yet, and cope with a list larger than one command-line argument can hold. A
#      dry run of `latest` must verify the bundle before unpacking it and the image digest before
#      the (would-be) pull, and validate each reader target's generated config against the
#      bundled Worker with the checkout's Wrangler; a refused attestation, a corrupted bundle or a
#      missing or outdated gh must stop the run before anything is unpacked or deployed, and a
#      bundle cached while verification was off is fetched and verified again once it's on.
#
# Needs the reader build (pnpm --filter "@waypoint/reader..." build), the workspace's Wrangler,
# Docker (compose config) and, for 1 and 2, the network. ACTIONLINT=<path> uses that actionlint
# instead of downloading the pinned one. actionlint runs shellcheck from PATH (or SHELLCHECK=<path>);
# with CI=true a missing shellcheck fails the run (GitHub's runner image has it), else it's a warning.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "release dry run FAILED: $*" >&2; exit 1; }
step() { echo "--- $*" >&2; }
chmod 700 "$work"

actionlint_version=1.7.12
actionlint_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 # linux_amd64
# release-please 17.6.0, the version googleapis/release-please-action v5.0.0 runs.
schema_url=https://raw.githubusercontent.com/googleapis/release-please/712fcf01effd08d7b0e7b1fd3861f2cb388bc8d1/schemas/config.json
schema_sha256=82ae5d0a805cd3e4c437ce7a4d3eae1e3db51706ad414c624cc749ca02e7c1c5

# A relative ACTIONLINT or SHELLCHECK path means one from where the script was started; the
# actionlint runs below change directory, so it's made absolute here.
absolute() { if [[ "$1" == */* && "$1" != /* ]]; then echo "$PWD/$1"; else echo "$1"; fi; }

step "actionlint"
actionlint="$(absolute "${ACTIONLINT:-}")"
if [[ -z "$actionlint" ]]; then
  [[ "$(uname -sm)" == "Linux x86_64" ]] || fail "no pinned actionlint for $(uname -sm); set ACTIONLINT"
  curl -fsSL --retry 3 -o "$work/actionlint.tgz" \
    "https://github.com/rhysd/actionlint/releases/download/v$actionlint_version/actionlint_${actionlint_version}_linux_amd64.tar.gz"
  echo "$actionlint_sha256  $work/actionlint.tgz" | sha256sum -c --quiet -
  tar -xzf "$work/actionlint.tgz" -C "$work" actionlint
  actionlint="$work/actionlint"
fi
# Without shellcheck, actionlint silently skips the run: scripts, so a local run could pass what CI
# then fails.
shellcheck="$(absolute "${SHELLCHECK:-$(command -v shellcheck || true)}")"
if [[ -n "$shellcheck" ]]; then
  "$shellcheck" --version > /dev/null || fail "$shellcheck doesn't run"
elif [[ "${CI:-}" == true ]]; then
  fail "shellcheck isn't installed, so actionlint can't check the workflows' run: scripts"
else
  echo "WARNING: shellcheck isn't installed (or set SHELLCHECK=<path>), so actionlint doesn't check the workflows' run: scripts; CI does" >&2
fi
# This repository's workflows with actionlint's defaults, which know no custom runner label (none
# may run on a self-hosted runner: scripts/check-hosted-runners.ts, D58). The ops template runs on
# the deploy runner of an instance's private ops repository, labelled waypoint-deploy.
# Both extensions: GitHub runs .yaml workflows as well, and the hosted-runner check reads both.
workflows=()
for workflow in "$repo"/.github/workflows/*.yml "$repo"/.github/workflows/*.yaml; do
  [[ -e "$workflow" ]] && workflows+=(".github/workflows/${workflow##*/}")
done
(( ${#workflows[@]} > 0 )) || fail "no workflows in .github/workflows"
(cd "$repo" && "$actionlint" -shellcheck="$shellcheck" "${workflows[@]}") || fail "actionlint"
cp "$repo/deploy/ops/deploy.yml.example" "$work/ops-deploy.yml"
printf 'self-hosted-runner:\n  labels:\n    - waypoint-deploy\n' > "$work/ops-actionlint.yaml"
(cd "$work" && "$actionlint" -shellcheck="$shellcheck" -config-file ops-actionlint.yaml ops-deploy.yml) \
  || fail "actionlint (deploy/ops/deploy.yml.example)"

step "release-please config"
curl -fsSL --retry 3 -o "$work/release-please-schema.json" "$schema_url"
echo "$schema_sha256  $work/release-please-schema.json" | sha256sum -c --quiet -
(cd "$work" && npx --yes -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv validate --spec=draft7 --strict=false \
  -c ajv-formats -s "$work/release-please-schema.json" -d "$repo/release-please-config.json") \
  || fail "release-please-config.json doesn't match the schema"
# The root package.json, the manifest and WAYPOINT_VERSION (whose agreement a core test checks)
# move together, and release-please rewrites version.ts through its annotation.
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("node:fs");
  const [root, manifest, config, versionTs] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
  const version = JSON.parse(root).version;
  if (JSON.parse(manifest)["."] !== version) throw new Error("manifest version != package.json version");
  const pkg = JSON.parse(config).packages["."];
  if (!pkg["extra-files"].includes("packages/core/src/version.ts")) throw new Error("version.ts is not an extra file");
  if (!versionTs.includes(`"${version}"; // x-release-please-version`)) throw new Error("version.ts lost its annotation");
' "$repo/package.json" "$repo/.release-please-manifest.json" "$repo/release-please-config.json" \
  "$repo/packages/core/src/version.ts" || fail "release-please's versions are out of step"
# release-please writes CHANGELOG.md in its own style (`*` bullets, two blank lines between
# sections), which oxfmt would rewrite, so the release PR's format check would always fail.
# Checked in a copy of the root config: a NOTES.md with the same text must fail, CHANGELOG.md pass.
fmt="$work/oxfmt"
mkdir "$fmt"
cp "$repo/oxfmt.config.ts" "$fmt/"
ln -s "$repo/node_modules" "$fmt/node_modules"
cat > "$fmt/CHANGELOG.md" <<'EOF'
# Changelog

## [0.2.0](https://github.com/example/waypoint/compare/v0.1.0...v0.2.0) (2026-10-08)


### Features

* **writer:** a feature ([#12](https://github.com/example/waypoint/issues/12)) ([abc1234](https://github.com/example/waypoint/commit/abc1234))


### Bug Fixes

* a fix ([def5678](https://github.com/example/waypoint/commit/def5678))
EOF
cp "$fmt/CHANGELOG.md" "$fmt/NOTES.md"
if (cd "$fmt" && "$repo/node_modules/.bin/oxfmt" --check NOTES.md > /dev/null 2>&1); then
  fail "oxfmt accepts release-please's changelog style, so this check proves nothing"
fi
rm "$fmt/NOTES.md"
(cd "$fmt" && "$repo/node_modules/.bin/oxfmt" --check . > "$work/err.log" 2>&1) \
  || { cat "$work/err.log" >&2; fail "oxfmt checks CHANGELOG.md, which release-please writes; add it to oxfmt's ignorePatterns"; }

step "the dispatch target (scripts/release-dispatch-target.sh)"
dispatch_target() {
  : > "$work/dispatch.out"
  REPO="$1" WORKFLOW="$2" GITHUB_OUTPUT="$work/dispatch.out" bash "$repo/scripts/release-dispatch-target.sh" > "$work/err.log" 2>&1
}
dispatch_target Example-Org/waypoint-ops deploy.yml || { cat "$work/err.log" >&2; fail "a valid dispatch target was refused"; }
[[ "$(cat "$work/dispatch.out")" == $'owner=Example-Org\nname=waypoint-ops\nworkflow=deploy.yml' ]] \
  || { cat "$work/dispatch.out" >&2; fail "unexpected dispatch target outputs"; }
for bad in "example|deploy.yml" "example/ops/x|deploy.yml" "example/..|deploy.yml" "example/ops|../deploy.yml" "example/ops|deploy.sh"; do
  if dispatch_target "${bad%%|*}" "${bad#*|}"; then fail "accepted the dispatch target $bad"; fi
  [[ ! -s "$work/dispatch.out" ]] || fail "the refused dispatch target $bad wrote outputs"
done

step "approving the release PR's checks (scripts/release-pr-approve.sh)"
# A stand-in gh answers from the directory $FAKE_APPROVE: the PR (pull.json, or an error with
# pull.fail), the runs awaiting approval (runs-<n>.json on the n-th listing, else none), and the
# approvals (logged; refused with a 403 when `refuse` exists).
ap="$work/approve"
mkdir -p "$ap/bin"
cat > "$ap/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_APPROVE"
[[ "$1" == api ]] || { echo "fake gh: unexpected $*" >&2; exit 2; }
case "$*" in
  "api repos/example/waypoint/pulls/7")
    [[ ! -e "$dir/pull.fail" ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    cat "$dir/pull.json" ;;
  "api repos/example/waypoint/actions/runs?event=pull_request&status=action_required&head_sha="*"&per_page=100")
    echo x >> "$dir/listings"
    n="$(wc -l < "$dir/listings")"
    if [[ -f "$dir/runs-$n.json" ]]; then cat "$dir/runs-$n.json"; else echo '{"total_count":0,"workflow_runs":[]}'; fi ;;
  "api --method POST repos/example/waypoint/actions/runs/"*"/approve")
    id="${4#repos/example/waypoint/actions/runs/}"
    echo "${id%/approve}" >> "$dir/approved"
    [[ ! -e "$dir/refuse" ]] || { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; } ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$ap/bin/gh"
head_sha="$(printf 'release PR head' | sha1sum | cut -d' ' -f1)"
other_sha="$(printf 'another commit' | sha1sum | cut -d' ' -f1)"
branch="release-please--branches--main--components--waypoint"
pr_output="$(jq -nc --arg b "$branch" '{headBranchName: $b, baseBranchName: "main", number: 7, title: "chore(main): release 0.2.0"}')"
# A run awaiting approval, as GET /actions/runs lists it (completed, with the conclusion
# action_required): $1 id, $2 workflow, $3 head repository, $4 head commit (default the PR's).
run_json() {
  jq -nc --argjson id "$1" --arg name "$2" --arg repo "$3" --arg sha "${4:-$head_sha}" --arg b "$branch" \
    '{id: $id, name: $name, event: "pull_request", status: "completed", conclusion: "action_required", head_sha: $sha,
      head_branch: $b, head_repository: {full_name: $repo}}'
}
runs_json() { jq -sc '{total_count: length, workflow_runs: .}'; }
approve_case() { # a fresh fake: $1 the PR's state, $2 its head repository
  rm -rf "$ap/case"
  mkdir "$ap/case"
  jq -n --arg sha "$head_sha" --arg b "$branch" --arg state "${1:-open}" --arg repo "${2:-example/waypoint}" \
    '{number: 7, state: $state, html_url: "https://github.com/example/waypoint/pull/7",
      head: {sha: $sha, ref: $b, repo: {full_name: $repo}}}' > "$ap/case/pull.json"
}
approve_run() { # the job's script, with short waits; output in $ap/out, summary in $ap/summary
  : > "$ap/summary"
  FAKE_APPROVE="$ap/case" PATH="$ap/bin:$PATH" GITHUB_REPOSITORY=example/waypoint GH_TOKEN=fake \
    GITHUB_STEP_SUMMARY="$ap/summary" APPROVE_INTERVAL=1 "$@" \
    bash "$repo/scripts/release-pr-approve.sh" > "$ap/out" 2>&1
}
approve_show() { cat "$ap/out" "$ap/summary" >&2; }

# Found and approved: CI's run appears on the second listing and PR title's a listing later (each
# workflow's run turns up on its own); a fork's run on the same commit, a run on another commit and
# one already running are left alone.
approve_case
echo '{"total_count":0,"workflow_runs":[]}' > "$ap/case/runs-1.json"
{ run_json 101 CI example/waypoint; run_json 900 CI someone/waypoint; run_json 901 CI example/waypoint "$other_sha"
  run_json 902 CI example/waypoint | jq -c '.status = "in_progress" | .conclusion = null'; } | runs_json > "$ap/case/runs-2.json"
run_json 102 "PR title" example/waypoint | runs_json > "$ap/case/runs-3.json"
approve_run env PR="$pr_output" APPROVE_WAIT=10 APPROVE_SETTLE=2 || { approve_show; fail "approving the release PR's runs failed"; }
[[ "$(cat "$ap/case/approved")" == $'101\n102' ]] || { approve_show; fail "approved $(paste -sd' ' "$ap/case/approved"), not the release PR's runs 101 and 102"; }
grep -q '^::notice title=Release PR checks::Approved 2 workflow run(s) of the release PR #7: CI (run 101); PR title (run 102)$' "$ap/out" \
  || { approve_show; fail "the approvals aren't reported"; }
! grep -q '^::\(warning\|error\)' "$ap/out" || { approve_show; fail "a warning or error after approving every run"; }
grep -q "^- PR title (run 102)$" "$ap/summary" || { approve_show; fail "the job summary doesn't list the approved runs"; }

# Refused: a warning with the PR and the command that approves the runs by hand, and success.
approve_case
touch "$ap/case/refuse"
{ run_json 101 CI example/waypoint; run_json 102 "PR title" example/waypoint; } | runs_json > "$ap/case/runs-1.json"
approve_run env PR="$pr_output" APPROVE_WAIT=10 APPROVE_SETTLE=0 || { approve_show; fail "a refused approval failed the job"; }
[[ "$(cat "$ap/case/approved")" == $'101\n102' ]] || { approve_show; fail "didn't try to approve both runs"; }
# shellcheck disable=SC2016 # the command in the warning, not an expansion
grep -q '^::warning title=Release PR checks need approval::GitHub refused to approve 2 workflow run(s) of the release PR #7 with this token: CI (run 101): gh: Resource not accessible by integration (HTTP 403); PR title (run 102): .*https://github.com/example/waypoint/pull/7.*Approve workflows to run.*for id in 101 102; do gh api -X POST repos/example/waypoint/actions/runs/\$id/approve; done$' "$ap/out" \
  || { approve_show; fail "the refusal's warning doesn't name the runs, the PR and the fix"; }
! grep -q '^::\(notice\|error\)' "$ap/out" || { approve_show; fail "a refusal reported as an approval or an error"; }
grep -q 'Approve workflows to run' "$ap/summary" || { approve_show; fail "the job summary doesn't explain the fix"; }

# None within the wait: a warning with the PR and a command that finds and approves them, and success.
approve_case
approve_run env PR="$pr_output" APPROVE_WAIT=2 APPROVE_SETTLE=0 || { approve_show; fail "finding no runs failed the job"; }
[[ ! -e "$ap/case/approved" ]] || { approve_show; fail "approved a run that wasn't listed"; }
(( $(wc -l < "$ap/case/listings") >= 2 )) || { approve_show; fail "didn't keep looking for the runs"; }
grep -q "^::warning title=Release PR checks not found::No workflow run awaiting approval appeared on the release PR #7 (head ${head_sha::7}) within 2s\..*https://github.com/example/waypoint/pull/7.*gh run list --repo example/waypoint --commit $head_sha --branch [^ ]* --status action_required" "$ap/out" \
  || { approve_show; fail "no runs found isn't explained"; }
! grep -q '^::error' "$ap/out" || { approve_show; fail "finding no runs reported an error"; }

# The PR can't be read: a warning, and success.
approve_case
touch "$ap/case/pull.fail"
approve_run env PR="$pr_output" APPROVE_WAIT=2 || { approve_show; fail "an unreadable PR failed the job"; }
grep -q "^::warning title=Release PR checks need approval::Couldn't read the release PR #7 (gh: Not Found (HTTP 404))" "$ap/out" \
  || { approve_show; fail "an unreadable PR isn't explained"; }
[[ ! -e "$ap/case/listings" ]] || { approve_show; fail "listed runs without the PR's head commit"; }

# A closed PR: nothing to approve.
approve_case closed
approve_run env PR="$pr_output" || { approve_show; fail "a closed release PR failed the job"; }
if ! grep -q '^::notice title=Release PR checks::The release PR #7 is closed' "$ap/out" || [[ -e "$ap/case/listings" ]]; then
  approve_show; fail "a closed release PR wasn't skipped"
fi

# Refused before anything is approved: release-please's output naming another branch or no PR,
# and a PR whose head isn't this repository's release branch.
approve_case
for bad in "$(jq -c '.headBranchName = "main"' <<< "$pr_output")" "$(jq -c '.number = "7 x"' <<< "$pr_output")" "not json"; do
  if approve_run env PR="$bad"; then approve_show; fail "accepted the release PR output $bad"; fi
  grep -q '^::error::unexpected release' "$ap/out" || { approve_show; fail "the bad release PR output $bad isn't named"; }
done
approve_case open someone/waypoint
if approve_run env PR="$pr_output"; then approve_show; fail "accepted a release PR whose head is a fork's"; fi
grep -q "^::error::#7 isn't example/waypoint's $branch" "$ap/out" || { approve_show; fail "the fork's head isn't named"; }
[[ ! -e "$ap/case/listings" && ! -e "$ap/case/approved" ]] || fail "listed or approved runs of a refused PR"

step "publish mode's checks (scripts/release-publish-check.sh)"
# A scratch repository whose main has: the 0.1.0 commit, a feature, the 0.2.0 release commit, a
# later fix, a merge of a branch that sets 0.3.0 (so the merge is the 0.3.0 release commit and the
# branch's commit only an ancestor), a commit that bumps 0.4.0 everywhere but version.ts, and one
# that fixes version.ts. Off main: the head of a 0.2.0 release PR branch. A stand-in gh answers
# from $FAKE_PUBLISH: the release by tag (release-<tag>.json, else a 404), the release list
# (releases.json, two pages), the tag ref (ref-<tag>.json), tag objects (tag-<sha>.json) and the
# release PRs labelled `autorelease: pending` (pending.json).
pub="$work/publish"
mkdir -p "$pub/bin" "$pub/repo/packages/core/src"
cat > "$pub/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_PUBLISH"
echo "$*" >> "$dir/gh.log"
[[ "$1" == api ]] || { echo "fake gh: unexpected $*" >&2; exit 2; }
shift
[[ "$1" != --paginate ]] || shift
case "$*" in
  "repos/example/waypoint/releases/tags/"*) f="$dir/release-${1##*/}.json" ;;
  "repos/example/waypoint/releases?per_page=100") f="$dir/releases.json" ;;
  "repos/example/waypoint/git/ref/tags/"*) f="$dir/ref-${1##*/}.json" ;;
  "repos/example/waypoint/git/tags/"*) f="$dir/tag-${1##*/}.json" ;;
  "repos/example/waypoint/issues?state=closed&labels=autorelease%3A%20pending&per_page=100") f="$dir/pending.json" ;;
  *) echo "fake gh: unexpected api $*" >&2; exit 2 ;;
esac
[[ -f "$f" ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
cat "$f"
GH
chmod +x "$pub/bin/gh"
pgit() { git -C "$pub/repo" -c user.name="release dry run" -c user.email=dry-run@example.test -c commit.gpgsign=false "$@"; }
set_versions() { # $1 package.json and the manifest, $2 version.ts
  printf '{ "name": "waypoint", "version": "%s" }\n' "$1" > "$pub/repo/package.json"
  printf '{ ".": "%s" }\n' "$1" > "$pub/repo/.release-please-manifest.json"
  printf 'export const WAYPOINT_VERSION: string = "%s"; // x-release-please-version\n' "$2" > "$pub/repo/packages/core/src/version.ts"
}
pcommit() { pgit add -A && pgit commit -q -m "$1" && pgit rev-parse HEAD; }
pgit init -q -b main
set_versions 0.1.0 0.1.0; pcommit "chore: 0.1.0" > /dev/null
echo a > "$pub/repo/feature.txt"; c_feat="$(pcommit "feat: a feature")"
pgit checkout -q -b release-pr
set_versions 0.2.0 0.2.0; c_branch="$(pcommit "chore(main): release 0.2.0 (the PR branch)")"
pgit checkout -q main
set_versions 0.2.0 0.2.0; c_rel="$(pcommit "chore(main): release 0.2.0")"
echo b > "$pub/repo/fix.txt"; c_later="$(pcommit "fix: after 0.2.0")"
pgit checkout -q -b side
set_versions 0.3.0 0.3.0; c_merged="$(pcommit "chore(main): release 0.3.0 (merged branch)")"
pgit checkout -q main
pgit merge -q --no-ff -m "Merge the 0.3.0 release" side
c_merge="$(pgit rev-parse HEAD)"
set_versions 0.4.0 0.3.0; c_partial="$(pcommit "chore(main): release 0.4.0 (version.ts missed)")"
set_versions 0.4.0 0.4.0; c_head="$(pcommit "fix: version.ts")"
[[ "$c_feat" != "$c_branch" ]] || fail "the scratch repository's history is wrong"
# Fresh fake state: $1 the tag, $2 the commit it names, $3... every published release (default
# v0.1.0 and the tag's). The list spans two pages, with a draft, a prerelease and a non-version tag
# that are all newer and don't count.
pstate() {
  local tag="$1" commit="$2"; shift 2
  (( $# > 0 )) || set -- v0.1.0 "$tag"
  rm -rf "$pub/gh" && mkdir "$pub/gh"
  jq -n --arg t "$tag" '{tag_name: $t, draft: false, prerelease: false, immutable: false,
    assets: [{name: "notes.txt"}]}' > "$pub/gh/release-$tag.json"
  jq -n --arg r "refs/tags/$tag" --arg s "$commit" '{ref: $r, object: {type: "commit", sha: $s}}' > "$pub/gh/ref-$tag.json"
  { jq -n --arg t "$1" '[{tag_name: $t, draft: false, prerelease: false}, {tag_name: "v9.0.0", draft: true, prerelease: false},
      {tag_name: "v8.0.0", draft: false, prerelease: true}, {tag_name: "nightly", draft: false, prerelease: false}]'
    shift
    printf '%s\n' "$@" | jq -R . | jq -s 'map({tag_name: ., draft: false, prerelease: false})'; } > "$pub/gh/releases.json"
  echo '[]' > "$pub/gh/pending.json"
}
pedit() { jq "$2" "$pub/gh/$1" > "$pub/gh/$1.new" && mv "$pub/gh/$1.new" "$pub/gh/$1"; } # $1 file, $2 jq filter
prun() { # the job's step, from the scratch repository; extra environment as arguments
  : > "$pub/outputs"; : > "$pub/summary"
  (cd "$pub/repo" && env PATH="$pub/bin:$PATH" FAKE_PUBLISH="$pub/gh" GH_TOKEN=fake GITHUB_REPOSITORY=example/waypoint \
    GITHUB_REF=refs/heads/main GITHUB_SHA="$c_head" GITHUB_OUTPUT="$pub/outputs" GITHUB_STEP_SUMMARY="$pub/summary" \
    REPUBLISH=false "$@" bash "$repo/scripts/release-publish-check.sh") > "$pub/out" 2>&1
}
prefused() { # $1 what, $2 a pattern of the error message, then prun's arguments
  local what="$1" pattern="$2"; shift 2
  if prun "$@"; then cat "$pub/out" >&2; fail "publish mode accepted $what"; fi
  grep -q "^::error title=publish_tag refused::.*$pattern" "$pub/out" || { cat "$pub/out" >&2; fail "the refusal of $what isn't explained"; }
  [[ ! -s "$pub/outputs" ]] || fail "publish mode wrote outputs for $what"
}
paccepted() { # $1 what, $2 tag, $3 the commit the outputs must name, then prun's arguments
  local what="$1" tag="$2" commit="$3"; shift 3
  prun "$@" || { cat "$pub/out" >&2; fail "publish mode refused $what"; }
  [[ "$(cat "$pub/outputs")" == "$(printf 'release_created=true\ntag_name=%s\nversion=%s\nsha=%s' "$tag" "${tag#v}" "$commit")" ]] \
    || { cat "$pub/outputs" >&2; fail "unexpected outputs for $what"; }
}

# Valid: a lightweight tag, an annotated one (peeled through two tag objects), and a release made
# by merging a branch (the merge commit is the release commit).
pstate v0.2.0 "$c_rel"
paccepted "a valid release" v0.2.0 "$c_rel" TAG=v0.2.0
grep -q "^Publish mode: publishing v0.2.0 (0.2.0) from $c_rel$" "$pub/summary" || fail "the job summary doesn't name the release"
! grep -q '^::\(warning\|error\)' "$pub/out" || { cat "$pub/out" >&2; fail "a warning or error for a valid release"; }
tag1="$(printf 'tag object 1' | sha1sum | cut -d' ' -f1)"
tag2="$(printf 'tag object 2' | sha1sum | cut -d' ' -f1)"
jq -n --arg s "$tag1" '{ref: "refs/tags/v0.2.0", object: {type: "tag", sha: $s}}' > "$pub/gh/ref-v0.2.0.json"
jq -n --arg s "$tag2" '{object: {type: "tag", sha: $s}}' > "$pub/gh/tag-$tag1.json"
jq -n --arg s "$c_rel" '{object: {type: "commit", sha: $s}}' > "$pub/gh/tag-$tag2.json"
paccepted "an annotated tag" v0.2.0 "$c_rel" TAG=v0.2.0
pstate v0.3.0 "$c_merge"
paccepted "a release commit that merged a branch" v0.3.0 "$c_merge" TAG=v0.3.0

# Refused before GitHub is asked anything: another ref, and malformed tags or republish values.
pstate v0.2.0 "$c_rel"
prefused "a run from another branch" "runs from main only, not refs/heads/release-pr" GITHUB_REF=refs/heads/release-pr TAG=v0.2.0
prefused "a run from a tag" "runs from main only" GITHUB_REF=refs/tags/v0.2.0 TAG=v0.2.0
for bad in "" 0.2.0 v0.2 v0.2.0-rc.1 "v0.2.0 " " v0.2.0" "v0.2.0;x" $'v0.2.0\nv0.3.0' refs/tags/v0.2.0 V0.2.0; do
  prefused "the tag '$bad'" "publish_tag must be a release tag vX.Y.Z" TAG="$bad"
done
prefused "republish=yes" "republish must be true or false" TAG=v0.2.0 REPUBLISH=yes
[[ ! -e "$pub/gh/gh.log" ]] || fail "publish mode asked GitHub before refusing the ref or the input"

# The release: missing, a draft, a prerelease, immutable, or another tag's.
rm "$pub/gh/release-v0.2.0.json"
prefused "a tag without a release" "no published GitHub release for v0.2.0 (gh: Not Found (HTTP 404))" TAG=v0.2.0
for case in "draft|.draft = true|is a draft" "prerelease|.prerelease = true|is a prerelease" \
  "immutable release|.immutable = true|is immutable" "release of another tag|.tag_name = \"v0.1.0\"|another release than v0.2.0"; do
  IFS='|' read -r what filter pattern <<< "$case"
  pstate v0.2.0 "$c_rel"
  pedit release-v0.2.0.json "$filter"
  prefused "a $what" "$pattern" TAG=v0.2.0
done

# Not the newest published release (versions compared as numbers: 0.10.0 is newer than 0.2.0).
pstate v0.2.0 "$c_rel" v0.1.0 v0.2.0 v0.10.0
prefused "an older release" "v0.2.0 isn't the newest release (v0.10.0 is)" TAG=v0.2.0

# A tag whose commit isn't a commit of main: a release PR branch's head, a merged branch's commit
# (an ancestor of main, off its first-parent line), a commit GitHub has that main's history doesn't,
# a tag that names a tree, and a ref GitHub answers for another tag.
pstate v0.2.0 "$c_branch"
prefused "the release PR branch's head" "names ${c_branch::12}, which isn't a commit of main" TAG=v0.2.0
pstate v0.3.0 "$c_merged"
prefused "a merged branch's commit" "names ${c_merged::12}, which isn't a commit of main" TAG=v0.3.0
unknown="$(printf 'not in main' | sha1sum | cut -d' ' -f1)"
pstate v0.2.0 "$unknown"
prefused "an unknown commit" "which isn't in main's history" TAG=v0.2.0
pstate v0.2.0 "$c_rel"
pedit ref-v0.2.0.json '.object.type = "tree"'
prefused "a tag naming a tree" "v0.2.0 doesn't name a commit" TAG=v0.2.0
pstate v0.2.0 "$c_rel"
pedit ref-v0.2.0.json '.ref = "refs/tags/v0.2.0-evil"'
prefused "another tag's ref" "another ref than refs/tags/v0.2.0" TAG=v0.2.0
# And main is the run's commit: from an older head, the 0.2.0 release commit isn't on it yet.
pstate v0.2.0 "$c_rel"
prefused "a release after the run's commit" "isn't a commit of main" TAG=v0.2.0 GITHUB_SHA="$c_feat"

# A commit of main that isn't the version's release commit: another version, a version file left
# behind, or a later commit of the same version (its parent already had it).
pstate v0.2.1 "$c_rel"
prefused "a tag of another version" "package.json says '0.2.0', not 0.2.1" TAG=v0.2.1
pstate v0.4.0 "$c_partial"
prefused "a version.ts out of step" "packages/core/src/version.ts says '0.3.0', not 0.4.0" TAG=v0.4.0
pstate v0.2.0 "$c_later"
prefused "a later commit of the same version" "0.2.0 was already released before it" TAG=v0.2.0
pstate v0.4.0 "$c_head"
prefused "the commit after a partial bump" "0.4.0 was already released before it" TAG=v0.4.0

# Already published: refused, unless republish=true (still only for the newest release).
pstate v0.2.0 "$c_rel"
pedit release-v0.2.0.json '.assets += [{name: "waypoint-deploy-0.2.0.tgz"}, {name: "waypoint-deploy-0.2.0.tgz.sha256"}]'
prefused "a release that has its bundle" "already has waypoint-deploy-0.2.0.tgz" TAG=v0.2.0
paccepted "republishing" v0.2.0 "$c_rel" TAG=v0.2.0 REPUBLISH=true
grep -q "^Publish mode: republishing v0.2.0" "$pub/summary" || fail "republishing isn't reported as such"
pstate v0.2.0 "$c_rel" v0.1.0 v0.2.0 v0.3.0
pedit release-v0.2.0.json '.assets += [{name: "waypoint-deploy-0.2.0.tgz"}]'
prefused "republishing an older release" "isn't the newest release (v0.3.0 is)" TAG=v0.2.0 REPUBLISH=true

# A merged release PR still labelled `autorelease: pending`: a warning naming it (not an open
# one's), and still published. An unreadable list is a warning too.
pstate v0.2.0 "$c_rel"
echo '[{"number": 35, "pull_request": {"merged_at": "2026-10-08T00:00:00Z"}}, {"number": 40, "pull_request": {"merged_at": null}}]' > "$pub/gh/pending.json"
paccepted "a release with a pending release PR" v0.2.0 "$c_rel" TAG=v0.2.0
grep -q "^::warning title=Release PR still pending::merged release PR(s) #35 still have the 'autorelease: pending' label.*--add-label 'autorelease: tagged'$" "$pub/out" \
  || { cat "$pub/out" >&2; fail "the pending release PR isn't named"; }
rm "$pub/gh/pending.json"
paccepted "a release whose PR labels can't be read" v0.2.0 "$c_rel" TAG=v0.2.0
grep -q "^::warning title=Release PR labels unchecked::" "$pub/out" || { cat "$pub/out" >&2; fail "the unread labels aren't reported"; }

step "build-release-bundle.sh"
version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"
sha="$(git -C "$repo" rev-parse HEAD)"
digest="sha256:$(printf 'waypoint release dry run' | sha256sum | cut -d' ' -f1)"
name="waypoint-deploy-$version"
rel="$work/release"
tgz="$(bash "$repo/scripts/build-release-bundle.sh" --out "$rel" --sha "$sha" --image-digest "$digest")"
[[ "$tgz" == "$rel/$name.tgz" ]] || fail "unexpected bundle path $tgz"
(cd "$rel" && sha256sum --quiet -c "$name.tgz.sha256") || fail "the .sha256 doesn't match"
! tar -tzf "$tgz" | grep -qv "^$name/" || fail "the bundle has entries outside $name/"
mkdir "$work/unpacked"
tar -xzf "$tgz" -C "$work/unpacked" --strip-components=1
u="$work/unpacked"
for f in upgrade.sh lib/env.sh lib/reader-config.mjs compose.yaml compose.tailscale.yaml serve.json \
  instance.env.example make-instance-env.sh README.md ops/deploy.yml.example docs/self-hosting.md \
  VERSION BUILD_SHA IMAGE_DIGEST reader/index.js reader/wrangler.jsonc reader/WRANGLER_VERSION SHA256SUMS \
  LICENSE THIRD_PARTY_NOTICES.md; do
  [[ -s "$u/$f" ]] || fail "the bundle has no $f"
done
(cd "$u" && sha256sum --quiet -c SHA256SUMS) || fail "SHA256SUMS doesn't match"
[[ "$(cd "$u" && find . -type f ! -name SHA256SUMS -printf '%P\n' | sort)" == "$(cut -c67- "$u/SHA256SUMS" | sort)" ]] \
  || fail "SHA256SUMS doesn't list exactly the bundle's files"
[[ "$(cat "$u/VERSION")" == "$version" && "$(cat "$u/BUILD_SHA")" == "$sha" && "$(cat "$u/IMAGE_DIGEST")" == "$digest" ]] \
  || fail "VERSION, BUILD_SHA or IMAGE_DIGEST is wrong"
[[ "$(cat "$u/reader/WRANGLER_VERSION")" == "$(node -p 'require(process.argv[1]).devDependencies.wrangler' "$repo/apps/reader/package.json")" ]] \
  || fail "WRANGLER_VERSION isn't the reader's pinned Wrangler"
cmp -s "$u/reader/index.js" "$repo/apps/reader/dist/index.js" || fail "the bundled Worker isn't the reader build"
[[ -x "$u/upgrade.sh" && "$(stat -c %a "$u/lib/env.sh")" == 644 ]] || fail "unexpected file modes"
again="$(bash "$repo/scripts/build-release-bundle.sh" --out "$work/again" --sha "$sha" --image-digest "$digest" 2>/dev/null)"
cmp -s "$tgz" "$again" || fail "two builds of the same commit differ"
if bash "$repo/scripts/build-release-bundle.sh" --out "$work/x" --version 99.0.0 2> "$work/err.log"; then
  fail "built a bundle for another version than package.json's"
fi
grep -q "isn't the root package.json version" "$work/err.log" || fail "the version refusal isn't explained"
owner='sean''cassiere'
cp "$repo/apps/reader/dist/index.js" "$work/planted.js"
echo "// https://$owner.example.test" >> "$work/planted.js"
if bash "$repo/scripts/build-release-bundle.sh" --out "$work/x" --reader "$work/planted.js" 2> "$work/err.log"; then
  fail "built a bundle that names the owner"
fi
grep -q "names the owner's instance" "$work/err.log" || { cat "$work/err.log" >&2; fail "the owner-string refusal isn't explained"; }

step "the owner-string check (scripts/check-owner-strings.sh)"
# Every form of the owner's instance is refused, wherever it is; the published image, the
# upstream repository and names that merely contain the host's (agent-10) pass. (The account IDs
# it matches by hash aren't planted: that would name them.)
probe="$work/owner-probe"
for planted in "https://$owner.workers.dev" "$owner/waypoint-ops" "Turso org $owner" "share.ping""stash.com" \
  "waypoint.tail7a""ca06.ts.net" "the agent""-1 host" "agent""-1.example.test" "(agent""-1)" "team.cloudflare""access.com" "$owner/waypoint.github.io"; do
  rm -rf "$probe" && mkdir -p "$probe" && printf '%s\n' "$planted" > "$probe/doc.md"
  if bash "$repo/scripts/check-owner-strings.sh" "$probe" > /dev/null 2>&1; then fail "the owner-string check passed: $planted"; fi
done
# A file passed directly, with the value before the first colon (grep prints no file name for a
# lone file unless asked to, which would shift the fields).
rm -rf "$probe" && mkdir -p "$probe" && printf '%s\n' "ping""stash.com: the reader" > "$probe/doc.md"
if bash "$repo/scripts/check-owner-strings.sh" "$probe/doc.md" > /dev/null 2>&1; then fail "the owner-string check passed a value in a file passed directly"; fi
rm -rf "$probe" && mkdir -p "$probe"
printf '%s\n' "ghcr.io/$owner/waypoint-writer:1.0.0" "https://github.com/$owner/waypoint/releases" "$owner/waypoint." \
  "git clone https://github.com/$owner/waypoint.git" "agents agent""-10 and reagent""-1" > "$probe/ok.md"
bash "$repo/scripts/check-owner-strings.sh" "$probe" > /dev/null 2>&1 || fail "the owner-string check refused the published image, the repository or another agent name"
mkdir -p "$probe/agent""-1"
if bash "$repo/scripts/check-owner-strings.sh" "$probe" > /dev/null 2>&1; then fail "the owner-string check passed a directory named for the owner's host"; fi
if bash "$repo/scripts/check-owner-strings.sh" "$work/no-such-dir" > /dev/null 2>&1; then fail "the owner-string check passed a path that doesn't exist"; fi

step "upgrade.sh release mode against a fake release"
bin="$work/bin"
mkdir -p "$bin"
real_curl="$(command -v curl)"
# The release list, newest first by date as GitHub sends it, but not by version: only $version has
# its bundle. The newer ones are a release still publishing (no asset yet), one whose bundle upload
# never finished, a prerelease and a draft; `latest` must skip them all, and say why.
asset() { printf '{"name":"waypoint-deploy-%s.tgz","state":"%s"}' "$1" "${2:-uploaded}"; }
mkdir "$work/releases"
cat > "$work/releases/1.json" <<EOF
[
  {"tag_name":"v$version","draft":false,"prerelease":false,"assets":[$(asset "$version")]},
  {"tag_name":"v99.0.0","draft":false,"prerelease":false,"assets":[]},
  {"tag_name":"v98.0.0","draft":false,"prerelease":false,"assets":[$(asset 98.0.0 open)]},
  {"tag_name":"v97.0.0","draft":false,"prerelease":true,"assets":[$(asset 97.0.0)]},
  {"tag_name":"v96.0.0","draft":true,"prerelease":false,"assets":[$(asset 96.0.0)]},
  {"tag_name":"v95.0.0-rc.1","draft":false,"prerelease":false,"assets":[$(asset 95.0.0-rc.1)]}
]
EOF
# The release list is served from FAKE_RELEASES (a directory, default $work/releases), one page per
# <n>.json, with GitHub's Link header pointing at the next page by its repository ID, as GitHub does.
cat > "$bin/curl" <<EOF
#!/usr/bin/env bash
out="" hdr="" url=""
for ((i = 1; i <= \$#; i++)); do
  case "\${!i}" in
    -o) j=\$((i + 1)); out="\${!j}" ;;
    -D) j=\$((i + 1)); hdr="\${!j}" ;;
    https://*) url="\${!i}" ;;
  esac
done
releases_page() {
  local dir="\${FAKE_RELEASES:-$work/releases}" p="\$1" last
  [[ "\$p" =~ ^[1-9][0-9]*\$ && -f "\$dir/\$p.json" ]] || { echo "fake curl: no release page \$p" >&2; exit 22; }
  last="\$(find "\$dir" -name '*.json' | wc -l)"
  echo "\$p" >> "$work/pages"
  link() { printf '<https://api.github.com/repositories/4242/releases?per_page=100&page=%s>; rel="%s"' "\$1" "\$2"; }
  if [[ -n "\$hdr" ]]; then
    {
      printf 'HTTP/2 200\r\ncontent-type: application/json; charset=utf-8\r\n'
      if (( p > 1 && p < last )); then printf 'link: %s, %s, %s\r\n' "\$(link \$((p - 1)) prev)" "\$(link \$((p + 1)) next)" "\$(link "\$last" last)"
      elif (( p < last )); then printf 'link: %s, %s\r\n' "\$(link \$((p + 1)) next)" "\$(link "\$last" last)"
      elif (( p > 1 )); then printf 'link: %s, %s\r\n' "\$(link \$((p - 1)) prev)" "\$(link 1 first)"
      fi
      printf '\r\n'
    } > "\$hdr"
  fi
  if [[ -n "\$out" ]]; then exec cp "\$dir/\$p.json" "\$out"; fi
  exec cat "\$dir/\$p.json"
}
case "\$url" in
  https://github.com/example/waypoint/releases/download/v$version/$name.tgz)
    echo download >> "$work/downloads"
    exec cp "\${FAKE_BUNDLE:-$tgz}" "\$out" ;;
  https://api.github.com/repos/example/waypoint/releases\?per_page=100) releases_page 1 ;;
  https://api.github.com/repositories/4242/releases\?per_page=100\&page=*) releases_page "\${url##*&page=}" ;;
  https://github.com/*|https://api.github.com/*)
    echo "fake curl: unexpected \$url" >&2; exit 22 ;;
esac
exec "$real_curl" "\$@"
EOF
# FAKE_GH_VERSION: what --version reports. FAKE_GH_DENY: a substring of the subjects to refuse.
cat > "$bin/gh" <<EOF
#!/usr/bin/env bash
case "\$1 \${2:-}" in
  "--version ") echo "gh version \${FAKE_GH_VERSION:-2.102.0} (2026-09-30)" ;;
  "api repos/example/waypoint") echo Example/waypoint ;;
  "attestation verify")
    printf '%s\n' "\${*:3}" >> "$work/gh.log"
    if [[ -n "\${FAKE_GH_DENY:-}" && "\$3" == *"\$FAKE_GH_DENY"* ]]; then
      echo "Error: verifying with issuer \"sigstore.dev\"" >&2; exit 1
    fi
    echo "Loaded 1 attestation from GitHub API"; echo "✓ Verification succeeded!" ;;
  *) echo "fake gh: unexpected \$*" >&2; exit 2 ;;
esac
EOF
chmod 700 "$bin/curl" "$bin/gh"

cd "$work"
printf 'WAYPOINT_ENV=prod\nWAYPOINT_SYNC=off\n' > writer.env
printf 'CLOUDFLARE_ACCOUNT_ID=dry-run\nCLOUDFLARE_API_TOKEN=dry-run\n' > cloudflare.env
for t in dev prod; do
  cat > "reader-$t.env" <<'EOF'
TURSO_DATABASE_URL=libsql://db.example.test
TURSO_READONLY_TOKEN=dry-run
R2_READER_ACCESS_KEY_ID=dry-run
R2_READER_SECRET_ACCESS_KEY=dry-run
R2_BUCKET=dry-run
R2_ACCOUNT_ID=dry-run
RAW_CAP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
EOF
done
chmod 600 ./*.env
write_instance() {
  cat > instance.env <<EOF
DATA_DIR=$work/data
WRITER_ENV_FILE=writer.env
COMPOSE_PROJECT=release-dry-run
IMAGE=ghcr.io/example/waypoint-writer
READER_TARGETS=dev prod
READER_dev_WORKER=example-reader-dev
READER_dev_DOMAIN=dev.share.example.com
READER_dev_SECRETS_FILE=reader-dev.env
READER_dev_ANALYTICS_DATASET=example_access_dev
READER_dev_RATELIMIT_NAMESPACE=1001
READER_prod_WORKER=example-reader
READER_prod_DOMAIN=share.example.com
READER_prod_SECRETS_FILE=reader-prod.env
READER_prod_ANALYTICS_DATASET=example_access
READER_prod_RATELIMIT_NAMESPACE=1002
EOF
  if [[ -n "${1:-}" ]]; then echo "VERIFY_ATTESTATIONS=$1" >> instance.env; fi
  chmod 644 instance.env
}
state="$work/state/release-dry-run"
fresh() { rm -rf "$work/state"; : > "$work/gh.log"; : > "$work/wrangler.log"; : > "$work/downloads"; : > "$work/pages"; }
# The checkout's upgrade.sh, asked for a release, fetches that release's bundle and runs its own.
# The checkout's Wrangler validates each generated config against the bundled Worker.
release_run() {
  PATH="$bin:$PATH" DRY_RUN_LOG="$work/wrangler.log" WRANGLER="$repo/apps/reader/node_modules/.bin/wrangler" \
    bash "$repo/deploy/upgrade.sh" --instance "$work/instance.env" --dry-run "$@" 2> "$work/err.log"
}
show() { cat "$work/err.log" >&2; }

write_instance
fresh
release_run latest || { show; fail "the release dry run failed"; }
policy="--repo Example/waypoint --signer-workflow Example/waypoint/.github/workflows/release.yml --source-ref refs/heads/main --deny-self-hosted-runners"
[[ "$(sed -n 1p gh.log)" == *"/$name.tgz $policy" ]] || { cat gh.log >&2; fail "the bundle wasn't verified first, with the release policy"; }
[[ "$(sed -n 2p gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "the image digest wasn't verified with the release policy"; }
[[ "$(wc -l < gh.log)" == 2 ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }
grep -q "would pull ghcr.io/example/waypoint-writer@$digest" err.log || { show; fail "the image isn't pulled by the bundle's digest"; }
grep -q "running upgrade.sh from the $version bundle" err.log || { show; fail "the bundle's own upgrade.sh didn't run"; }
grep -q "reader configs validate with wrangler deploy --dry-run" err.log || { show; fail "the generated configs weren't validated"; }
grep -q "dry run passed: release-$version" err.log || { show; fail "the dry run didn't pass"; }
grep -q "latest release with a deploy bundle: $version$" err.log || { show; fail "latest didn't resolve to $version"; }
for skipped in "99.0.0: no waypoint-deploy-99.0.0.tgz yet" "98.0.0: no waypoint-deploy-98.0.0.tgz yet" \
  "97.0.0: a prerelease" "96.0.0: a draft"; do
  grep -q "skipping example/waypoint $skipped" err.log || { show; fail "latest didn't report skipping $skipped"; }
done
! grep -q "95.0.0" err.log || { show; fail "latest considered a tag that isn't X.Y.Z"; }
for t in dev prod; do
  grep -q "^wrangler deploy --config .*/reader-$t.json --var WAYPOINT_BUILD_SHA:$sha$" wrangler.log || { cat wrangler.log >&2; fail "reader $t doesn't deploy with the release commit"; }
done
cmp -s "$u/upgrade.sh" "$state/releases/$version/upgrade.sh" || fail "the bundle wasn't installed in the state directory"
[[ "$(cat "$state/releases/$version/.provenance")" == "attested example/waypoint" ]] || fail "the cached bundle doesn't record its attestation"

step "latest with no release that has its bundle"
mkdir "$work/no-bundle"
printf '[{"tag_name":"v%s","draft":false,"prerelease":false,"assets":[]}]' "$version" > "$work/no-bundle/1.json"
if FAKE_RELEASES="$work/no-bundle" release_run latest; then fail "latest deployed a release without its bundle"; fi
grep -q "no release of example/waypoint has its deploy bundle" err.log || { show; fail "the missing bundle isn't explained"; }
! grep -q "running upgrade.sh from" err.log || { show; fail "a bundle ran"; }

# Writes a fake release list to the directory $1, one <n>.json per page. Each further argument is a
# page: comma-separated <kind>x<count>, where kind is draft, prerelease, publishing (no bundle yet)
# or ours (v$version, with its bundle). Each release gets a higher major than the one before it,
# so the last page holds the newest, and PAD pads every release's body to that many bytes.
release_pages() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const fs = require("node:fs");
    const [dir, version, pad, ...pages] = process.argv.slice(1);
    fs.mkdirSync(dir);
    let major = 50;
    pages.forEach((spec, i) => {
      const list = spec.split(",").flatMap((item) => {
        const [kind, count] = item.split("x");
        return Array.from({ length: Number(count) }, () => {
          const v = kind === "ours" ? version : `${major++}.0.0`;
          return {
            tag_name: `v${v}`, draft: kind === "draft", prerelease: kind === "prerelease", body: "x".repeat(Number(pad)),
            assets: kind === "publishing" ? [] : [{ name: `waypoint-deploy-${v}.tgz`, state: "uploaded" }],
          };
        });
      });
      fs.writeFileSync(`${dir}/${i + 1}.json`, JSON.stringify(list));
    });
  ' "$1" "$version" "${PAD:-0}" "${@:2}"
}
latest_passed() {
  grep -q "latest release with a deploy bundle: $version$" err.log && grep -q "dry run passed: release-$version" err.log
}

step "latest reads every page of the release list"
# Page 1 is 100 drafts, page 2 has the deployable release, and page 3 the newest (still publishing):
# all three are read, and the versions compared across them.
release_pages "$work/paged" draftx100 prereleasex3,oursx1 publishingx2
fresh
FAKE_RELEASES="$work/paged" release_run latest || { show; fail "latest failed on a release list of 3 pages"; }
latest_passed || { show; fail "latest didn't resolve to $version, on page 2 of 3"; }
[[ "$(cat pages)" == $'1\n2\n3' ]] || { cat pages >&2; fail "latest didn't read each page once, in order"; }
for skipped in "154.0.0: no waypoint-deploy-154.0.0.tgz yet" "150.0.0: a prerelease" "50.0.0: a draft"; do
  grep -q "skipping example/waypoint $skipped" err.log || { show; fail "latest didn't report skipping $skipped"; }
done

step "latest with a release list larger than one argument can hold"
# 131 releases with 2 KiB bodies: page 1 alone is past the kernel's 128 KiB limit on one argument.
PAD=2048 release_pages "$work/large" publishingx100 publishingx30,oursx1
(( $(stat -c %s "$work/large/1.json") > 131072 )) || fail "the large release list's first page isn't larger than 128 KiB"
fresh
FAKE_RELEASES="$work/large" release_run latest || { show; fail "latest failed on a release list larger than 128 KiB"; }
latest_passed || { show; fail "latest didn't resolve to $version in a release list larger than 128 KiB"; }
[[ "$(cat pages)" == $'1\n2' ]] || { cat pages >&2; fail "latest didn't read both pages of the large release list"; }

step "a verified cached bundle is reused"
: > gh.log; : > downloads
release_run "$version" || { show; fail "the cached bundle's dry run failed"; }
[[ ! -s downloads ]] || fail "a verified cached bundle was downloaded again"
[[ "$(cat gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }

step "a bundle run directly (as the ops workflow does) verifies the image only"
: > gh.log
PATH="$bin:$PATH" DRY_RUN_LOG="$work/wrangler.log" WRANGLER="$repo/apps/reader/node_modules/.bin/wrangler" \
  bash "$u/upgrade.sh" --instance "$work/instance.env" --dry-run "$version" 2> err.log \
  || { show; fail "the bundle's own dry run failed"; }
[[ "$(cat gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }

step "a refused bundle attestation stops the run before it's unpacked"
fresh
if FAKE_GH_DENY="$name.tgz" release_run "$version"; then fail "an unattested bundle was accepted"; fi
grep -q "the release bundle has no valid attestation from Example/waypoint" err.log || { show; fail "the refusal isn't explained"; }
[[ ! -e "$state/releases/$version" ]] || fail "an unattested bundle was unpacked"

step "a refused image attestation stops the run before anything is deployed"
fresh
if FAKE_GH_DENY="oci://" release_run "$version"; then fail "an unattested image was accepted"; fi
grep -q "the writer image $digest has no valid attestation" err.log || { show; fail "the refusal isn't explained"; }
! grep -q "would pull\|would deploy" err.log || { show; fail "the run went on after the refusal"; }
! grep -Eq '^wrangler (secret|deploy|rollback) ' wrangler.log || fail "a reader changed after the refusal"

step "a corrupted bundle fails its checksums"
fresh
mkdir "$work/tampered" && tar -xzf "$tgz" -C "$work/tampered"
echo "# tampered" >> "$work/tampered/$name/upgrade.sh"
tar -czf "$work/tampered.tgz" -C "$work/tampered" "$name"
if FAKE_BUNDLE="$work/tampered.tgz" release_run "$version"; then fail "a corrupted bundle was accepted"; fi
grep -q "fails its checksums" err.log || { show; fail "the checksum failure isn't explained"; }
[[ ! -e "$state/releases/$version" ]] || fail "a corrupted bundle was installed"

step "VERIFY_ATTESTATIONS"
write_instance 1
fresh
if GH_BIN="$work/no-gh" release_run "$version"; then fail "VERIFY_ATTESTATIONS=1 passed without gh"; fi
grep -q "VERIFY_ATTESTATIONS=1 needs the GitHub CLI" err.log || { show; fail "the missing gh isn't explained"; }
[[ ! -s downloads ]] || fail "the bundle was downloaded before the gh check"
fresh
if FAKE_GH_VERSION=2.46.0 release_run "$version"; then fail "an outdated gh was accepted"; fi
grep -q "need gh 2.102.0 or later (this is 2.46.0)" err.log || { show; fail "the outdated gh isn't explained"; }
write_instance
fresh
GH_BIN="$work/no-gh" release_run "$version" || { show; fail "the default refused a host without gh"; }
grep -q "WARNING: the GitHub CLI (gh) isn't installed" err.log || { show; fail "skipping attestations wasn't reported"; }
[[ "$(cat "$state/releases/$version/.provenance")" == unverified ]] || fail "an unverified cached bundle isn't marked so"
# Cached without verification: once gh is there, it's fetched and verified again before it runs.
: > gh.log; : > downloads
release_run "$version" || { show; fail "the default with gh failed after a run without it"; }
grep -q "wasn't verified against example/waypoint's attestations; fetching it again" err.log || { show; fail "an unverified cached bundle was reused"; }
[[ "$(cat downloads)" == download && "$(sed -n 1p gh.log)" == *"/$name.tgz $policy" ]] || { cat gh.log >&2; fail "the cached bundle wasn't fetched and verified again"; }
write_instance 0
fresh
release_run "$version" || { show; fail "VERIFY_ATTESTATIONS=0 failed"; }
[[ ! -s gh.log ]] || fail "VERIFY_ATTESTATIONS=0 still verified"
# Turning verification on refuses the bundle cached while it was off, until it verifies.
write_instance 1
: > gh.log; : > downloads
if FAKE_GH_DENY="$name.tgz" release_run "$version"; then fail "VERIFY_ATTESTATIONS=1 ran a bundle cached unverified"; fi
grep -q "the release bundle has no valid attestation" err.log || { show; fail "the refetched bundle's refusal isn't explained"; }
! grep -q "running upgrade.sh from the $version bundle" err.log || { show; fail "the unverified cached bundle ran"; }
[[ "$(cat "$state/releases/$version/.provenance")" == unverified ]] || fail "a refused bundle replaced the cached one"
release_run "$version" || { show; fail "VERIFY_ATTESTATIONS=1 failed after VERIFY_ATTESTATIONS=0"; }
[[ "$(cat "$state/releases/$version/.provenance")" == "attested example/waypoint" ]] || fail "the verified bundle isn't recorded as attested"
write_instance 2
upgrade_validate() { bash "$repo/deploy/upgrade.sh" --instance "$work/instance.env" validate 2> err.log; }
if upgrade_validate; then fail "accepted VERIFY_ATTESTATIONS=2"; fi
grep -q "VERIFY_ATTESTATIONS must be 0 or 1" err.log || { show; fail "the bad value isn't named"; }

echo "release dry run passed" >&2
