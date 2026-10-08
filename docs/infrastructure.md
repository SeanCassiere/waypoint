# Infrastructure

Two environments, **dev** and **prod**, kept fully separate: different cloud DB, bucket, tokens, and writer data directory. Never share a resource between them; the [environment guard](write-path-and-sync.md#environment-guard) relies on that.

## Setup checklist

How to obtain each item, step by step: [provisioning.md](provisioning.md).

Items marked **(P1)** are needed for phase 1. Items marked **(P2)** are needed for the public reader.

### Turso
- [x] **(P1)** A Turso account and organization (`seancassiere`, Free plan). The organization's **TursoDB** setting must be enabled before Sync-capable databases can be created.
- [x] **(P1)** Cloud DBs `waypoint-dev` and `waypoint-prod`, created as Turso Sync databases in group `waypoint`, location `aws-ap-southeast-2` (Sydney):
  `turso db create waypoint-<env> --tursodb --location aws-ap-southeast-2 --group waypoint --wait`
  - Their URLs use the `turso://` scheme. For the HTTP API, swap it for `https://`.
- [x] **(P1)** A full-access token per DB for the writer(s), created with `turso db tokens create <db> --expiration never`.
- [x] **(P2)** Read-only tokens for `waypoint-prod` and `waypoint-dev`, used by the readers: `turso db tokens create waypoint-<env> --read-only --expiration never`. Verified: reads succeed, writes are `BLOCKED`.

### Cloudflare R2
- [x] **(P1)** R2 enabled on the account. This needs a payment method, even on the free plan.
- [x] **(P1)** Private buckets `waypoint-dev` and `waypoint-prod`, with location Automatic (resolved to Oceania). Default storage class **Standard**: Infrequent Access has no free tier and a 30-day minimum. No public access, `r2.dev` URL, custom domain, or CORS.
- [x] **(P1)** An R2 **Account API token** per bucket (`waypoint-writer-dev`, `waypoint-writer-prod`): **Object Read & Write**, scoped to that one bucket, TTL forever. The secret is shown only once. Each token was verified to be denied on the other environment's bucket (403).
- [x] **(P1)** A billing budget alert at $1, alongside the default $10 alert. Cloudflare has no hard spending cap, and alerts arrive by email about once a day.

### Cloudflare Workers (P2)
- [x] **(P2)** Read-only R2 tokens `waypoint-reader-prod` and `waypoint-reader-dev` (**Object Read only**, each scoped to its own bucket). Verified: list succeeds, put is denied (403), the other bucket is denied (403).
- [x] **(P2)** Deploy token `waypoint-reader-deploy` (custom token; permissions in [provisioning.md](provisioning.md#23-cloudflare-deploy-api-token)), scoped to this account and the `pingstash.com` zone only. Verified with a throwaway Worker on a custom domain, which was then deleted.
- [x] **(P2)** Workers Analytics Engine enabled. Account is on the Workers **Free** plan.
- [x] **(P2)** `waypoint.pingstash.com`, `waypoint-dev.pingstash.com` and `*.pingstash.com` had no DNS records before the custom domains were attached, and no zone rules match them.
- [x] **(P2)** Workers `waypoint-reader` (prod, `waypoint.pingstash.com`) and `waypoint-reader-dev` (dev, `waypoint-dev.pingstash.com`): the `prod` and `dev` reader targets of the owner's `instance.env` (below), deployed with configs generated from `apps/reader/wrangler.jsonc`. Both have `workers_dev: false` and `preview_urls: false` (D55; until the first `upgrade.sh` deploy, the prod Worker's `workers.dev` route and previews were on behind Cloudflare Access, D49). Each has:
  - seven secrets from `~/.config/waypoint/reader-<env>.env`, uploaded with `wrangler secret bulk`: `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`, `R2_ACCOUNT_ID`, `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `RAW_CAP_KEY` (the per-environment HMAC key for raw capabilities). Blobs are read over the S3 API, **not** an R2 binding (decision D38).
  - an Analytics Engine binding `ACCESS_LOG` (datasets `waypoint_access` and `waypoint_access_dev`)
  - a Rate Limiting binding `TOKEN_MISS_LIMITER` (30 per 60 s; namespaces `1002` prod and `1001` dev)
- [x] **(P2)** Custom domains `waypoint.pingstash.com` and `waypoint-dev.pingstash.com`, attached by Wrangler (`custom_domain: true`), which created their DNS records and certificates. Both answer `/healthz` and `/healthz/deep`.
- [x] **(P2)** Reader deploys: `deploy/upgrade.sh` deploys `dev`, then `prod`, after the writer, from the Deploy workflow. Each uploads secrets, deploys, smoke-tests the live hostname and rolls back to the previous version on failure. Runbook: [deploy/README.md](../deploy/README.md#public-reader-workers).
- [ ] **PR previews were dropped** (D55, reversing D49). Left to clean up by hand: the Cloudflare Access app `fb19dcb4-9f87-47dc-a038-1b41cef93d0f` (it covered `waypoint-reader.seancassiere.workers.dev` and `*-waypoint-reader.seancassiere.workers.dev`), any preview still listed under Workers & Pages → `waypoint-reader` → Previews, and the `waypoint_access_preview` dataset and rate-limit namespace `1003`, which nothing uses any more.

### Tailscale
- [x] **(P1)** The tag owner `tag:waypoint` is in the tailnet policy (`"tagOwners": {"tag:waypoint": ["autogroup:admin"]}`). The policy is otherwise allow-all.
- [x] **(P1)** A single-use, tagged auth key is stored in `~/.config/waypoint/ts.env` (`TS_AUTHKEY`, expires 2027-01-05). It's only needed for the sidecar's first login; node state lives in a Docker volume after that, and `TS_AUTH_ONCE=true`.
- [x] **(P1)** The writer is reachable at **`https://waypoint.tail7aca06.ts.net`** through its own Tailscale **sidecar container** (`ts-waypoint`, hostname `waypoint`, userspace networking), which serves HTTPS to the writer on `127.0.0.1:7410` in the shared network namespace. The host's tailscaled and its `tailscale serve` config (T3 Code on `:443`) are never touched. Agents use this URL as `WAYPOINT_URL`. It is **not reachable from the plain LAN**: the writer publishes no host port (decision D37). See [`deploy/README.md`](../deploy/README.md) and [`AGENTS.md`](../AGENTS.md).

### CI
- [x] **Turborepo remote cache** on Vercel (decision D52), used only by the CI workflow's turbo tasks, with signed artifacts. The team slug is the repository variable `TURBO_TEAM`; the access token and the signing key are the repository secrets `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY`. Fork PRs and the writer image build run without it. How to create or rotate them: [provisioning.md](provisioning.md#part-3-ci-remote-cache).

### Deployment (P1)
- [x] **Docker** is installed on agent-1, and `agent-1` is in the `docker` group. Deploys use `sg docker` when a session predates the group change, so no logout or reboot is ever needed.
- [x] **Self-hosted GitHub Actions runner** `agent-1-waypoint` (label `waypoint-deploy`) runs as the systemd user unit `waypoint-gh-runner.service` from `~/actions-runner-waypoint`, with low priority (Nice=10, MemoryHigh=2G).
- [x] **Deploy workflow:** each successful CI run on `main` runs `deploy/upgrade.sh --instance ~/.config/waypoint/instance.env current-checkout`, which builds the writer image and the reader locally, recreates only the writer, health-checks it (container health check, reported commit, then HTTPS via the tailnet) and rolls back to the previous image on failure, then deploys the readers. Runbook: [deploy/README.md](../deploy/README.md).
- **Secrets** stay in `~/.config/waypoint/{prod,ts,cloudflare,reader-dev,reader-prod}.env` (mode 600) and are passed at runtime with `env_file`, or to Wrangler. They never go into the repo, the image, or its layers.
- **Instance file** `~/.config/waypoint/instance.env` (no secrets; [deploy/instance.env.example](../deploy/instance.env.example)). It was written once with `deploy/make-instance-env.sh`:

  ```bash
  bash deploy/make-instance-env.sh --output ~/.config/waypoint/instance.env \
    --data-dir /home/agent-1/.local/share/waypoint/prod --writer-env prod.env \
    --tailscale --ts-env ts.env --ts-hostname waypoint --ts-tags tag:waypoint \
    --health-url https://waypoint.tail7aca06.ts.net/healthz --cloudflare-env cloudflare.env \
    --reader dev,waypoint-reader-dev,waypoint-dev.pingstash.com,reader-dev.env,waypoint_access_dev,1001 \
    --reader prod,waypoint-reader,waypoint.pingstash.com,reader-prod.env,waypoint_access,1002
  ```

  `upgrade.sh` keeps its state in `~/.config/waypoint/state/waypoint/`. Local images are `waypoint-writer:waypoint-<sha>`, `waypoint-writer:waypoint-current` and `waypoint-writer:waypoint-previous`; the older `waypoint-writer:<sha>`, `current` and `previous` tags from `deploy.sh` can be removed once a deploy through `upgrade.sh` has succeeded.
- **Re-rendering** after a `RENDERER_VERSION` bump: `bash deploy/upgrade.sh rerender` from a checkout on agent-1. A deploy that starts meanwhile waits for its lock, so the runner doesn't need stopping.
- **Resource limits:** writer 1 GB / 1.5 CPU / 512 pids; sidecar 256 MB / 0.5 CPU; Docker logs rotate at 10 MB × 3.

### Reinstalling the deploy runner

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

## Writer configuration

The configuration lives in an env file on the writer machine, never committed. Every variable, with its default, is in [configuration.md](configuration.md). On agent-1 the files are `~/.config/waypoint/dev.env` and `~/.config/waypoint/prod.env`, mode 600, in a directory with mode 700:

```bash
WAYPOINT_ENV=prod                         # dev | prod
WAYPOINT_DATA_DIR=~/.local/share/waypoint/prod
WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net
WAYPOINT_PUBLIC_BASE_URL=https://waypoint.pingstash.com  # optional; sharing needs this and the key below
WAYPOINT_SHARE_TOKEN_KEY=...             # 32 random bytes, base64url; derives share tokens (D50)
WAYPOINT_PORT=7410
WAYPOINT_QUEUE_GIVE_UP_HOURS=72
WAYPOINT_MAX_BLOB_MB=50

TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=waypoint-prod                   # any name; the bucket's environment marker guards it
# WAYPOINT_S3_ENDPOINT=...                # optional: any S3-compatible store instead of R2
# WAYPOINT_S3_REGION=auto
```

`WAYPOINT_SYNC=off` (local-only mode, no Turso or bucket) is allowed in prod too, with a persistent no-durability warning on `/status`; the owner's instance always syncs.

## Free-tier headroom (as of 2026-10-07)

| Service | Free allowance | Expected use |
|---|---|---|
| Turso | 5 GB storage, 500M rows read and 10M rows written per month, 3 GB sync per month | Metadata only; tiny |
| R2 | 10 GB-month storage, 1M Class A ops and 10M Class B ops per month, free egress | Storage is the only limit that could bind, driven by screenshots. Beyond 10 GB it costs $0.015/GB-month. |
| Workers | 100k requests/day, 10 ms CPU per request | Well within. The reader does no rendering. |
| Analytics Engine | 100k data points/day | Well within |

Not enforced for now, by decision: no storage cap.
