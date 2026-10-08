#!/usr/bin/env bash
# Writes an instance.env for deploy/upgrade.sh from flags, for an install whose env files already
# exist. It checks that each named file exists with the right mode, reads only WAYPOINT_BASE_URL
# from the writer env file (to default the health URL), never prints a value from any of them,
# and validates the result with `upgrade.sh validate`.
#
#   make-instance-env.sh --output FILE --data-dir DIR --writer-env FILE [options]
#
#   --output FILE            the instance file to write (refuses to overwrite without --force)
#   --config-dir DIR         CONFIG_DIR (default: the output file's directory)
#   --data-dir DIR           DATA_DIR
#   --writer-env FILE        WRITER_ENV_FILE
#   --image NAME             IMAGE
#   --project NAME           COMPOSE_PROJECT
#   --uid N --gid N          WRITER_UID, WRITER_GID
#   --bind ADDRESS --port N  WRITER_BIND_ADDRESS, WRITER_HOST_PORT
#   --health-url URL         WRITER_HEALTH_URL (default: <WAYPOINT_BASE_URL>/healthz when the
#                            writer env file sets an https base URL)
#   --no-health-url          leave WRITER_HEALTH_URL unset. Use it when this host can't reach
#                            the base URL itself, for example a .ts.net URL on a host that isn't
#                            on the tailnet (the Tailscale sidecar is its own node): upgrade.sh
#                            fetches the health URL from this host, and an unreachable one fails
#                            every deploy and its rollback
#   --tailscale              TAILSCALE=on (the three --ts-* options need it)
#   --ts-env FILE            TAILSCALE_ENV_FILE
#   --ts-hostname NAME       TAILSCALE_HOSTNAME
#   --ts-tags TAGS           TAILSCALE_TAGS
#   --cloudflare-env FILE    CLOUDFLARE_ENV_FILE (needs a --reader)
#   --reader NAME,WORKER,DOMAIN,SECRETS_FILE,DATASET,RATELIMIT_NAMESPACE[,WORKERS_DEV]
#                            a reader target; repeat in deploy order
#   --force                  overwrite --output
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_prefix=make-instance-env
# shellcheck source=deploy/lib/env.sh
source "$script_dir/lib/env.sh"

die() { echo "$log_prefix: $*" >&2; exit 1; }

output="" config_dir="" data_dir="" writer_env="" image="" project="" uid="" gid="" bind="" port=""
health_url="" no_health_url=0 tailscale=0 ts_env="" ts_hostname="" ts_tags="" cloudflare_env="" force=0
readers=()
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
while (($#)); do
  case "$1" in
    --output) need "$@"; output="$2"; shift 2 ;;
    --config-dir) need "$@"; config_dir="$2"; shift 2 ;;
    --data-dir) need "$@"; data_dir="$2"; shift 2 ;;
    --writer-env) need "$@"; writer_env="$2"; shift 2 ;;
    --image) need "$@"; image="$2"; shift 2 ;;
    --project) need "$@"; project="$2"; shift 2 ;;
    --uid) need "$@"; uid="$2"; shift 2 ;;
    --gid) need "$@"; gid="$2"; shift 2 ;;
    --bind) need "$@"; bind="$2"; shift 2 ;;
    --port) need "$@"; port="$2"; shift 2 ;;
    --health-url) need "$@"; health_url="$2"; shift 2 ;;
    --no-health-url) no_health_url=1; shift ;;
    --tailscale) tailscale=1; shift ;;
    --ts-env) need "$@"; ts_env="$2"; shift 2 ;;
    --ts-hostname) need "$@"; ts_hostname="$2"; shift 2 ;;
    --ts-tags) need "$@"; ts_tags="$2"; shift 2 ;;
    --cloudflare-env) need "$@"; cloudflare_env="$2"; shift 2 ;;
    --reader) need "$@"; readers+=("$2"); shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[[ -n "$output" && -n "$data_dir" && -n "$writer_env" ]] || die "--output, --data-dir and --writer-env are required"
