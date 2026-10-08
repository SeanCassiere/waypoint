#!/usr/bin/env bash
# The release workflow's `dispatch` job: checks the ops repository and workflow it's configured
# to start, and writes them as step outputs (owner, name, workflow) to $GITHUB_OUTPUT.
#
#   REPO=<owner/repo> WORKFLOW=<file.yml> GITHUB_OUTPUT=<file> scripts/release-dispatch-target.sh
#
# A script rather than inline shell so scripts/release-dry-run.sh can run it.
set -euo pipefail

: "${REPO:?}" "${WORKFLOW:?}" "${GITHUB_OUTPUT:?}"
[[ "$REPO" =~ ^([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)$ ]] || { echo "::error::DEPLOY_DISPATCH_REPO must be owner/repo"; exit 1; }
# Taken before the next match replaces BASH_REMATCH.
owner="${BASH_REMATCH[1]}"
name="${BASH_REMATCH[2]}"
[[ "$name" != . && "$name" != .. ]] || { echo "::error::DEPLOY_DISPATCH_REPO must be owner/repo"; exit 1; }
[[ "$WORKFLOW" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || { echo "::error::DEPLOY_DISPATCH_WORKFLOW must be a workflow file name"; exit 1; }
{ echo "owner=$owner"; echo "name=$name"; echo "workflow=$WORKFLOW"; } >> "$GITHUB_OUTPUT"
