#!/usr/bin/env bash
# Installs, upgrades and rolls back a Waypoint instance: the writer container, then each public
# reader Worker. Every value comes from instance.env (deploy/instance.env.example); runbook in
# deploy/README.md, adopter guide in docs/self-hosting.md.
#
#   upgrade.sh [options] <X.Y.Z | latest>   deploy a release: its GHCR image and release bundle
#   upgrade.sh [options] current-checkout   deploy this git checkout: build the writer image and
#                                           the reader locally
#   upgrade.sh [options] image <ref>        deploy the writer from an image you built (no readers)
#   upgrade.sh [options] status             what's deployed, and whether it's healthy
#   upgrade.sh [options] validate           check instance.env and every file it names
#   upgrade.sh [options] rerender           re-render markdown after a renderer upgrade
#   upgrade.sh [options] compose <args...>  run docker compose on this instance's project
#
# Options:
#   --instance FILE   instance file (default: $XDG_CONFIG_HOME/waypoint/instance.env)
#   --dry-run         change nothing: check everything, show what would be deployed, and run
#                     the reader steps against a stand-in Wrangler (rerender: count only; the
#                     count needs the data directory's lock, so the writer still stops briefly;
#                     another version: its bundle is still downloaded into the state directory,
#                     under the instance lock; compose: print the command only)
#   --force           redeploy components that are already at the target
#   --allow-dirty     current-checkout: deploy uncommitted changes (never idempotent)
#   --limit N         rerender: renditions per batch (default 500)
#   --collection ID   rerender: one collection only
#
# Environment (all optional):
#   WAYPOINT_INSTANCE         the instance file, like --instance (which wins)
#   WRITER_HEALTH_TIMEOUT     seconds the writer container gets to pass its Docker health check
#                             (default 120); raise it for a slow first start, such as one that
#                             restores from the cloud
#   WRITER_URL_TIMEOUT        seconds WRITER_HEALTH_URL gets to answer with the new build (90)
#   SMOKE_TIMEOUT_SECONDS     seconds each reader's smoke test retries for (default 120)
#   LOCK_WAIT_SECONDS         seconds to wait for another run on this instance (default 1800)
#   RERENDER_UPLOAD_TIMEOUT   rerender: seconds the writer gets to upload a batch (default 3600)
#   WRANGLER                  the Wrangler executable (default: the checkout's, or the version
#                             the release bundle pins, through npx)
#   GH_BIN                    the GitHub CLI that verifies release attestations (default: gh)
#
# Rolling back is deploying the older version. Each component (the writer, each reader) records
# what it runs in the state directory, so a rerun after a partial upgrade finishes the rest, and a
# rerun at the same version only repeats the health checks. A component that fails its checks is
# rolled back on the spot, and so is the one in progress when the script is interrupted.
#
# A release bundle (waypoint-deploy-X.Y.Z.tgz, built by scripts/build-release-bundle.sh) holds this
# script and lib/, the compose files, serve.json, VERSION, BUILD_SHA, IMAGE_DIGEST (the writer
# image's attested digest), reader/index.js (the built Worker), reader/wrangler.jsonc (the config
# template), reader/WRANGLER_VERSION and SHA256SUMS. Asked for another version, the script fetches
# that version's bundle, verifies it (its attestation, with the GitHub CLI, then SHA256SUMS) and
# runs that bundle's own upgrade.sh, which verifies the image's attestation before pulling it.
set -euo pipefail
# inherit_errexit needs bash 4.4 (associative arrays, used throughout, need 4.2).
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "upgrade: needs bash 4.4 or later (this is $BASH_VERSION)" >&2
  exit 1
fi
# A failure inside $(...) fails the command substitution too, not just its last command.
shopt -s inherit_errexit
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_prefix=upgrade
# shellcheck source=deploy/lib/env.sh
source "$script_dir/lib/env.sh"

readonly local_repo=waypoint-writer
readonly default_image=ghcr.io/seancassiere/waypoint-writer

log() { printf '%s: %s\n' "$log_prefix" "$*" >&2; }
die() { log "$*"; exit 1; }

usage() {
  sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"
}

# ---------------------------------------------------------------------------------------------
# Arguments

instance_file="${WAYPOINT_INSTANCE:-${XDG_CONFIG_HOME:-$HOME/.config}/waypoint/instance.env}"
dry_run=0
force=0
allow_dirty=0
rerender_limit=500
rerender_collection=""
command=""
command_args=()
while (($#)); do
  case "$1" in
    --instance) [[ $# -ge 2 ]] || die "--instance needs a file"; instance_file="$2"; shift 2 ;;
    --instance=*) instance_file="${1#*=}"; shift ;;
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --limit) [[ "${2:-}" =~ ^[1-9][0-9]{0,6}$ ]] || die "--limit needs a positive number"; rerender_limit="$2"; shift 2 ;;
    --collection) [[ "${2:-}" =~ ^[A-Za-z0-9_]{1,64}$ ]] || die "--collection needs an ID"; rerender_collection="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      if [[ -z "$command" ]]; then
        command="$1"; shift
        if [[ "$command" == compose ]]; then command_args=("$@"); break; fi
      else
        command_args+=("$1"); shift
      fi
      ;;
  esac
