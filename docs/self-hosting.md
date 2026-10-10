# Self-hosting Waypoint

Waypoint runs as one **writer** (a Docker container you reach from your own machines) plus,
optionally, cloud durability and a public **reader** for share links. Start small and add tiers
later: Tailscale and the public reader keep the data you already have, but cloud sync starts from a
new data directory, because a local-only one can't be synced. If you'll want cloud sync, start at
Tier 2.

| Tier | What you get | What you need |
|---|---|---|
| 0. Local-only | The writer on this host's `127.0.0.1`, agents and the viewer on the same machine | Docker |
| 1. Tailscale | The writer at `https://waypoint.<tailnet>.ts.net` for every device on your tailnet, with no open port | A Tailscale account |
| 2. Cloud sync | Metadata in Turso, files in R2 or any S3-compatible store, so the host is no longer the only copy | Turso, a bucket |
| 3. Public reader | Read-only share links on your own domain | Cloudflare (Workers, a zone) |

Every tier deploys with the same script, [deploy/upgrade.sh](../deploy/upgrade.sh), driven by one
`instance.env`. The operator runbook (what a deploy does, state, rollback, logs, rerender) is
[deploy/README.md](../deploy/README.md); every setting is in [configuration.md](configuration.md);
who can reach what is in the [trust model](trust-model.md).

