#!/usr/bin/env bash
# The release workflow's publish mode (`gh workflow run release.yml --ref main -f publish_tag=vX.Y.Z`,
# docs/releasing.md, D61): checks that vX.Y.Z is a release a maintainer created by hand for a
# release commit of `main` that hasn't been published yet, and writes the outputs release-please
# would have written for it (release_created, tag_name, version, sha) to $GITHUB_OUTPUT, so the
# publishing jobs build, attest and publish exactly that commit.
#
#   TAG=vX.Y.Z [REPUBLISH=true] GITHUB_REF=refs/heads/main GITHUB_SHA=<the run's commit> \
#     GITHUB_REPOSITORY=<owner/repo> GITHUB_OUTPUT=<file> GH_TOKEN=<token> scripts/release-publish-check.sh
#
# Run from a checkout of `main` with its full history (fetch-depth: 0). Refuses, before writing any
# output:
#
#   - a run from any ref but refs/heads/main;
#   - a tag that isn't vX.Y.Z;
#   - no published release for the tag: a draft, a prerelease or an immutable release (which can't
#     take the bundle) doesn't count;
#   - a release that isn't the newest published one (publishing it would move the image's `latest`
#     and X.Y tags back to an older version);
#   - a tag whose commit (annotated tags peeled, as GitHub resolves it) isn't on the first-parent
#     line of the run's commit, the head of `main`: every commit merged to `main` is on it, while a
#     release PR's branch head or the commits of a merged branch aren't;
#   - a commit whose root package.json `version`, .release-please-manifest.json and
#     packages/core/src/version.ts don't all say X.Y.Z, or that isn't the commit that set X.Y.Z (its
#     first parent already had it), so a tag moved to a later commit of the same version can't
#     publish code that merged after the release;
#   - a release that already has its waypoint-deploy-X.Y.Z.tgz, unless REPUBLISH=true.
#
# Republishing rebuilds the image (a new index digest under the same tags) and replaces the bundle.
# Every artifact it publishes still comes from the release commit and is attested like the first,
# and the newest-release rule above keeps `latest` from moving back; but instances that already
# fetched the first bundle keep its digest while new ones get the second. It's only for a release
# whose published artifacts are unusable (its image deleted from the registry, say); anything else
# is better fixed by a new release.
#
# Also warns (without failing) when a merged release PR still has the `autorelease: pending`
# label, which makes every later release-please run fail until it's relabelled.
#
# A script rather than inline shell so scripts/release-dry-run.sh can run it against a stand-in gh
# and a scratch repository.
set -euo pipefail

: "${TAG?}" "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_OUTPUT:?}"
republish="${REPUBLISH:-false}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
repo="$GITHUB_REPOSITORY"

die() {
  local message="$1"
  message="${message//'%'/'%25'}"
  message="${message//$'\r'/'%0D'}"
  message="${message//$'\n'/'%0A'}"
  echo "::error title=publish_tag refused::$message"
  exit 1
}