done
[[ -n "$command" ]] || { usage >&2; exit 2; }
case "$command" in
  status|validate|rerender|current-checkout|latest|compose) ;;
  image) [[ ${#command_args[@]} -eq 1 ]] || die "usage: upgrade.sh image <ref>" ;;
  *)
    [[ "$command" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "unknown command or version: $command (see --help)"
    command="${command#v}"
    ;;
esac
if [[ "$command" != image && "$command" != compose && ${#command_args[@]} -gt 0 ]]; then
  die "unexpected argument: ${command_args[0]}"
fi
for var in WRITER_HEALTH_TIMEOUT WRITER_URL_TIMEOUT SMOKE_TIMEOUT_SECONDS LOCK_WAIT_SECONDS RERENDER_UPLOAD_TIMEOUT; do
  [[ -z "${!var:-}" || "${!var}" =~ ^[0-9]{1,7}$ ]] || die "$var must be a number of seconds"
done

# ---------------------------------------------------------------------------------------------
# Instance file

instance_key() {
  case "$1" in
    CONFIG_DIR|DATA_DIR|STATE_DIR|WRITER_ENV_FILE|IMAGE|RELEASE_REPO|COMPOSE_PROJECT|COMPOSE_OVERRIDE) return 0 ;;
    WRITER_UID|WRITER_GID|WRITER_BIND_ADDRESS|WRITER_HOST_PORT|WRITER_HEALTH_URL) return 0 ;;
    TAILSCALE|TAILSCALE_ENV_FILE|TAILSCALE_HOSTNAME|TAILSCALE_TAGS) return 0 ;;
    CLOUDFLARE_ENV_FILE|READER_TARGETS|VERIFY_ATTESTATIONS) return 0 ;;
  esac
  [[ "$1" =~ ^READER_[a-z0-9]+_(WORKER|DOMAIN|SECRETS_FILE|ANALYTICS_DATASET|RATELIMIT_NAMESPACE|WORKERS_DEV)$ ]]
}

# Relative paths in instance.env are relative to CONFIG_DIR.
instance_path() {
  local value="$1"
  [[ -n "$value" ]] || { printf ''; return; }
  [[ "$value" != "~"* ]] || die "paths in instance.env can't start with ~ (use an absolute path)"
  if [[ "$value" == /* ]]; then printf '%s' "$value"; else printf '%s/%s' "$config_dir" "$value"; fi
}

load_instance() {
  [[ -f "$instance_file" ]] || die "no instance file at $instance_file (see deploy/instance.env.example, or pass --instance)"
  instance_file="$(cd "$(dirname "$instance_file")" && pwd)/$(basename "$instance_file")"
  envfile_check_config_mode "$instance_file" || exit 1
  envfile_read "$instance_file" i_ instance_key || exit 1

  config_dir="${i_CONFIG_DIR:-$(dirname "$instance_file")}"
  [[ "$config_dir" == /* ]] || die "CONFIG_DIR must be an absolute path"
  data_dir="${i_DATA_DIR:-}"
  [[ "$data_dir" == /* ]] || die "DATA_DIR must be set to an absolute path"
  project="${i_COMPOSE_PROJECT:-waypoint}"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "COMPOSE_PROJECT must be lowercase letters, digits, - and _"
  state_dir="$(instance_path "${i_STATE_DIR:-state/$project}")"
  writer_env_file="$(instance_path "${i_WRITER_ENV_FILE:-}")"
  [[ -n "$writer_env_file" ]] || die "WRITER_ENV_FILE must be set"
  image_repo="${i_IMAGE:-$default_image}"
  # A ':' is allowed only for a registry port, so never after the last '/'.
  [[ "$image_repo" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ && "$image_repo" != *@* && "${image_repo##*/}" != *:* ]] \
    || die "IMAGE must be an image name without a tag or digest"
  release_repo="${i_RELEASE_REPO:-}"
  if [[ -z "$release_repo" && "$image_repo" =~ ^ghcr\.io/([a-z0-9-]+)/waypoint-writer$ ]]; then
    release_repo="${BASH_REMATCH[1]}/waypoint"
  fi
  [[ -z "$release_repo" || "$release_repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "RELEASE_REPO must be owner/repo"
  verify_attestations="${i_VERIFY_ATTESTATIONS:-}"
  [[ -z "$verify_attestations" || "$verify_attestations" == 0 || "$verify_attestations" == 1 ]] || die "VERIFY_ATTESTATIONS must be 0 or 1"
  compose_override="$(instance_path "${i_COMPOSE_OVERRIDE:-}")"

  writer_uid="${i_WRITER_UID:-1000}"
  writer_gid="${i_WRITER_GID:-1000}"
  [[ "$writer_uid" =~ ^[0-9]{1,10}$ && "$writer_gid" =~ ^[0-9]{1,10}$ ]] || die "WRITER_UID and WRITER_GID must be numbers"
  bind_address="${i_WRITER_BIND_ADDRESS:-127.0.0.1}"
  [[ "$bind_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "WRITER_BIND_ADDRESS must be an IPv4 address"
  host_port="${i_WRITER_HOST_PORT:-7410}"
  if [[ ! "$host_port" =~ ^[1-9][0-9]{0,4}$ ]] || (( host_port > 65535 )); then die "WRITER_HOST_PORT must be a port number"; fi
  health_url="${i_WRITER_HEALTH_URL:-}"
  [[ -z "$health_url" || "$health_url" =~ ^https?://[^[:space:]]+$ ]] || die "WRITER_HEALTH_URL must be an http(s) URL"

  tailscale="${i_TAILSCALE:-off}"
  [[ "$tailscale" == on || "$tailscale" == off ]] || die "TAILSCALE must be on or off"
  ts_env_file="$(instance_path "${i_TAILSCALE_ENV_FILE:-ts.env}")"
  ts_hostname="${i_TAILSCALE_HOSTNAME:-waypoint}"
  [[ "$ts_hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "TAILSCALE_HOSTNAME must be a hostname label"
  ts_tags="${i_TAILSCALE_TAGS:-}"
  [[ -z "$ts_tags" || "$ts_tags" =~ ^tag:[A-Za-z0-9-]+(,tag:[A-Za-z0-9-]+)*$ ]] || die "TAILSCALE_TAGS must look like tag:a,tag:b"

  cloudflare_env_file="$(instance_path "${i_CLOUDFLARE_ENV_FILE:-cloudflare.env}")"
  read -r -a reader_targets <<< "${i_READER_TARGETS:-}"
  local t key var seen_names=" " seen_domains=" "
  declare -gA r_worker=() r_domain=() r_secrets=() r_dataset=() r_namespace=() r_workers_dev=()
  for t in "${reader_targets[@]}"; do
    [[ "$t" =~ ^[a-z0-9]{1,32}$ ]] || die "READER_TARGETS: target names are lowercase letters and digits ($t)"
    [[ -z "${r_worker[$t]:-}" ]] || die "READER_TARGETS lists $t twice"
    for key in WORKER DOMAIN SECRETS_FILE ANALYTICS_DATASET RATELIMIT_NAMESPACE; do
      var="i_READER_${t}_$key"
      [[ -n "${!var:-}" ]] || die "reader target $t needs READER_${t}_$key"
    done
    var="i_READER_${t}_WORKER"; r_worker[$t]="${!var}"
    var="i_READER_${t}_DOMAIN"; r_domain[$t]="${!var}"
    var="i_READER_${t}_SECRETS_FILE"; r_secrets[$t]="$(instance_path "${!var}")"
    var="i_READER_${t}_ANALYTICS_DATASET"; r_dataset[$t]="${!var}"
    var="i_READER_${t}_RATELIMIT_NAMESPACE"; r_namespace[$t]="${!var}"
    var="i_READER_${t}_WORKERS_DEV"; r_workers_dev[$t]="${!var:-false}"
    [[ "${r_worker[$t]}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "READER_${t}_WORKER isn't a Worker name"
    [[ "${r_domain[$t]}" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] || die "READER_${t}_DOMAIN isn't a lowercase hostname"
    [[ "${r_dataset[$t]}" =~ ^[A-Za-z0-9_]{1,64}$ ]] || die "READER_${t}_ANALYTICS_DATASET must be letters, digits and _"
    [[ "${r_namespace[$t]}" =~ ^[0-9]{1,10}$ ]] || die "READER_${t}_RATELIMIT_NAMESPACE must be a number"
    [[ "${r_workers_dev[$t]}" == true || "${r_workers_dev[$t]}" == false ]] || die "READER_${t}_WORKERS_DEV must be true or false"
    [[ "$seen_names" != *" ${r_worker[$t]} "* ]] || die "two reader targets deploy the Worker ${r_worker[$t]}"
    [[ "$seen_domains" != *" ${r_domain[$t]} "* ]] || die "two reader targets use ${r_domain[$t]}"
    seen_names+="${r_worker[$t]} "
    seen_domains+="${r_domain[$t]} "
  done
  # A READER_<t>_* key for a target that isn't listed is a typo, not a disabled target.
  for var in $(compgen -v i_READER_); do
    [[ "$var" == i_READER_TARGETS ]] && continue
    t="${var#i_READER_}"; t="${t%%_*}"
    [[ -n "${r_worker[$t]:-}" ]] || die "${var#i_} is set, but $t isn't in READER_TARGETS"
  done
}

# Checks every file the instance names, without printing any value.
check_instance_files() {
  envfile_check_secret_mode "$writer_env_file" || exit 1
  grep -Eq '^WAYPOINT_ENV=(dev|prod)$' "$writer_env_file" || die "$writer_env_file must set WAYPOINT_ENV=dev or WAYPOINT_ENV=prod"
  if [[ "$tailscale" == on ]]; then
    envfile_check_secret_mode "$ts_env_file" || exit 1
  fi
  if [[ -n "$compose_override" ]]; then
    envfile_check_config_mode "$compose_override" || exit 1
  fi
  if ((${#reader_targets[@]})); then
    load_cloudflare
    unset cf_account cf_token
    local t
    for t in "${reader_targets[@]}"; do
      reader_secrets_json "${r_secrets[$t]}" "$scratch/check.json" || exit 1
      rm -f "$scratch/check.json"
    done
  fi
}

load_cloudflare() {
  envfile_check_secret_mode "$cloudflare_env_file" || exit 1
  unset c_CLOUDFLARE_ACCOUNT_ID c_CLOUDFLARE_API_TOKEN
  envfile_read "$cloudflare_env_file" c_ envfile_cloudflare_key secret || exit 1
  [[ -n "${c_CLOUDFLARE_ACCOUNT_ID:-}" && -n "${c_CLOUDFLARE_API_TOKEN:-}" ]] || die "$cloudflare_env_file needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
  cf_account="$c_CLOUDFLARE_ACCOUNT_ID"
  cf_token="$c_CLOUDFLARE_API_TOKEN"
  unset c_CLOUDFLARE_ACCOUNT_ID c_CLOUDFLARE_API_TOKEN
}

# ---------------------------------------------------------------------------------------------
# Docker and Compose

docker_direct=""
docker_run() {
  if [[ -z "$docker_direct" ]]; then
    if docker info >/dev/null 2>&1; then
      docker_direct=1
    elif command -v sg >/dev/null && sg docker -c 'docker info' >/dev/null 2>&1; then
      # A login session that predates docker-group membership; no daemon change needed.
      docker_direct=0
    else
      die "Docker is unavailable"
    fi
  fi
  if (( docker_direct )); then
    docker "$@"
  else
    local quoted='' arg
    for arg in "$@"; do printf -v quoted '%s%q ' "$quoted" "$arg"; done
    sg docker -c "docker $quoted"
  fi
}

docker_available() {
  [[ -n "$docker_direct" ]] && return 0
  if docker info >/dev/null 2>&1; then docker_direct=1; return 0; fi
  if command -v sg >/dev/null && sg docker -c 'docker info' >/dev/null 2>&1; then docker_direct=0; return 0; fi
  return 1
}

compose_env() {
  export WAYPOINT_IMAGE="$local_repo:$project-current"
  export WAYPOINT_WRITER_ENV_FILE="$writer_env_file"
  export WAYPOINT_DATA_HOST_DIR="$data_dir"
  export WAYPOINT_UID="$writer_uid" WAYPOINT_GID="$writer_gid"
  export WAYPOINT_BIND_ADDRESS="$bind_address" WAYPOINT_HOST_PORT="$host_port"
  export WAYPOINT_TS_ENV_FILE="$ts_env_file" WAYPOINT_TS_HOSTNAME="$ts_hostname"
  if [[ -n "$ts_tags" ]]; then export WAYPOINT_TS_EXTRA_ARGS="--advertise-tags=$ts_tags"; else export WAYPOINT_TS_EXTRA_ARGS=""; fi
  export WAYPOINT_TS_SERVE_CONFIG="$state_dir/serve.json"
  compose_files=(-f "$script_dir/compose.yaml")
  if [[ "$tailscale" == on ]]; then compose_files+=(-f "$script_dir/compose.tailscale.yaml"); fi
  if [[ -n "$compose_override" ]]; then compose_files+=(-f "$compose_override"); fi
}

compose() { docker_run compose -p "$project" "${compose_files[@]}" "$@"; }

# The sidecar mounts serve.json from the state directory, not from beside this script, so the
# mount (and with it the sidecar's config) doesn't change with every release directory, and an
# old release directory can be removed. Rewritten in place only when it differs, so a running
# sidecar's mount sees the change.
install_serve_config() {
  if [[ "$tailscale" != on ]] || (( dry_run )); then return 0; fi
  cmp -s "$script_dir/serve.json" "$WAYPOINT_TS_SERVE_CONFIG" && return 0
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  cat "$script_dir/serve.json" > "$WAYPOINT_TS_SERVE_CONFIG"
  chmod 644 "$WAYPOINT_TS_SERVE_CONFIG"
}

# A service's container, running or not. Not `compose ps -a`, which also lists the one-off
# containers a `compose run` without --rm leaves behind.
# Usage: service_container <service>
service_container() {
  docker_run ps -a -q --no-trunc --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" --filter label=com.docker.compose.oneoff=False 2>/dev/null || true
}
writer_container() { service_container writer; }

image_id() { docker_run image inspect --format '{{.Id}}' "$1" 2>/dev/null; }

container_field() { docker_run inspect --format "$2" "$1" 2>/dev/null || true; }

# GET /healthz inside the writer container (works whatever is published), printing the body.
writer_healthz() {
  docker_run exec "$1" node -e '
    fetch("http://127.0.0.1:7410/healthz").then(async (r) => {
      const body = await r.text();
      process.stdout.write(body);
      process.exit(r.ok ? 0 : 1);
    }).catch(() => process.exit(1));
  ' 2>/dev/null
}

# Checks a /healthz body: ok, plus the expected version and commit when given.
# Usage: healthz_matches <body> <version or ""> <sha or "">
healthz_matches() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const [body, version, sha] = process.argv.slice(1);
    let h;
    try { h = JSON.parse(body); } catch { process.exit(1); }
    if (h?.ok !== true) process.exit(1);
    if (version && h.version !== version) { console.error(`version ${h.version}, expected ${version}`); process.exit(1); }
    if (sha && h.sha !== sha) { console.error(`commit ${h.sha}, expected ${sha}`); process.exit(1); }
  ' "$1" "$2" "$3"
}

# Waits for the writer container's Docker health check. Fails fast if the container exits, or
# restarts while we wait (a crash loop). The baseline is the restart count to compare with: 0 for
# a container this run just created; by default, the count when the wait starts, so a restart
# days ago doesn't count against a writer that's healthy now.
# Usage: wait_writer_healthy [baseline]
wait_writer_healthy() {
  local container status state restarts baseline="${1:-}" deadline
  container="$(writer_container)"
  [[ -n "$container" ]] || { log "no writer container"; return 1; }
  [[ -n "$baseline" ]] || baseline="$(container_field "$container" '{{.RestartCount}}')"
  deadline=$((SECONDS + ${WRITER_HEALTH_TIMEOUT:-120}))
  while (( SECONDS < deadline )); do
    state="$(container_field "$container" '{{.State.Status}}')"
    restarts="$(container_field "$container" '{{.RestartCount}}')"
    status="$(container_field "$container" '{{if .State.Health}}{{.State.Health.Status}}{{end}}')"
    if [[ "$state" == exited || "$state" == dead || "${restarts:-0}" != "${baseline:-0}" ]]; then
      log "writer container stopped ($state, restarted $(( ${restarts:-0} - ${baseline:-0} )) times)"
      return 1
    fi
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy ]] && { log "writer container is unhealthy"; return 1; }
    sleep 2
  done
  log "writer container didn't become healthy in time"
  return 1
}

# The external health gate: WRITER_HEALTH_URL, when set, must answer with the expected build.
check_writer_url() {
  local version="$1" sha="$2" body deadline
  [[ -n "$health_url" ]] || return 0
  deadline=$((SECONDS + ${WRITER_URL_TIMEOUT:-90}))
  while (( SECONDS < deadline )); do
    if body="$(curl -fsS --max-time 5 "$health_url" 2>/dev/null)" && healthz_matches "$body" "$version" "$sha" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  log "$health_url didn't answer healthy${sha:+ with commit $sha}"
  return 1
}

# Container health, then the build it reports, then the external URL.
# Usage: verify_writer <version or ""> <sha or ""> [restart baseline, see wait_writer_healthy]
verify_writer() {
  local version="$1" sha="$2" container body
  wait_writer_healthy "${3:-}" || return 1
  container="$(writer_container)"
  body="$(writer_healthz "$container")" || { log "writer /healthz failed"; return 1; }
  healthz_matches "$body" "$version" "$sha" || { log "writer reports a different build"; return 1; }
  check_writer_url "$version" "$sha"
}

# ---------------------------------------------------------------------------------------------
# State: what each component runs, and the marker of a run in progress

state_key() { [[ "$1" =~ ^[a-z_]+$ ]]; }

state_get() {
  local file="$state_dir/$1" field="$2"
  [[ -f "$file" ]] || return 0
  ( unset "s_$field"; envfile_read "$file" s_ state_key >/dev/null 2>&1 || exit 0; local v="s_$field"; printf '%s' "${!v:-}" )
}

state_put() {
  local file="$state_dir/$1"; shift
  (( dry_run )) && return 0
  printf '%s\n' "$@" "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$file.tmp"
  mv "$file.tmp" "$file"
}

marker_set() {
  (( dry_run )) && return 0
  printf 'target=%s\nstarted_at=%s\npid=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" > "$state_dir/deploying"
}

# A reader's rollback target, saved before anything is uploaded to it and kept until that deploy
# succeeds or is rolled back. A run killed in between (SIGKILL, a lost runner) leaves it, so the
# next run rolls back to the version that served before the killed run, not to whatever the killed
# run left deployed. An empty version means the Worker had nothing deployed before.
rollback_record() { printf '%s/rollback-reader-%s' "$state_dir" "$1"; }
rollback_record_save() {
  (( dry_run )) && return 0
  printf 'version=%s\nworker=%s\nsaved_at=%s\n' "$2" "${r_worker[$1]}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$(rollback_record "$1").tmp"
  mv "$(rollback_record "$1").tmp" "$(rollback_record "$1")"
}
rollback_record_clear() {
  (( dry_run )) || rm -f "$(rollback_record "$1")"
}

# The writer's rollback target works the same way: the image ID to go back to (empty for a first
# deployment), saved before the writer is recreated and kept until the new writer passes every
# health gate, or is rolled back to that image. A run killed in between, even once the new
# container is Docker-healthy but before WRITER_HEALTH_URL answered, leaves it, so the next run
# keeps that image as `<project>-previous` instead of the unverified one running.
writer_record() { printf '%s/rollback-writer' "$state_dir"; }
writer_record_save() {
  (( dry_run )) && return 0
  printf 'image=%s\nsaved_at=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$(writer_record).tmp"
  mv "$(writer_record).tmp" "$(writer_record)"
}
writer_record_clear() {
  (( dry_run )) || rm -f "$(writer_record)"
}

lock_state() {
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  # Run by another version's upgrade.sh (exec_release_bundle), this one inherits that run's lock
  # on fd 9; reopening the file would release it.
  if [[ ! /dev/fd/9 -ef "$state_dir/lock" ]]; then exec 9> "$state_dir/lock"; fi
  if ! flock -n 9; then
    log "another upgrade.sh is running for this instance; waiting (up to ${LOCK_WAIT_SECONDS:-1800} s)"
    flock -w "${LOCK_WAIT_SECONDS:-1800}" 9 || die "timed out waiting for the instance lock"
  fi
}

# ---------------------------------------------------------------------------------------------
# Rollback on failure or interruption

in_progress=""        # writer | reader:<target> | rerender
writer_previous_id="" # the writer image ID to go back to (empty for a first deployment)
reader_previous=""    # the Worker version to roll back to
# In the runner's per-job temporary directory under GitHub Actions, which the runner empties after
# every job, so a reader secrets file left by a killed run doesn't outlive it.
scratch="$(mktemp -d -p "${TMPDIR:-${RUNNER_TEMP:-/tmp}}" upgrade.XXXXXXXX)"

rollback_writer() {
  local container
  container="$(writer_container)"
  if [[ -n "$container" ]]; then
    log "failed writer logs:"
    docker_run logs --tail 100 "$container" >&2 || true
  fi
  if [[ -n "$writer_previous_id" ]]; then
    log "rolling the writer back to the previous image"
    docker_run tag "$writer_previous_id" "$local_repo:$project-current"
    compose up -d --no-deps --force-recreate --pull never writer || { log "rollback: recreate failed"; return 1; }
    if ! verify_writer "" "" 0; then log "rollback: the previous writer isn't healthy either"; return 1; fi
    writer_record_clear
    log "writer rolled back"
  else
    # The record stays (no image to go back to), so the next run doesn't take this one for good.
    log "no previous writer image; stopping the failed first deployment"
    compose stop writer || true
  fi
}

rollback_reader() {
  local t="$1"
  if [[ -z "$reader_previous" ]]; then
    log "reader $t: no previous Worker version to roll back to"
    return 1
  fi
  log "reader $t: rolling back to Worker version $reader_previous"
  wrangler_cmd rollback "$reader_previous" --config "$scratch/reader-$t.json" --message "upgrade.sh rollback" --yes || { log "reader $t: rollback failed"; return 1; }
}

# Rolls back the component in progress. The deploying marker stays only if that fails.
rollback_in_progress() {
  local component="$in_progress" ok=0
  in_progress=""
  case "$component" in
    writer) rollback_writer && ok=1 ;;
    reader:*)
      if [[ -z "$reader_previous" ]]; then
        # As in deploy_reader's failure path: the record and the marker stay, so a rerun deploys it.
        log "reader ${component#reader:}: first deployment, nothing to roll back to; rerun to deploy it"
        return 0
      fi
      rollback_reader "${component#reader:}" && ok=1 && rollback_record_clear "${component#reader:}" ;;
    rerender) rollback_rerender; return ;;
    *) return 0 ;;
  esac
  if (( ok )) && (( ! dry_run )); then rm -f "$state_dir/deploying"; fi
  (( ok ))
}

on_exit() {
  local status=$?
  trap - EXIT
  # A second Ctrl-C, or SIGTERM after SIGINT, mustn't stop the rollback halfway (say, with the
  # previous image tagged but the writer not recreated). Ignored signals stay ignored in the
  # commands it runs, so Compose and Wrangler finish too. Only SIGKILL stops it now.
  trap '' INT TERM
  if [[ -n "$in_progress" ]]; then
    log "interrupted or failed during $in_progress (exit $status); rolling it back"
    rollback_in_progress || log "ROLLBACK FAILED: check the instance with 'upgrade.sh status'"
    status=$(( status == 0 ? 1 : status ))
  fi
  rm -rf "$scratch"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------------------------
# What to deploy

# Sets: target_id, target_version, target_sha, writer_source (build|pull|image), writer_ref,
# release_digest, reader_main, reader_template, readers_deployable.
repo_root=""
if [[ -f "$script_dir/../apps/writer/Dockerfile" ]] && git -C "$script_dir/.." rev-parse --git-dir >/dev/null 2>&1; then
  repo_root="$(cd "$script_dir/.." && pwd)"
fi
bundle_version=""
release_digest=""
if [[ -f "$script_dir/VERSION" ]]; then bundle_version="$(tr -d '[:space:]' < "$script_dir/VERSION")"; fi

resolve_checkout() {
  [[ -n "$repo_root" ]] || die "current-checkout needs to run from a git checkout of Waypoint"
  target_sha="$(git -C "$repo_root" rev-parse --verify HEAD)"
  target_version="$(node -p 'require(process.argv[1]).version' "$repo_root/package.json")"
  local dirty=""
  if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]]; then
    (( allow_dirty )) || die "the checkout has uncommitted changes (commit them, or pass --allow-dirty)"
    dirty="-dirty"
  fi
  target_id="checkout-$target_sha$dirty"
  writer_source=build
  writer_ref="$local_repo:$project-$target_sha$dirty"
  reader_main="$repo_root/apps/reader/dist/index.js"
  reader_template="$repo_root/apps/reader/wrangler.jsonc"
  readers_deployable=1
  if [[ -n "$dirty" ]]; then force=1; fi
}

resolve_image() {
  writer_ref="${command_args[0]}"
  [[ "$writer_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "invalid image reference"
  writer_source=image
  readers_deployable=0
  target_version=""
  target_sha=""
  target_id=""
}

resolve_release() {
  local version="$1"
  [[ "$bundle_version" == "$version" ]] || return 1
  target_version="$version"
  target_sha="$(tr -d '[:space:]' < "$script_dir/BUILD_SHA")"
  [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || die "the bundle's BUILD_SHA is invalid"
  target_id="release-$version"
  writer_source=pull
  writer_ref="$image_repo:$version"
  # The digest of the image the release workflow attested, recorded in the bundle (which is attested
  # too). Bundles without one pull by tag and pin the digest that arrives.
  release_digest=""
  if [[ -f "$script_dir/IMAGE_DIGEST" ]]; then
    release_digest="$(tr -d '[:space:]' < "$script_dir/IMAGE_DIGEST")"
    [[ "$release_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the bundle's IMAGE_DIGEST is invalid"
  fi
  reader_main="$script_dir/reader/index.js"
  reader_template="$script_dir/reader/wrangler.jsonc"
  readers_deployable=1
}

latest_version() {
  [[ -n "$release_repo" ]] || die "set RELEASE_REPO to resolve 'latest'"
  curl -fsSL --max-time 20 "https://api.github.com/repos/$release_repo/releases/latest" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).tag_name??"";if(!/^v\d+\.\d+\.\d+$/.test(t))process.exit(1);console.log(t.slice(1))})' \
    || die "couldn't resolve the latest release of $release_repo"
}

# Release integrity. SHA256SUMS inside the bundle guards against a truncated or corrupted download.
# Provenance is the attestation check: the bundle and the writer image must each carry a build
# provenance attestation signed by RELEASE_REPO's release workflow (.github/workflows/release.yml)
# running on GitHub-hosted runners from refs/heads/main (gh attestation verify). Both checks run
# before anything running is touched: the bundle's before it's unpacked, the image's before it's
# pulled (or, for a bundle without IMAGE_DIGEST, before the pulled digest is used).
#
# VERIFY_ATTESTATIONS=1 requires them, 0 turns them off, and unset verifies whenever the GitHub CLI
# is installed. A CLI that's too old to enforce the policy is an error, not a reason to skip.
readonly gh_min_version=2.102.0
gh_bin="${GH_BIN:-gh}"
attest_mode=""  # required | skipped, decided once per run
attest_repo=""  # RELEASE_REPO as GitHub spells it: --signer-workflow is case-sensitive

attestations_enabled() {
  if [[ -z "$attest_mode" ]]; then
    if [[ "$verify_attestations" == 0 ]]; then
      attest_mode=skipped
      log "VERIFY_ATTESTATIONS=0: release attestations aren't verified (only SHA256SUMS and the digest pin)"
    elif ! command -v "$gh_bin" >/dev/null 2>&1; then
      [[ "$verify_attestations" != 1 ]] || die "VERIFY_ATTESTATIONS=1 needs the GitHub CLI ($gh_bin, version $gh_min_version or later: https://cli.github.com), and it isn't installed"
      attest_mode=skipped
      log "WARNING: the GitHub CLI (gh) isn't installed, so release attestations aren't verified; install gh $gh_min_version or later and log in (or set GH_TOKEN), or set VERIFY_ATTESTATIONS=0 to accept SHA256SUMS and the digest pin alone"
    else
      local version
      version="$("$gh_bin" --version 2>/dev/null | sed -n '1s/^gh version \([0-9][0-9.]*\).*/\1/p')"
      if [[ -z "$version" || "$(printf '%s\n%s\n' "$gh_min_version" "$version" | sort -V | head -n1)" != "$gh_min_version" ]]; then
        die "release attestations need gh $gh_min_version or later (this is ${version:-an unknown version}); upgrade it, or set VERIFY_ATTESTATIONS=0 in instance.env to skip the check"
      fi
      attest_mode=required
    fi
  fi
  [[ "$attest_mode" == required ]]
}

# Verifies a release artifact's provenance: a file path, or oci://<image>@<digest>.
# Usage: verify_attestation <subject> <what, for messages>
verify_attestation() {
  local subject="$1" what="$2"
  [[ -n "$release_repo" ]] || die "set RELEASE_REPO to verify release attestations"
  if [[ -z "$attest_repo" ]]; then
    attest_repo="$("$gh_bin" api "repos/$release_repo" --jq .full_name 2> "$scratch/gh.err")" || {
      cat "$scratch/gh.err" >&2
      die "couldn't look up $release_repo on GitHub (gh needs a login: gh auth login, or GH_TOKEN)"
    }
    [[ "$attest_repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "unexpected answer looking up $release_repo"
  fi
  if ! "$gh_bin" attestation verify "$subject" --repo "$attest_repo" \
    --signer-workflow "$attest_repo/.github/workflows/release.yml" --source-ref refs/heads/main \
    --deny-self-hosted-runners > "$scratch/attestation.log" 2>&1; then
    cat "$scratch/attestation.log" >&2
    die "$what has no valid attestation from $attest_repo's release workflow on main"
  fi
  log "$what is attested by $attest_repo's release workflow on main"
}

verify_release_bundle() {
  local tgz="$1"
  [[ -s "$tgz" ]] || die "empty release bundle"
  if attestations_enabled; then verify_attestation "$tgz" "the release bundle"; fi
}
verify_release_image() {
  local ref="$1"
  [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || die "the release image must be pinned by digest"
  if attestations_enabled; then verify_attestation "oci://$ref" "the writer image ${ref##*@}"; fi
}

# Runs another release's own upgrade.sh: the one that matches the version being deployed.
# The bundle is installed and run under the instance lock, dry runs included, and the lock is
# kept across the exec (the bundle's upgrade.sh inherits it on fd 9), so a concurrent run can't
# unpack over, replace or prune a bundle another run is using.
#
# The hand-off is a contract between releases, so it never changes (deploy/README.md): the bundle
# is unpacked into <STATE_DIR>/releases/X.Y.Z only after its attestation and SHA256SUMS pass, and
# its script runs as `WAYPOINT_UPGRADE_REEXEC=1 bash <dir>/upgrade.sh --instance <file>
# [--dry-run] [--force] X.Y.Z`, holding the instance lock on fd 9.
exec_release_bundle() {
  local version="$1" dir tgz unpacked
  [[ -z "${WAYPOINT_UPGRADE_REEXEC:-}" ]] || die "bundle $version doesn't contain version $version"
  [[ -n "$release_repo" ]] || die "set RELEASE_REPO to fetch release bundles"
  lock_state
  dir="$state_dir/releases/$version"
  tgz="$scratch/waypoint-deploy-$version.tgz"
  if [[ ! -f "$dir/upgrade.sh" ]]; then
    # Whether attestations are verified, and with which gh, is settled before the download.
    attestations_enabled || true
    log "fetching the $version release bundle from $release_repo"
    curl -fsSL --max-time 300 -o "$tgz" \
      "https://github.com/$release_repo/releases/download/v$version/waypoint-deploy-$version.tgz" \
      || die "couldn't download the $version release bundle"
    verify_release_bundle "$tgz"
    mkdir -p "$state_dir/releases"
    # Left behind only by a killed run; prune_release_bundles removes it.
    unpacked="$(mktemp -d "$state_dir/releases/.unpack-$version.XXXXXXXX")"
    tar -xzf "$tgz" -C "$unpacked" --strip-components=1 --no-same-owner
    (cd "$unpacked" && sha256sum --quiet -c SHA256SUMS) || die "the $version release bundle fails its checksums"
    [[ "$(tr -d '[:space:]' < "$unpacked/VERSION")" == "$version" ]] || die "the bundle's VERSION isn't $version"
    chmod 700 "$unpacked"
    rm -rf "$dir"
    mv "$unpacked" "$dir"
  fi
  local args=(--instance "$instance_file")
  (( dry_run )) && args+=(--dry-run)
  (( force )) && args+=(--force)
  log "running upgrade.sh from the $version bundle"
  rm -rf "$scratch"
  trap - EXIT
  WAYPOINT_UPGRADE_REEXEC=1 exec bash "$dir/upgrade.sh" "${args[@]}" "$version"
}

# Removes downloaded release bundles but the one running and the newest three others, and what a
# killed run left unpacking. Runs under the instance lock, so no other run is unpacking now.
prune_release_bundles() {
  local dir="$state_dir/releases" v kept=0
  [[ -d "$dir" ]] || return 0
  while IFS= read -r v; do
    if [[ "$v" == .unpack-* ]]; then rm -rf "${dir:?}/$v"; continue; fi
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || continue
    [[ "$dir/$v" -ef "$script_dir" ]] && continue
    kept=$((kept + 1))
    if (( kept > 3 )); then rm -rf "${dir:?}/$v"; fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -rV)
}

# ---------------------------------------------------------------------------------------------
# Writer

# Builds or pulls the target image, before anything running changes. Sets target_image_id.
fetch_writer() {
  case "$writer_source" in
    build)
      if (( force )) || ! image_id "$writer_ref" >/dev/null; then
        if (( dry_run )); then log "would build $writer_ref"; target_image_id="(not built)"; return 0; fi
        log "building $writer_ref"
        docker_run build -f "$repo_root/apps/writer/Dockerfile" --build-arg "WAYPOINT_BUILD_SHA=$target_sha" -t "$writer_ref" "$repo_root"
      fi
      ;;
    pull)
      if [[ -n "$release_digest" ]]; then
        # The attested digest, verified before the pull (a dry run verifies it too).
        writer_ref="$image_repo@$release_digest"
        verify_release_image "$writer_ref"
        if (( dry_run )); then log "would pull $writer_ref"; target_image_id="(not pulled)"; return 0; fi
        log "pulling $writer_ref"
        docker_run pull "$writer_ref" >/dev/null
      else
        if (( dry_run )); then log "would pull $writer_ref, then verify the digest that arrives"; target_image_id="(not pulled)"; return 0; fi
        log "pulling $writer_ref (the bundle names no digest; pinning the one that arrives)"
        docker_run pull "$writer_ref" >/dev/null
        local digest
        digest="$(docker_run image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$writer_ref" | grep -m1 "^$image_repo@sha256:" || true)"
        [[ -n "$digest" ]] || die "no registry digest for $writer_ref"
        verify_release_image "$digest"
        writer_ref="$digest"
      fi
      local built
      built="$(docker_run image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$writer_ref" | sed -n 's/^WAYPOINT_BUILD_SHA=//p')"
      [[ "$built" == "$target_sha" ]] || die "the image was built from ${built:-an unknown commit}, not $target_sha"
      # This instance's own reference to the release, which prune_writer_images counts.
      docker_run tag "$writer_ref" "$local_repo:$project-$target_version"
      ;;
    image)
      if ! image_id "$writer_ref" >/dev/null; then
        (( dry_run )) && { log "would pull $writer_ref"; target_image_id="(not pulled)"; return 0; }
        docker_run pull "$writer_ref" >/dev/null || die "no image $writer_ref"
      fi
      ;;
  esac
  target_image_id="$(image_id "$writer_ref")" || die "no image $writer_ref"
  if [[ "$writer_source" == image ]]; then
    target_id="image-$target_image_id"
    target_sha="$(docker_run image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$writer_ref" | sed -n 's/^WAYPOINT_BUILD_SHA=//p')"
  fi
}

check_data_dir() {
  if [[ ! -d "$data_dir" ]]; then
    (( dry_run )) && { log "would create $data_dir"; return 0; }
    mkdir -p "$data_dir"
    chmod 700 "$data_dir"
  fi
  local owner
  owner="$(stat -c %u:%g "$data_dir")"
  [[ "$owner" == "$writer_uid:$writer_gid" ]] || die "$data_dir must be owned by $writer_uid:$writer_gid (it's $owner): sudo chown $writer_uid:$writer_gid $data_dir"
}

# Whether the running writer is the one a previous run deployed for this target, with the current
# Compose config. The config hash is compared with what that run recorded, not with the
# container's com.docker.compose.config-hash label: Compose computes the label after resolving
# `network_mode: service:...` to the sidecar's container ID, so with the Tailscale overlay the
# label never equals `compose config --hash`.
# Usage: writer_is_current <container> <its image ID> <expected config hash>
writer_is_current() {
  local container="$1" current_id="$2" expected_hash="$3" sidecar
  [[ -n "$container" && -n "$expected_hash" ]] || return 1
  [[ "$current_id" == "$target_image_id" ]] || return 1
  [[ "$(state_get writer id)" == "$target_id" ]] || return 1
  [[ "$(state_get writer hash)" == "$expected_hash" ]] || return 1
  [[ "$(state_get writer container)" == "$container" ]] || return 1
  if [[ "$tailscale" == on ]]; then
    # A recreated sidecar leaves the writer in the old one's network namespace.
    sidecar="$(service_container ts-waypoint)"
    [[ -n "$sidecar" && "$(container_field "$container" '{{.HostConfig.NetworkMode}}')" == "container:$sidecar" ]] || return 1
  fi
}

# Arms the writer's rollback: picks the image to go back to (the one an earlier, unfinished run
# recorded, or else the running image, unless it's a broken one left by an earlier failed run and
# a previous image is already tagged), saves it in the rollback record and sets the deploying
# marker. From here on, a failure or an interruption recreates the writer from that image.
# Usage: writer_arm <container or ""> <its image ID> <1 if it's healthy>
writer_arm() {
  local container="$1" current_id="$2" healthy="$3"
  writer_previous_id=""
  if [[ -f "$(writer_record)" ]]; then
    writer_previous_id="$(state_get rollback-writer image)"
    if [[ -n "$writer_previous_id" ]] && ! image_id "$writer_previous_id" >/dev/null; then
      die "the writer's rollback target from an earlier run ($writer_previous_id) is gone; delete $(writer_record) to keep the running image as the rollback target instead"
    fi
    log "an earlier writer deploy didn't finish; rolling back, if needed, to the image from before it (${writer_previous_id:-none, a first deployment})"
  elif [[ -n "$container" ]]; then
    if (( healthy )); then
      writer_previous_id="$current_id"
    else
      writer_previous_id="$(image_id "$local_repo:$project-previous" || printf '%s' "$current_id")"
    fi
  fi
  writer_record_save "$writer_previous_id"
  in_progress=writer
  marker_set "$target_id"
}

# The sidecar's container and when it started: a change means the writer is left in the old
# sidecar's network namespace, unreachable, until it's recreated.
sidecar_instance() {
  local sidecar
  sidecar="$(service_container ts-waypoint)"
  [[ -n "$sidecar" ]] || return 0
  printf '%s %s' "$sidecar" "$(container_field "$sidecar" '{{.State.StartedAt}}')"
}

deploy_writer() {
  local container current_id="" healthy=0 expected_hash armed=0 had_record=0 had_marker=0 sidecar_moved=0 sidecar_before
  expected_hash="$(compose config --hash writer | awk '$1 == "writer" {print $2}')"
  [[ -n "$expected_hash" ]] || die "couldn't compute the writer's Compose config hash"
  container="$(writer_container)"
  if [[ -n "$container" ]]; then
    current_id="$(container_field "$container" '{{.Image}}')"
    [[ "$(container_field "$container" '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" == healthy ]] && healthy=1
  fi
  # The sidecar first (a no-op when it already runs unchanged), so the check below sees the
  # network namespace the writer will join. Recreating or restarting it strands the running
  # writer in the old namespace, so the writer's rollback is armed before it: interrupted from
  # here on, the writer is recreated, from its rollback target, in the new sidecar's namespace.
  if [[ "$tailscale" == on ]] && (( ! dry_run )); then
    install_serve_config
    if [[ -n "$container" ]]; then
      [[ -f "$(writer_record)" ]] && had_record=1
      [[ -f "$state_dir/deploying" ]] && had_marker=1
      sidecar_before="$(sidecar_instance)"
      writer_arm "$container" "$current_id" "$healthy"
      armed=1
    fi
    compose up -d ts-waypoint
    if (( armed )) && [[ "$(sidecar_instance)" != "$sidecar_before" ]]; then
      log "the Tailscale sidecar was recreated or restarted; the writer must be recreated to join it"
      sidecar_moved=1
    fi
  fi
  if (( ! force && ! sidecar_moved )) && writer_is_current "$container" "$current_id" "$expected_hash"; then
    if (( armed )); then
      # Nothing changed after all: disarm, leaving the record and the marker as they were.
      in_progress=""
      (( had_record )) || writer_record_clear
      (( had_marker )) || rm -f "$state_dir/deploying"
    fi
    log "writer already runs $target_id; checking its health"
    verify_writer "$target_version" "$target_sha" || die "the writer runs the target but isn't healthy (rerun with --force to recreate it)"
    # Recorded as deployed, so a leftover record is from a run killed just after that.
    writer_record_clear
    return 0
  fi
  if (( dry_run )); then
    log "would deploy the writer: $writer_ref (${target_version:-unversioned} ${target_sha:-no commit})${container:+, replacing $current_id}"
    return 0
  fi

  (( armed )) || writer_arm "$container" "$current_id" "$healthy"
  if [[ -n "$writer_previous_id" ]]; then
    docker_run tag "$writer_previous_id" "$local_repo:$project-previous"
  fi
  docker_run tag "$target_image_id" "$local_repo:$project-current"
  log "recreating the writer"
  compose up -d --no-deps --force-recreate --pull never writer
  if ! verify_writer "$target_version" "$target_sha" 0; then
    trap '' INT TERM   # the rollback runs to the end, as in on_exit
    in_progress=""
    if rollback_writer; then rm -f "$state_dir/deploying"; fi
    die "writer deploy failed"
  fi
  in_progress=""
  container="$(writer_container)"
  state_put writer "id=$target_id" "version=$target_version" "sha=$target_sha" "image=$target_image_id" \
    "hash=$expected_hash" "container=$container"
  writer_record_clear
  log "writer is healthy on $target_id"
  prune_writer_images
}

# Drops old local builds and pulled releases of this instance, keeping the newest three of each.
# A pulled release is tagged <project>-X.Y.Z too (fetch_writer), so only this instance's tags are
# counted: another instance on the host that uses the same IMAGE keeps its own. The registry tag
# of a release goes with this instance's tag; an image another instance still tags stays. The
# current and previous images keep their own tags, so they're never removed.
prune_writer_images() {
  local builds=0 releases=0 tag version
  while IFS= read -r tag; do
    if [[ "$tag" =~ ^$project-[0-9a-f]{40}(-dirty)?$ ]]; then
      builds=$((builds + 1))
      if (( builds > 3 )); then docker_run image rm "$local_repo:$tag" >/dev/null || true; fi
    elif [[ "$tag" =~ ^$project-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
      version="${BASH_REMATCH[1]}"
      releases=$((releases + 1))
      if (( releases > 3 )); then
        docker_run image rm "$local_repo:$tag" >/dev/null || true
        docker_run image rm "$image_repo:$version" >/dev/null 2>&1 || true
      fi
    fi
  done < <(docker_run image ls "$local_repo" --format '{{.Tag}}')
}

# ---------------------------------------------------------------------------------------------
# Readers

wrangler_bin=()
resolve_wrangler() {
  if [[ -n "${WRANGLER:-}" ]]; then
    wrangler_bin=("$WRANGLER")
  elif [[ -n "$repo_root" && -x "$repo_root/apps/reader/node_modules/.bin/wrangler" ]]; then
    wrangler_bin=("$repo_root/apps/reader/node_modules/.bin/wrangler")
  elif [[ -f "$script_dir/reader/WRANGLER_VERSION" ]]; then
    wrangler_bin=(npx --yes "wrangler@$(tr -d '[:space:]' < "$script_dir/reader/WRANGLER_VERSION")")
  else
    die "no Wrangler found (set WRANGLER, or run pnpm install in the checkout)"
  fi
  if [[ -z "${WRANGLER:-}" ]]; then
    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]')" || die "Wrangler needs Node.js"
    (( node_major >= 22 )) || die "Wrangler needs Node.js 22 or later (this host has $(node --version))"
  fi
}

# Runs Wrangler with the Cloudflare credentials in its environment only. In a dry run, a stand-in
# records the call and answers like Wrangler would.
wrangler_cmd() {
  if (( dry_run )); then
    dry_wrangler "$@"
    return
  fi
  CLOUDFLARE_ACCOUNT_ID="$cf_account" CLOUDFLARE_API_TOKEN="$cf_token" WRANGLER_SEND_METRICS=false \
    "${wrangler_bin[@]}" "$@"
}

# DRY_RUN_DEPLOYMENTS=fail:<target> makes the deployments lookup fail for that target, and
# missing:<target> answers like Wrangler does for a Worker that doesn't exist yet.
dry_wrangler() {
  if [[ -n "${DRY_RUN_LOG:-}" ]]; then printf 'wrangler %s\n' "$*" >> "$DRY_RUN_LOG"; fi
  case "$1 ${2:-}" in
    'deployments list')
      case "${DRY_RUN_DEPLOYMENTS:-}" in
        fail:*) if [[ "$*" == *"/reader-${DRY_RUN_DEPLOYMENTS#fail:}.json"* ]]; then
            echo 'X [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]' >&2; return 1
          fi ;;
        missing:*) if [[ "$*" == *"/reader-${DRY_RUN_DEPLOYMENTS#missing:}.json"* ]]; then
            echo 'X [ERROR] A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]' >&2; return 1
          fi ;;
      esac
      printf '[{"versions":[{"version_id":"dry-run-previous"}]}]\n'
      ;;
    'secret bulk')
      node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));if(fs.statSync(p).mode&0o077||!d.TURSO_DATABASE_URL||!d.RAW_CAP_KEY)process.exit(1)' "$3"
      ;;
    deploy*|rollback*) : ;;
    *) return 2 ;;
  esac
}

# Writes the target's Wrangler config into the scratch directory, and prints a fingerprint of what
# would be deployed (build, config and secrets). Equal fingerprints mean nothing changed.
prepare_reader() {
  local t="$1"
  local config="$scratch/reader-$t.json"
  node "$script_dir/lib/reader-config.mjs" --template "$reader_template" --main "$reader_main" \
    --name "${r_worker[$t]}" --domain "${r_domain[$t]}" --dataset "${r_dataset[$t]}" \
    --ratelimit-namespace "${r_namespace[$t]}" --workers-dev "${r_workers_dev[$t]}" > "$config" \
    || die "reader $t: couldn't generate the Wrangler config"
  [[ -s "$config" ]] || die "reader $t: the generated Wrangler config is empty"
  reader_secrets_json "${r_secrets[$t]}" "$scratch/secrets-$t.json" || exit 1
  { printf '%s\n%s\n%s\n' "$target_id" "$target_version" "$target_sha"; cat "$config" "$scratch/secrets-$t.json"; } \
    | sha256sum | cut -d' ' -f1
  # Written again right before its upload, so it only exists while one is in progress.
  rm -f "$scratch/secrets-$t.json"
}

# Prints the Worker version the target serves now: the one to roll back to. Prints nothing when
# Wrangler reports that the Worker doesn't exist yet (a first deployment). Any other failure, or
# an answer that names no version, stops the run before anything is uploaded: deploying without
# a rollback target isn't safe.
reader_deployed_version() {
  local t="$1"
  local out="$scratch/deployments-$t.json" err="$scratch/deployments-$t.err" text
  if ! wrangler_cmd deployments list --json --config "$scratch/reader-$t.json" > "$out" 2> "$err"; then
    if grep -Eq '\[code: (10007|10090)\]' "$err"; then
      log "reader $t: the Worker ${r_worker[$t]} doesn't exist yet; this is its first deployment"
      return 0
    fi
    text="$(cat "$err")"
    [[ -z "${cf_account:-}" ]] || text="${text//"$cf_account"/<account>}"
    printf '%s\n' "$text" >&2
    die "reader $t: couldn't list the Worker's deployments, so there'd be no version to roll back to"
  fi
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(d)) process.exit(1);
    if (d.length === 0) process.exit(0); // the Worker exists, but nothing is deployed
    const id = d.at(-1)?.versions?.[0]?.version_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) process.exit(1);
    console.log(id);
  ' "$out" || die "reader $t: unexpected answer from wrangler deployments list"
}

