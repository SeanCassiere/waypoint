#!/usr/bin/env bash
# Checks deploy/upgrade.sh without deploying anything: a scratch instance with two reader targets
# and fake credentials, then `upgrade.sh --dry-run current-checkout` (the generated Wrangler
# configs go through `wrangler deploy --dry-run`; the reader steps run against a stand-in
# Wrangler), a smoke failure that must roll back, and instance files that must be refused.
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
# The other target uses another S3-compatible store instead of R2.
printf '%s\nWAYPOINT_S3_ENDPOINT=https://s3.example.test\nWAYPOINT_S3_REGION=us-east-1\n' "$reader_secrets" > reader-prod.env
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

echo "--- make-instance-env.sh writes a valid instance" >&2
printf 'TS_AUTHKEY=dry-run\n' > ts.env
chmod 600 ts.env
bash "$repo/deploy/make-instance-env.sh" --output "$work/made.env" --data-dir "$work/data" \
  --writer-env writer.env --project deploy-dry-run --tailscale --ts-env ts.env --ts-tags tag:example \
  --health-url https://writer.example.test/healthz --cloudflare-env cloudflare.env \
  --reader dev,example-reader-dev,dev.share.example.com,reader-dev.env,example_access_dev,1001 \
  --reader prod,example-reader,share.example.com,reader-prod.env,example_access,1002,true
grep -qx 'READER_TARGETS=dev prod' made.env || fail "make-instance-env.sh lost the target order"
grep -qx 'READER_prod_WORKERS_DEV=true' made.env || fail "make-instance-env.sh dropped WORKERS_DEV"
if bash "$repo/deploy/make-instance-env.sh" --output "$work/made.env" --data-dir "$work/data" --writer-env writer.env 2> /dev/null; then
  fail "make-instance-env.sh overwrote an instance file"
fi

echo "--- invalid instance files are refused" >&2
refuse() {
  local what="$1"
  if upgrade validate 2> err.log; then fail "accepted: $what"; fi
  printf 'refused %s: %s\n' "$what" "$(grep -v 'fnm\|Node.js' err.log | head -n1)" >&2
  write_instance off
}
write_instance off
echo 'SURPRISE=1' >> instance.env; refuse "an unknown key"
echo 'READER_staging_WORKER=x' >> instance.env; refuse "a target that isn't listed"
echo 'COMPOSE_PROJECT=other' >> instance.env; refuse "a repeated key"
sed -i 's|^DATA_DIR=.*|DATA_DIR="/tmp/quoted"|' instance.env; refuse "a quoted value"
# shellcheck disable=SC2016 # a literal $HOME
sed -i 's|^DATA_DIR=.*|DATA_DIR=$HOME/data|' instance.env; refuse "a variable"
sed -i 's|^READER_dev_DOMAIN=.*|READER_dev_DOMAIN=Share.Example.com/x|' instance.env; refuse "a bad domain"
chmod 664 instance.env; refuse "a group-writable instance file"
chmod 644 reader-dev.env; refuse "a readable secrets file"; chmod 600 reader-dev.env
cp reader-dev.env saved.env
grep -v RAW_CAP_KEY saved.env > reader-dev.env; refuse "a missing reader secret"
grep -v R2_ACCOUNT_ID saved.env > reader-dev.env; refuse "neither R2_ACCOUNT_ID nor WAYPOINT_S3_ENDPOINT"
{ cat saved.env; echo 'EXTRA_SECRET=x'; } > reader-dev.env; refuse "an unknown reader secret"
cp saved.env reader-dev.env
grep -v WAYPOINT_ENV writer.env > w && mv w writer.env && chmod 600 writer.env; refuse "a writer env without WAYPOINT_ENV"
grep -q 'WAYPOINT_ENV' err.log || fail "the refusal doesn't name WAYPOINT_ENV"
! grep -q 'dry-run' err.log || fail "an error message printed a value"

echo "deploy dry run passed" >&2
