#!/usr/bin/env bash
# Creates, updates or deletes the Worker Preview `pr-<number>` of the production reader Worker
# `waypoint-reader`, served at https://pr-<number>-waypoint-reader.<subdomain>.workers.dev.
#
# Previews run PR code against production data with the prod read-only reader credentials, so
# they're safe only behind Cloudflare Access. `up` succeeds only once both the preview URL and
# its deployment URL answer 302 to the Access login. It fails closed: once `wrangler preview`
# has started, any failure before that check passes (including a signal) deletes the preview.
# See docs/decisions.md D49 and deploy/README.md#pr-previews.
#
# DRY_RUN=1 runs every stage against a fake wrangler and fake responses, without secrets.
# DRY_RUN_FAIL=<stage> makes one stage fail (wrangler, json, urls, served, redirect, error,
# unreachable), and DRY_RUN_LOG=<file> records the fake wrangler's calls; see
# deploy/preview-reader-check.sh.
set -euo pipefail

pr="${1:-}"
action="${2:-}"
if [[ ! "$pr" =~ ^[1-9][0-9]{0,6}$ || ( "$action" != up && "$action" != down ) ]]; then
  echo 'Usage: preview-reader.sh <pr-number> <up|down>' >&2
  exit 2
fi
name="pr-$pr"
worker=waypoint-reader
access_host="${ACCESS_TEAM_DOMAIN:-seancassiere.cloudflareaccess.com}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/reader"

umask 077
temporary="$(mktemp -d -p "${RUNNER_TEMP:-/tmp}")"
uploaded=0
verified=0
# Fail closed: a preview that was (or may have been) uploaded but not verified is deleted.
cleanup() {
  if (( uploaded && !verified )); then
    echo "$log_prefix: $name was not verified behind Cloudflare Access; deleting it" >&2
    delete_preview || echo "$log_prefix: deleting $name FAILED; delete it by hand (deploy/README.md#pr-previews)" >&2
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export WRANGLER_SEND_METRICS=false
log_prefix="Reader preview"
# shellcheck source=deploy/reader-env.sh
source "$repo_root/deploy/reader-env.sh"
dry_run="${DRY_RUN:-0}"
if [[ "$dry_run" == 1 ]]; then
  # The prod env must define a previews block with its own dataset, and the custom domain must
  # keep previews off.
  node -e 'const fs=require("fs");const s=fs.readFileSync("wrangler.jsonc","utf8");for(const key of ["\"previews\"","waypoint_access_preview","TOKEN_MISS_LIMITER","\"previews_enabled\": false"])if(!s.includes(key))process.exit(1)'
  bash -n "$repo_root/deploy/preview-reader.sh"
  bash -n "$repo_root/deploy/reader-env.sh"
  reader_dry_run_config prod
  export READER_ENV_LIB="$repo_root/deploy/reader-env.sh"
  cat > "$temporary/wrangler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=deploy/reader-env.sh
source "$READER_ENV_LIB"
args="$*"
case "$args" in
  'preview --env prod --name pr-'*' --secrets-file '*' --json '*)
    file="${args#*--secrets-file }"; reader_check_secrets_file "${file%% *}"
    preview="${args#*--name }"; preview="${preview%% *}"
    if [[ -n "${DRY_RUN_LOG:-}" ]]; then echo "upload $preview" >> "$DRY_RUN_LOG"; fi
    case "${DRY_RUN_FAIL:-}" in
      wrangler) exit 1 ;;
      json) echo 'not json' ;;
      urls) printf '{"preview":{"name":"%s","urls":[]},"deployment":{"id":"dry-run-deployment","urls":[]}}\n' "$preview" ;;
      *) printf '{"preview":{"name":"%s","urls":["https://%s-waypoint-reader.dry-run.workers.dev"]},"deployment":{"id":"dry-run-deployment","urls":["https://dry-run-waypoint-reader.dry-run.workers.dev"]}}\n' "$preview" "$preview" ;;
    esac ;;
  'preview delete --env prod --name pr-'*' --skip-confirmation')
    preview="${args#*--name }"; preview="${preview%% *}"
    if [[ -n "${DRY_RUN_LOG:-}" ]]; then echo "delete $preview" >> "$DRY_RUN_LOG"; fi ;;
  *) exit 2 ;;
esac
EOF
  chmod 700 "$temporary/wrangler"
fi
wrangler="$repo_root/apps/reader/node_modules/.bin/wrangler"
if [[ "$dry_run" == 1 ]]; then wrangler="$temporary/wrangler"; fi
reader_load_cloudflare

# GET an account-scoped Cloudflare API path. The token goes to curl on stdin, never argv.
cf_get() {
  curl -sS -m 20 -H @- "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$1" <<<"Authorization: Bearer $CLOUDFLARE_API_TOKEN"
}
# Prints `found`, `missing` or `error` for this preview.
preview_state() {
  if [[ "$dry_run" == 1 ]]; then if [[ "$dry_deleted" == 1 ]]; then echo missing; else echo found; fi; return; fi
  cf_get "/workers/workers/$worker/previews/$name" > "$temporary/preview-state.json" 2>/dev/null || { echo error; return; }
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.success?"found":(d.errors??[]).some(e=>e.code===10025||e.code===10222||/not found/i.test(e.message??""))?"missing":"error")' "$temporary/preview-state.json" 2>/dev/null || echo error
}
dry_deleted=0
delete_preview() {
  "$wrangler" preview delete --env prod --name "$name" --skip-confirmation
  dry_deleted=1
}

