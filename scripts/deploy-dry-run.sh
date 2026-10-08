#!/usr/bin/env bash
# Checks deploy/upgrade.sh without deploying anything: a scratch instance with two reader targets
# and fake credentials, then `upgrade.sh --dry-run current-checkout` (the generated Wrangler
# configs go through `wrangler deploy --dry-run`; the reader steps run against a stand-in
# Wrangler), a smoke failure that must roll back (to a killed run's recorded target, unless it
# was saved for another Worker), two concurrent dry runs of another release
# (its bundle must be installed once, under the instance lock), and instance files that must be
# refused.
#
# Needs the reader build (pnpm --filter "@waypoint/reader..." build) and Docker (compose config).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "deploy dry run FAILED: $*" >&2; exit 1; }
upgrade() { bash "$repo/deploy/upgrade.sh" --instance "$work/instance.env" "$@"; }

cd "$work"
chmod 700 "$work"
printf 'WAYPOINT_ENV=prod\nWAYPOINT_SYNC=off\n' > writer.env
printf 'CLOUDFLARE_ACCOUNT_ID=dry-run\nCLOUDFLARE_API_TOKEN=dry-run\n' > cloudflare.env
reader_secrets='TURSO_DATABASE_URL=libsql://db.example.test
TURSO_READONLY_TOKEN=dry-run
R2_READER_ACCESS_KEY_ID=dry-run
R2_READER_SECRET_ACCESS_KEY=dry-run
R2_BUCKET=dry-run
RAW_CAP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
printf '%s\nR2_ACCOUNT_ID=dry-run\n' "$reader_secrets" > reader-dev.env
# The other target uses another S3-compatible store instead of R2, with a secret key holding
# characters a shell would interpret; secrets files take them literally.
{
  printf '%s\n' "$reader_secrets" | grep -v '^R2_READER_SECRET_ACCESS_KEY='
  cat <<'EOF'
R2_READER_SECRET_ACCESS_KEY=dry-run$x`y"z'
WAYPOINT_S3_ENDPOINT=https://s3.example.test
WAYPOINT_S3_REGION=us-east-1
EOF
} > reader-prod.env
chmod 600 ./*.env
write_instance() {
  cat > instance.env <<EOF
DATA_DIR=$work/data
WRITER_ENV_FILE=writer.env
COMPOSE_PROJECT=deploy-dry-run
TAILSCALE=$1
TAILSCALE_ENV_FILE=writer.env
TAILSCALE_TAGS=tag:example
READER_TARGETS=dev prod
READER_dev_WORKER=example-reader-dev
READER_dev_DOMAIN=dev.share.example.com
READER_dev_SECRETS_FILE=reader-dev.env
READER_dev_ANALYTICS_DATASET=example_access_dev
READER_dev_RATELIMIT_NAMESPACE=1001
READER_prod_WORKER=example-reader
READER_prod_DOMAIN=share.example.com
READER_prod_SECRETS_FILE=$work/reader-prod.env
READER_prod_ANALYTICS_DATASET=example_access
READER_prod_RATELIMIT_NAMESPACE=1002
READER_prod_WORKERS_DEV=true
EOF
  chmod 644 instance.env
}

for tailscale in off on; do
  write_instance "$tailscale"
  echo "--- dry run (tailscale $tailscale)" >&2
  : > wrangler.log
  DRY_RUN_LOG="$work/wrangler.log" upgrade --dry-run --allow-dirty current-checkout
  [[ "$(grep -c '^wrangler deploy --config' wrangler.log)" == 2 ]] || fail "expected two reader deploys"
  grep -q "^wrangler deploy --config .*reader-dev.json --var WAYPOINT_BUILD_SHA:$(git -C "$repo" rev-parse HEAD)$" wrangler.log || fail "the dev deploy doesn't carry the commit"
  ! grep -q rollback wrangler.log || fail "a passing dry run rolled back"
done

echo "--- a failed smoke test rolls back" >&2
: > wrangler.log
if DRY_RUN_LOG="$work/wrangler.log" DRY_RUN_FAIL_SMOKE=prod upgrade --dry-run --allow-dirty current-checkout; then
  fail "a failed smoke test passed"
fi
grep -q '^wrangler rollback dry-run-previous --config .*reader-prod.json' wrangler.log || fail "no rollback after the failed smoke test"
grep -q 'reader-dev.json' wrangler.log || fail "dev didn't deploy before prod"

echo "--- a failed deployments lookup stops the run before anything changes" >&2
: > wrangler.log
if DRY_RUN_LOG="$work/wrangler.log" DRY_RUN_DEPLOYMENTS=fail:prod upgrade --dry-run --allow-dirty current-checkout 2> err.log; then
  fail "a failed deployments lookup passed"
fi
grep -q "no version to roll back to" err.log || { cat err.log >&2; fail "the lookup failure isn't reported"; }
! grep -q 'would deploy the writer' err.log || fail "the writer step ran before the reader lookups"
! grep -Eq '^wrangler (secret|deploy|rollback) ' wrangler.log || fail "a reader changed after a failed lookup"

echo "--- a Worker that doesn't exist yet is a first deployment" >&2
: > wrangler.log
DRY_RUN_LOG="$work/wrangler.log" DRY_RUN_DEPLOYMENTS=missing:prod upgrade --dry-run --allow-dirty current-checkout 2> err.log \
  || { cat err.log >&2; fail "a first deployment failed"; }
grep -q "doesn't exist yet" err.log || fail "the first deployment isn't reported"
grep -q '^wrangler deploy --config .*reader-prod.json' wrangler.log || fail "the new Worker wasn't deployed"

echo "--- a killed run's reader rollback target is kept, unless it's for another Worker" >&2
state="$work/state/deploy-dry-run"
mkdir -p "$state"
printf 'version=killed-run-previous\nworker=example-reader\n' > "$state/rollback-reader-prod"
: > wrangler.log
if DRY_RUN_LOG="$work/wrangler.log" DRY_RUN_FAIL_SMOKE=prod upgrade --dry-run --allow-dirty current-checkout 2> err.log; then
  fail "a failed smoke test passed"
fi
grep -q '^wrangler rollback killed-run-previous --config .*reader-prod.json' wrangler.log || { cat err.log >&2; fail "the rollback didn't use the killed run's target"; }
! grep -q '^wrangler deployments list .*reader-prod.json' wrangler.log || fail "a new rollback target was looked up despite the record"
printf 'version=killed-run-previous\nworker=renamed-reader\n' > "$state/rollback-reader-prod"
: > wrangler.log
if DRY_RUN_LOG="$work/wrangler.log" DRY_RUN_FAIL_SMOKE=prod upgrade --dry-run --allow-dirty current-checkout 2> err.log; then
  fail "a failed smoke test passed"
fi
grep -q 'on the Worker renamed-reader, not example-reader' err.log || { cat err.log >&2; fail "the other Worker's record isn't reported"; }
grep -q '^wrangler rollback dry-run-previous --config .*reader-prod.json' wrangler.log || { cat wrangler.log >&2; fail "the rollback used another Worker's version"; }
rm -f "$state/rollback-reader-prod"

echo "--- make-instance-env.sh writes a valid instance" >&2
printf 'TS_AUTHKEY=dry-run\n' > ts.env
chmod 600 ts.env
bash "$repo/deploy/make-instance-env.sh" --output "$work/made.env" --data-dir "$work/data" \
  --writer-env writer.env --project deploy-dry-run --tailscale --ts-env ts.env --ts-tags tag:example \
  --health-url https://writer.example.test/healthz --cloudflare-env cloudflare.env \
  --release-repo example/waypoint --verify-attestations 1 \
  --reader dev,example-reader-dev,dev.share.example.com,reader-dev.env,example_access_dev,1001 \
  --reader prod,example-reader,share.example.com,reader-prod.env,example_access,1002,true
grep -qx 'READER_TARGETS=dev prod' made.env || fail "make-instance-env.sh lost the target order"
grep -qx 'READER_prod_WORKERS_DEV=true' made.env || fail "make-instance-env.sh dropped WORKERS_DEV"
grep -qx 'VERIFY_ATTESTATIONS=1' made.env || fail "make-instance-env.sh dropped VERIFY_ATTESTATIONS"
grep -qx 'RELEASE_REPO=example/waypoint' made.env || fail "make-instance-env.sh dropped RELEASE_REPO"
if bash "$repo/deploy/make-instance-env.sh" --output "$work/made.env" --data-dir "$work/data" --writer-env writer.env 2> /dev/null; then
  fail "make-instance-env.sh overwrote an instance file"
fi
if bash "$repo/deploy/make-instance-env.sh" --output "$work/made-ts.env" --data-dir "$work/data" --writer-env writer.env \
  --ts-env ts.env --ts-tags tag:example 2> err.log; then
  fail "make-instance-env.sh dropped Tailscale settings without --tailscale"
fi
grep -q 'need --tailscale' err.log || { cat err.log >&2; fail "the missing --tailscale isn't named"; }
if bash "$repo/deploy/make-instance-env.sh" --output "$work/made-cf.env" --data-dir "$work/data" --writer-env writer.env \
  --cloudflare-env cloudflare.env 2> err.log; then
  fail "make-instance-env.sh dropped --cloudflare-env without a reader"
fi
grep -q 'needs a --reader' err.log || { cat err.log >&2; fail "the missing --reader isn't named"; }

echo "--- compose --dry-run only prints the command" >&2
write_instance off
upgrade --dry-run compose down --volumes 2> err.log || { cat err.log >&2; fail "compose --dry-run failed"; }
grep -q 'would run: docker compose -p deploy-dry-run .* down --volumes$' err.log || { cat err.log >&2; fail "compose --dry-run didn't print the command"; }

echo "--- concurrent runs of another release install its bundle once, under the instance lock" >&2
# A minimal bundle for version 9.9.9 (no readers), served by a stand-in curl that's slow and
# counts downloads; anything else goes to the real curl. Attestations are off here; the release
# path with them is scripts/release-dry-run.sh.
rel="$work/release"
bundle="$rel/waypoint-deploy-9.9.9"
mkdir -p "$bundle/lib" "$rel/bin"
cp "$repo/deploy/upgrade.sh" "$repo/deploy/compose.yaml" "$repo/deploy/compose.tailscale.yaml" "$repo/deploy/serve.json" "$bundle/"
cp "$repo/deploy/lib/"* "$bundle/lib/"
echo 9.9.9 > "$bundle/VERSION"
git -C "$repo" rev-parse HEAD > "$bundle/BUILD_SHA"
(cd "$bundle" && find . -type f -printf '%P\n' | sort | xargs sha256sum > "$rel/SHA256SUMS")
mv "$rel/SHA256SUMS" "$bundle/SHA256SUMS"
tar -czf "$rel/bundle.tgz" -C "$rel" waypoint-deploy-9.9.9
cat > "$rel/bin/curl" <<EOF
#!/usr/bin/env bash
out="" url=""
for ((i = 1; i <= \$#; i++)); do
  case "\${!i}" in
    -o) j=\$((i + 1)); out="\${!j}" ;;
    https://*) url="\${!i}" ;;
  esac
done
if [[ "\$url" == https://github.com/example/waypoint/releases/download/v9.9.9/waypoint-deploy-9.9.9.tgz ]]; then
  echo download >> "$rel/downloads"
  sleep 2
  exec cp "$rel/bundle.tgz" "\$out"
fi
exec "$(command -v curl)" "\$@"
EOF
chmod 700 "$rel/bin/curl"
cat > release.env <<EOF
DATA_DIR=$work/data
WRITER_ENV_FILE=writer.env
COMPOSE_PROJECT=deploy-dry-run
RELEASE_REPO=example/waypoint
VERIFY_ATTESTATIONS=0
EOF
chmod 644 release.env
release_run() { PATH="$rel/bin:$PATH" bash "$repo/deploy/upgrade.sh" --instance "$work/release.env" --dry-run 9.9.9 2> "$rel/$1.log"; }
release_run a & pid_a=$!
release_run b & pid_b=$!
release_check() {
  wait "$2" || { cat "$rel/$1.log" >&2; fail "concurrent run $1 failed"; }
  grep -q 'dry run passed: release-9.9.9' "$rel/$1.log" || { cat "$rel/$1.log" >&2; fail "run $1 didn't run the 9.9.9 bundle"; }
}
release_check a "$pid_a"
release_check b "$pid_b"
[[ "$(wc -l < "$rel/downloads")" == 1 ]] || fail "concurrent runs downloaded the bundle $(wc -l < "$rel/downloads") times"
cmp -s "$repo/deploy/upgrade.sh" "$work/state/deploy-dry-run/releases/9.9.9/upgrade.sh" || fail "the bundle wasn't installed"
[[ -z "$(find "$work/state/deploy-dry-run/releases" -mindepth 1 -maxdepth 1 -name '.unpack-*')" ]] || fail "an unpack directory was left behind"

echo "--- invalid instance files are refused" >&2
refuse() {
  local what="$1"
  if upgrade validate 2> err.log; then fail "accepted: $what"; fi
  printf 'refused %s: %s\n' "$what" "$(grep -v 'fnm\|Node.js' err.log | head -n1)" >&2
  write_instance off
}
write_instance off
if WRITER_HEALTH_TIMEOUT=2m upgrade validate 2> err.log; then fail "accepted a timeout that isn't a number"; fi
grep -q 'WRITER_HEALTH_TIMEOUT must be a number' err.log || fail "the bad timeout isn't named"
echo 'SURPRISE=1' >> instance.env; refuse "an unknown key"
echo 'READER_staging_WORKER=x' >> instance.env; refuse "a target that isn't listed"
echo 'COMPOSE_PROJECT=other' >> instance.env; refuse "a repeated key"
sed -i 's|^DATA_DIR=.*|DATA_DIR="/tmp/quoted"|' instance.env; refuse "a quoted value"
# shellcheck disable=SC2016 # a literal $HOME
sed -i 's|^DATA_DIR=.*|DATA_DIR=$HOME/data|' instance.env; refuse "a variable"
sed -i 's|^READER_dev_DOMAIN=.*|READER_dev_DOMAIN=Share.Example.com/x|' instance.env; refuse "a bad domain"
echo 'IMAGE=registry.example:5000/x/waypoint-writer:latest' >> instance.env; refuse "an IMAGE with a tag"
grep -q 'IMAGE must be' err.log || fail "the tagged IMAGE isn't named"
echo 'IMAGE=registry.example:5000/x/waypoint-writer' >> instance.env
upgrade validate 2> err.log || { cat err.log >&2; fail "refused an IMAGE with a registry port"; }
write_instance off
chmod 664 instance.env; refuse "a group-writable instance file"
chmod 644 reader-dev.env; refuse "a readable secrets file"; chmod 600 reader-dev.env
cp reader-dev.env saved.env
grep -v RAW_CAP_KEY saved.env > reader-dev.env; refuse "a missing reader secret"
grep -v R2_ACCOUNT_ID saved.env > reader-dev.env; refuse "neither R2_ACCOUNT_ID nor WAYPOINT_S3_ENDPOINT"
sed 's|^R2_BUCKET=.*|R2_BUCKET="dry-run"|' saved.env > reader-dev.env; refuse "a quoted secret"
{ cat saved.env; echo 'EXTRA_SECRET=x'; } > reader-dev.env; refuse "an unknown reader secret"
cp saved.env reader-dev.env
grep -v WAYPOINT_ENV writer.env > w && mv w writer.env && chmod 600 writer.env; refuse "a writer env without WAYPOINT_ENV"
grep -q 'WAYPOINT_ENV' err.log || fail "the refusal doesn't name WAYPOINT_ENV"
! grep -q 'dry-run' err.log || fail "an error message printed a value"

echo "deploy dry run passed" >&2
