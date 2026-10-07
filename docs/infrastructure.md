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
- [x] **(P2)** `waypoint.pingstash.com`, `waypoint-dev.pingstash.com` and `*.pingstash.com` have no existing DNS records, and no zone rules match them.
- [x] **(P2)** Reader Worker source, Wrangler configuration for both environments, rate-limit and Analytics Engine bindings, and the deploy pipeline are implemented and pass a local Wrangler dry run. Deployment is still pending.
- [ ] **(P2)** Workers `waypoint-reader` (prod, `waypoint.pingstash.com`) and `waypoint-reader-dev` (dev, `waypoint-dev.pingstash.com`), with `workers_dev: false`. Each has:
  - secrets from `~/.config/waypoint/reader-<env>.env`: the Turso read-only token and R2 read-only keys. Blobs are read over the S3 API, **not** an R2 binding (decision D38).
  - an Analytics Engine binding `ACCESS_LOG`
  - a Rate Limiting binding `TOKEN_MISS_LIMITER`
- [ ] **(P2)** Custom domains attached to those Workers. Attaching them creates the DNS records and certificates.

### Tailscale
- [x] **(P1)** The tag owner `tag:waypoint` is in the tailnet policy (`"tagOwners": {"tag:waypoint": ["autogroup:admin"]}`). The policy is otherwise allow-all.
- [x] **(P1)** A single-use, tagged auth key is stored in `~/.config/waypoint/ts.env` (`TS_AUTHKEY`, expires 2027-01-05). It's only needed for the sidecar's first login; node state lives in a Docker volume after that, and `TS_AUTH_ONCE=true`.
- [x] **(P1)** The writer is reachable at **`https://waypoint.tail7aca06.ts.net`** through its own Tailscale **sidecar container** (`ts-waypoint`, hostname `waypoint`, userspace networking), which serves HTTPS to the writer on `127.0.0.1:7410` in the shared network namespace. The host's tailscaled and its `tailscale serve` config (T3 Code on `:443`) are never touched. Agents use this URL as `WAYPOINT_URL`. It is **not reachable from the plain LAN**: the writer publishes no host port (decision D37). See [`deploy/README.md`](../deploy/README.md) and [`AGENTS.md`](../AGENTS.md).

### Deployment (P1)
- [x] **Docker** is installed on agent-1, and `agent-1` is in the `docker` group. Deploys use `sg docker` when a session predates the group change, so no logout or reboot is ever needed.
- [x] **Self-hosted GitHub Actions runner** `agent-1-waypoint` (label `waypoint-deploy`) runs as the systemd user unit `waypoint-gh-runner.service` from `~/actions-runner-waypoint`, with low priority (Nice=10, MemoryHigh=2G).
- [x] **Deploy workflow:** each successful CI run on `main` runs `deploy/deploy.sh`, which builds the image locally, recreates only the writer, health-checks it (container health check plus HTTPS via the tailnet), and rolls back to the previous image on failure.
- **Secrets** stay in `~/.config/waypoint/{prod,ts}.env` (mode 600) and are passed at runtime with `env_file`. They never go into the repo, the image, or its layers.
- **Resource limits:** writer 1 GB / 1.5 CPU / 512 pids; sidecar 256 MB / 0.5 CPU; Docker logs rotate at 10 MB × 3.

## Writer configuration

The configuration lives in an env file on the writer machine, never committed. On agent-1 the files are `~/.config/waypoint/dev.env` and `~/.config/waypoint/prod.env`, mode 600, in a directory with mode 700:

```bash
WAYPOINT_ENV=prod                         # dev | prod
WAYPOINT_DATA_DIR=~/.local/share/waypoint/prod
WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net
WAYPOINT_PUBLIC_BASE_URL=https://waypoint.pingstash.com  # optional; enables share-link API
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
