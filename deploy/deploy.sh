#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# A login session predating docker-group membership needs sg; no daemon change.
docker_run() {
  if (( DOCKER_DIRECT )); then
    docker "$@"
  else
    local quoted='' arg
    for arg in "$@"; do
      printf -v quoted '%s%q ' "$quoted" "$arg"
    done
    sg docker -c "docker $quoted"
  fi
}

compose() { docker_run compose -p waypoint -f deploy/compose.yaml "$@"; }

DOCKER_DIRECT=0
if docker info >/dev/null 2>&1; then
  DOCKER_DIRECT=1
elif ! sg docker -c 'docker info' >/dev/null 2>&1; then
  echo 'Docker is unavailable, including through sg docker' >&2
  exit 1
fi

config_dir=/home/agent-1/.config/waypoint
data_dir=/home/agent-1/.local/share/waypoint/prod
for env_file in "$config_dir/prod.env" "$config_dir/ts.env"; do
  if [[ ! -f "$env_file" || $(stat -c %a "$env_file") != 600 ]]; then
    echo "Required env file is missing or not mode 600: $env_file" >&2
    exit 1
  fi
done
if ! grep -Eq '^[[:space:]]*WAYPOINT_ENV=prod[[:space:]]*$' "$config_dir/prod.env"; then
  echo 'prod.env must set WAYPOINT_ENV=prod' >&2
  exit 1
fi
if [[ ! -d "$data_dir" ]]; then
  mkdir -m 700 -p "$data_dir"
fi
if [[ $(stat -c %u:%g "$data_dir") != 1000:1000 ]]; then
  echo "Data directory must be owned by uid/gid 1000: $data_dir" >&2
  exit 1
fi

sha=$(git rev-parse --verify HEAD)
image="waypoint-writer:$sha"
docker_run build -f apps/writer/Dockerfile -t "$image" .

# Preserve the image actually running, which may differ from the current tag.
old_container=$(compose ps -q writer 2>/dev/null || true)
had_previous=0
if [[ -n "$old_container" ]]; then
  old_image=$(docker_run inspect --format '{{.Image}}' "$old_container")
  docker_run tag "$old_image" waypoint-writer:previous
  had_previous=1
fi
docker_run tag "$image" waypoint-writer:current

wait_for_writer() {
  local container status attempt
  container=$(compose ps -a -q writer)
  [[ -n "$container" ]] || return 1
  for ((attempt=0; attempt<45; attempt++)); do
    status=$(docker_run inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy ]] && return 1
    sleep 2
  done
  return 1
}

verify_tailnet() {
  local attempt
  for ((attempt=0; attempt<18; attempt++)); do
    if curl -fsS --max-time 5 https://waypoint.tail7aca06.ts.net/healthz >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

rollback() {
  local failed_container
  failed_container=$(compose ps -a -q writer 2>/dev/null || true)
  if [[ -n "$failed_container" ]]; then
    echo 'Failed writer logs:' >&2
    docker_run logs --tail 100 "$failed_container" >&2 || true
  fi
  if (( had_previous )); then
    docker_run tag waypoint-writer:previous waypoint-writer:current
    compose up -d --no-deps --force-recreate writer
    wait_for_writer || echo 'Rollback writer did not become healthy' >&2
  else
    compose stop writer || true
    echo 'No previous writer image exists; stopped failed first deployment' >&2
  fi
  exit 1
}

if ! compose up -d ts-waypoint; then rollback; fi
if ! compose up -d --no-deps --force-recreate writer; then rollback; fi
if ! wait_for_writer; then rollback; fi
if ! verify_tailnet; then rollback; fi

# `docker image ls` is newest first. Drop only old commit tags for this image.
kept=0
while IFS= read -r tag; do
  [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
  ((kept+=1))
  if (( kept > 3 )); then
    docker_run image rm "waypoint-writer:$tag" || true
  fi
done < <(docker_run image ls waypoint-writer --format '{{.Tag}}')

echo "Deployed $image"
