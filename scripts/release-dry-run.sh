#!/usr/bin/env bash
# Checks the release pipeline without publishing anything (the CI job `release-dry-run`):
#
#   1. actionlint on every workflow and on the ops workflow template (deploy/ops/deploy.yml.example);
#   2. the release-please config against its schema, the versions it keeps in step, and oxfmt
#      leaving the CHANGELOG.md it writes alone (else the release PR's format check fails);
#   3. the release workflow's dispatch target check (scripts/release-dispatch-target.sh), which
#      accepts owner/repo and a workflow file name only;
#   4. scripts/build-release-bundle.sh: the layout upgrade.sh unpacks, SHA256SUMS, a reproducible
#      tarball, and the refusals (another version, a file naming the owner's instance);
#   5. upgrade.sh's release mode against a fake release: a stand-in curl serves the bundle and the
#      release list from a local directory, and a stand-in gh answers `gh attestation
#      verify` (recording the policy it was asked for) and refuses the subjects it's told to.
#      `latest` must skip newer releases that are drafts, prereleases or have no bundle yet. A
#      dry run of `latest` must verify the bundle before unpacking it and the image digest before
#      the (would-be) pull, and validate each reader target's generated config against the
#      bundled Worker with the checkout's Wrangler; a refused attestation, a corrupted bundle or a
#      missing or outdated gh must stop the run before anything is unpacked or deployed, and a
#      bundle cached while verification was off is fetched and verified again once it's on.
#
# Needs the reader build (pnpm --filter "@waypoint/reader..." build), the workspace's Wrangler,
# Docker (compose config) and, for 1 and 2, the network. ACTIONLINT=<path> uses that actionlint
# instead of downloading the pinned one.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "release dry run FAILED: $*" >&2; exit 1; }
step() { echo "--- $*" >&2; }
chmod 700 "$work"

actionlint_version=1.7.12
actionlint_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 # linux_amd64
# release-please 17.6.0, the version googleapis/release-please-action v5.0.0 runs.
schema_url=https://raw.githubusercontent.com/googleapis/release-please/712fcf01effd08d7b0e7b1fd3861f2cb388bc8d1/schemas/config.json
schema_sha256=82ae5d0a805cd3e4c437ce7a4d3eae1e3db51706ad414c624cc749ca02e7c1c5

step "actionlint"
actionlint="${ACTIONLINT:-}"
if [[ -z "$actionlint" ]]; then
  [[ "$(uname -sm)" == "Linux x86_64" ]] || fail "no pinned actionlint for $(uname -sm); set ACTIONLINT"
  curl -fsSL --retry 3 -o "$work/actionlint.tgz" \
    "https://github.com/rhysd/actionlint/releases/download/v$actionlint_version/actionlint_${actionlint_version}_linux_amd64.tar.gz"
  echo "$actionlint_sha256  $work/actionlint.tgz" | sha256sum -c --quiet -
  tar -xzf "$work/actionlint.tgz" -C "$work" actionlint
  actionlint="$work/actionlint"
