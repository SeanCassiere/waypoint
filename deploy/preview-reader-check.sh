#!/usr/bin/env bash
# Dry-run checks of preview-reader.sh (no secrets, no network). Run by CI's build-reader job
# and before every real preview upload. Every failure after the upload must delete the preview.
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/preview-reader.sh"
log="$(mktemp -p "${RUNNER_TEMP:-/tmp}")"
trap 'rm -f "$log"' EXIT
run() { : > "$log"; DRY_RUN=1 DRY_RUN_LOG="$log" "$@"; }
fail() { echo "preview-reader check failed: $*" >&2; exit 1; }

run bash "$script" 1 up > /dev/null || fail "up should pass"
[[ "$(cat "$log")" == "upload pr-1" ]] || fail "up should upload and not delete: $(tr '\n' ' ' < "$log")"
run bash "$script" 1 down > /dev/null || fail "down should pass"
[[ "$(cat "$log")" == "delete pr-1" ]] || fail "down should delete: $(tr '\n' ' ' < "$log")"
# wrangler: upload exits nonzero (it may have created the preview). json, urls: unusable output.
# served: 2xx without Access. redirect: 302 elsewhere. error: 5xx. unreachable: no response.
for stage in wrangler json urls served redirect error unreachable; do
  if DRY_RUN_FAIL="$stage" run bash "$script" 1 up > /dev/null 2>&1; then fail "$stage: up should fail"; fi
  [[ "$(tr '\n' ' ' < "$log")" == "upload pr-1 delete pr-1 " ]] || fail "$stage: the preview should be deleted: $(tr '\n' ' ' < "$log")"
  echo "fails closed on $stage"
done
# A cancelled run (the runner sends SIGINT/SIGTERM) must delete it too.
: > "$log"
DRY_RUN=1 DRY_RUN_LOG="$log" DRY_RUN_FAIL=unreachable SMOKE_TIMEOUT_SECONDS=30 bash "$script" 1 up > /dev/null 2>&1 &
pid=$!
for _ in $(seq 50); do grep -q upload "$log" && break; sleep 0.1; done
sleep 0.5
kill -TERM "$pid"
if wait "$pid"; then fail "signal: up should fail"; fi
[[ "$(tr '\n' ' ' < "$log")" == "upload pr-1 delete pr-1 " ]] || fail "signal: the preview should be deleted: $(tr '\n' ' ' < "$log")"
echo "fails closed on SIGTERM"
echo "preview-reader dry-run checks passed"
