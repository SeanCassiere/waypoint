#!/usr/bin/env bash
# Fails if a file names the owner's own instance: its hosts, machine names, accounts or IDs.
# Waypoint is a generic, self-hostable project; the owner's instance values live only in its
# instance.env on the host and in a private ops repository.
#
#   scripts/check-owner-strings.sh            every file tracked by git (CI's lint job)
#   scripts/check-owner-strings.sh PATH...    every file under these paths (the release bundle)
#
# Matching is case-insensitive. Caught: the owner's handle in any form (so its Cloudflare
# workers.dev subdomain and its Turso organization too), its public domain, its tailnet name, its
# host's name, Cloudflare Access team domains, and a few opaque IDs (Cloudflare account, Access
# app, GitHub App), which are matched by hash so this script doesn't publish them.
#
# Allowed everywhere, because they name the published project rather than an instance:
#   - its image, ghcr.io/seancassiere/... (the default IMAGE);
#   - its repository, seancassiere/waypoint (GitHub URLs and clone URLs ending .git, releases,
#     attestations), but not another repository of the owner's, such as its private ops repository.
# Allowed in one file each: the owner's GitHub handle in .github/CODEOWNERS (@handle),
# .github/FUNDING.yml (github: [handle]) and CODE_OF_CONDUCT.md (@handle and its profile URL, the
# contact). CHANGELOG.md, written by release-please, isn't scanned.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Spelled in pieces so this script doesn't match itself.
owner='sean''cassiere'
pattern="$owner|ping""stash|tail7a""ca06|agent""-1|cloudflare""access"
# A form that isn't followed by more of a repository name ends the match.
end='([^-[:alnum:]_.]|\.([^[:alnum:]]|$)|$)'
strip_global="s#ghcr\\.io/$owner/##Ig; s#$owner/waypoint(\\.git)?$end#\\2#Ig"
# Per-file allowances: sed expressions applied to that file's lines only.
strip_for() {
  case "$1" in
    .github/CODEOWNERS) printf '%s' "s#@$owner([^[:alnum:]-]|$)#\\1#Ig" ;;
    .github/FUNDING.yml) printf '%s' "s#^github: \\[$owner\\]##I" ;;
    CODE_OF_CONDUCT.md) printf '%s' "s#@$owner([^[:alnum:]-]|$)#\\1#Ig; s#github\\.com/$owner([^/[:alnum:]-]|$)#\\1#Ig" ;;
    *) printf '%s' '' ;;
  esac
}
# sha256 of the owner's Cloudflare account ID, Cloudflare Access app ID, GitHub App ID and the
# App's client ID. Candidates are strings of those shapes (32 hex digits, a UUID, a 7-digit number,
# a GitHub App client ID), so hashing them stays cheap. Hex is matched in either case, and a
# candidate may be glued to other text as long as it doesn't follow a hex digit (a digit, for the
# number): `id1234567` and `x1234567y` hold one, `01234567` doesn't hold `1234567`.
id_shapes='[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{7}|Iv[0-9a-z]{16,20}'
# The shapes with what may precede them (matched case-insensitively); `tokens` then takes the
# shape back out of each match.
hex='[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
id_candidates="(^|[^0-9a-f])($hex)|(^|[^0-9])[0-9]{7}|Iv[0-9a-z]{16,20}"
id_hashes=(
  781bdfb8dc578c6ac2c0567e2efb3f3151eb073f94a32aaa446f0c53f31da6f6
  cf5412cc60ce75d147fddbfecb919b9ea4234feacd77184c0290eae72acf0cc5
  1650e726e5b47b32409b4912b05ca92d58fcac4ec9e5846eba23896d848caf70
  28143c7f0470337001027267fe391888342e66d134a1dc5b1485e7e6ecd52b57
)

found=0
report() { printf '%s\n' "$1" >&2; found=1; }

# Hits as `file:line:text`, from `git grep` (repository mode) or `grep -r` (paths).
if (($# == 0)); then
  cd "$repo"
  label="the tracked files"
  hits() { git grep -I -n -i -E "$pattern" -- . ':(exclude)CHANGELOG.md' || true; }
  candidates() { git grep -I -h -o -i -E "$id_candidates" -- . ':(exclude)CHANGELOG.md' || true; }
  names() { git ls-files | grep -i -E "$pattern" || true; }
else
  label="${*#"$repo"/}"
  hits() { grep -r -I -n -i -E "$pattern" "$@" || true; }
  candidates() { grep -r -I -h -o -i -E "$id_candidates" "$@" || true; }
  # Names below each path, so a path's own location (a home directory, say) doesn't count.
  names() { find "$@" -mindepth 1 -printf '%P\n' | grep -i -E "$pattern" || true; }
fi

while IFS= read -r name; do
  [[ -n "$name" ]] && report "${name#"$repo"/}: the file name names the owner's instance"
done < <(names "$@")

while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  text="${rest#*:}"
  rel="${file#"$repo"/}"
  [[ -n "$text" ]] || continue
  if sed -E "$strip_global; $(strip_for "$rel")" <<<"$text" | grep -qiE "$pattern"; then
    report "$rel:$rest"
  fi
done < <(hits "$@")

tokens() { candidates "$@" | grep -o -i -E "$id_shapes" || true; }
while IFS= read -r token; do
  [[ -n "$token" ]] || continue
  # As written, and lowercased (the hex IDs' hashes are of their lowercase form).
  for form in "$token" "${token,,}"; do
    sum="$(printf '%s' "$form" | sha256sum)"
    for h in "${id_hashes[@]}"; do
      if [[ "${sum%% *}" == "$h" ]]; then
        report "an identifier of the owner's accounts: $token (find it with: grep -rni '$token')"
        continue 3
      fi
    done
  done
done < <(tokens "$@" | sort -u)

if ((found)); then
  echo "Owner-specific values above. Use generic wording or example values; an instance's own values belong in its instance.env (deploy tooling) or its operator's notes" >&2
  exit 1
fi
echo "No owner-specific values in $label"
