#!/usr/bin/env bash
# The adopter install test: drives the real deploy/upgrade.sh against a throwaway instance (local
# writer, sync off, no readers) and checks install, upgrade, rollback, idempotence, failure
# rollback, interruption and rerender, with the same data directory throughout.
#
#   scripts/install-test.sh [old-ref]
#
# old-ref is the commit to roll back to (default: the merge base with origin/main, or HEAD^ when
# HEAD is on it). Everything it creates is named after INSTALL_TEST_NAME (default install-test):
# the Compose project, the waypoint-writer:<name>-* images and a scratch directory. It removes
# them at the end, and never touches another project.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="${INSTALL_TEST_NAME:-install-test}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ && "$name" != waypoint ]] || { echo "bad INSTALL_TEST_NAME" >&2; exit 2; }
port="${INSTALL_TEST_PORT:-17410}"
upgrade=(bash "$repo/deploy/upgrade.sh")

if docker info >/dev/null 2>&1; then
  docker_() { docker "$@"; }
else
  # A login session that predates docker-group membership.
  docker_() { local q='' a; for a in "$@"; do printf -v q '%s%q ' "$q" "$a"; done; sg docker -c "docker $q"; }
fi

old_ref="${1:-}"
if [[ -z "$old_ref" ]]; then
  old_ref="$(git -C "$repo" merge-base HEAD origin/main)"
  if [[ "$old_ref" == "$(git -C "$repo" rev-parse HEAD)" ]]; then old_ref="$(git -C "$repo" rev-parse HEAD^)"; fi
fi
old_sha="$(git -C "$repo" rev-parse --verify "$old_ref^{commit}")"
new_sha="$(git -C "$repo" rev-parse HEAD)"
new_version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"
old_image="waypoint-writer:$name-old"
broken_image="waypoint-writer:$name-broken"
hung_image="waypoint-writer:$name-hung"

