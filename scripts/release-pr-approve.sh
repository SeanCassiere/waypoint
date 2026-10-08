#!/usr/bin/env bash
# The release workflow's `release-pr-checks` job: approves the workflow runs of the release PR, so
# its required `ci-ok` check runs (D59).
#
#   PR=<release-please's `pr` output> GH_TOKEN=<token> [REPO=<owner/repo>] scripts/release-pr-approve.sh
#
# release-please opens and updates the release PR with GITHUB_TOKEN, so GitHub creates the PR's
# `pull_request` runs (CI, PR title) awaiting approval rather than running them: the API lists
# them as completed with the conclusion `action_required` (its `status=action_required` filter
# finds them). This polls for those runs on the PR's head commit, for up to APPROVE_WAIT seconds
# (default 120) every APPROVE_INTERVAL seconds (default 5), and approves each one
# (POST /repos/{owner}/{repo}/actions/runs/{id}/approve, which needs `actions: write`). Once it has
# found one, it keeps looking for APPROVE_SETTLE more seconds (default 20) after the last new run,
# since each workflow's run appears on its own.
#
# Only runs of this repository's release branch, on the PR's head commit, are approved: never a
# run of another branch or of a fork (a fork's PR can carry the same commit).
#
# GitHub doesn't document whether GITHUB_TOKEN may approve runs of a PR it opened. A refusal, an
# API error or no runs at all is a warning, never a failure: the release run goes on, and the
# warning (and the job summary) says how the maintainer approves the runs by hand. Only a
# malformed `pr` output, or a PR that isn't the release branch's, fails the script.
#
# A script rather than inline shell so scripts/release-dry-run.sh can run it against a stand-in gh.
set -euo pipefail

: "${PR:?}"
REPO="${REPO:-${GITHUB_REPOSITORY:?}}"
wait_s="${APPROVE_WAIT:-120}"
interval="${APPROVE_INTERVAL:-5}"
settle="${APPROVE_SETTLE:-20}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
for n in "$wait_s" "$interval" "$settle"; do
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "::error::APPROVE_WAIT, APPROVE_INTERVAL and APPROVE_SETTLE must be whole seconds"; exit 1; }
done
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "::error::unexpected repository: $REPO"; exit 1; }

# A workflow command; its message is escaped so a line break or % in it can't end or alter it.
annotate() {
  local level="$1" title="$2" message="$3"
  message="${message//'%'/'%25'}"
  message="${message//$'\r'/'%0D'}"
  message="${message//$'\n'/'%0A'}"
  echo "::$level title=$title::$message"
}

number="$(jq -r '.number // empty' <<< "$PR" 2> /dev/null || true)"
branch="$(jq -r '.headBranchName // empty' <<< "$PR" 2> /dev/null || true)"
[[ "$number" =~ ^[1-9][0-9]*$ ]] || { echo "::error::unexpected release PR number: $number"; exit 1; }
[[ "$branch" =~ ^release-please--[A-Za-z0-9._/-]+$ ]] || { echo "::error::unexpected release branch: $branch"; exit 1; }
url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/pull/$number"

err="$(mktemp)"
trap 'rm -f "$err"' EXIT
last_error() { tail -n 1 "$err" | cut -c1-300; }

# The fix by hand, for the warnings below: the PR page's "Approve workflows to run" button, or the
# API. $1 lists the run IDs if they're known; else the command finds them.
manual_fix() {
  local cmd
  if [[ -n "${1:-}" ]]; then
    cmd="for id in $1; do gh api -X POST repos/$REPO/actions/runs/\$id/approve; done"
  else
    cmd="gh run list --repo $REPO --commit ${sha:-\$(gh pr view $number --repo $REPO --json headRefOid --jq .headRefOid)} --status action_required --json databaseId --jq '.[].databaseId' | xargs -I{} gh api -X POST repos/$REPO/actions/runs/{}/approve"
  fi
  printf '%s\n' "$cmd"
}
join() { local out="$1" item; shift; for item in "$@"; do out+="; $item"; done; printf '%s' "$out"; }
summarized=""
summarize() {
  { [[ -n "$summarized" ]] || printf '### Release PR checks\n\n'; printf '%s\n' "$@" ""; } >> "$summary"
  summarized=1
}
warn_manual() { # title, message, run IDs (optional), lead (optional)
  local fix lead="${4:-Approve them}"
  fix="$(manual_fix "${3:-}")"
  annotate warning "$1" "$2 $lead before merging: open $url and select \"Approve workflows to run\", or run: $fix"
  summarize "$2" "" "$lead before merging the release PR: open $url and select" \
    "**Approve workflows to run** in its merge box, or run:" "" '```bash' "$fix" '```'
}

