#!/usr/bin/env bash
# Fails if a workflow of this repository could run on a self-hosted runner (D58). This repository
# is public and takes pull requests from forks, and a self-hosted runner attached to it would run
# whatever a workflow change asks for on the host; instances deploy from their own private ops
# repository instead (deploy/ops/deploy.yml.example, which isn't scanned).
#
#   scripts/check-hosted-runners.sh            .github/workflows/ of this repository (CI's lint job)
#   scripts/check-hosted-runners.sh DIR...     the workflow files (*.yml, *.yaml) in these directories
#
# Exits 1 when a workflow fails the check, and 2 for a directory that doesn't exist or holds no
# workflow.
#
# The rules, checked line by line (a workflow is YAML, but every runs-on this repository uses is a
# one-line value, and anything else is refused rather than parsed):
#   - `self-hosted` may not appear as a value anywhere (a label in runs-on, a matrix or an input);
#   - every `runs-on:` is one GitHub-hosted label on the same line (ubuntu-*, windows-*, macos-*),
#     or `${{ matrix.NAME }}` where every `NAME:` value in the file is such a label. A list, a
#     `group:`/`labels:` mapping, a block value or any other expression is refused: those are how
#     self-hosted runners are selected, and a lone custom label selects one too.
# A GitHub-hosted larger runner with a custom label would need a rule of its own here.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dirs=("$@")
[[ ${#dirs[@]} -gt 0 ]] || dirs=("$repo/.github/workflows")

files=()
for dir in "${dirs[@]}"; do
  [[ -d "$dir" ]] || { echo "check-hosted-runners: no such directory: $dir" >&2; exit 2; }
  for f in "$dir"/*.yml "$dir"/*.yaml; do
    [[ -f "$f" ]] && files+=("$f")
  done
done
[[ ${#files[@]} -gt 0 ]] || { echo "check-hosted-runners: no workflow files in ${dirs[*]}" >&2; exit 2; }

status=0
for f in "${files[@]}"; do
  [[ -r "$f" ]] || { echo "$f: can't be read" >&2; status=1; continue; }
  # awk prints one finding per line; any output fails the file.
  findings="$(awk -v q="'" '
    BEGIN {
      selfhosted = "(^|[][ \t,:\"" q "{])self-hosted($|[][ \t,\"" q "}])"
      quoted = "^(\".*\"|" q ".*" q ")$"
    }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    # A value with its trailing comment and quotes removed.
    function value(s) {
      s = trim(s)
      if (substr(s, 1, 1) != "\"" && substr(s, 1, 1) != q) sub(/[ \t]+#.*$/, "", s)
      s = trim(s)
      if (length(s) >= 2 && s ~ quoted) s = substr(s, 2, length(s) - 2)
      return s
    }
    function hosted(s) { return s ~ /^(ubuntu|windows|macos)-[A-Za-z0-9.]+(-[A-Za-z0-9.]+)*$/ }
    {
      line[NR] = $0
      if ($0 ~ /^[ \t]*#/) next
      text = $0
      sub(/[ \t]+#.*$/, "", text)
      if (tolower(text) ~ selfhosted)
        print NR ": names a self-hosted runner"
      if (match(text, /^[ \t]*-?[ \t]*runs-on[ \t]*:/)) {
        v = value(substr(text, RLENGTH + 1))
        if (v == "")
          print NR ": runs-on must be one GitHub-hosted label on the same line, not a block value"
        else if (v ~ /^\$\{\{[ \t]*matrix\.[A-Za-z0-9_-]+[ \t]*\}\}$/) {
          name = v
          sub(/^\$\{\{[ \t]*matrix\./, "", name)
          sub(/[ \t]*\}\}$/, "", name)
          matrix[NR] = name
        } else if (!hosted(v))
          print NR ": runs-on: " v " is not a single GitHub-hosted label"
      }
    }
    END {
      for (at in matrix) {
        name = matrix[at]
        seen = 0
        for (i = 1; i <= NR; i++) {
          text = line[i]
          if (text ~ /^[ \t]*#/) continue
          if (!match(text, "^[ \t]*-?[ \t]*" name "[ \t]*:")) continue
          v = value(substr(text, RLENGTH + 1))
          sub(/[ \t]+#.*$/, "", v)
          if (v ~ /^\[.*\]$/) v = substr(v, 2, length(v) - 2)
          n = split(v, parts, ",")
          if (n == 0) { print i ": matrix." name " must list GitHub-hosted labels on the same line"; continue }
          for (j = 1; j <= n; j++) {
            p = value(parts[j])
            seen++
            if (!hosted(p)) print i ": matrix." name ": " p " is not a GitHub-hosted label"
          }
        }
        if (seen == 0) print at ": runs-on: matrix." name " has no values in this file to check"
      }
    }
  ' "$f")" || { echo "$f: can't be checked" >&2; status=1; continue; }
  if [[ -n "$findings" ]]; then
    while IFS= read -r finding; do echo "${f#"$repo/"}:$finding" >&2; done <<< "$findings"
    status=1
  fi
done

if [[ $status -ne 0 ]]; then
  echo "Workflows here must run on GitHub-hosted runners only (D58, docs/trust-model.md#deploy-pipeline)." >&2
fi
exit "$status"