work="$(mktemp -d)"
step() { printf '\n=== %s\n' "$*" >&2; }
fail() { echo "install test FAILED: $*" >&2; exit 1; }
cleanup() {
  local status=$?
  step "cleanup"
  if [[ -n "${pid:-}" ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
  "${upgrade[@]}" --instance "$work/config/instance.env" compose down --remove-orphans >/dev/null 2>&1 || true
  local tag
  while IFS= read -r tag; do
    [[ "$tag" == "$name-"* ]] && docker_ image rm "waypoint-writer:$tag" >/dev/null 2>&1 || true
  done < <(docker_ image ls waypoint-writer --format '{{.Tag}}')
  git -C "$repo" worktree remove --force "$work/old" >/dev/null 2>&1 || true
  if [[ -d "$work/data" && "$(stat -c %u "$work/data")" != "$(id -u)" ]]; then sudo -n rm -rf "$work/data" || true; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step "old image from $old_sha"
git -C "$repo" worktree add --detach "$work/old" "$old_sha" >/dev/null
docker_ build -q -f "$work/old/apps/writer/Dockerfile" --build-arg "WAYPOINT_BUILD_SHA=$old_sha" -t "$old_image" "$work/old" >/dev/null
git -C "$repo" worktree remove --force "$work/old"

step "instance"
mkdir -m 700 "$work/config"
printf 'WAYPOINT_ENV=dev\nWAYPOINT_SYNC=off\n' > "$work/config/writer.env"
chmod 600 "$work/config/writer.env"
if [[ "$(id -u)" == 1000 ]]; then
  mkdir -m 700 "$work/data"
else
  sudo -n install -d -m 700 -o 1000 -g 1000 "$work/data"
fi
cat > "$work/config/instance.env" <<EOF
DATA_DIR=$work/data
WRITER_ENV_FILE=writer.env
COMPOSE_PROJECT=$name
WRITER_HOST_PORT=$port
EOF
chmod 600 "$work/config/instance.env"
"${upgrade[@]}" --instance "$work/config/instance.env" validate

up() { "${upgrade[@]}" --instance "$work/config/instance.env" "$@"; }
container() { up compose ps -q writer; }
# Runs JavaScript inside the writer container, against the writer's own port.
writer_js() { docker_ exec -i "$(container)" node --input-type=module -; }
healthz() { echo 'const r = await fetch("http://127.0.0.1:7410/healthz"); process.stdout.write(await r.text());' | writer_js; }
expect_build() {
  local body; body="$(healthz)"
  node -e '
    const [body, sha, version] = process.argv.slice(1); const h = JSON.parse(body);
    if (h.ok !== true || h.sha !== sha || (version && h.version !== version)) { console.error(body); process.exit(1); }
  ' "$body" "$1" "${2:-}" || fail "expected build $1, got $body"
}
expect_data() {
  local text
  text="$(writer_js <<EOF
const r = await fetch("http://127.0.0.1:7410/api/collections/$collection?include_head=1");
const c = await r.json();
process.stdout.write(c.head?.text ?? c.head_text ?? JSON.stringify(c));
EOF
)"
  [[ "$text" == *"written before the hops"* ]] || fail "data written before the hops is gone: $text"
}

step "install the old writer (no previous image)"
up image "$old_image"
expect_build "$old_sha"
collection="$(writer_js <<'EOF'
const form = new FormData();
form.append("meta", JSON.stringify({ title: "Install test", head_path: "notes.md" }));
form.append("file:notes.md", new Blob(["# Notes\n\nwritten before the hops\n"], { type: "text/markdown" }), "notes.md");
const r = await fetch("http://127.0.0.1:7410/api/collections", { method: "POST", body: form });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
process.stdout.write((await r.json()).collection_id);
EOF
)"
[[ "$collection" == col_* ]] || fail "couldn't create a collection: $collection"
expect_data

step "upgrade to this commit (current-checkout)"
up current-checkout
expect_build "$new_sha" "$new_version"
expect_data
curl -fsS "http://127.0.0.1:$port/healthz" | grep -q "$new_sha" || fail "the published port doesn't reach the writer"

step "the same version again is a no-op"
before="$(container)"
up current-checkout
[[ "$(container)" == "$before" ]] || fail "a rerun recreated the writer"

step "roll back to the old writer"
up image "$old_image"
expect_build "$old_sha"
expect_data

step "and forward again"
up current-checkout
expect_build "$new_sha" "$new_version"
expect_data

step "a broken image is rolled back"
printf 'FROM %s\nCMD ["node", "-e", "process.exit(3)"]\n' "waypoint-writer:$name-current" | docker_ build -q -t "$broken_image" - >/dev/null
if up image "$broken_image"; then fail "deploying a broken image succeeded"; fi
expect_build "$new_sha" "$new_version"
expect_data

step "an interrupted deploy is rolled back"
printf 'FROM %s\nCMD ["node", "-e", "setInterval(() => {}, 1000)"]\n' "waypoint-writer:$name-current" | docker_ build -q -t "$hung_image" - >/dev/null
# Started directly (not through a function), so $! is upgrade.sh itself.
"${upgrade[@]}" --instance "$work/config/instance.env" image "$hung_image" &
pid=$!
state="$work/config/state/$name"
for _ in $(seq 60); do [[ -f "$state/deploying" ]] && break; sleep 1; done
[[ -f "$state/deploying" ]] || fail "the deploy never started"
sleep 5
kill -TERM "$pid"
status=0; wait "$pid" || status=$?
[[ "$status" == 143 ]] || fail "an interrupted deploy exited $status, expected 143"
[[ ! -f "$state/deploying" ]] || fail "the deploying marker survived a successful rollback"
expect_build "$new_sha" "$new_version"
expect_data

step "a rerun converges"
up current-checkout
expect_build "$new_sha" "$new_version"

step "rerender"
up rerender > "$work/rerender.log" 2>&1 || { cat "$work/rerender.log" >&2; fail "rerender failed"; }
grep -q '"sources":1' "$work/rerender.log" || { cat "$work/rerender.log" >&2; fail "rerender didn't see the markdown"; }
expect_build "$new_sha" "$new_version"
expect_data

step "status"
up status

echo "install test passed: $old_sha -> $new_sha -> $old_sha -> $new_sha" >&2