# Smoke test against the live custom domain, retried while DNS and certificates settle.
smoke_reader() {
  local t="$1"
  local host="${r_domain[$t]}" deadline
  if (( dry_run )); then
    [[ "${DRY_RUN_FAIL_SMOKE:-}" != "$t" ]] || { log "reader $t: simulated smoke failure"; return 1; }
    log "reader $t: smoke test skipped (dry run)"
    return 0
  fi
  deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-120}))
  while (( SECONDS < deadline )); do
    if smoke_once "$host"; then return 0; fi
    sleep 6
  done
  log "reader $t: smoke test failed on https://$host ($smoke_error)"
  return 1
}

smoke_error=""
header_value() { sed -n "s/^$2: *//Ip" "$1" | tr -d '\r' | tail -n1; }
smoke_once() {
  local host="$1" code miss_token d="$scratch/smoke"
  mkdir -p "$d"
  code="$(curl -sS -m 8 -D "$d/h" -o "$d/b" -w '%{http_code}' "https://$host/healthz" 2>/dev/null || true)"
  [[ "$code" == 200 && "$(cat "$d/b")" == ok ]] || { smoke_error="/healthz $code"; return 1; }
  if [[ -n "$target_version" && "$(header_value "$d/h" x-waypoint-version)" != "$target_version" ]]; then
    smoke_error="X-Waypoint-Version $(header_value "$d/h" x-waypoint-version), expected $target_version"; return 1
  fi
  if [[ -n "$target_sha" && "$(header_value "$d/h" x-waypoint-sha)" != "$target_sha" ]]; then
    smoke_error="X-Waypoint-Sha $(header_value "$d/h" x-waypoint-sha), expected $target_sha"; return 1
  fi
  code="$(curl -sS -m 15 -o "$d/b" -w '%{http_code}' "https://$host/healthz/deep" 2>/dev/null || true)"
  [[ "$code" == 200 && "$(cat "$d/b")" == ok* ]] || { smoke_error="/healthz/deep $code"; return 1; }
  miss_token="wps_$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  code="$(curl -sS -m 8 -D "$d/h" -o /dev/null -w '%{http_code}' "https://$host/s/$miss_token/c/000000000000/" 2>/dev/null || true)"
  [[ "$code" == 404 ]] || { smoke_error="unknown share link answered $code"; return 1; }
  [[ "$(header_value "$d/h" x-robots-tag)" == "noindex, nofollow" ]] || { smoke_error="share 404 without X-Robots-Tag"; return 1; }
  [[ "$(header_value "$d/h" referrer-policy)" == no-referrer ]] || { smoke_error="share 404 without Referrer-Policy"; return 1; }
  code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "https://$host/" 2>/dev/null || true)"
  [[ "$code" == 200 ]] || { smoke_error="/ $code"; return 1; }
  code="$(curl -sS -m 8 -o "$d/b" -w '%{http_code}' "https://$host/robots.txt" 2>/dev/null || true)"
  if [[ "$code" != 200 ]] || ! grep -q 'Disallow: /' "$d/b"; then smoke_error="/robots.txt $code"; return 1; fi
}

