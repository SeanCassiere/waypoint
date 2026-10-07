# Waypoint production deployment

Start with [AGENTS.md](../AGENTS.md) for how updates reach production and the
rules for operating on agent-1.

The production writer runs on agent-1 in the `waypoint` Compose project. The
`ts-waypoint` sidecar owns a separate Tailscale node named `waypoint` and serves
`https://waypoint.tail7aca06.ts.net` to the writer on the shared container
loopback. The writer publishes no host port. Docker, the host Tailscale daemon,
and the host's `tailscale serve` settings are not changed by deployment.

## First-time setup

The runner `agent-1-waypoint` with label `waypoint-deploy` is already installed
in `~/actions-runner-waypoint` as the systemd user unit
`waypoint-gh-runner.service`. Linger is already enabled for `agent-1`.

As `agent-1`, create the env files outside the repository. Keep their directory
at mode 700 and each file at mode 600:

```bash
install -d -m 700 ~/.config/waypoint
install -m 600 /dev/null ~/.config/waypoint/prod.env
install -m 600 /dev/null ~/.config/waypoint/ts.env
install -d -m 700 ~/.local/share/waypoint/prod
```

If the files already exist, leave their contents intact. `prod.env` contains
the writer's production Turso and R2 credentials and must include
`WAYPOINT_ENV=prod`, `WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net`,
and `WAYPOINT_PORT=7410`. The deploy script sets `WAYPOINT_DATA_DIR=/data`
inside the container. `ts.env` contains only `TS_AUTHKEY=...`: a single-use
Tailscale auth key tagged `tag:waypoint`. It's used only for the sidecar's first
login (`TS_AUTH_ONCE=true`); afterwards the node identity lives in the
`waypoint_tailscale-state` volume. Only if that volume is lost do you need a new
key. In the Tailscale admin
console, set the tag owner for `tag:waypoint` to the account or group authorized
to create this node before generating the key. Enable HTTPS certificates for
the tailnet so Tailscale Serve can use the node's certificate. Never put these
keys in Git, image build arguments, or workflow secrets.

The deploy script requires the data directory to be owned by uid/gid 1000.
`agent-1` has Docker group membership; older login sessions may not see it, so
the script automatically runs Docker commands through `sg docker` when needed.
No logout or Docker daemon restart is required.

## Deploy and rollback

From the checked out repository on agent-1:

```bash
bash deploy/deploy.sh
```

Successful CI on `main` triggers the same command on the installed runner. A
manual `workflow_dispatch` deploys the selected ref's exact commit. The script
builds a commit-tagged image, saves the running image as `previous`, updates
`current`, starts the sidecar, recreates only the writer, and checks both its
Docker health status and the HTTPS tailnet endpoint. On failure it recreates
the writer from `previous` and prints the failed writer's recent logs. On a
first deployment with no previous writer, it stops the failed writer.

To roll back a healthy deploy manually, run from the repository root:

```bash
sg docker -c 'docker tag waypoint-writer:previous waypoint-writer:current'
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml up -d --no-deps --force-recreate writer'
```

If the current shell already has Docker access, `docker` may replace
`sg docker -c 'docker …'`. Check the result with
`curl -fsS https://waypoint.tail7aca06.ts.net/healthz`.

## Logs and stopping

```bash
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml logs --tail=100 writer'
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml logs --tail=100 ts-waypoint'
```

To stop the deployment safely, preserving the writer data and Tailscale state:

```bash
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml stop writer ts-waypoint'
```

Avoid `down --volumes`: the named volume holds the sidecar's Tailscale identity.
The deployment never touches unrelated containers, networks, images, the host
Tailscale daemon, or the host's Serve configuration. It needs no reboot.

## Memory

The writer container is limited to 1 GB. Check its usage with:

```bash
sg docker -c 'docker stats --no-stream waypoint-writer-1'
```

