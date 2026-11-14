#!/usr/bin/env bash
# Tests `upgrade.sh rerender`'s watch of a writer that re-renders by itself (rerender_wait) against
# a stubbed Docker: which writer containers it tells to end their post-start delay
# (POST /api/rerender/start). A release deployed during the watch must keep its delay (D89), even
# when it replaces the writer between the status read and the POST, or reports the same version
# and no commit. Runs no Docker and touches no instance: the functions are copied out of
# deploy/upgrade.sh, and `docker exec <container> node -e <script>` runs the script here, with a
# fetch that answers from a scratch directory. Run by tests/rerender-watch.test.ts.
#
# Usage: bash scripts/rerender-watch-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upgrade="$root/deploy/upgrade.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The functions under test, verbatim. Each starts with `name() {` and ends with a `}` line, or is
# one line ending in `; }`.
functions="$work/functions.sh"
for name in writer_rerender_status rerender_parse rerender_capable rerender_start_now rerender_wait rerender_renderer_lines; do
  awk -v name="$name" '
    !inside && index($0, name "() {") == 1 { inside = 1; print; if ($0 ~ /; }$/) inside = 0; next }
    inside { print; if ($0 == "}") inside = 0 }
  ' "$upgrade" > "$work/$name.sh"
  [[ -s "$work/$name.sh" ]] || { echo "deploy/upgrade.sh has no $name()" >&2; exit 1; }
  cat "$work/$name.sh" >> "$functions"
done

# A fetch for the scripts run "inside" a container: GET /api/status answers with the container's
# status.json; POST /api/rerender/start records the container in $FAKE/starts.
# shellcheck disable=SC2016 # JavaScript, not shell
fetch_prelude='
const fakeFs = require("node:fs");
globalThis.fetch = async (url, init = {}) => {
  const dir = `${process.env.FAKE}/c/${process.env.FAKE_CONTAINER}`;
  if (url.endsWith("/api/status"))
    return { ok: true, json: async () => JSON.parse(fakeFs.readFileSync(`${dir}/status.json`, "utf8")) };
  if (url.endsWith("/api/rerender/start") && init.method === "POST") {
    fakeFs.appendFileSync(`${process.env.FAKE}/starts`, `${process.env.FAKE_CONTAINER}\n`);
    return { ok: true };
  }
  return { ok: false, status: 404 };
};
'

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }

# Runs one scenario in a subshell with fresh stubs. The scenario function sets up containers, and
# may define after_status <container> <read count> (runs after each status read) and
# on_tick <tick> (runs at each 5 s sleep).
scenario() {
  local title="$1" fn="$2" expected="$3" fake actual
  fake="$work/$fn"
  mkdir -p "$fake/c"
  : > "$fake/starts"
  FAKE="$fake"
  export FAKE
  if ! (
    # shellcheck source=/dev/null
    . "$functions"
    # shellcheck disable=SC2034 # read by the copied rerender functions
    dry_run=0
    # shellcheck disable=SC2034 # read by the copied rerender functions
    rerender_limit_set=0
    log() { printf '  %s\n' "$*" >> "$FAKE/log"; }
    die() { log "die: $*"; exit 1; }
    # shellcheck disable=SC2329 # a stub called by the copied functions
    writer_container() { cat "$FAKE/current" 2>/dev/null || true; }
    # shellcheck disable=SC2329 # a stub called by the copied functions
    container_field() { cat "$FAKE/c/$1/image" 2>/dev/null || true; }
    # shellcheck disable=SC2329 # a stub called by the copied functions
    docker_run() {
      [[ "$1 $3 $4" == "exec node -e" ]] || { echo "unexpected docker_run $*" >&2; return 2; }
      local id="$2" script="$5" reads
      shift 5
      [[ -d "$FAKE/c/$id" ]] || { echo "Error response from daemon: No such container: $id" >&2; return 1; }
      FAKE_CONTAINER="$id" node -e "$fetch_prelude$script" "$@" || return
      if [[ "$script" == *"/api/status"* ]]; then
        reads=$(( $(cat "$FAKE/reads" 2>/dev/null || echo 0) + 1 ))
        echo "$reads" > "$FAKE/reads"
        if declare -F after_status >/dev/null; then after_status "$id" "$reads"; fi
      fi
    }
    ticks=0
    # shellcheck disable=SC2329 # a stub called by the copied functions
    sleep() {
      ticks=$((ticks + 1))
      if declare -F on_tick >/dev/null; then on_tick "$ticks"; fi
      (( ticks < 50 )) || die "the watch never ended"
    }
    "$fn"
    status="$(writer_rerender_status)"
    rerender_capable "$status" || die "the first status isn't a capable writer: $status"
    rerender_wait "$status"
  ); then
    fail "$title: the watch failed"
    cat "$fake/log" >&2 2>/dev/null || true
    return 0
  fi
  actual="$(tr '\n' ' ' < "$fake/starts" | sed 's/ $//')"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok: $title"
  else
    fail "$title: started [$actual], expected [$expected]"
    cat "$fake/log" >&2
  fi
}

