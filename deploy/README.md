# Waypoint production deployment

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
inside the container. `ts.env` contains only `TS_AUTHKEY=...`; use a reusable,
preauthorized Tailscale auth key tagged `tag:waypoint`. In the Tailscale admin
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