The Turso engine leaks native memory for each statement it prepares, so the
writer caches prepared statements by SQL text and reuses them (see
[Prepared statements and native memory](../docs/architecture.md#prepared-statements-and-native-memory)).
With the cache, RSS grows by about 0.16 KB per query and flattens over time,
instead of the 12.5 KB per query that took prod from start to 294 MB in 14 h.
If usage still climbs toward the limit, restarting the writer is safe, because
queued writes survive in `queue.db`:

```bash
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml restart -t 60 writer'
```

Note the usage and uptime before restarting, so the growth rate can be compared
with the numbers above.

## Re-rendering markdown after a renderer upgrade

Markdown is rendered at ingest, so a deploy that bumps `RENDERER_VERSION` only
affects new content. Older documents keep their previous rendition (which is
fine to serve) until you run the `rerender` subcommand once after the deploy.
It takes the data-directory lock, so stop the writer while it runs; writes from
agents fail during that window, which is usually a minute or two. Run it from
the repository root on agent-1:

```bash
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml stop writer'
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml run --rm --no-deps writer node dist/main.js rerender --all --dry-run'
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml run --rm --no-deps writer node dist/main.js rerender --all'
sg docker -c 'docker compose -p waypoint -f deploy/compose.yaml up -d --no-deps writer'
curl -fsS https://waypoint.tail7aca06.ts.net/healthz
```

Each run prints a JSON summary (`sources`, `current`, `queued`, `remaining`,
`missing`, `failed`). The work is queued locally; the writer's committer
uploads each new rendition and inserts its rows when the writer starts again,
and the reader switches to the newest version once the rows are pushed.
`--collection <id or public id>` limits the scope and `--limit <n>` caps a run;
both are safe to repeat, because sources that already have a current-version
rendition are skipped. A source blob missing from the local cache is fetched
from R2. `--renderer markdown --version <n>` is accepted as a guard and fails if
the image renders a different version. `docker compose run` reuses the writer
service's env file, data volume and user, so no secrets are loaded in your shell.

## Public reader Workers

The reader job runs on the same self-hosted runner after the writer job succeeds. It checks out the same commit, installs the frozen lockfile, builds the reader, then deploys dev before prod. No reader credentials enter GitHub Actions secrets. The runner reads mode-600 `~/.config/waypoint/cloudflare.env` for `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, and `reader-dev.env` or `reader-prod.env` for the seven reader values listed in [provisioning](../docs/provisioning.md#part-2-cloud-reader). The deploy script writes them to a mode-600 temporary JSON file for `wrangler secret bulk`, then deletes it immediately after upload.

Before the first reader deploy, provision those files and add `WAYPOINT_PUBLIC_BASE_URL=https://waypoint-dev.pingstash.com` to the writer's `dev.env` and `WAYPOINT_PUBLIC_BASE_URL=https://waypoint.pingstash.com` to `prod.env`. The writer must be restarted through the normal deploy for the setting to take effect. The custom domains are attached by Wrangler; do not add DNS records by hand.

Manual deploy from the checked out repository on agent-1:

```bash
pnpm install --frozen-lockfile --filter @waypoint/reader... --store-dir /tmp/pnpm-store-waypoint
pnpm --filter @waypoint/reader build
bash deploy/deploy-reader.sh dev
bash deploy/deploy-reader.sh prod
```

The script records the current Worker version, uploads secrets, deploys, then retries `/healthz`, `/healthz/deep`, an unknown share URL, and `/robots.txt` for up to 120 seconds by default. On smoke failure it calls `wrangler rollback` with the recorded version when one exists and exits nonzero. For a manual rollback, inspect versions and select the prior known-good version:

```bash
cd apps/reader
./node_modules/.bin/wrangler deployments list --env prod
./node_modules/.bin/wrangler rollback <version-id> --env prod --yes
./node_modules/.bin/wrangler tail --env prod
```

Use `dev` in place of `prod` for the dev Worker. Load `cloudflare.env` in the shell before manual `wrangler` commands, without echoing it. `DRY_RUN=1 bash deploy/deploy-reader.sh dev` checks the script's local stages without reading secrets or calling Wrangler.

## Reinstalling the existing runner

These are recovery steps for the already installed runner, not part of a
normal deployment. Run as `agent-1`; no `sudo` is needed. Obtain a fresh,
short-lived registration token from the repository's **Settings → Actions →
Runners → New self-hosted runner** page. If removing an existing runner
registration, obtain a separate removal token from that page first. Tokens are
read without echoing them:

```bash
systemctl --user stop waypoint-gh-runner.service
cd ~/actions-runner-waypoint
read -rsp 'Runner removal token: ' REMOVE_TOKEN; echo
./config.sh remove --token "$REMOVE_TOKEN"
unset REMOVE_TOKEN
read -rsp 'Runner registration token: ' RUNNER_TOKEN; echo
./config.sh --url https://github.com/SeanCassiere/waypoint \
  --token "$RUNNER_TOKEN" --name agent-1-waypoint \
  --labels waypoint-deploy --unattended --replace
unset RUNNER_TOKEN
```

If the runner files themselves must be replaced, after removing the old
registration, download and extract the current Linux x64 runner archive, then
run the registration command above:

```bash
cd ~/actions-runner-waypoint
RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))')
curl -fsSLo /tmp/waypoint-actions-runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
# Verify against the SHA-256 published in the release notes before extracting.
expected=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | grep -o "actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz.\{0,200\}" | grep -oE '[0-9a-f]{64}' | head -1)
echo "${expected}  /tmp/waypoint-actions-runner.tar.gz" | sha256sum -c -
tar -xzf /tmp/waypoint-actions-runner.tar.gz
rm /tmp/waypoint-actions-runner.tar.gz
unset RUNNER_VERSION
```

The existing user unit is:

```ini
[Unit]
Description=GitHub Actions runner for SeanCassiere/waypoint (deploys Waypoint)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/actions-runner-waypoint
ExecStart=%h/actions-runner-waypoint/run.sh
Restart=always
RestartSec=10
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Nice=10
CPUWeight=50
MemoryHigh=2G

[Install]
WantedBy=default.target
```

To restore that unit if missing, save the block above as
`~/.config/systemd/user/waypoint-gh-runner.service`, then run:

```bash
loginctl show-user "$USER" -p Linger
systemctl --user daemon-reload
systemctl --user enable --now waypoint-gh-runner.service
systemctl --user status waypoint-gh-runner.service
```

`Linger=yes` is already configured. If it was removed, run
`loginctl enable-linger "$USER"` as `agent-1` before starting the unit.

The smoke window defaults to 120 seconds; set `SMOKE_TIMEOUT_SECONDS` for slow first-time custom-domain DNS and certificate provisioning. The smoke includes `/healthz/deep`. A first deployment with no previous version cannot roll back. Worker secrets are not versioned: after a rollback caused by a bad secret, correct and re-upload that secret.
