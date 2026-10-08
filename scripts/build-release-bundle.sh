#!/usr/bin/env bash
# Builds the release bundle, waypoint-deploy-<version>.tgz: everything an instance needs to deploy
# that release with deploy/upgrade.sh, without the monorepo. The release workflow runs it after the
# writer image is published; scripts/release-dry-run.sh runs it in CI. Run it locally the same way.
#
#   scripts/build-release-bundle.sh --out DIR [--version X.Y.Z] [--sha COMMIT]
#                                   [--image-digest sha256:<hex>] [--reader FILE]
#
#   --out DIR             where the .tgz and its .sha256 go (created if missing)
#   --version X.Y.Z       the release version; must equal the root package.json version, which
#                         the reader build reports (default: that version)
#   --sha COMMIT          the commit the release, and its image, were built from (default: HEAD).
#                         Becomes BUILD_SHA, which the image's WAYPOINT_BUILD_SHA must equal.
#   --image-digest D      the writer image's multi-arch index digest, the one the release
#                         workflow attested; written to IMAGE_DIGEST, so upgrade.sh pulls by it
#   --reader FILE         the built reader Worker (default: apps/reader/dist/index.js, from
#                         `pnpm --filter "@waypoint/reader..." build`)
#
# The tarball holds one directory, waypoint-deploy-<version>/, which upgrade.sh unpacks with
# --strip-components=1 (keep the two in sync; deploy/README.md lists the layout). It's
# reproducible: sorted entries, fixed owners and modes, and the commit's timestamp. Fails if any
# file names the owner's instance (scripts/check-owner-strings.sh). Prints the .tgz path.
set -euo pipefail
umask 022

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "build-release-bundle: $*" >&2; exit 1; }

out="" version="" sha="" image_digest="" reader="$repo/apps/reader/dist/index.js"
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
while (($#)); do
  case "$1" in
    --out) need "$@"; out="$2"; shift 2 ;;
    --version) need "$@"; version="$2"; shift 2 ;;
    --sha) need "$@"; sha="$2"; shift 2 ;;
    --image-digest) need "$@"; image_digest="$2"; shift 2 ;;
    --reader) need "$@"; reader="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[[ -n "$out" ]] || die "--out is required"

package_version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"
version="${version:-$package_version}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid version: $version"
[[ "$version" == "$package_version" ]] || die "version $version isn't the root package.json version ($package_version)"
if [[ -z "$sha" ]]; then sha="$(git -C "$repo" rev-parse --verify HEAD)"; fi
sha="$(git -C "$repo" rev-parse --verify --quiet "$sha^{commit}")" || die "no commit $sha in this checkout"
[[ -z "$image_digest" || "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "--image-digest must be sha256:<64 hex digits>"
[[ -s "$reader" ]] || die "no reader build at $reader (pnpm --filter \"@waypoint/reader...\" build)"
wrangler_version="$(node -p 'require(process.argv[1]).devDependencies.wrangler' "$repo/apps/reader/package.json")"
[[ "$wrangler_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "apps/reader pins wrangler as $wrangler_version, not an exact version"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
name="waypoint-deploy-$version"
d="$stage/$name"
mkdir -p "$d/lib" "$d/reader" "$d/ops" "$d/docs"

install -m 755 "$repo/deploy/upgrade.sh" "$repo/deploy/make-instance-env.sh" "$d/"
install -m 644 "$repo/deploy/compose.yaml" "$repo/deploy/compose.tailscale.yaml" "$repo/deploy/serve.json" \
  "$repo/deploy/instance.env.example" "$repo/deploy/README.md" "$d/"
install -m 644 "$repo/deploy/lib/env.sh" "$repo/deploy/lib/reader-config.mjs" "$d/lib/"
install -m 644 "$repo/deploy/ops/deploy.yml.example" "$d/ops/"
install -m 644 "$repo/docs/self-hosting.md" "$d/docs/"
# The reader Worker inlines third-party code: its notices travel with it.
install -m 644 "$repo/LICENSE" "$repo/THIRD_PARTY_NOTICES.md" "$d/"
install -m 644 "$reader" "$d/reader/index.js"
install -m 644 "$repo/apps/reader/wrangler.jsonc" "$d/reader/wrangler.jsonc"
printf '%s\n' "$wrangler_version" > "$d/reader/WRANGLER_VERSION"
printf '%s\n' "$version" > "$d/VERSION"
printf '%s\n' "$sha" > "$d/BUILD_SHA"
if [[ -n "$image_digest" ]]; then printf '%s\n' "$image_digest" > "$d/IMAGE_DIGEST"; fi
(cd "$d" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum) > "$stage/SHA256SUMS"
mv "$stage/SHA256SUMS" "$d/SHA256SUMS"
chmod 644 "$d"/{VERSION,BUILD_SHA,SHA256SUMS} "$d/reader/WRANGLER_VERSION"
[[ -z "$image_digest" ]] || chmod 644 "$d/IMAGE_DIGEST"
find "$d" -type d -exec chmod 755 {} +

# What upgrade.sh expects in a bundle (resolve_release, exec_release_bundle, resolve_wrangler).
for f in upgrade.sh lib/env.sh lib/reader-config.mjs compose.yaml compose.tailscale.yaml serve.json \
  VERSION BUILD_SHA SHA256SUMS reader/index.js reader/wrangler.jsonc reader/WRANGLER_VERSION \
  LICENSE THIRD_PARTY_NOTICES.md; do
  [[ -s "$d/$f" ]] || die "the bundle has no $f"
done
bash "$repo/scripts/check-owner-strings.sh" "$d" >&2 || die "the bundle names the owner's instance"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
epoch="$(git -C "$repo" show -s --format=%ct "$sha")"
tar --sort=name --format=gnu --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
  -C "$stage" -cf - "$name" | gzip -n -9 > "$out/$name.tgz.tmp"
mv "$out/$name.tgz.tmp" "$out/$name.tgz"
(cd "$out" && sha256sum "$name.tgz" > "$name.tgz.sha256")
echo "build-release-bundle: $out/$name.tgz ($(wc -c < "$out/$name.tgz") bytes, commit $sha${image_digest:+, image $image_digest})" >&2
printf '%s\n' "$out/$name.tgz"
