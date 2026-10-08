# Infrastructure

The checklist of everything a full Waypoint deployment has: the writer behind Tailscale, cloud sync,
a public reader per environment, automatic deploys and CI. Each tier of
[self-hosting.md](self-hosting.md) needs only its own part. How to obtain each item, step by step:
[provisioning.md](provisioning.md). Keep a copy of this list, filled in with your own values, in your
operator notes (never in the repository): what exists, its name and scope, where its credential
lives, and when it expires.

Names below are the conventional ones (`waypoint-<env>`, `waypoint-reader`); any names work.

## Environments

Two environments, **dev** and **prod**, kept fully separate: a different cloud DB, bucket, tokens,
writer data directory and reader. Never share a resource between them; the
[environment guard](write-path-and-sync.md#environment-guard) and the bucket's environment marker
rely on that. A dev environment is optional: it lets you test share links and the reader end to end
without touching prod data, with a writer run locally from a checkout
([AGENTS.md](../AGENTS.md#developing)).

## Turso (cloud sync)

- [ ] A Turso organization, with the **TursoDB** setting enabled (needed before Sync-capable
  databases can be created).
- [ ] A cloud DB per environment, created as a Turso Sync database
  (`turso db create waypoint-<env> --tursodb --location <location> --group <group> --wait`). Its URL
  uses the `turso://` scheme; for the HTTP API, swap it for `https://`.
- [ ] A full-access token per DB for the writer (`--expiration never`, or an expiry you track).
- [ ] With a public reader: a read-only token per DB (`--read-only`). Verified: reads succeed,
  writes are `BLOCKED`.

## Bucket: Cloudflare R2 or another S3-compatible store (cloud sync)

- [ ] R2 enabled on the Cloudflare account (it needs a payment method, even on the free plan), and
  a billing budget alert: Cloudflare has no hard spending cap.
- [ ] A private bucket per environment, default storage class **Standard** (Infrequent Access has
  no free tier and a 30-day minimum). No public access, `r2.dev` URL, custom domain or CORS. The
  writer marks it with `meta/environment.json` on first use.
- [ ] A writer key per bucket: **Object Read & Write**, scoped to that one bucket. Verified to be
  denied on the other environment's bucket (403).
- [ ] With a public reader: a reader key per bucket, **Object Read only**, scoped to its own
  bucket. Verified: list succeeds, put is denied (403), the other bucket is denied (403).

Another S3-compatible store works the same way through `WAYPOINT_S3_ENDPOINT` and
`WAYPOINT_S3_REGION` ([configuration.md](configuration.md#cloud-sync-on)); it must support
`If-None-Match: *` on `PutObject`.

## Cloudflare Workers (public reader)

- [ ] A deploy token (custom token; permissions in
  [provisioning.md](provisioning.md#23-cloudflare-deploy-api-token)) scoped to your account and the
  reader's zone only, in `cloudflare.env` on the deploying host. Never a GitHub secret.
- [ ] Workers Analytics Engine enabled.
- [ ] A zone for the reader's domain. The reader's hostname (for example `share.example.com`, and a
  separate one for dev) has no DNS record before its first deploy, and no zone rule (redirects, Bot
  Fight Mode, WAF) matches it.
- [ ] A reader target per environment in `instance.env` (`READER_TARGETS`, then
  `READER_<target>_WORKER`, `_DOMAIN`, `_SECRETS_FILE`, `_ANALYTICS_DATASET`,
  `_RATELIMIT_NAMESPACE`). `upgrade.sh` deploys each Worker with a config generated from the
  release's Wrangler template, with `workers_dev` and `preview_urls` off (D55), so it's reachable
  only on its custom domain. Each Worker has:
  - seven secrets from its secrets file, uploaded by `upgrade.sh` with `wrangler secret bulk`:
    `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`, `R2_ACCOUNT_ID` (or `WAYPOINT_S3_ENDPOINT`),
    `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET` and `RAW_CAP_KEY` (the
    per-environment HMAC key for raw capabilities). Blobs are read over the S3 API, **not** an R2
    binding (D38);
  - an Analytics Engine binding `ACCESS_LOG`, on its own dataset (for example `waypoint_access` and
    `waypoint_access_dev`);
  - a Rate Limiting binding `TOKEN_MISS_LIMITER` (30 per 60 s), on its own namespace ID (any
    integer unique in the account, for example `1001` and `1002`).
- [ ] The custom domain, attached by Wrangler on the first deploy (`custom_domain: true`), which
  creates its DNS record and certificate. It answers `/healthz` and `/healthz/deep`.

## Tailscale

- [ ] MagicDNS and HTTPS certificates enabled for the tailnet (on by default).
- [ ] Optionally a tag for the writer's node, for example `tag:waypoint`, with yourself as its owner
  (`"tagOwners": {"tag:waypoint": ["autogroup:admin"]}`), and, if the policy isn't allow-all, access
  to it on `tcp:443`.
- [ ] A single-use auth key (tagged, if you defined the tag) in `ts.env`. It's used only for the
  sidecar's first login; the node's state then lives in the `<project>_tailscale-state` Docker
  volume (`TS_AUTH_ONCE=true`).
- [ ] The writer reachable at `https://<TAILSCALE_HOSTNAME>.<tailnet>.ts.net` through its own
  sidecar node, with no host port. The host's own Tailscale setup, if any, is untouched (D37).

## Deployment

- [ ] **Docker** Engine and Compose 2.24+ on the host, the deploying user in the `docker` group
  (`upgrade.sh` uses `sg docker` when the login session predates it).
- [ ] **Secrets** in `~/.config/waypoint/` (directory mode 700, files mode 600), passed at runtime
  only (`env_file`, or to Wrangler): never in a repository, an image or its layers.

  | File | Used by | Contents |
  |---|---|---|
  | `writer.env` (or `<env>.env`) | the writer container | `WAYPOINT_*` (including the secret `WAYPOINT_SHARE_TOKEN_KEY`), `TURSO_*`, `R2_*` ([configuration.md](configuration.md#writer)) |
  | `ts.env` | the Tailscale sidecar | `TS_AUTHKEY` |
  | `cloudflare.env` | reader deploys | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
  | `reader-<env>.env` | reader deploys | the seven reader secrets above |
  | `instance.env` | `upgrade.sh` | no secrets: paths, data directory, Tailscale settings, reader targets ([instance.env.example](../deploy/instance.env.example)) |

- [ ] **Instance file** `~/.config/waypoint/instance.env`, copied from
  [instance.env.example](../deploy/instance.env.example) or written with
  [make-instance-env.sh](../deploy/make-instance-env.sh), for example:

  ```bash
  bash deploy/make-instance-env.sh --output ~/.config/waypoint/instance.env \
    --data-dir /home/<you>/.local/share/waypoint/prod --writer-env prod.env \
    --tailscale --ts-env ts.env --ts-hostname waypoint --ts-tags tag:waypoint \
    --health-url https://waypoint.<tailnet>.ts.net/healthz --cloudflare-env cloudflare.env \
    --reader dev,waypoint-reader-dev,share-dev.example.com,reader-dev.env,waypoint_access_dev,1001 \
    --reader prod,waypoint-reader,share.example.com,reader-prod.env,waypoint_access,1002
  ```

  Check it with `upgrade.sh validate`. `upgrade.sh` keeps its state in
  `~/.config/waypoint/state/<project>/`.
- [ ] **Data directory** owned by the writer's uid and gid (1000 by default), mode 700.
- [ ] **Resource limits** (from the Compose files; `COMPOSE_OVERRIDE` changes them): writer 1 GB /
  1.5 CPU / 512 pids; sidecar 256 MB / 0.5 CPU; Docker logs rotate at 10 MB × 3.
- [ ] Optionally, **automatic deploys on release:** a private ops repository with the workflow
  [deploy/ops/deploy.yml.example](../deploy/ops/deploy.yml.example) and a self-hosted runner on the
  host, registered to that repository only, with the label `waypoint-deploy`, running as the user
  that runs `upgrade.sh` (for example as a systemd user unit with linger enabled)
  ([self-hosting.md](self-hosting.md#optional-automatic-deploys-on-release)). Verifying releases
  needs the GitHub CLI 2.102.0 or later on the host for manual `upgrade.sh <version>` runs (the ops
  workflow installs its own).

## Repository (a fork that publishes its own releases)

- [ ] **Turborepo remote cache** (optional, D52): repository variable `TURBO_TEAM`, secrets
  `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY`
  ([provisioning.md](provisioning.md#part-3-ci-remote-cache)). Fork PRs and the writer image build
  run without it.
- [ ] **Release settings** ([releasing.md](releasing.md#settings-and-secrets)): Actions may create
  pull requests, branch protection on `main` requiring `ci-ok` only, the `waypoint-writer` package
  public.
- [ ] **Deploy dispatch** (optional, D56): a GitHub App with Actions: write on the ops repository
  only, its key in the `release` environment, and the `DEPLOY_APP_CLIENT_ID` and
  `DEPLOY_DISPATCH_REPO` variables ([provisioning.md](provisioning.md#part-4-release-deploy-dispatch)).

## Free-tier headroom (as of 2026-10-07)

For a single user's instance:

| Service | Free allowance | Expected use |
|---|---|---|
| Turso | 5 GB storage, 500M rows read and 10M rows written per month, 3 GB sync per month | Metadata only; tiny |
| R2 | 10 GB-month storage, 1M Class A ops and 10M Class B ops per month, free egress | Storage is the only limit that could bind, driven by screenshots. Beyond 10 GB it costs $0.015/GB-month. |
| Workers | 100k requests/day, 10 ms CPU per request | Well within. The reader does no rendering. |
| Analytics Engine | 100k data points/day | Well within |

Waypoint enforces no storage cap, by decision (D28).