if ! pull="$(gh api "repos/$REPO/pulls/$number" 2> "$err")"; then
  warn_manual "Release PR checks need approval" \
    "Couldn't read the release PR #$number ($(last_error)), so its workflow runs weren't approved."
  exit 0
fi
sha="$(jq -r '.head.sha // empty' <<< "$pull")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::unexpected head commit of #$number: $sha"; exit 1; }
[[ "$(jq -r '.head.ref' <<< "$pull")" == "$branch" && "$(jq -r '.head.repo.full_name' <<< "$pull")" == "$REPO" ]] \
  || { echo "::error::#$number isn't $REPO's $branch"; exit 1; }
url="$(jq -r '.html_url // empty' <<< "$pull")"
[[ "$url" == https://* ]] || url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/pull/$number"
if [[ "$(jq -r .state <<< "$pull")" != open ]]; then
  annotate notice "Release PR checks" "The release PR #$number is closed; nothing to approve."
  exit 0
fi
echo "Release PR #$number: $branch at $sha" >&2

declare -A seen=()
approved=() refused=() refused_ids="" list_error="" last_new=0
deadline=$((SECONDS + wait_s))
while :; do
  if runs="$(gh api "repos/$REPO/actions/runs?event=pull_request&status=action_required&head_sha=$sha&per_page=100" 2> "$err")"; then
    list_error=""
    while IFS=$'\t' read -r id name; do
      [[ "$id" =~ ^[0-9]+$ && -z "${seen[$id]:-}" ]] || continue
      seen[$id]=1
      last_new=$SECONDS
      if gh api --method POST "repos/$REPO/actions/runs/$id/approve" > /dev/null 2> "$err"; then
        echo "approved run $id ($name)" >&2
        approved+=("$name (run $id)")
      else
        echo "approving run $id ($name) was refused: $(last_error)" >&2
        refused+=("$name (run $id): $(last_error)")
        refused_ids="${refused_ids:+$refused_ids }$id"
      fi
    done < <(jq -r --arg sha "$sha" --arg branch "$branch" --arg repo "$REPO" '.workflow_runs[]?
      | select(.event == "pull_request" and (.conclusion == "action_required" or .status == "action_required")
          and .head_sha == $sha and .head_branch == $branch and .head_repository.full_name == $repo)
      | "\(.id)\t\(.name | gsub("[\t\n\r]"; " "))"' <<< "$runs")
  else
    list_error="$(last_error)"
    echo "listing the runs failed: $list_error" >&2
  fi
  if (( ${#seen[@]} > 0 )); then
    (( SECONDS >= last_new + settle || SECONDS >= deadline + settle )) && break
  else
    (( SECONDS >= deadline )) && break
  fi
  sleep "$interval"
done

if (( ${#approved[@]} > 0 )); then
  annotate notice "Release PR checks" "Approved ${#approved[@]} workflow run(s) of the release PR #$number: $(join "${approved[@]}")"
  summarize "Approved the workflow runs of the release PR [#$number]($url):" "" "${approved[@]/#/- }"
fi
if (( ${#refused[@]} > 0 )); then
  warn_manual "Release PR checks need approval" \
    "GitHub refused to approve ${#refused[@]} workflow run(s) of the release PR #$number with this token: $(join "${refused[@]}")." \
    "$refused_ids"
fi
if (( ${#seen[@]} == 0 )); then
  warn_manual "Release PR checks not found" \
    "No workflow run awaiting approval appeared on the release PR #$number (head ${sha::7}) within ${wait_s}s${list_error:+ (listing them failed: $list_error)}. If its checks are already running, nothing is needed." \
    "" "Otherwise approve its runs"
fi
exit 0