if [[ "$action" == down ]]; then
  state="$(preview_state)"
  if [[ "$state" == missing ]]; then
    echo "Preview $name doesn't exist; nothing to delete"
  else
    delete_preview
    [[ "$(preview_state)" == missing ]] || { echo "$log_prefix: $name still exists after delete" >&2; exit 1; }
    echo "Preview $name deleted"
  fi
  exit 0
fi

reader_load_secrets prod
reader_write_secrets "$temporary/secrets.json"
sha="${PREVIEW_SHA:-$(git -C "$repo_root" rev-parse HEAD)}"
# --ignore-base-config: the dashboard's Preview base config is not merged in. Wrangler sends it
# only when it creates the preview (the first push of a PR); later deployments carry their whole
# runtime env (bindings from the previews block, secrets from --secrets-file) anyway, so the
# base config never reaches a deployment either way. Keep the base config empty regardless.
# wrangler reads GITHUB_SHA for the deployment's commit annotation; on pull_request events that
# is the merge commit, so pass the PR head instead.
uploaded=1
if ! GITHUB_SHA="$sha" "$wrangler" preview --env prod --name "$name" --secrets-file "$temporary/secrets.json" \
  --json --ignore-base-config --tag "${sha:0:12}" --message "PR #$pr at ${sha:0:12}" > "$temporary/preview.json"; then
  rm -f "$temporary/secrets.json"
  echo "$log_prefix: wrangler preview failed for $name" >&2
  exit 1
fi
rm -f "$temporary/secrets.json"
# Wrangler prints one JSON object ({preview, deployment}); secret values are stripped from it.
# Extract only the URLs and deployment ID; never print the raw output.
node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const data = JSON.parse(text.slice(text.indexOf("{")));
const out = [data.preview?.urls?.[0] ?? "", data.deployment?.urls?.[0] ?? "", data.deployment?.id ?? ""];
fs.writeFileSync(process.argv[2], out.join("\n") + "\n");
' "$temporary/preview.json" "$temporary/preview-fields"
{ read -r url; read -r deployment_url; read -r deployment_id; } < "$temporary/preview-fields"
url="${url%/}"; deployment_url="${deployment_url%/}"
url_pattern="^https://$name-$worker\\.[a-z0-9-]+\\.workers\\.dev\$"
deployment_pattern="^https://[a-z0-9-]+-$worker\\.[a-z0-9-]+\\.workers\\.dev\$"
if [[ ! "$url" =~ $url_pattern || ! "$deployment_url" =~ $deployment_pattern || -z "$deployment_id" ]]; then
  echo "$log_prefix: unexpected preview URLs or deployment for $name: '$url' '$deployment_url' '$deployment_id'" >&2
  echo "Is the workers.dev route with previews enabled on $worker? See deploy/README.md#pr-previews" >&2
  exit 1
fi
if [[ "$dry_run" != 1 ]]; then
  cf_get "/workers/workers/$worker/previews/$name/deployments/latest" > "$temporary/latest.json"
  latest="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.success?d.result.id:"")' "$temporary/latest.json")"
  [[ "$latest" == "$deployment_id" ]] || { echo "$log_prefix: latest deployment of $name is '$latest', expected $deployment_id" >&2; exit 1; }
fi
echo "Preview $name deployment $deployment_id is live"

# Without credentials, both URLs must redirect to the Access login for their own hostname.
# A 2xx means the preview is reachable without Access: stop at once. Anything else that isn't
# that redirect is retried until the window closes. Either way the EXIT trap deletes it.
smoke() {
  local target host result code location attempt_ok deadline
  local interval=6
  deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-120}))
  if [[ "$dry_run" == 1 ]]; then interval=0; deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-1})); fi
  while (( SECONDS < deadline )); do
    attempt_ok=1
    for target in "$url" "$deployment_url"; do
      host="${target#https://}"
      if [[ "$dry_run" == 1 ]]; then
        case "${DRY_RUN_FAIL:-}" in
          served) result="200 " ;;
          redirect) result="302 https://elsewhere.example/cdn-cgi/access/login/$host?redirect_url=%2Fhealthz" ;;
          error) result="503 " ;;
          unreachable) result="000 " ;;
          *) result="302 https://$access_host/cdn-cgi/access/login/$host?redirect_url=%2Fhealthz" ;;
        esac
      else
        result="$(curl -sS -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' "$target/healthz" 2>/dev/null || echo '000 ')"
      fi
      code="${result%% *}"; location="${result#* }"
      echo "$host/healthz -> $code ${location%%\?*}"
      if [[ "$code" == 2* ]]; then
        echo "$log_prefix: $host served content without Cloudflare Access" >&2
        return 1
      fi
      [[ "$code" == 302 && "$location" == "https://$access_host/cdn-cgi/access/login/$host?"* ]] || attempt_ok=0
    done
    (( attempt_ok )) && return 0
    sleep "$interval"
  done
  echo "$log_prefix: no Access redirect from $name within the smoke window" >&2
  return 1
}
smoke
verified=1
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'url=%s\ndeployment_url=%s\ndeployment_id=%s\n' "$url" "$deployment_url" "$deployment_id" >> "$GITHUB_OUTPUT"
fi
echo "Preview URL: $url"
echo "Deployment URL: $deployment_url"
if [[ "$dry_run" == 1 ]]; then echo "Reader preview dry run passed: $name"; fi
