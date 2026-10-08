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
# prod: workers_dev and preview_urls are on, so its workers.dev hostname must be behind the
# Cloudflare Access app (decision D49). The smoke requires the Access redirect there.
workers_dev_host=waypoint-reader.seancassiere.workers.dev
access_host="${ACCESS_TEAM_DOMAIN:-seancassiere.cloudflareaccess.com}"

umask 077
temporary="$(mktemp -d -p "${RUNNER_TEMP:-/tmp}")"
trap 'rm -rf "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export WRANGLER_SEND_METRICS=false
log_prefix="Reader deploy"
# shellcheck source=deploy/reader-env.sh
source "$repo_root/deploy/reader-env.sh"
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  node -e 'const fs=require("fs");const s=fs.readFileSync("wrangler.jsonc","utf8");for(const key of ["TOKEN_MISS_LIMITER","ACCESS_LOG","workers_dev","preview_urls"])if(!s.includes(key))process.exit(1)'
  bash -n "$repo_root/deploy/deploy-reader.sh"
  bash -n "$repo_root/deploy/reader-env.sh"
  reader_dry_run_config "$environment"
  export READER_ENV_LIB="$repo_root/deploy/reader-env.sh"
  cat > "$temporary/wrangler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=deploy/reader-env.sh
source "$READER_ENV_LIB"
case "$1 $2" in
  'deployments list') printf '[{"versions":[{"version_id":"dry-run-previous"}]}]\n' ;;
  'secret bulk') reader_check_secrets_file "$3" ;;
  'deploy --env'|'rollback dry-run-previous') : ;;
  *) exit 2 ;;
esac
EOF
  chmod 700 "$temporary/wrangler"
fi
reader_load_cloudflare
reader_load_secrets "$environment"
reader_write_secrets "$temporary/secrets.json"
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
# The commit rides along as a Worker variable (part of the version, so a rollback restores the
# old one); the reader reports it in the X-Waypoint-Sha header on /healthz.
deploy_args=(deploy --env "$environment")
build_sha="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ "$build_sha" =~ ^[0-9a-f]{40}$ ]]; then deploy_args+=(--var "WAYPOINT_BUILD_SHA:$build_sha"); fi
if ! "$wrangler" "${deploy_args[@]}"; then
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
    grep -q 'Disallow: /' "$temporary/robots-body" || return 1
    [[ "$environment" != prod || "${DRY_RUN_FAIL_ACCESS:-0}" != 1 ]]
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
    [[ "$code" == 200 ]] && grep -q 'Disallow: /' "$temporary/robots-body" || return 1
    if [[ "$environment" == prod ]]; then
      local result
      result="$(curl -sS -m 8 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$workers_dev_host/healthz" || true)"
      if [[ "${result%% *}" != 302 || "${result#* }" != "https://$access_host/cdn-cgi/access/login/$workers_dev_host?"* ]]; then
        echo "Reader smoke: https://$workers_dev_host/healthz -> ${result%%\?*}, expected 302 to Cloudflare Access" >&2
        return 1
      fi
    fi
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