# Without --tailscale they'd be dropped, and the writer published on the host instead.
if (( ! tailscale )) && [[ -n "$ts_env$ts_hostname$ts_tags" ]]; then die "--ts-env, --ts-hostname and --ts-tags need --tailscale"; fi
# Likewise, it's only written with a reader target.
if ((${#readers[@]} == 0)) && [[ -n "$cloudflare_env" ]]; then die "--cloudflare-env needs a --reader"; fi
[[ ! -e "$output" ]] || (( force )) || die "$output exists (pass --force to overwrite it)"
output_dir="$(cd "$(dirname "$output")" && pwd)" || die "no directory for $output"
output="$output_dir/$(basename "$output")"
config_dir="${config_dir:-$output_dir}"
resolve() { if [[ "$1" == /* ]]; then printf '%s' "$1"; else printf '%s/%s' "$config_dir" "$1"; fi; }

envfile_check_secret_mode "$(resolve "$writer_env")" || exit 1
if [[ -z "$health_url" ]] && (( ! no_health_url )); then
  # Only WAYPOINT_BASE_URL is read, and it isn't printed.
  base="$(sed -n 's/^WAYPOINT_BASE_URL=\(https:\/\/[^[:space:]]*\)$/\1/p' "$(resolve "$writer_env")" | tail -n1)"
  if [[ -n "$base" ]]; then
    health_url="${base%/}/healthz"
    echo "$log_prefix: WRITER_HEALTH_URL defaults to the writer's base URL; upgrade.sh fetches it from this host, so pass --no-health-url if this host can't reach it (say, a .ts.net URL on a host that isn't on the tailnet)" >&2
  fi
fi
(( ! tailscale )) || envfile_check_secret_mode "$(resolve "${ts_env:-ts.env}")" || exit 1

lines=(
  "# Written by deploy/make-instance-env.sh on $(date -u +%Y-%m-%d). See deploy/instance.env.example."
  "CONFIG_DIR=$config_dir"
  "DATA_DIR=$data_dir"
  "WRITER_ENV_FILE=$writer_env"
)
add() { if [[ -n "$2" ]]; then lines+=("$1=$2"); fi; }
add IMAGE "$image"
add COMPOSE_PROJECT "$project"
add WRITER_UID "$uid"
add WRITER_GID "$gid"
add WRITER_BIND_ADDRESS "$bind"
add WRITER_HOST_PORT "$port"
add WRITER_HEALTH_URL "$health_url"
if (( tailscale )); then
  lines+=("TAILSCALE=on")
  add TAILSCALE_ENV_FILE "$ts_env"
  add TAILSCALE_HOSTNAME "$ts_hostname"
  add TAILSCALE_TAGS "$ts_tags"
fi
if ((${#readers[@]})); then
  add CLOUDFLARE_ENV_FILE "$cloudflare_env"
  names=()
  for spec in "${readers[@]}"; do
    IFS=, read -r name worker domain secrets dataset namespace workers_dev extra <<< "$spec"
    [[ -z "${extra:-}" && -n "${namespace:-}" ]] || die "--reader takes NAME,WORKER,DOMAIN,SECRETS_FILE,DATASET,RATELIMIT_NAMESPACE[,WORKERS_DEV]"
    envfile_check_secret_mode "$(resolve "$secrets")" || exit 1
    names+=("$name")
    lines+=(
      "READER_${name}_WORKER=$worker"
      "READER_${name}_DOMAIN=$domain"
      "READER_${name}_SECRETS_FILE=$secrets"
      "READER_${name}_ANALYTICS_DATASET=$dataset"
      "READER_${name}_RATELIMIT_NAMESPACE=$namespace"
    )
    add "READER_${name}_WORKERS_DEV" "${workers_dev:-}"
  done
  lines+=("READER_TARGETS=${names[*]}")
fi

temporary="$output.tmp.$$"
trap 'rm -f "$temporary"' EXIT
printf '%s\n' "${lines[@]}" > "$temporary"
chmod 600 "$temporary"
bash "$script_dir/upgrade.sh" --instance "$temporary" validate
mv "$temporary" "$output"
echo "$log_prefix: wrote $output"
