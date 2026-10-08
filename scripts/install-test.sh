#!/usr/bin/env bash
# The adopter install test: drives the real deploy/upgrade.sh against a throwaway instance (local
# writer, sync off, no readers) and checks install, upgrade, rollback, idempotence, failure
# rollback, interruption, convergence after a killed run, rerender and its lock, a reader deploy
# killed midway (against a stand-in Wrangler), and idempotence with the writer in a sidecar's
# network namespace (the Tailscale overlay's layout), with the same data directory throughout.
#
# Needs Docker, and pnpm with the workspace installed (upgrade.sh builds the reader).
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
new_image="waypoint-writer:$name-$new_sha"
broken_image="waypoint-writer:$name-broken"
hung_image="waypoint-writer:$name-hung"

work="$(mktemp -d)"
step() { printf '\n=== %s\n' "$*" >&2; }
fail() { echo "install test FAILED: $*" >&2; exit 1; }
cleanup() {
  local status=$?
  step "cleanup"
  if [[ -n "${pid:-}" ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
  if [[ -n "${holder:-}" ]]; then kill -KILL "$holder" 2>/dev/null || true; fi
  if [[ -f "$work/wrangler/hung.pid" ]]; then kill -KILL "$(cat "$work/wrangler/hung.pid")" 2>/dev/null || true; fi
  # A throwaway project, so its volumes go too.
  "${upgrade[@]}" --instance "$work/config/instance.env" compose down --remove-orphans --volumes >/dev/null 2>&1 || true
  local tag
  while IFS= read -r tag; do
    if [[ "$tag" == "$name-"* ]]; then docker_ image rm "waypoint-writer:$tag" >/dev/null 2>&1 || true; fi
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

step "a writer that crashed and restarted once still counts as healthy"
before="$(container)"
# Kill the server process (tini is PID 1), as an OOM kill would; Docker restarts the container.
# shellcheck disable=SC2016 # JavaScript, not shell
docker_ exec "$before" node -e '
  const fs = require("node:fs");
  for (const p of fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d) && d !== String(process.pid)))
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, "utf8").startsWith("node\0dist/main.js\0")) process.kill(Number(p), "SIGKILL"); } catch {}
'
for _ in $(seq 90); do
  [[ "$(docker_ inspect --format '{{.RestartCount}} {{.State.Health.Status}}' "$before")" == "1 healthy" ]] && break
  sleep 1
done
[[ "$(docker_ inspect --format '{{.RestartCount}} {{.State.Health.Status}}' "$before")" == "1 healthy" ]] || fail "the writer didn't restart and recover"
up current-checkout
[[ "$(container)" == "$before" ]] || fail "a rerun recreated a writer that had restarted once"

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

step "a killed deploy leaves its marker, and a rerun converges"
hung_id="$(docker_ image inspect --format '{{.Id}}' "$hung_image")"
new_id="$(docker_ image inspect --format '{{.Id}}' "$new_image")"
# Its scratch directory goes with $work.
TMPDIR="$work" "${upgrade[@]}" --instance "$work/config/instance.env" image "$hung_image" &
pid=$!
for _ in $(seq 60); do
  [[ "$(docker_ inspect --format '{{.Image}} {{.State.Status}}' "$(container)" 2>/dev/null)" == "$hung_id running" ]] && break
  sleep 1
done
[[ "$(docker_ inspect --format '{{.Image}}' "$(container)")" == "$hung_id" ]] || fail "the hung writer never started"
kill -KILL "$pid"
wait "$pid" || true
pid=""
[[ -f "$state/deploying" ]] || fail "the deploying marker didn't survive SIGKILL"
up current-checkout
expect_build "$new_sha" "$new_version"
expect_data
[[ "$(docker_ inspect --format '{{.Image}}' "$(container)")" == "$new_id" ]] || fail "the rerun didn't go back to this commit's image"
[[ ! -f "$state/deploying" ]] || fail "the rerun left the deploying marker"
# The killed run's writer was never healthy, so the last healthy image stays the rollback target.
[[ "$(docker_ image inspect --format '{{.Id}}' "waypoint-writer:$name-previous")" == "$new_id" ]] || fail "the previous image isn't the last healthy one"

step "rerender waits for the instance lock, dry runs too"
( exec 8> "$state/lock"; flock 8; exec sleep 300 ) &
holder=$!
for _ in $(seq 20); do flock -n "$state/lock" true || break; sleep 0.5; done
started="$(docker_ inspect --format '{{.State.StartedAt}}' "$(container)")"
if LOCK_WAIT_SECONDS=2 up --dry-run rerender 2> "$work/locked.log"; then fail "a rerender ran while another run held the lock"; fi
grep -q 'timed out waiting for the instance lock' "$work/locked.log" || { cat "$work/locked.log" >&2; fail "rerender didn't wait for the lock"; }
[[ "$(docker_ inspect --format '{{.State.StartedAt}}' "$(container)")" == "$started" ]] || fail "a locked-out rerender restarted the writer"
kill -KILL "$holder"
wait "$holder" 2>/dev/null || true
holder=""

step "rerender"
up rerender > "$work/rerender.log" 2>&1 || { cat "$work/rerender.log" >&2; fail "rerender failed"; }
grep -q '"sources":1' "$work/rerender.log" || { cat "$work/rerender.log" >&2; fail "rerender didn't see the markdown"; }
expect_build "$new_sha" "$new_version"
expect_data