# The ref, the input and the run's commit, before anything is asked of GitHub.
[[ "$GITHUB_REF" == refs/heads/main ]] || die "publish mode runs from main only, not $GITHUB_REF"
[[ "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || die "publish_tag must be a release tag vX.Y.Z (for example v1.2.3), not '${TAG:0:100}'"
version="${BASH_REMATCH[1]}"
[[ "$republish" == true || "$republish" == false ]] || die "republish must be true or false"
[[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "unexpected repository: $repo"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || die "unexpected run commit: $GITHUB_SHA"
git cat-file -e "$GITHUB_SHA^{commit}" 2> /dev/null || die "the checkout doesn't have the run's commit $GITHUB_SHA"
asset="waypoint-deploy-$version.tgz"

err="$(mktemp)"
trap 'rm -f "$err" "$err.main"' EXIT
last_error() { tail -n 1 "$err" | cut -c1-300; }

# The release. GET /releases/tags/{tag} answers only for a published (non-draft) release.
release="$(gh api "repos/$repo/releases/tags/$TAG" 2> "$err")" \
  || die "no published GitHub release for $TAG ($(last_error)); create it first (a draft doesn't count)"
jq -e --arg tag "$TAG" '.tag_name == $tag' <<< "$release" > /dev/null 2>&1 || die "GitHub answered with another release than $TAG"
[[ "$(jq -r '.draft' <<< "$release")" == false ]] || die "the $TAG release is a draft; publish it first"
[[ "$(jq -r '.prerelease' <<< "$release")" == false ]] || die "the $TAG release is a prerelease, which instances never deploy"
[[ "$(jq -r '.immutable // false' <<< "$release")" == false ]] \
  || die "the $TAG release is immutable, so the bundle can't be attached to it"
has_bundle="$(jq -r --arg a "$asset" '[.assets[]?.name] | index($a) != null' <<< "$release")"
if [[ "$has_bundle" == true && "$republish" != true ]]; then
  die "the $TAG release already has $asset, so it's published; republishing it is refused unless republish=true (see docs/releasing.md)"
fi

# The newest published release: publishing an older one would move the image's `latest` (and,
# within one minor version, X.Y) tag back to it.
newest="$(gh api --paginate "repos/$repo/releases?per_page=100" 2> "$err" \
  | jq -rs 'add // [] | .[] | select(.draft == false and .prerelease == false) | .tag_name
      | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' | sed 's/^v//' | sort -V | tail -n 1)" \
  || die "couldn't list the releases ($(last_error))"
[[ -n "$newest" ]] || die "couldn't list the releases ($(last_error))"
[[ "$newest" == "$version" ]] \
  || die "$TAG isn't the newest release (v$newest is): publishing it would move the image's latest tag back to it"

# The tag's commit as GitHub resolves it, annotated tags peeled.
ref="$(gh api "repos/$repo/git/ref/tags/$TAG" 2> "$err")" || die "no tag $TAG ($(last_error))"
jq -e --arg r "refs/tags/$TAG" '.ref == $r' <<< "$ref" > /dev/null 2>&1 || die "GitHub answered with another ref than refs/tags/$TAG"
type="$(jq -r '.object.type' <<< "$ref")"
sha="$(jq -r '.object.sha' <<< "$ref")"
for _ in 1 2 3 4 5; do
  [[ "$type" == tag ]] || break
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "unexpected tag object for $TAG: $sha"
  tag_object="$(gh api "repos/$repo/git/tags/$sha" 2> "$err")" || die "couldn't read the $TAG tag object ($(last_error))"
  type="$(jq -r '.object.type' <<< "$tag_object")"
  sha="$(jq -r '.object.sha' <<< "$tag_object")"
done
[[ "$type" == commit && "$sha" =~ ^[0-9a-f]{40}$ ]] || die "$TAG doesn't name a commit"

# On main's first-parent line: a commit merged to main, not a branch's.
git cat-file -e "$sha^{commit}" 2> /dev/null || die "$TAG names ${sha::12}, which isn't in main's history"
git rev-list --first-parent "$GITHUB_SHA" > "$err.main" || die "couldn't list main's history"
grep -qx "$sha" "$err.main" \
  || die "$TAG names ${sha::12}, which isn't a commit of main (on its first-parent line up to ${GITHUB_SHA::12})"

# The release commit of X.Y.Z: every version file says X.Y.Z, and its first parent's manifest didn't.
file_at() { git show "$1:$2" 2> /dev/null; }
pkg_version="$(file_at "$sha" package.json | jq -r '.version // empty' 2> /dev/null || true)"
manifest_version="$(file_at "$sha" .release-please-manifest.json | jq -r '.["."] // empty' 2> /dev/null || true)"
ts_version="$(file_at "$sha" packages/core/src/version.ts \
  | sed -n 's/^export const WAYPOINT_VERSION[^=]*= *"\([^"]*\)";.*x-release-please-version.*$/\1/p' | head -n 1 || true)"
for pair in "package.json:$pkg_version" ".release-please-manifest.json:$manifest_version" "packages/core/src/version.ts:$ts_version"; do
  [[ "${pair#*:}" == "$version" ]] \
    || die "at ${sha::12}, ${pair%%:*} says '${pair#*:}', not $version: $TAG doesn't name the $version release commit"
done
git rev-parse -q --verify "$sha^1^{commit}" > /dev/null || die "$TAG names ${sha::12}, which has no parent"
parent_version="$(file_at "$sha^1" .release-please-manifest.json | jq -r '.["."] // empty' 2> /dev/null || true)"
[[ "$parent_version" != "$version" ]] \
  || die "$TAG names ${sha::12}, but $version was already released before it (its parent says $version): move the tag to the commit that set $version"

# A merged release PR still labelled `autorelease: pending` fails every later release-please run.
if pending="$(gh api "repos/$repo/issues?state=closed&labels=autorelease%3A%20pending&per_page=100" 2> "$err")"; then
  numbers="$(jq -r '[.[] | select(.pull_request.merged_at != null) | "#\(.number)"] | join(" ")' <<< "$pending" 2> /dev/null || true)"
  if [[ -n "$numbers" ]]; then
    echo "::warning title=Release PR still pending::merged release PR(s) $numbers still have the 'autorelease: pending' label, so later release runs will fail; relabel each: gh pr edit <number> --repo $repo --remove-label 'autorelease: pending' --add-label 'autorelease: tagged'"
  fi
else
  echo "::warning title=Release PR labels unchecked::couldn't list release PRs labelled 'autorelease: pending' ($(last_error))"
fi

mode=publishing
[[ "$has_bundle" == true ]] && mode=republishing
{
  echo "release_created=true"
  echo "tag_name=$TAG"
  echo "version=$version"
  echo "sha=$sha"
} >> "$GITHUB_OUTPUT"
echo "Publish mode: $mode $TAG ($version) from $sha" | tee -a "$summary"