# Usage: deploy_reader <target> <fingerprint> <Worker version to roll back to, or "">
deploy_reader() {
  local t="$1" fingerprint="$2"
  local config="$scratch/reader-$t.json" deploy_args
  if (( ! force )) && [[ ! -f "$(rollback_record "$t")" && "$(state_get "reader-$t" fingerprint)" == "$fingerprint" ]]; then
    log "reader $t already runs $target_id; smoke testing"
    smoke_reader "$t" || die "reader $t runs the target but fails its smoke test (rerun with --force to redeploy it)"
    return 0
  fi
  log "reader $t: deploying ${r_worker[$t]} to ${r_domain[$t]}"
  reader_secrets_json "${r_secrets[$t]}" "$scratch/secrets-$t.json" || exit 1
  reader_previous="$3"
  rollback_record_save "$t" "$reader_previous"
  in_progress="reader:$t"
  marker_set "$target_id"
  wrangler_cmd secret bulk "$scratch/secrets-$t.json" --config "$config" > "$scratch/secret-bulk.log"
  rm -f "$scratch/secrets-$t.json"
  # The commit rides along as a Worker variable, part of the version, so a rollback restores the
  # old one; the reader reports it in X-Waypoint-Sha.
  deploy_args=(deploy --config "$config")
  if [[ -n "$target_sha" ]]; then deploy_args+=(--var "WAYPOINT_BUILD_SHA:$target_sha"); fi
  if ! wrangler_cmd "${deploy_args[@]}" || ! smoke_reader "$t"; then
    trap '' INT TERM   # the rollback runs to the end, as in on_exit
    in_progress=""
    if [[ -z "$reader_previous" ]]; then
      log "reader $t: first deployment, nothing to roll back to (DNS or certificates may still be provisioning; rerun to retry)"
    elif rollback_reader "$t"; then
      rollback_record_clear "$t"
      (( dry_run )) || rm -f "$state_dir/deploying"
    fi
    die "reader $t deploy failed"
  fi
  in_progress=""
  state_put "reader-$t" "id=$target_id" "version=$target_version" "sha=$target_sha" "fingerprint=$fingerprint"
  rollback_record_clear "$t"
  if (( dry_run )); then log "reader $t: dry run passed"; else log "reader $t deployed and smoke tested"; fi
}

