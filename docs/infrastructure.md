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
- [ ] **(P1)** The writer is served on agent-1 via `tailscale serve --bg https / http://127.0.0.1:<port>`, so it's reachable at `https://agent-1.<tailnet>.ts.net`. Agents use this as `WAYPOINT_URL`.

## Writer configuration

The configuration lives in an env file on the writer machine, never committed. On agent-1 the files are `~/.config/waypoint/dev.env` and `~/.config/waypoint/prod.env`, mode 600, in a directory with mode 700:

```bash
WAYPOINT_ENV=prod                         # dev | prod
WAYPOINT_DATA_DIR=~/.local/share/waypoint/prod
WAYPOINT_BASE_URL=https://agent-1.<tailnet>.ts.net
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
