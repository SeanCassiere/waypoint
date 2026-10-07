# Infrastructure

Two environments, **dev** and **prod**, kept fully separate: different cloud DB, bucket, tokens, and writer data directory. Never share a resource between them; the [environment guard](write-path-and-sync.md#environment-guard) relies on that.

## Setup checklist

Items marked **(P1)** are needed for phase 1. Items marked **(P2)** are needed for the public reader.

### Turso
- [x] **(P1)** A Turso account and organization (`seancassiere`, Free plan). The organization's **TursoDB** setting must be enabled before Sync-capable databases can be created.
- [x] **(P1)** Cloud DBs `waypoint-dev` and `waypoint-prod`, created as Turso Sync databases in group `waypoint`, location `aws-ap-southeast-2` (Sydney):
  `turso db create waypoint-<env> --tursodb --location aws-ap-southeast-2 --group waypoint --wait`
  - Their URLs use the `turso://` scheme. For the HTTP API, swap it for `https://`.
- [x] **(P1)** A full-access token per DB for the writer(s), created with `turso db tokens create <db> --expiration never`.
- [ ] **(P2)** A read-only token for `waypoint-prod`, used by the reader: `turso db tokens create waypoint-prod --read-only`.

### Cloudflare R2
- [x] **(P1)** R2 enabled on the account. This needs a payment method, even on the free plan.
- [x] **(P1)** Private buckets `waypoint-dev` and `waypoint-prod`, with location Automatic (resolved to Oceania). Default storage class **Standard**: Infrequent Access has no free tier and a 30-day minimum. No public access, `r2.dev` URL, custom domain, or CORS.
- [x] **(P1)** An R2 **Account API token** per bucket (`waypoint-writer-dev`, `waypoint-writer-prod`): **Object Read & Write**, scoped to that one bucket, TTL forever. The secret is shown only once. Each token was verified to be denied on the other environment's bucket (403).
- [x] **(P1)** A billing budget alert at $1, alongside the default $10 alert. Cloudflare has no hard spending cap, and alerts arrive by email about once a day.

### Cloudflare Workers (P2)
- [ ] **(P2)** A Worker `waypoint-reader` with:
  - an R2 binding `BUCKET` to `waypoint-prod`
  - an Analytics Engine binding `ACCESS_LOG`
  - a Rate Limiting binding `TOKEN_MISS_LIMITER`
  - secrets `TURSO_DATABASE_URL` and `TURSO_READONLY_TOKEN`
- [ ] **(P2)** A custom domain **`waypoint.pingstash.com`** attached to the Worker. The `pingstash.com` zone is already on Cloudflare. Attaching it creates the DNS record and certificate automatically.
- [ ] **(P2)** The `workers.dev` route turned off once the custom domain works.

### Tailscale
- [x] **(P1)** The tag owner `tag:waypoint` is in the tailnet policy (`"tagOwners": {"tag:waypoint": ["autogroup:admin"]}`). The policy is otherwise allow-all.
- [x] **(P1)** A single-use, tagged auth key is stored in `~/.config/waypoint/ts.env` (`TS_AUTHKEY`, expires 2027-01-05). It's only needed for the sidecar's first login; node state lives in a Docker volume after that, and `TS_AUTH_ONCE=true`.
- [ ] **(P1)** The writer is reachable at **`https://waypoint.tail7aca06.ts.net`** through its own Tailscale **sidecar container** (`ts-waypoint`, hostname `waypoint`, userspace networking), which serves HTTPS to the writer on `127.0.0.1:7410` in the shared network namespace. The host's tailscaled and its `tailscale serve` config (T3 Code on `:443`) are never touched. Agents use this URL as `WAYPOINT_URL`. See [`deploy/README.md`](../deploy/README.md).

### Deployment (P1)
- [x] **Docker** is installed on agent-1, and `agent-1` is in the `docker` group. Deploys use `sg docker` when a session predates the group change, so no logout or reboot is ever needed.
- [x] **Self-hosted GitHub Actions runner** `agent-1-waypoint` (label `waypoint-deploy`) runs as the systemd user unit `waypoint-gh-runner.service` from `~/actions-runner-waypoint`, with low priority (Nice=10, MemoryHigh=2G).
- [ ] **Deploy workflow:** each successful CI run on `main` runs `deploy/deploy.sh`, which builds the image locally, recreates only the writer, health-checks it (container health check plus HTTPS via the tailnet), and rolls back to the previous image on failure.
- **Secrets** stay in `~/.config/waypoint/{prod,ts}.env` (mode 600) and are passed at runtime with `env_file`. They never go into the repo, the image, or its layers.
- **Resource limits:** writer 1 GB / 1.5 CPU / 512 pids; sidecar 256 MB / 0.5 CPU; Docker logs rotate at 10 MB × 3.

## Writer configuration

The configuration lives in an env file on the writer machine, never committed. On agent-1 the files are `~/.config/waypoint/dev.env` and `~/.config/waypoint/prod.env`, mode 600, in a directory with mode 700:

```bash
WAYPOINT_ENV=prod                         # dev | prod
WAYPOINT_DATA_DIR=~/.local/share/waypoint/prod
WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net
WAYPOINT_PORT=7410
WAYPOINT_QUEUE_GIVE_UP_HOURS=72
WAYPOINT_MAX_BLOB_MB=50

TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=waypoint-prod
```

## Free-tier headroom (as of 2026-10-07)

| Service | Free allowance | Expected use |
|---|---|---|
| Turso | 5 GB storage, 500M rows read and 10M rows written per month, 3 GB sync per month | Metadata only; tiny |
| R2 | 10 GB-month storage, 1M Class A ops and 10M Class B ops per month, free egress | Storage is the only limit that could bind, driven by screenshots. Beyond 10 GB it costs $0.015/GB-month. |
| Workers | 100k requests/day, 10 ms CPU per request | Well within. The reader does no rendering. |
| Analytics Engine | 100k data points/day | Well within |

Not enforced for now, by decision: no storage cap.
