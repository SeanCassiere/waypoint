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
instead of about 12.5 KB per query before (when prod reached 294 MiB of its
1 GiB after 14 h).
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
fine to serve) until `rerender` gives them one at the new version. Do it once
after the deploy, in batches, with this procedure.

`rerender` takes the data-directory lock, so the writer must be stopped while it
runs; agents' writes fail during that window. The rendered output is only
queued. The writer uploads it after it starts again, a batch of 50 renditions
at a time between new revisions, so a large backlog never holds up agents.

Run everything from the repository root on agent-1. `$C` is the compose
prefix. Every command passes `--version 2`, which must match the deployed
`RENDERER_VERSION`; change it if the deploy bumped to a different version.

```bash
C="docker compose -p waypoint -f deploy/compose.yaml"
S=https://waypoint.tail7aca06.ts.net/api/status
```

Before starting:

- Note the baseline, so you can tell what this procedure changed:

  ```bash
  curl -fsS "$S" | jq '{queue, failed: (.failed_items | length)}'
  ```

- If **Status** (`/status`) lists failed revisions, retry or drop them there
  first. Their own renditions stay queued until they commit or are dropped, so
  they show in `pending_renditions` but not in `rerender_pending`.

1. Stop the deploy runner, so no deploy can recreate the writer during the
   window:

   ```bash
   systemctl --user stop waypoint-gh-runner.service
   ```

2. Check that the Tailscale sidecar is running (its `STATUS` starts with
   `Up`). Don't stop it; the writer shares its network namespace.

   ```bash
   sg docker -c "$C ps ts-waypoint"
   ```

3. Stop the writer, giving it 60 s to finish in-flight uploads, and check that
   it exited (its `STATUS` starts with `Exited`):

   ```bash
   sg docker -c "$C stop -t 60 writer"
   sg docker -c "$C ps -a writer"
   ```

4. Preview, then render one batch. Each run prints its JSON summary, then
   `missing: X`, `failed: Y` and a last `remaining: N` line. `remaining`
   counts sources this run didn't reach because of `--limit`; it excludes
   missing and failed sources, which another run won't fix.

   ```bash
   sg docker -c "$C run --rm --no-deps -T writer node dist/main.js rerender --all --renderer markdown --version 2 --dry-run"
   sg docker -c "$C run --rm --no-deps -T writer node dist/main.js rerender --all --renderer markdown --version 2 --limit 500"
   ```

5. Start the writer and wait until it's healthy:

   ```bash
   sg docker -c "$C up -d --no-deps writer"
   until [ "$(sg docker -c "docker inspect -f '{{.State.Health.Status}}' waypoint-writer-1")" = healthy ]; do sleep 2; done
   ```

6. Check it through the tailnet, then wait for the queued renditions to upload
   (`rerender_pending` reaches 0). Don't wait on `pending_renditions`: it also
   counts renditions of queued revisions, which commit with their revision.

   ```bash
   curl -fsS https://waypoint.tail7aca06.ts.net/healthz
   until [ "$(curl -fsS "$S" | jq .queue.rerender_pending)" = 0 ]; do sleep 10; done
   ```

7. If step 4 printed `remaining:` above 0, repeat steps 3 to 6. Stop once it
   prints `remaining: 0`, whatever `missing` and `failed` say.

8. Restart the deploy runner:

   ```bash
   systemctl --user start waypoint-gh-runner.service
   ```

9. If any run reported `missing` or `failed` above 0, investigate the hashes
   listed in that run's JSON summary (`missing`, `failed`). A missing source is
   in neither the local blob cache nor R2; a failed one made the renderer
   return nothing or time out, as it would at ingest. Those documents keep
   their previous rendition. A later run retries them.

If anything fails, start the writer (step 5) and the runner (step 8) before
investigating. Every step is safe to repeat: sources that already have a
current-version rendition, committed or queued, are skipped.

The summary's fields are `sources`, `current`, `queued`, `remaining`, and the
`missing` and `failed` source hashes. `--limit` caps the renditions queued per
run; missing and failed sources don't count toward it, so each run with
renderable sources left makes progress. `--collection <id or public id>`
limits the scope. A source blob missing from the local cache is fetched from
R2. `--renderer markdown --version <n>` is a guard: it fails if the image
renders a different version. `docker compose run` reuses the writer service's
env file, data volume and user, so no secrets are loaded in your shell. `-T`
keeps the output plain for scripts.

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