fi
cp "$repo/deploy/ops/deploy.yml.example" "$work/ops-deploy.yml"
(cd "$repo" && "$actionlint" -config-file .github/actionlint.yaml .github/workflows/*.yml "$work/ops-deploy.yml") \
  || fail "actionlint"

step "release-please config"
curl -fsSL --retry 3 -o "$work/release-please-schema.json" "$schema_url"
echo "$schema_sha256  $work/release-please-schema.json" | sha256sum -c --quiet -
(cd "$work" && npx --yes -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv validate --spec=draft7 --strict=false \
  -c ajv-formats -s "$work/release-please-schema.json" -d "$repo/release-please-config.json") \
  || fail "release-please-config.json doesn't match the schema"
# The root package.json, the manifest and WAYPOINT_VERSION (whose agreement a core test checks)
# move together, and release-please rewrites version.ts through its annotation.
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("node:fs");
  const [root, manifest, config, versionTs] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
  const version = JSON.parse(root).version;
  if (JSON.parse(manifest)["."] !== version) throw new Error("manifest version != package.json version");
  const pkg = JSON.parse(config).packages["."];
  if (!pkg["extra-files"].includes("packages/core/src/version.ts")) throw new Error("version.ts is not an extra file");
  if (!versionTs.includes(`"${version}"; // x-release-please-version`)) throw new Error("version.ts lost its annotation");
' "$repo/package.json" "$repo/.release-please-manifest.json" "$repo/release-please-config.json" \
  "$repo/packages/core/src/version.ts" || fail "release-please's versions are out of step"
# release-please writes CHANGELOG.md in its own style (`*` bullets, two blank lines between
# sections), which oxfmt would rewrite, so the release PR's format check would always fail.
# Checked in a copy of the root config: a NOTES.md with the same text must fail, CHANGELOG.md pass.
fmt="$work/oxfmt"
mkdir "$fmt"
cp "$repo/oxfmt.config.ts" "$fmt/"
ln -s "$repo/node_modules" "$fmt/node_modules"
cat > "$fmt/CHANGELOG.md" <<'EOF'
# Changelog

## [0.2.0](https://github.com/example/waypoint/compare/v0.1.0...v0.2.0) (2026-10-08)


### Features

* **writer:** a feature ([#12](https://github.com/example/waypoint/issues/12)) ([abc1234](https://github.com/example/waypoint/commit/abc1234))


### Bug Fixes

* a fix ([def5678](https://github.com/example/waypoint/commit/def5678))
EOF
cp "$fmt/CHANGELOG.md" "$fmt/NOTES.md"
if (cd "$fmt" && "$repo/node_modules/.bin/oxfmt" --check NOTES.md > /dev/null 2>&1); then
  fail "oxfmt accepts release-please's changelog style, so this check proves nothing"
fi
rm "$fmt/NOTES.md"
(cd "$fmt" && "$repo/node_modules/.bin/oxfmt" --check . > "$work/err.log" 2>&1) \
  || { cat "$work/err.log" >&2; fail "oxfmt checks CHANGELOG.md, which release-please writes; add it to oxfmt's ignorePatterns"; }

step "the dispatch target (scripts/release-dispatch-target.sh)"
dispatch_target() {
  : > "$work/dispatch.out"
  REPO="$1" WORKFLOW="$2" GITHUB_OUTPUT="$work/dispatch.out" bash "$repo/scripts/release-dispatch-target.sh" > "$work/err.log" 2>&1
}
dispatch_target Example-Org/waypoint-ops deploy.yml || { cat "$work/err.log" >&2; fail "a valid dispatch target was refused"; }
[[ "$(cat "$work/dispatch.out")" == $'owner=Example-Org\nname=waypoint-ops\nworkflow=deploy.yml' ]] \
  || { cat "$work/dispatch.out" >&2; fail "unexpected dispatch target outputs"; }
for bad in "example|deploy.yml" "example/ops/x|deploy.yml" "example/..|deploy.yml" "example/ops|../deploy.yml" "example/ops|deploy.sh"; do
  if dispatch_target "${bad%%|*}" "${bad#*|}"; then fail "accepted the dispatch target $bad"; fi
  [[ ! -s "$work/dispatch.out" ]] || fail "the refused dispatch target $bad wrote outputs"
done

step "build-release-bundle.sh"
version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"
sha="$(git -C "$repo" rev-parse HEAD)"
digest="sha256:$(printf 'waypoint release dry run' | sha256sum | cut -d' ' -f1)"
name="waypoint-deploy-$version"
rel="$work/release"
tgz="$(bash "$repo/scripts/build-release-bundle.sh" --out "$rel" --sha "$sha" --image-digest "$digest")"
[[ "$tgz" == "$rel/$name.tgz" ]] || fail "unexpected bundle path $tgz"
(cd "$rel" && sha256sum --quiet -c "$name.tgz.sha256") || fail "the .sha256 doesn't match"
! tar -tzf "$tgz" | grep -qv "^$name/" || fail "the bundle has entries outside $name/"
mkdir "$work/unpacked"
tar -xzf "$tgz" -C "$work/unpacked" --strip-components=1
u="$work/unpacked"
for f in upgrade.sh lib/env.sh lib/reader-config.mjs compose.yaml compose.tailscale.yaml serve.json \
  instance.env.example make-instance-env.sh README.md ops/deploy.yml.example docs/self-hosting.md \
  VERSION BUILD_SHA IMAGE_DIGEST reader/index.js reader/wrangler.jsonc reader/WRANGLER_VERSION SHA256SUMS; do
  [[ -s "$u/$f" ]] || fail "the bundle has no $f"
done
(cd "$u" && sha256sum --quiet -c SHA256SUMS) || fail "SHA256SUMS doesn't match"
[[ "$(cd "$u" && find . -type f ! -name SHA256SUMS -printf '%P\n' | sort)" == "$(cut -c67- "$u/SHA256SUMS" | sort)" ]] \
  || fail "SHA256SUMS doesn't list exactly the bundle's files"
[[ "$(cat "$u/VERSION")" == "$version" && "$(cat "$u/BUILD_SHA")" == "$sha" && "$(cat "$u/IMAGE_DIGEST")" == "$digest" ]] \
  || fail "VERSION, BUILD_SHA or IMAGE_DIGEST is wrong"
[[ "$(cat "$u/reader/WRANGLER_VERSION")" == "$(node -p 'require(process.argv[1]).devDependencies.wrangler' "$repo/apps/reader/package.json")" ]] \
  || fail "WRANGLER_VERSION isn't the reader's pinned Wrangler"
cmp -s "$u/reader/index.js" "$repo/apps/reader/dist/index.js" || fail "the bundled Worker isn't the reader build"
[[ -x "$u/upgrade.sh" && "$(stat -c %a "$u/lib/env.sh")" == 644 ]] || fail "unexpected file modes"
again="$(bash "$repo/scripts/build-release-bundle.sh" --out "$work/again" --sha "$sha" --image-digest "$digest" 2>/dev/null)"
cmp -s "$tgz" "$again" || fail "two builds of the same commit differ"
if bash "$repo/scripts/build-release-bundle.sh" --out "$work/x" --version 99.0.0 2> "$work/err.log"; then
  fail "built a bundle for another version than package.json's"
fi
grep -q "isn't the root package.json version" "$work/err.log" || fail "the version refusal isn't explained"
owner='sean''cassiere'
cp "$repo/apps/reader/dist/index.js" "$work/planted.js"
echo "// https://$owner.example.test" >> "$work/planted.js"
if bash "$repo/scripts/build-release-bundle.sh" --out "$work/x" --reader "$work/planted.js" 2> "$work/err.log"; then
  fail "built a bundle that names the owner"
fi
grep -q "names the owner's instance" "$work/err.log" || { cat "$work/err.log" >&2; fail "the owner-string refusal isn't explained"; }

step "upgrade.sh release mode against a fake release"
bin="$work/bin"
mkdir -p "$bin"
real_curl="$(command -v curl)"
# The release list, newest first by date as GitHub sends it, but not by version: only $version has
# its bundle. The newer ones are a release still publishing (no asset yet), one whose bundle upload
# never finished, a prerelease and a draft; `latest` must skip them all, and say why.
asset() { printf '{"name":"waypoint-deploy-%s.tgz","state":"%s"}' "$1" "${2:-uploaded}"; }
cat > "$work/releases.json" <<EOF
[
  {"tag_name":"v$version","draft":false,"prerelease":false,"assets":[$(asset "$version")]},
  {"tag_name":"v99.0.0","draft":false,"prerelease":false,"assets":[]},
  {"tag_name":"v98.0.0","draft":false,"prerelease":false,"assets":[$(asset 98.0.0 open)]},
  {"tag_name":"v97.0.0","draft":false,"prerelease":true,"assets":[$(asset 97.0.0)]},
  {"tag_name":"v96.0.0","draft":true,"prerelease":false,"assets":[$(asset 96.0.0)]},
  {"tag_name":"v95.0.0-rc.1","draft":false,"prerelease":false,"assets":[$(asset 95.0.0-rc.1)]}
]
EOF
cat > "$bin/curl" <<EOF
#!/usr/bin/env bash
out="" url=""
for ((i = 1; i <= \$#; i++)); do
  case "\${!i}" in
    -o) j=\$((i + 1)); out="\${!j}" ;;
    https://*) url="\${!i}" ;;
  esac
done
case "\$url" in
  https://github.com/example/waypoint/releases/download/v$version/$name.tgz)
    echo download >> "$work/downloads"
    exec cp "\${FAKE_BUNDLE:-$tgz}" "\$out" ;;
  https://api.github.com/repos/example/waypoint/releases\?per_page=100)
    exec cat "\${FAKE_RELEASES:-$work/releases.json}" ;;
  https://github.com/*|https://api.github.com/*)
    echo "fake curl: unexpected \$url" >&2; exit 22 ;;
esac
exec "$real_curl" "\$@"
EOF
# FAKE_GH_VERSION: what --version reports. FAKE_GH_DENY: a substring of the subjects to refuse.
cat > "$bin/gh" <<EOF
#!/usr/bin/env bash
case "\$1 \${2:-}" in
  "--version ") echo "gh version \${FAKE_GH_VERSION:-2.102.0} (2026-09-30)" ;;
  "api repos/example/waypoint") echo Example/waypoint ;;
  "attestation verify")
    printf '%s\n' "\${*:3}" >> "$work/gh.log"
    if [[ -n "\${FAKE_GH_DENY:-}" && "\$3" == *"\$FAKE_GH_DENY"* ]]; then
      echo "Error: verifying with issuer \"sigstore.dev\"" >&2; exit 1
    fi
    echo "Loaded 1 attestation from GitHub API"; echo "✓ Verification succeeded!" ;;
  *) echo "fake gh: unexpected \$*" >&2; exit 2 ;;
esac
EOF
chmod 700 "$bin/curl" "$bin/gh"

cd "$work"
printf 'WAYPOINT_ENV=prod\nWAYPOINT_SYNC=off\n' > writer.env
printf 'CLOUDFLARE_ACCOUNT_ID=dry-run\nCLOUDFLARE_API_TOKEN=dry-run\n' > cloudflare.env
for t in dev prod; do
  cat > "reader-$t.env" <<'EOF'
TURSO_DATABASE_URL=libsql://db.example.test
TURSO_READONLY_TOKEN=dry-run
R2_READER_ACCESS_KEY_ID=dry-run
R2_READER_SECRET_ACCESS_KEY=dry-run
R2_BUCKET=dry-run
R2_ACCOUNT_ID=dry-run
RAW_CAP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
EOF
done
chmod 600 ./*.env
write_instance() {
  cat > instance.env <<EOF
DATA_DIR=$work/data
WRITER_ENV_FILE=writer.env
COMPOSE_PROJECT=release-dry-run
IMAGE=ghcr.io/example/waypoint-writer
READER_TARGETS=dev prod
READER_dev_WORKER=example-reader-dev
READER_dev_DOMAIN=dev.share.example.com
READER_dev_SECRETS_FILE=reader-dev.env
READER_dev_ANALYTICS_DATASET=example_access_dev
READER_dev_RATELIMIT_NAMESPACE=1001
READER_prod_WORKER=example-reader
READER_prod_DOMAIN=share.example.com
READER_prod_SECRETS_FILE=reader-prod.env
READER_prod_ANALYTICS_DATASET=example_access
READER_prod_RATELIMIT_NAMESPACE=1002
EOF
  if [[ -n "${1:-}" ]]; then echo "VERIFY_ATTESTATIONS=$1" >> instance.env; fi
  chmod 644 instance.env
}
state="$work/state/release-dry-run"
fresh() { rm -rf "$work/state"; : > "$work/gh.log"; : > "$work/wrangler.log"; : > "$work/downloads"; }
# The checkout's upgrade.sh, asked for a release, fetches that release's bundle and runs its own.
# The checkout's Wrangler validates each generated config against the bundled Worker.
release_run() {
  PATH="$bin:$PATH" DRY_RUN_LOG="$work/wrangler.log" WRANGLER="$repo/apps/reader/node_modules/.bin/wrangler" \
    bash "$repo/deploy/upgrade.sh" --instance "$work/instance.env" --dry-run "$@" 2> "$work/err.log"
}
show() { cat "$work/err.log" >&2; }

write_instance
fresh
release_run latest || { show; fail "the release dry run failed"; }
policy="--repo Example/waypoint --signer-workflow Example/waypoint/.github/workflows/release.yml --source-ref refs/heads/main --deny-self-hosted-runners"
[[ "$(sed -n 1p gh.log)" == *"/$name.tgz $policy" ]] || { cat gh.log >&2; fail "the bundle wasn't verified first, with the release policy"; }
[[ "$(sed -n 2p gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "the image digest wasn't verified with the release policy"; }
[[ "$(wc -l < gh.log)" == 2 ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }
grep -q "would pull ghcr.io/example/waypoint-writer@$digest" err.log || { show; fail "the image isn't pulled by the bundle's digest"; }
grep -q "running upgrade.sh from the $version bundle" err.log || { show; fail "the bundle's own upgrade.sh didn't run"; }
grep -q "reader configs validate with wrangler deploy --dry-run" err.log || { show; fail "the generated configs weren't validated"; }
grep -q "dry run passed: release-$version" err.log || { show; fail "the dry run didn't pass"; }
grep -q "latest release with a deploy bundle: $version$" err.log || { show; fail "latest didn't resolve to $version"; }
for skipped in "99.0.0: no waypoint-deploy-99.0.0.tgz yet" "98.0.0: no waypoint-deploy-98.0.0.tgz yet" \
  "97.0.0: a prerelease" "96.0.0: a draft"; do
  grep -q "skipping example/waypoint $skipped" err.log || { show; fail "latest didn't report skipping $skipped"; }
done
! grep -q "95.0.0" err.log || { show; fail "latest considered a tag that isn't X.Y.Z"; }
for t in dev prod; do
  grep -q "^wrangler deploy --config .*/reader-$t.json --var WAYPOINT_BUILD_SHA:$sha$" wrangler.log || { cat wrangler.log >&2; fail "reader $t doesn't deploy with the release commit"; }
done
cmp -s "$u/upgrade.sh" "$state/releases/$version/upgrade.sh" || fail "the bundle wasn't installed in the state directory"
[[ "$(cat "$state/releases/$version/.provenance")" == "attested example/waypoint" ]] || fail "the cached bundle doesn't record its attestation"

step "latest with no release that has its bundle"
printf '[{"tag_name":"v%s","draft":false,"prerelease":false,"assets":[]}]' "$version" > "$work/no-bundle.json"
if FAKE_RELEASES="$work/no-bundle.json" release_run latest; then fail "latest deployed a release without its bundle"; fi
grep -q "no release of example/waypoint has its deploy bundle" err.log || { show; fail "the missing bundle isn't explained"; }
! grep -q "running upgrade.sh from" err.log || { show; fail "a bundle ran"; }

step "a verified cached bundle is reused"
: > gh.log; : > downloads
release_run "$version" || { show; fail "the cached bundle's dry run failed"; }
[[ ! -s downloads ]] || fail "a verified cached bundle was downloaded again"
[[ "$(cat gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }

step "a bundle run directly (as the ops workflow does) verifies the image only"
: > gh.log
PATH="$bin:$PATH" DRY_RUN_LOG="$work/wrangler.log" WRANGLER="$repo/apps/reader/node_modules/.bin/wrangler" \
  bash "$u/upgrade.sh" --instance "$work/instance.env" --dry-run "$version" 2> err.log \
  || { show; fail "the bundle's own dry run failed"; }
[[ "$(cat gh.log)" == "oci://ghcr.io/example/waypoint-writer@$digest $policy" ]] || { cat gh.log >&2; fail "unexpected attestation checks"; }

step "a refused bundle attestation stops the run before it's unpacked"
fresh
if FAKE_GH_DENY="$name.tgz" release_run "$version"; then fail "an unattested bundle was accepted"; fi
grep -q "the release bundle has no valid attestation from Example/waypoint" err.log || { show; fail "the refusal isn't explained"; }
[[ ! -e "$state/releases/$version" ]] || fail "an unattested bundle was unpacked"

step "a refused image attestation stops the run before anything is deployed"
fresh
if FAKE_GH_DENY="oci://" release_run "$version"; then fail "an unattested image was accepted"; fi
grep -q "the writer image $digest has no valid attestation" err.log || { show; fail "the refusal isn't explained"; }
! grep -q "would pull\|would deploy" err.log || { show; fail "the run went on after the refusal"; }
! grep -Eq '^wrangler (secret|deploy|rollback) ' wrangler.log || fail "a reader changed after the refusal"

step "a corrupted bundle fails its checksums"
fresh
mkdir "$work/tampered" && tar -xzf "$tgz" -C "$work/tampered"
echo "# tampered" >> "$work/tampered/$name/upgrade.sh"
tar -czf "$work/tampered.tgz" -C "$work/tampered" "$name"
if FAKE_BUNDLE="$work/tampered.tgz" release_run "$version"; then fail "a corrupted bundle was accepted"; fi
grep -q "fails its checksums" err.log || { show; fail "the checksum failure isn't explained"; }
[[ ! -e "$state/releases/$version" ]] || fail "a corrupted bundle was installed"

step "VERIFY_ATTESTATIONS"
write_instance 1
fresh
if GH_BIN="$work/no-gh" release_run "$version"; then fail "VERIFY_ATTESTATIONS=1 passed without gh"; fi
grep -q "VERIFY_ATTESTATIONS=1 needs the GitHub CLI" err.log || { show; fail "the missing gh isn't explained"; }
[[ ! -s downloads ]] || fail "the bundle was downloaded before the gh check"
fresh
if FAKE_GH_VERSION=2.46.0 release_run "$version"; then fail "an outdated gh was accepted"; fi
grep -q "need gh 2.102.0 or later (this is 2.46.0)" err.log || { show; fail "the outdated gh isn't explained"; }
write_instance
fresh
GH_BIN="$work/no-gh" release_run "$version" || { show; fail "the default refused a host without gh"; }
grep -q "WARNING: the GitHub CLI (gh) isn't installed" err.log || { show; fail "skipping attestations wasn't reported"; }
[[ "$(cat "$state/releases/$version/.provenance")" == unverified ]] || fail "an unverified cached bundle isn't marked so"
# Cached without verification: once gh is there, it's fetched and verified again before it runs.
: > gh.log; : > downloads
release_run "$version" || { show; fail "the default with gh failed after a run without it"; }
grep -q "wasn't verified against example/waypoint's attestations; fetching it again" err.log || { show; fail "an unverified cached bundle was reused"; }
[[ "$(cat downloads)" == download && "$(sed -n 1p gh.log)" == *"/$name.tgz $policy" ]] || { cat gh.log >&2; fail "the cached bundle wasn't fetched and verified again"; }
write_instance 0
fresh
release_run "$version" || { show; fail "VERIFY_ATTESTATIONS=0 failed"; }
[[ ! -s gh.log ]] || fail "VERIFY_ATTESTATIONS=0 still verified"
# Turning verification on refuses the bundle cached while it was off, until it verifies.
write_instance 1
: > gh.log; : > downloads
if FAKE_GH_DENY="$name.tgz" release_run "$version"; then fail "VERIFY_ATTESTATIONS=1 ran a bundle cached unverified"; fi
grep -q "the release bundle has no valid attestation" err.log || { show; fail "the refetched bundle's refusal isn't explained"; }
! grep -q "running upgrade.sh from the $version bundle" err.log || { show; fail "the unverified cached bundle ran"; }
[[ "$(cat "$state/releases/$version/.provenance")" == unverified ]] || fail "a refused bundle replaced the cached one"
release_run "$version" || { show; fail "VERIFY_ATTESTATIONS=1 failed after VERIFY_ATTESTATIONS=0"; }
[[ "$(cat "$state/releases/$version/.provenance")" == "attested example/waypoint" ]] || fail "the verified bundle isn't recorded as attested"
write_instance 2
upgrade_validate() { bash "$repo/deploy/upgrade.sh" --instance "$work/instance.env" validate 2> err.log; }
if upgrade_validate; then fail "accepted VERIFY_ATTESTATIONS=2"; fi
grep -q "VERIFY_ATTESTATIONS must be 0 or 1" err.log || { show; fail "the bad value isn't named"; }

echo "release dry run passed" >&2