step "a reader deploy killed midway rolls back to the version from before it"
# A stand-in Wrangler for one Worker: `deploy` makes a new version the deployed one, `rollback`
# deploys the one named, `deployments list` reports the deployed one. With $fake/hang, `deploy`
# hangs after deploying, like a run killed before its smoke test.
fake="$work/wrangler"
mkdir -p "$fake"
echo v0 > "$fake/current"
echo 0 > "$fake/count"
cat > "$fake/wrangler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")"
printf '%s\n' "$*" >> "$d/calls"
case "$1 ${2:-}" in
  "deployments list") printf '[{"versions":[{"version_id":"%s"}]}]\n' "$(cat "$d/current")" ;;
  "secret bulk") ;;
  deploy*)
    n=$(( $(cat "$d/count") + 1 )); echo "$n" > "$d/count"; echo "v$n" > "$d/current"
    if [[ -f "$d/hang" ]]; then echo "$$" > "$d/hung.pid"; exec sleep 600; fi
    ;;
  "rollback "*) echo "$2" > "$d/current" ;;
  *) exit 2 ;;
esac
EOF
chmod 700 "$fake/wrangler"
printf 'CLOUDFLARE_ACCOUNT_ID=install-test\nCLOUDFLARE_API_TOKEN=install-test\n' > "$work/config/cloudflare.env"
printf '%s\n' TURSO_DATABASE_URL=libsql://db.example.test TURSO_READONLY_TOKEN=x R2_ACCOUNT_ID=x \
  R2_READER_ACCESS_KEY_ID=x R2_READER_SECRET_ACCESS_KEY=x R2_BUCKET=x RAW_CAP_KEY=x > "$work/config/reader.env"
chmod 600 "$work/config/cloudflare.env" "$work/config/reader.env"
# In the same directory, so it shares the state directory of the instance without readers. A
# .test domain never resolves, so every smoke test fails.
{
  cat "$work/config/instance.env"
  printf '%s\n' READER_TARGETS=one READER_one_WORKER=install-test-reader READER_one_DOMAIN=reader.example.test \
    READER_one_SECRETS_FILE=reader.env READER_one_ANALYTICS_DATASET=install_test READER_one_RATELIMIT_NAMESPACE=1
} > "$work/config/reader-instance.env"
chmod 600 "$work/config/reader-instance.env"
before="$(container)"
touch "$fake/hang"
TMPDIR="$work" WRANGLER="$fake/wrangler" "${upgrade[@]}" --instance "$work/config/reader-instance.env" current-checkout &
pid=$!
for _ in $(seq 600); do [[ -f "$fake/hung.pid" ]] && break; sleep 1; done
[[ -f "$fake/hung.pid" ]] || fail "the reader deploy never started"
kill -KILL "$pid"
wait "$pid" || true
pid=""
# Wrangler outlives a killed upgrade.sh and holds the instance lock it inherited; stop it too.
kill -KILL "$(cat "$fake/hung.pid")"
rm -f "$fake/hang" "$fake/hung.pid"
[[ "$(cat "$fake/current")" == v1 ]] || fail "the killed run didn't deploy"
[[ -f "$state/rollback-reader-one" && -f "$state/deploying" ]] || fail "the killed reader deploy left no rollback record"
: > "$fake/calls"
if SMOKE_TIMEOUT_SECONDS=1 WRANGLER="$fake/wrangler" "${upgrade[@]}" --instance "$work/config/reader-instance.env" current-checkout 2> "$work/reader.log"; then
  fail "a reader that fails its smoke test deployed"
fi
grep -q '^rollback v0 ' "$fake/calls" || { cat "$fake/calls" "$work/reader.log" >&2; fail "the rerun didn't roll back to the version from before the killed run"; }
! grep -q '^deployments list' "$fake/calls" || fail "the rerun looked up a new rollback target"
[[ "$(cat "$fake/current")" == v0 ]] || fail "the Worker doesn't serve the version from before the killed run"
[[ ! -f "$state/rollback-reader-one" && ! -f "$state/deploying" ]] || fail "a successful rollback left its records"
[[ "$(container)" == "$before" ]] || fail "the reader runs recreated the writer"

step "with the writer in a sidecar's network namespace, a rerun is still a no-op"
# The Tailscale overlay's layout (network_mode: service:ts-waypoint), with a stand-in sidecar
# that only holds the namespace. Compose labels such a writer with a config hash that never
# equals `compose config --hash`, so upgrade.sh mustn't rely on the label.
printf 'TS_AUTHKEY=unused\n' > "$work/config/ts.env"
chmod 600 "$work/config/ts.env"
cat > "$work/config/sidecar.yaml" <<EOF
services:
  ts-waypoint:
    image: $old_image
    entrypoint: ["node", "-e", "setInterval(() => {}, 1 << 30)"]
    volumes: !reset []
    healthcheck:
      disable: true
EOF
chmod 644 "$work/config/sidecar.yaml"
printf 'TAILSCALE=on\nTAILSCALE_ENV_FILE=ts.env\nCOMPOSE_OVERRIDE=sidecar.yaml\n' >> "$work/config/instance.env"
up current-checkout
expect_build "$new_sha" "$new_version"
expect_data
[[ "$(docker_ inspect --format '{{.HostConfig.NetworkMode}}' "$(container)")" == container:* ]] || fail "the writer isn't in the sidecar's namespace"
before="$(container)"
up current-checkout
[[ "$(container)" == "$before" ]] || fail "a rerun recreated the writer behind the sidecar"

step "status"
up status

echo "install test passed: $old_sha -> $new_sha -> $old_sha -> $new_sha" >&2
