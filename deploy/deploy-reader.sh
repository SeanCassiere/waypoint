#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
if [[ "$environment" != dev && "$environment" != prod ]]; then
  echo 'Usage: deploy-reader.sh <dev|prod>' >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/reader"
host=waypoint.pingstash.com
if [[ "$environment" == dev ]]; then host=waypoint-dev.pingstash.com; fi

umask 077
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export WRANGLER_SEND_METRICS=false
config_dir="$HOME/.config/waypoint"
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  node -e 'const fs=require("fs");const s=fs.readFileSync("wrangler.jsonc","utf8");for(const key of ["TOKEN_MISS_LIMITER","ACCESS_LOG","workers_dev","preview_urls"])if(!s.includes(key))process.exit(1)'
  bash -n "$repo_root/deploy/deploy-reader.sh"
  config_dir="$temporary/config"
  mkdir -m 700 "$config_dir"
  printf 'CLOUDFLARE_ACCOUNT_ID=dry-run\nCLOUDFLARE_API_TOKEN=dry-run\n' > "$config_dir/cloudflare.env"
  printf 'TURSO_DATABASE_URL=dry-run\nTURSO_READONLY_TOKEN=dry-run\nR2_ACCOUNT_ID=dry-run\nR2_READER_ACCESS_KEY_ID=dry-run\nR2_READER_SECRET_ACCESS_KEY=dry-run\nR2_BUCKET=dry-run\nRAW_CAP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' > "$config_dir/reader-$environment.env"
  chmod 600 "$config_dir"/*.env
  cat > "$temporary/wrangler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'deployments list') printf '[{"versions":[{"version_id":"dry-run-previous"}]}]\n' ;;
  'secret bulk') node -e 'const fs=require("fs");const p=process.argv[1];const data=JSON.parse(fs.readFileSync(p,"utf8"));const keys=["TURSO_DATABASE_URL","TURSO_READONLY_TOKEN","R2_ACCOUNT_ID","R2_READER_ACCESS_KEY_ID","R2_READER_SECRET_ACCESS_KEY","R2_BUCKET","RAW_CAP_KEY"];if(fs.statSync(p).mode&0o077||keys.some(k=>!data[k]))process.exit(1)' "$3" ;;
  'deploy --env'|'rollback dry-run-previous') : ;;
  *) exit 2 ;;
esac
EOF
  chmod 700 "$temporary/wrangler"
fi
cloud_env="$config_dir/cloudflare.env"
reader_env="$config_dir/reader-$environment.env"
for file in "$cloud_env" "$reader_env"; do
  [[ -f "$file" && "$(stat -c %a "$file")" == 600 ]] || { echo "Reader deploy: missing or non-600 env file: $file" >&2; exit 1; }
done
# Accept only literal assignments. Never execute env file contents or echo values.
read_env() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "Reader deploy: invalid env assignment in $file" >&2; return 1
    fi
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    case "$key" in
      CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|TURSO_DATABASE_URL|TURSO_READONLY_TOKEN|R2_ACCOUNT_ID|R2_READER_ACCESS_KEY_ID|R2_READER_SECRET_ACCESS_KEY|R2_BUCKET|RAW_CAP_KEY) printf -v "$key" '%s' "$value" ;;
      *) echo "Reader deploy: unexpected env key $key" >&2; return 1 ;;
    esac
  done < "$file"
}
read_env "$cloud_env"
read_env "$reader_env"
for key in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN TURSO_DATABASE_URL TURSO_READONLY_TOKEN R2_ACCOUNT_ID R2_READER_ACCESS_KEY_ID R2_READER_SECRET_ACCESS_KEY R2_BUCKET RAW_CAP_KEY; do
  [[ -n "${!key:-}" ]] || { echo "Reader deploy: missing $key" >&2; exit 1; }
done
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
TURSO_DATABASE_URL="$TURSO_DATABASE_URL" TURSO_READONLY_TOKEN="$TURSO_READONLY_TOKEN" R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_READER_ACCESS_KEY_ID="$R2_READER_ACCESS_KEY_ID" R2_READER_SECRET_ACCESS_KEY="$R2_READER_SECRET_ACCESS_KEY" R2_BUCKET="$R2_BUCKET" RAW_CAP_KEY="$RAW_CAP_KEY" node -e 'const fs=require("fs");const keys=["TURSO_DATABASE_URL","TURSO_READONLY_TOKEN","R2_ACCOUNT_ID","R2_READER_ACCESS_KEY_ID","R2_READER_SECRET_ACCESS_KEY","R2_BUCKET","RAW_CAP_KEY"];fs.writeFileSync(process.argv[1],JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))),{mode:0o600})' "$temporary/secrets.json"
unset TURSO_DATABASE_URL TURSO_READONLY_TOKEN R2_ACCOUNT_ID R2_READER_ACCESS_KEY_ID R2_READER_SECRET_ACCESS_KEY R2_BUCKET RAW_CAP_KEY
wrangler="$repo_root/apps/reader/node_modules/.bin/wrangler"
if [[ "${DRY_RUN:-0}" == 1 ]]; then wrangler="$temporary/wrangler"; fi
previous=""
if "$wrangler" deployments list --json --env "$environment" > "$temporary/deployments.json"; then
  previous="$(node -e 'const d=require(process.argv[1]);const items=Array.isArray(d)?d:d.deployments??[];const x=items.at(-1);console.log(x?.versions?.[0]?.version_id??x?.version_id??"")' "$temporary/deployments.json")"
fi
"$wrangler" secret bulk "$temporary/secrets.json" --env "$environment" > "$temporary/secret-bulk.log"
rm -f "$temporary/secrets.json"
rollback() {
  if [[ -n "$previous" ]]; then "$wrangler" rollback "$previous" --env "$environment" --yes; else echo 'No previous version was available for rollback' >&2; fi
}
if ! "$wrangler" deploy --env "$environment"; then
  echo "Reader deploy failed for $environment; rolling back" >&2
  rollback
  exit 1
fi

smoke() {
  local code attempt miss_token deadline
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    [[ "${DRY_RUN_FAIL_SMOKE:-0}" != 1 ]] || return 1
    printf 'ok' > "$temporary/health-body"
    printf 'x-robots-tag: noindex, nofollow\nreferrer-policy: no-referrer\n' > "$temporary/miss-headers"
    printf 'User-agent: *\nDisallow: /\n' > "$temporary/robots-body"
    code=200
    [[ "$(cat "$temporary/health-body")" == ok ]] || return 1
    grep -qi '^x-robots-tag: noindex, nofollow' "$temporary/miss-headers" || return 1
    grep -qi '^referrer-policy: no-referrer' "$temporary/miss-headers" || return 1
    grep -q 'Disallow: /' "$temporary/robots-body"
    return
  fi
  check_once() {
    code="$(curl -sS -m 8 -o "$temporary/health-body" -w '%{http_code}' "https://$host/healthz" || true)"
    [[ "$code" == 200 && "$(cat "$temporary/health-body" 2>/dev/null)" == ok ]] || return 1
    code="$(curl -sS -m 8 -o "$temporary/deep-body" -w '%{http_code}' "https://$host/healthz/deep" || true)"
    [[ "$code" == 200 && "$(cat "$temporary/deep-body" 2>/dev/null)" == ok ]] || return 1
    miss_token="$(node -e 'console.log("wps_"+require("node:crypto").randomBytes(32).toString("base64url"))')"
    code="$(curl -sS -m 8 -D "$temporary/miss-headers" -o "$temporary/miss-body" -w '%{http_code}' "https://$host/s/$miss_token/c/000000000000/" || true)"
    [[ "$code" == 404 ]] || return 1
    grep -qi '^x-robots-tag: noindex, nofollow' "$temporary/miss-headers" || return 1
    grep -qi '^referrer-policy: no-referrer' "$temporary/miss-headers" || return 1
    code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "https://$host/" || true)"
    [[ "$code" == 200 ]] || return 1
    code="$(curl -sS -m 8 -o "$temporary/robots-body" -w '%{http_code}' "https://$host/robots.txt" || true)"
    [[ "$code" == 200 ]] && grep -q 'Disallow: /' "$temporary/robots-body"
  }
  deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-120}))
  while (( SECONDS < deadline )); do
    if check_once; then return 0; fi
    sleep 6
  done
  return 1
}
if ! smoke; then
  echo "Reader smoke failed for $environment" >&2
  if [[ -z "$previous" ]]; then echo "No previous deployment; DNS or certificate may still be provisioning" >&2; exit 1; fi
  rollback
  exit 1
fi
if [[ "${DRY_RUN:-0}" == 1 ]]; then echo "Reader deploy dry run passed: $environment ($host)"; else echo "Reader $environment deployed and smoke tested"; fi