You need a Linux host with Docker Engine and Docker Compose 2.24+, bash 4.4+, `curl` and Node.js 22+
(24+ to deploy from a git checkout with the public reader, which builds it). To verify releases,
install the [GitHub CLI](https://cli.github.com) 2.102.0 or later and log in (`gh auth login`).

## Getting the deploy files

Releases publish the writer image as `ghcr.io/seancassiere/waypoint-writer:<version>` (amd64 and
arm64) and a deploy bundle, `waypoint-deploy-<version>.tgz`, holding `upgrade.sh`, the Compose
files and the prebuilt reader, on the
[Releases page](https://github.com/SeanCassiere/waypoint/releases). Both carry a build provenance
attestation from the repository's release workflow ([releasing](releasing.md)). For a first
install, download a bundle, check it, and extract it:

```bash
v=0.1.0   # the version you want
gh release download "v$v" --repo SeanCassiere/waypoint --pattern "waypoint-deploy-$v.tgz"
gh attestation verify "waypoint-deploy-$v.tgz" --repo SeanCassiere/waypoint \
  --signer-workflow SeanCassiere/waypoint/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
tar -xzf "waypoint-deploy-$v.tgz" && cd "waypoint-deploy-$v"
```

then run its `./upgrade.sh <version>`. From then on, `upgrade.sh` fetches and verifies every
release itself, the image included (`VERIFY_ATTESTATIONS` in `instance.env`;
[deploy/README.md](../deploy/README.md#release-provenance)).

To deploy a commit that isn't a release (your own changes, or a fork), use a git checkout instead:
clone the repository and run `deploy/upgrade.sh current-checkout`, which builds the writer image
locally (and, with reader targets, the reader; run
`pnpm install --frozen-lockfile --filter @waypoint/reader...` first). Nothing verifies such a build
against a release attestation. The examples below use `deploy/upgrade.sh`; from a bundle it's
`./upgrade.sh`.

## Tier 0: local-only

The writer keeps everything in its data directory and nothing leaves the host (local-only mode,
[`WAYPOINT_SYNC=off`](configuration.md#local-only-mode)). `/status` says so permanently: the data
directory is the only copy, so back it up.

```bash
install -d -m 700 ~/.config/waypoint
# Created with their modes first: upgrade.sh refuses a writer env file that isn't mode 600, and
# an instance file that group or others can write (what a plain `cat >` gives under umask 002).
install -m 600 /dev/null ~/.config/waypoint/writer.env
cat > ~/.config/waypoint/writer.env <<'EOF'
WAYPOINT_ENV=prod
WAYPOINT_SYNC=off
EOF

install -m 600 /dev/null ~/.config/waypoint/instance.env
cat > ~/.config/waypoint/instance.env <<EOF
DATA_DIR=$HOME/.local/share/waypoint/prod
WRITER_ENV_FILE=writer.env
EOF

deploy/upgrade.sh validate
deploy/upgrade.sh current-checkout     # or, from a release bundle: ./upgrade.sh <version>
```

The writer runs as uid/gid 1000 and its data directory must belong to it. If your user isn't
1000, create the directory first with `sudo install -d -m 700 -o 1000 -g 1000 <DATA_DIR>`, or set
`WRITER_UID` and `WRITER_GID` in `instance.env`.

Open `http://127.0.0.1:7410`. The writer has no login: anything that can reach the port can read
and change everything, which is why it's published on loopback only. To reach it from other
machines, use Tier 1 rather than opening the port.

Without `upgrade.sh`, the same container runs with plain Compose:

```bash
WAYPOINT_IMAGE=ghcr.io/seancassiere/waypoint-writer:<version> \
WAYPOINT_WRITER_ENV_FILE=$HOME/.config/waypoint/writer.env \
WAYPOINT_DATA_HOST_DIR=$HOME/.local/share/waypoint/prod \
docker compose -p waypoint -f deploy/compose.yaml up -d
```

You then do what `upgrade.sh` would: health gating, rollback and keeping track of versions.

## Tier 1: Tailscale

The writer gets its own Tailscale node, served over HTTPS with Tailscale's certificate, and
publishes no port on the host. Every device on your tailnet can reach it; nothing else can.

1. In the Tailscale admin console, enable HTTPS certificates for the tailnet. Optionally define a
   tag (for example `tag:waypoint`) with yourself as its owner.
2. Create an auth key (single use is enough; tagged if you defined a tag) and store it:

   ```bash
   install -m 600 /dev/null ~/.config/waypoint/ts.env
   echo 'TS_AUTHKEY=tskey-auth-...' > ~/.config/waypoint/ts.env    # mind your shell history
   ```

3. Add to `instance.env`:

   ```
   TAILSCALE=on
   TAILSCALE_HOSTNAME=waypoint
   ```

   If you defined a tag in step 1, also add `TAILSCALE_TAGS=tag:waypoint`. Leave it out otherwise:
   a node that advertises a tag nobody defined can't log in. Add to `writer.env`:
   `WAYPOINT_BASE_URL=https://waypoint.<tailnet>.ts.net`.

   If this host is on the tailnet itself (it runs Tailscale and resolves `*.ts.net` names through
   MagicDNS), also add `WRITER_HEALTH_URL=https://waypoint.<tailnet>.ts.net/healthz`, so a deploy
   counts only once the writer answers there. Otherwise leave it out: the sidecar is its own node,
   so the host needn't be on the tailnet, but `upgrade.sh` checks that URL from the host, and a
   URL it can't reach fails every deploy, and the rollback too. The container's health check
   still gates the deploy.

4. Deploy again. The key is used only for the node's first login; afterwards the node's identity
   lives in the `waypoint_tailscale-state` Docker volume. Keep that volume (never
   `docker compose down --volumes`), or you'll need a new key.

## Tier 2: cloud sync

With sync on, the writer pushes metadata to a Turso database and file contents to a bucket, and
can rebuild its data directory from them.

A data directory can't switch sync modes, and there is no migration from local-only to synced
yet ([configuration](configuration.md#local-only-mode)): the writer refuses to start with sync on
over a directory created with `WAYPOINT_SYNC=off`. A synced writer therefore needs a new data
directory, which it fills from the cloud DB. Coming from Tier 0, your local-only data stays in the
old directory and doesn't carry over. Starting fresh, follow Tier 0 (and Tier 1 if you want it)
with the changes below.

1. Provision as in [provisioning.md](provisioning.md#part-1-local-writer): a Turso database with
   a full-access token, and a bucket with a read-write key. R2 is the default; any S3-compatible
   store works with `WAYPOINT_S3_ENDPOINT` and `WAYPOINT_S3_REGION`
   ([configuration](configuration.md#cloud-sync-on)).
2. In `writer.env`, leave out (or remove) `WAYPOINT_SYNC=off`, and set `WAYPOINT_BASE_URL` and the
   `TURSO_*` and `R2_*` values.
3. If `instance.env` already has a `DATA_DIR` that a local-only writer used, point it at a new
   directory, for example `DATA_DIR=/home/<you>/.local/share/waypoint/prod-synced` (an absolute
   path, owned by the writer's uid and gid as in Tier 0).
4. Deploy again.

## Tier 3: the public reader

Share links are served by a Cloudflare Worker on your own domain, which reads the cloud data with
read-only credentials and can't write anything. It needs Tier 2.

1. Provision as in [provisioning.md, part 2](provisioning.md#part-2-cloud-reader): a read-only
   Turso token, a read-only bucket key, a `RAW_CAP_KEY`, a Cloudflare API token that can deploy
   Workers on your account and edit your zone, and a zone for the domain.
2. Store the deploy token in `~/.config/waypoint/cloudflare.env` (`CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_API_TOKEN`) and the reader's values in `~/.config/waypoint/reader-prod.env`
   ([the keys](configuration.md#public-reader-cloudflare-worker)), both mode 600.
3. Add a reader target to `instance.env`:

   ```
   READER_TARGETS=prod
   READER_prod_WORKER=waypoint-reader
   READER_prod_DOMAIN=share.example.com
   READER_prod_SECRETS_FILE=reader-prod.env
   READER_prod_ANALYTICS_DATASET=waypoint_access
   READER_prod_RATELIMIT_NAMESPACE=1001
   ```

   and to `writer.env`: `WAYPOINT_PUBLIC_BASE_URL=https://share.example.com` and a
   `WAYPOINT_SHARE_TOKEN_KEY` (32 random bytes, base64url).

4. Deploy again. The writer is deployed first, then each reader target in order, each smoke
   tested on its domain and rolled back if it fails. Wrangler attaches the custom domain; give
   DNS and the certificate a minute on the first deploy.

A second target (for example a staging reader on its own Worker, domain and data) goes in
`READER_TARGETS` too; targets deploy in the listed order.

## Upgrading and rolling back

```bash
deploy/upgrade.sh latest       # or a version: deploy/upgrade.sh 1.4.0
deploy/upgrade.sh 1.3.2        # rolling back is deploying the older version
deploy/upgrade.sh status
```

`upgrade.sh` fetches and checks everything first, then replaces the writer, then each reader,
health-checking each one and rolling it back on failure. `latest` is the newest release that
already has its deploy bundle: a release the release workflow is still publishing (or failed to
publish) is skipped, and the log says so. Rerunning it is safe: it finishes a
partial upgrade and only re-checks what's already current. Older releases run on data a newer one
migrated, because schema changes are additive only; see
[the rollback window](../deploy/README.md#rolling-back). After a release that bumps the markdown
renderer, run `deploy/upgrade.sh rerender` once.

## Optional: automatic deploys on release

To deploy every release as soon as it's published, without logging in to the host, use a private
GitHub repository for operations whose one workflow is
[deploy/ops/deploy.yml.example](../deploy/ops/deploy.yml.example) (also in each bundle, under
`ops/`), with a self-hosted runner on the instance's host. What it does and why cancelling it is
safe: [deploy/README.md](../deploy/README.md#automatic-deploys-on-release).

1. Create the private repository (say `<you>/waypoint-ops`) and copy the template to
   `.github/workflows/deploy.yml` there.
2. Register a self-hosted runner for that repository only, on the instance's host, as the user
   that runs `upgrade.sh` (it reads `instance.env` and the env files it names), with the label
   `waypoint-deploy`. Runners of a private repository never run anything from forks. Run it as a
   service that survives logouts, for example a systemd user unit with linger enabled
   (`loginctl enable-linger`), with `KillMode=process` so stopping the runner never kills a deploy
   in progress, and a low priority (`Nice=10`) so deploys don't starve the host's other work:

   ```ini
   [Unit]
   Description=GitHub Actions runner that deploys Waypoint
   After=network-online.target

   [Service]
   WorkingDirectory=%h/actions-runner-waypoint
   ExecStart=%h/actions-runner-waypoint/run.sh
   Restart=always
   RestartSec=10
   KillMode=process
   KillSignal=SIGTERM
   TimeoutStopSec=5min
   Nice=10

   [Install]
   WantedBy=default.target
   ```

   Never register that runner to a repository that runs pull-request code, this one included: it
   can read every secret of the instance ([trust model](trust-model.md#deploy-pipeline)).
3. Optionally set repository variables there: `WAYPOINT_RELEASE_REPO` (the repository you deploy
   from, default `SeanCassiere/waypoint`; it must be the one `instance.env`'s `RELEASE_REPO` or
   `IMAGE` names), `WAYPOINT_DEPLOY_ADMIN` (the user login that may choose a version; default
   the repository's owner), `WAYPOINT_INSTANCE` and `WAYPOINT_DEPLOY_WORK`. **Set
   `WAYPOINT_DEPLOY_ADMIN` explicitly for an organization-owned ops repository:** the default is
   then the organization's login, which is never a run's actor, so no one could choose a version
   (the workflow fails a run that asks for one, rather than deploy the latest release instead).
4. Run it by hand (Actions → Deploy → Run workflow) to deploy the latest release.

That's enough to deploy on demand. To deploy on every release, the repository that publishes the
releases has to dispatch it: on your own fork, set up the dispatch as in
[releasing.md](releasing.md#deploy-dispatch) (a GitHub App with Actions: write on the ops
repository only). Following upstream releases instead, start the workflow on a schedule: add
`schedule: [{cron: "17 4 * * *"}]` to its `on:`, and it deploys whatever is latest each day
(a rerun at the deployed version only repeats the health checks).

## Connecting agents

Open `/mcp` on your writer (for example `https://waypoint.<tailnet>.ts.net/mcp`). It has
copy-paste snippets for Claude Code and Codex and the skill install commands. Agents start the
MCP server with `npx`, from a launcher the writer serves, and fetch the current server from the
writer on every start, so upgrading the writer upgrades every agent's next session; see
[api-and-mcp.md](api-and-mcp.md).
