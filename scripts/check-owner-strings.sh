#!/usr/bin/env bash
# Fails if deploy tooling names the owner's own instance. Everything an adopter runs (deploy/,
# the reader's Wrangler template, a release bundle) must work from instance.env alone.
#
#   scripts/check-owner-strings.sh [path...]   (default: deploy/ and apps/reader/wrangler.jsonc)
#
# Matching is case-insensitive. The one allowed form is the published image,
# ghcr.io/seancassiere/..., the default IMAGE.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if (($# == 0)); then set -- "$repo/deploy" "$repo/apps/reader/wrangler.jsonc"; fi
# Spelled in pieces so this script doesn't match itself when it's scanned.
owner='sean''cassiere'
pattern="agent-1|tail7aca06|$owner|ping""stash"
allowed="ghcr\\.io/$owner/"

found=0
while IFS= read -r -d '' file; do
  while IFS= read -r hit; do
    printf '%s:%s\n' "${file#"$repo"/}" "$hit" >&2
    found=1
  done < <(sed -E "s#$allowed##Ig" "$file" | grep -inE "$pattern" || true)
done < <(find "$@" -type f -print0)
if (( found )); then
  echo "Owner-specific values above; deploy tooling must take them from instance.env" >&2
  exit 1
fi
echo "No owner-specific values in: ${*#"$repo"/}"