# ---------------------------------------------------------------------------------------------
# Commands

cmd_deploy() {
  case "$command" in
    current-checkout) resolve_checkout ;;
    image) resolve_image ;;
    latest)
      local v; v="$(latest_version)"; log "latest release: $v"
      resolve_release "$v" || exec_release_bundle "$v"
      ;;
    *) resolve_release "$command" || exec_release_bundle "$command" ;;
  esac
  check_instance_files
  compose_env
  if (( ! dry_run )); then lock_state; fi
  if [[ -f "$state_dir/deploying" ]]; then
    log "an earlier run didn't finish ($(state_get deploying target)); converging"
  fi

  # 1. Fetch and check everything before touching anything running.
  local t readers=()
  declare -A fingerprint=() previous_version=()
  if (( readers_deployable )) && ((${#reader_targets[@]})); then
    load_cloudflare
    resolve_wrangler
    for t in "${reader_targets[@]}"; do
      fingerprint[$t]="$(prepare_reader "$t")"
      # A reader with a leftover rollback record runs whatever a killed run left: deploy it again.
      if (( force )) || [[ -f "$(rollback_record "$t")" || "$(state_get "reader-$t" fingerprint)" != "${fingerprint[$t]}" ]]; then
        readers+=("$t")
      fi
    done
    if ((${#readers[@]})) && [[ -n "$repo_root" && "$writer_source" == build ]]; then
      if (( dry_run )); then
        [[ -f "$reader_main" ]] || die "no reader build at $reader_main (pnpm --filter '@waypoint/reader...' build)"
      else
        log "building the reader"
        (cd "$repo_root" && pnpm --filter "@waypoint/reader..." build) >&2
      fi
    fi
    # Nothing to upload when every target is current; the dry run still validates every config.
    if ((${#readers[@]})) || (( dry_run )); then
      [[ -f "$reader_main" ]] || die "no built reader at $reader_main"
    fi
    if (( dry_run )) && [[ "${wrangler_bin[0]}" != npx ]]; then
      for t in "${reader_targets[@]}"; do
        WRANGLER_SEND_METRICS=false "${wrangler_bin[@]}" deploy --dry-run --config "$scratch/reader-$t.json" \
          --outdir "$scratch/out-$t" > "$scratch/wrangler-dry-run.log" 2>&1 \
          || { cat "$scratch/wrangler-dry-run.log" >&2; die "reader $t: the generated Wrangler config doesn't validate"; }
      done
      log "reader configs validate with wrangler deploy --dry-run"
    fi
    for t in "${readers[@]}"; do
      # A record saved for another Worker (READER_<t>_WORKER changed since) names a version of
      # that Worker, which this one can't roll back to.
      if [[ -f "$(rollback_record "$t")" && "$(state_get "rollback-reader-$t" worker)" != "${r_worker[$t]}" ]]; then
        log "reader $t: an earlier deploy of it didn't finish, on the Worker $(state_get "rollback-reader-$t" worker), not ${r_worker[$t]}; check that Worker by hand"
        previous_version[$t]="$(reader_deployed_version "$t")"
      elif [[ -f "$(rollback_record "$t")" ]]; then
        previous_version[$t]="$(state_get "rollback-reader-$t" version)"
        [[ -z "${previous_version[$t]}" || "${previous_version[$t]}" =~ ^[A-Za-z0-9-]{1,64}$ ]] || die "reader $t: invalid version in $(rollback_record "$t")"
        log "reader $t: an earlier deploy of it didn't finish; rolling back, if needed, to the version from before it (${previous_version[$t]:-none, a first deployment})"
      else
        previous_version[$t]="$(reader_deployed_version "$t")"
      fi
    done
  fi
  docker_available || die "Docker is unavailable"
  compose config -q || die "the compose files don't validate"
  check_data_dir
  fetch_writer

  # 2. The writer, then each reader in order.
  deploy_writer
  if (( readers_deployable )); then
    for t in "${reader_targets[@]}"; do deploy_reader "$t" "${fingerprint[$t]}" "${previous_version[$t]:-}"; done
  elif ((${#reader_targets[@]})); then
    log "readers aren't deployed from a bare image; deploy a release or the checkout to update them"
  fi

  if (( dry_run )); then
    log "dry run passed: $target_id"
  else
    printf 'id=%s\nversion=%s\nsha=%s\ncompleted_at=%s\n' "$target_id" "$target_version" "$target_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$state_dir/release"
    rm -f "$state_dir/deploying"
    prune_release_bundles
    log "deployed $target_id"
  fi
}

cmd_status() {
  compose_env
  printf 'instance   %s (project %s, tailscale %s)\n' "$instance_file" "$project" "$tailscale"
  printf 'state      %s\n' "$state_dir"
  if [[ -f "$state_dir/deploying" ]]; then printf 'WARNING    a run is in progress or was interrupted: %s\n' "$(state_get deploying target)"; fi
  printf 'release    %s\n' "$(state_get release id)"
  local container body t
  if docker_available; then
    container="$(writer_container)"
    if [[ -n "$container" ]]; then
      printf 'writer     %s, %s, recorded %s\n' "$(container_field "$container" '{{.State.Status}}')" \
        "$(container_field "$container" '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" "$(state_get writer id)"
      body="$(writer_healthz "$container" || true)"
      printf 'healthz    %s\n' "${body:-unreachable}"
    else
      printf 'writer     not created\n'
    fi
  else
    printf 'writer     (Docker unavailable)\n'
  fi
  if [[ -f "$(writer_record)" ]]; then
    printf "WARNING    writer: a deploy didn't finish, or failed with no image to go back to; the next run keeps rollback target %s\n" "$(v="$(state_get rollback-writer image)"; printf '%s' "${v:-none}")"
  fi
  for t in "${reader_targets[@]}"; do
    local h="$scratch/h"
    rm -f "$h"
    curl -sS -m 8 -D "$h" -o /dev/null "https://${r_domain[$t]}/healthz" 2>/dev/null || true
    printf 'reader %-4s %s: recorded %s, serving %s %s\n' "$t" "${r_domain[$t]}" "$(state_get "reader-$t" id)" \
      "$(header_value "$h" x-waypoint-version 2>/dev/null)" "$(header_value "$h" x-waypoint-sha 2>/dev/null)"
    if [[ -f "$(rollback_record "$t")" ]]; then
      printf "WARNING    reader %s: a deploy didn't finish; the next run redeploys it (rollback target %s)\n" "$t" "$(v="$(state_get "rollback-reader-$t" version)"; printf '%s' "${v:-none}")"
    fi
  done
}

cmd_validate() {
  check_instance_files
  compose_env
  if docker_available; then compose config -q || die "the compose files don't validate"; fi
  if ((${#reader_targets[@]})); then
    local t template="${repo_root:+$repo_root/apps/reader/wrangler.jsonc}"
    template="${template:-$script_dir/reader/wrangler.jsonc}"
    for t in "${reader_targets[@]}"; do
      node "$script_dir/lib/reader-config.mjs" --template "$template" --main /dev/null \
        --name "${r_worker[$t]}" --domain "${r_domain[$t]}" --dataset "${r_dataset[$t]}" \
        --ratelimit-namespace "${r_namespace[$t]}" --workers-dev "${r_workers_dev[$t]}" > /dev/null
    done
  fi
  log "instance is valid: project $project, ${#reader_targets[@]} reader target(s)"
}

# Re-renders markdown after a renderer upgrade (deploy/README.md). `rerender` takes the data
# directory's lock, so each batch runs with the writer stopped (agents' writes fail meanwhile);
# the writer then uploads what was queued, and the next batch starts once it has. The writer is
# started again after every batch, and on any failure or interruption. Only the writer container
# is stopped and started; the Tailscale sidecar, Docker and the host are left alone.
cmd_rerender() {
  compose_env
  docker_available || die "Docker is unavailable"
  # Even a dry run stops the writer (the count needs the data directory's lock), so it must not
  # overlap a deploy or another rerender.
  lock_state
  [[ ! -f "$state_dir/deploying" ]] || die "an upgrade didn't finish; rerun it before re-rendering"
  local args summary remaining version pending deadline
  [[ -n "$(writer_container)" ]] || die "no writer container"
  wait_writer_healthy || die "the writer isn't healthy"
  args=(--all)
  if [[ -n "$rerender_collection" ]]; then args=(--collection "$rerender_collection"); fi

  # A dry run first: it reports the image's renderer version, which every batch then pins, so an
  # image change mid-way fails instead of mixing versions.
  rerender_stop
  compose run --rm --no-deps -T writer node dist/main.js rerender "${args[@]}" --renderer markdown --dry-run > "$scratch/rerender.out"
  summary="$(head -n1 "$scratch/rerender.out")"
  version="$(node -e 'console.log(JSON.parse(process.argv[1]).renderer_version)' "$summary")" || die "unexpected rerender output"
  # shellcheck disable=SC2016 # JavaScript, not shell
  # Without --limit, the dry run counts every source still to render as queued (and none remaining).
  log "markdown renderer v$version: $(node -e 'const s=JSON.parse(process.argv[1]);console.log(`${s.sources} sources, ${s.current} current, ${s.queued} to render`)' "$summary")"
  if (( dry_run )); then rerender_start; return 0; fi
  while :; do
    compose run --rm --no-deps -T writer node dist/main.js rerender "${args[@]}" --renderer markdown --version "$version" --limit "$rerender_limit" > "$scratch/rerender.out"
    cat "$scratch/rerender.out" >&2
    remaining="$(sed -n 's/^remaining: \([0-9]*\).*/\1/p' "$scratch/rerender.out" | tail -n1)"
    [[ "$remaining" =~ ^[0-9]+$ ]] || die "unexpected rerender output"
    rerender_start
    log "waiting for the writer to upload the queued renditions"
    deadline=$((SECONDS + ${RERENDER_UPLOAD_TIMEOUT:-3600}))
    pending=""
    while (( SECONDS < deadline )); do
      pending="$(docker_run exec "$(writer_container)" node -e 'fetch("http://127.0.0.1:7410/api/status").then(r=>r.json()).then(s=>console.log(s.queue.rerender_pending)).catch(()=>process.exit(1))' 2>/dev/null || true)"
      [[ "$pending" == 0 ]] && break
      sleep 10
    done
    [[ "$pending" == 0 ]] || die "renditions are still queued after the upload timeout; the writer keeps uploading them, rerun later"
    (( remaining > 0 )) || break
    log "$remaining sources left; next batch"
    rerender_stop
  done
  log "rerender done. Sources reported as missing or failed keep their previous rendition; see the JSON summaries above."
}

rerender_stop() {
  rerender_check_config
  in_progress=rerender
  log "stopping the writer"
  compose stop -t 60 writer >&2
}

# Each batch runs in a one-off container built from the instance's current settings (image, data
# directory, env file), while the writer that uploads its renditions is the container the last
# deploy created. They must be the same: with a changed DATA_DIR, say, the batch would render
# into a directory the running writer never uploads from, and its upload check would pass.
# Checked before every stop, so a change between batches is caught too.
rerender_check_config() {
  local container hash
  container="$(writer_container)"
  hash="$(compose config --hash writer | awk '$1 == "writer" {print $2}')"
  if [[ -z "$container" || -z "$hash" || "$(state_get writer hash)" != "$hash" || "$(state_get writer container)" != "$container" \
    || "$(container_field "$container" '{{.Image}}')" != "$(image_id "$local_repo:$project-current")" ]]; then
    die "the writer doesn't run with the instance's current settings (instance.env, the writer env file or the image changed since the last deploy, or the writer was rolled back): deploy first (upgrade.sh <version>), then re-render"
  fi
}

# `start`, not `up`: the same container comes back (a recreate belongs to a deploy, with its
# health gate and rollback); rerender_check_config made sure it's the one the batches match.
rerender_start() {
  compose start writer >&2
  in_progress=""
  wait_writer_healthy || die "the writer didn't come back healthy"
}

# Interrupted or failed mid-batch: start the writer again.
rollback_rerender() {
  log "starting the writer again"
  compose start writer >&2 && wait_writer_healthy
}

case "$command" in
  compose)
    load_instance
    compose_env
    if (( dry_run )); then
      log "would run: docker compose -p $project ${compose_files[*]} ${command_args[*]}"
      exit 0
    fi
    # Anything that can change containers waits for the instance lock, so it can't start the
    # writer under a rerender or recreate it in the middle of a deploy's health gate.
    sub=""
    for arg in "${command_args[@]}"; do [[ "$arg" == -* ]] || { sub="$arg"; break; }; done
    case "$sub" in
      ps|config|logs|images|ls|top|port|version|events|stats|exec) ;;
      *) lock_state ;;
    esac
    install_serve_config
    compose "${command_args[@]}"
    ;;
  status) load_instance; cmd_status ;;
  validate) load_instance; cmd_validate ;;
  rerender) load_instance; cmd_rerender ;;
  *) load_instance; cmd_deploy ;;
esac