# container <id> <image ID, or "" for one that can't be read> <state> <version> <sha>
# Version and sha are JSON values (null, or a quoted string). A container whose directory exists
# is running; current is what writer_container resolves.
container() {
  local dir="$FAKE/c/$1" left=3 starts=null
  mkdir -p "$dir"
  if [[ -n "$2" ]]; then printf '%s\n' "$2" > "$dir/image"; else rm -f "$dir/image"; fi
  if [[ "$3" == "done" ]]; then left=0; fi
  if [[ "$3" == waiting ]]; then starts=1794650000000; fi
  cat > "$dir/status.json" <<JSON
{"version": $4, "sha": $5, "queue": {"rerender_pending": 0},
 "rerender": {"mode": "auto", "state": "$3", "starts_at": $starts, "paused_reason": null,
  "stale": $left, "skipped": 0, "left": $left, "rendered": 0,
  "renderers": [{"renderer": "markdown", "version": 6, "stale": $left, "skipped": 0, "left": $left}]}}
JSON
}
replace() { rm -rf "${FAKE:?}/c/$1"; container "${@:2}"; echo "$2" > "$FAKE/current"; }

# 1. The status says build A is waiting; before the POST, a deploy replaces A's container with
# B's. The POST goes to the container that was read (and fails), never to B.
replaced_between_read_and_post() {
  container a1 sha256:aaa waiting '"0.8.0"' '"1111111111111111111111111111111111111111"'
  echo a1 > "$FAKE/current"
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  after_status() {
    if [[ "$1 $2" == "a1 1" ]]; then
      replace a1 b1 sha256:bbb waiting '"0.9.0"' '"2222222222222222222222222222222222222222"'
    fi
  }
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  on_tick() { if (( $1 == 3 )); then container b1 sha256:bbb "done" '"0.9.0"' '"2222222222222222222222222222222222222222"'; fi; }
}
scenario "a writer replaced between the status read and the POST keeps its delay" replaced_between_read_and_post ""

# 2. Images built without WAYPOINT_BUILD_SHA report no commit: a different image with the same
# version is still another build, and keeps its delay.
same_version_no_sha() {
  container a2 sha256:aaa waiting '"0.8.0"' null
  echo a2 > "$FAKE/current"
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  on_tick() {
    case "$1" in
      1) replace a2 b2 sha256:bbb waiting '"0.8.0"' null ;;
      4) container b2 sha256:bbb "done" '"0.8.0"' null ;;
    esac
  }
}
scenario "another image with the same version and no commit keeps its delay" same_version_no_sha "a2"

# 3. The same with neither version nor commit.
no_build_metadata() {
  container a3 sha256:aaa waiting null null
  echo a3 > "$FAKE/current"
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  on_tick() {
    case "$1" in
      1) replace a3 b3 sha256:bbb waiting null null ;;
      4) container b3 sha256:bbb "done" null null ;;
    esac
  }
}
scenario "another image with no version and no commit keeps its delay" no_build_metadata "a3"

# 4. The build the watch began on is told to start again after a restart in place and after a
# recreate on the same image (unchanged behaviour).
same_image_restarted() {
  container a4 sha256:aaa waiting '"0.8.0"' null
  echo a4 > "$FAKE/current"
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  on_tick() {
    case "$1" in
      2) replace a4 c4 sha256:aaa waiting '"0.8.0"' null ;;
      3) container c4 sha256:aaa running '"0.8.0"' null ;;
      4) container c4 sha256:aaa "done" '"0.8.0"' null ;;
    esac
  }
}
scenario "the same image is told to start after a restart and a recreate" same_image_restarted "a4 a4 c4"

# 5. A writer whose image can't be read is never told to start: it might be a new release.
unknown_image() {
  container a5 "" waiting '"0.8.0"' '"1111111111111111111111111111111111111111"'
  echo a5 > "$FAKE/current"
  # shellcheck disable=SC2329 # a hook called by scenario's stubs
  on_tick() { if (( $1 == 2 )); then container a5 "" "done" '"0.8.0"' '"1111111111111111111111111111111111111111"'; fi; }
}
scenario "a writer whose image can't be read keeps its delay" unknown_image ""

if (( failures )); then
  echo "$failures scenario(s) failed" >&2
  exit 1
fi
echo "all rerender watch scenarios passed"
