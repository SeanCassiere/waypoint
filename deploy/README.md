# Operating a Waypoint instance

The runbook for installing, upgrading, rolling back and operating a Waypoint instance with
[`upgrade.sh`](upgrade.sh). Every instance, the maintainer's included, deploys through these files
and nothing else; its own values live in one `instance.env` outside the repository. New to
Waypoint? Start with [docs/self-hosting.md](../docs/self-hosting.md). What each setting means:
[docs/configuration.md](../docs/configuration.md). Who can reach what: [docs/trust-model.md](../docs/trust-model.md).

| File | What it is |
|---|---|
| `upgrade.sh` | Install, upgrade, roll back, status, validate, rerender, compose passthrough |
| `instance.env.example` | Every instance setting, documented line by line |
| `make-instance-env.sh` | Writes an `instance.env` from flags, for an install whose env files already exist |
| `compose.yaml` | The writer, published on the host's `127.0.0.1:7410` by default |
| `compose.tailscale.yaml` | Overlay: the writer behind its own Tailscale node, with no host port |
| `serve.json` | The Tailscale sidecar's Serve config: HTTPS on 443 to the writer |
| `lib/env.sh` | The strict env-file parser |
| `lib/reader-config.mjs` | Renders a reader target's Wrangler config from `apps/reader/wrangler.jsonc` |

## Requirements

A Linux host with Docker Engine and Docker Compose 2.24 or later, bash 4.2+, `flock`, `curl`,
`sha256sum` and Node.js 20 or later (`upgrade.sh` uses it for JSON, and Wrangler needs it).
Deploying a git checkout (`current-checkout`) also needs `git`, and with reader targets, pnpm
and an installed workspace (`pnpm install --frozen-lockfile --filter @waypoint/reader...`).

If your login session predates your `docker` group membership, `upgrade.sh` runs Docker through
`sg docker`; no logout or daemon restart is needed.

## The instance file

`upgrade.sh` reads `~/.config/waypoint/instance.env` (or `$XDG_CONFIG_HOME/waypoint/instance.env`,
or `--instance FILE`). Copy [instance.env.example](instance.env.example) and fill it in, or have
[make-instance-env.sh](make-instance-env.sh) write it:

```bash
deploy/make-instance-env.sh --output ~/.config/waypoint/instance.env \
  --data-dir ~/.local/share/waypoint/prod --writer-env writer.env
```

The instance file holds no secrets. It names the files that do (the writer env file, the
Tailscale auth key, the Cloudflare deploy token, each reader's secrets), which must be mode 600.
It's parsed strictly: literal `KEY=value` lines with known keys only, never executed, and values
are never printed. `cloudflare.env` and the reader secrets files are parsed the same way, except
that their values may contain quotes, `$` and backticks, taken literally (a value wrapped in a
pair of quotes is refused, since the quotes would become part of it). Check the instance, and
every file it names, with:

```bash
deploy/upgrade.sh validate
```

## Deploying

```bash
deploy/upgrade.sh 1.4.0            # a release: its image (pulled by digest) and its bundle
deploy/upgrade.sh latest           # the newest release
deploy/upgrade.sh current-checkout # this git checkout: builds the writer image and the reader
deploy/upgrade.sh image my/waypoint-writer:test   # the writer from an image you built
deploy/upgrade.sh --dry-run current-checkout      # everything except changing anything
```

A release is deployed by **its own** `upgrade.sh`: run from a release bundle
(`waypoint-deploy-X.Y.Z.tgz`) at the same version, it uses the files beside it; asked for any
other version, it downloads that release's bundle into the state directory, checks its
`SHA256SUMS` and runs that bundle's `upgrade.sh`. Release images are pinned by digest, and the
image must report the bundle's commit.

What a deploy does, in order:

1. **Fetch and check, before anything running changes.** Validate the instance and every file it
   names. Build or pull the writer image. With reader targets, render each target's Wrangler
   config, build the reader (`current-checkout`), prepare the secrets, and record the Worker
   version each target to deploy serves now (`wrangler deployments list`), the one a failure
   rolls back to. If that lookup fails for any reason other than the Worker not existing yet,
   the run stops here: deploying without a rollback target isn't safe.
2. **The writer.** Tag the running image `waypoint-writer:<project>-previous`, point
   `waypoint-writer:<project>-current` at the new one, start the Tailscale sidecar if the
   overlay is on (a no-op when it's already running unchanged), and recreate only the writer.
   Wait for the container's health check (a restart of the new container fails it at once),
   then check that `/healthz` (from inside the container) reports the expected version and
   commit, then that `WRITER_HEALTH_URL`, if set, answers the same. On any failure, print the failed writer's logs, recreate it from the previous image, and
   exit nonzero. A first install with no previous image stops the failed writer instead.
3. **Each reader target, in `READER_TARGETS` order.** Upload the secrets (`wrangler secret
   bulk`), deploy the prebuilt Worker with the commit as the `WAYPOINT_BUILD_SHA` variable, then
   smoke test the custom domain for up to 120 s
   (`SMOKE_TIMEOUT_SECONDS`): `/healthz` answers `ok` with the expected `X-Waypoint-Version` and
   `X-Waypoint-Sha`, `/healthz/deep` answers `ok`, an unknown share link answers 404 with
   `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`, `/` answers 200, and
   `/robots.txt` disallows everything. On failure, `wrangler rollback` to the recorded version.
   A reader failure stops the run; the readers after it aren't touched.

Old local builds and pulled releases are pruned to the newest three; the current and previous
images keep their tags.

### Re-entrance and idempotence

`upgrade.sh` keeps its state in `STATE_DIR` (default `<CONFIG_DIR>/state/<project>`): what each
component runs (`writer`, `reader-<target>`), the last completed deploy (`release`), a `lock`
that serializes runs on one instance (a second run waits up to 30 minutes, `LOCK_WAIT_SECONDS`,
then fails without changing anything), and a `deploying` marker while a deploy is in progress.

- **The same version twice** only repeats the health checks and smoke tests. The writer counts as
  deployed when it's the container the last successful run created, on the target image, with
  the Compose config that run recorded (`compose config --hash`; an edited env file or instance
  setting redeploys it) and, with the overlay, in the running sidecar's network namespace; a
  reader, when the build, its generated config and its secrets are unchanged. `--force` redeploys anyway. A component that runs the target but
  fails its checks is reported, not redeployed: rerun with `--force`.
- **A partial deploy converges on a rerun.** If the writer was upgraded and a reader rolled back,
  the next run leaves the writer alone and deploys the reader again.
- **Failures and interruptions roll back the component in progress.** A failed step, `Ctrl-C`
  (SIGINT) or SIGTERM rolls back the writer or the reader being deployed, then exits nonzero
  (130 or 143 for a signal). The `deploying` marker is removed once the rollback succeeds. If the
  process is killed outright (SIGKILL), the marker stays and the next run reports it and
  converges.

### Rolling back

Rolling back is deploying the older version: `upgrade.sh 1.3.2`, or `upgrade.sh image
waypoint-writer:<project>-previous` for the writer alone. **The rollback window:** schema changes
are additive only ([docs/data-model.md](../docs/data-model.md#migrations)), so an older writer
runs on a data directory and cloud DB that a newer one migrated, ignoring the tables and columns
it doesn't know. CI proves exactly one hop on every change: the install test runs the previous
`main` writer, this one, the previous one again and this one again against one data directory
([scripts/install-test.sh](../scripts/install-test.sh)). Going back further is expected to work
but isn't tested; read the release notes in between first. An older `upgrade.sh` refuses `instance.env` keys it doesn't know (keys are only ever added), so comment out settings introduced after the release you're going back to. Renditions made by a newer renderer
stay in place, and Worker secrets aren't versioned: after rolling back a reader because of a bad
secret, fix the secrets file and deploy again.

To roll back a reader by hand, with `cloudflare.env` loaded in the shell (without echoing it):

```bash
cd apps/reader
./node_modules/.bin/wrangler deployments list --name <worker>
./node_modules/.bin/wrangler rollback <version-id> --name <worker> --yes
```

## Status, logs and stopping

```bash
deploy/upgrade.sh status                          # recorded and running versions, health
deploy/upgrade.sh compose ps
deploy/upgrade.sh compose logs --tail=100 writer
deploy/upgrade.sh compose restart -t 60 writer    # safe: queued writes survive in queue.db
deploy/upgrade.sh compose stop                    # keeps the data and the Tailscale state
```

`compose` runs `docker compose` with this instance's project, files and values. Never use
`down --volumes` with the Tailscale overlay: the `<project>_tailscale-state` volume holds the
node's identity, and losing it means a new auth key. Nothing here touches other Compose projects,
the Docker daemon, the host's Tailscale daemon or its Serve config.

## Memory

The writer container is limited to 1 GB (`COMPOSE_OVERRIDE` can change it). Check its usage with
`docker stats --no-stream <project>-writer-1`.

The Turso engine leaks native memory for each statement it prepares, so the writer caches
prepared statements by SQL text and reuses them (see
[Prepared statements and native memory](../docs/architecture.md#prepared-statements-and-native-memory)).
With the cache, RSS grows by about 0.16 KB per query and flattens over time, instead of about
12.5 KB per query before. If usage still climbs toward the limit, restarting the writer is safe
(above). Note the usage and uptime first, so the growth rate can be compared.

## Re-rendering markdown after a renderer upgrade

Markdown is rendered at ingest, so a release that bumps `RENDERER_VERSION` only affects new
content. Older documents keep their previous rendition (which is fine to serve) until they're
re-rendered. After such a deploy, run once:

```bash
deploy/upgrade.sh rerender               # or --limit 200, or --collection <id>
deploy/upgrade.sh --dry-run rerender     # count only (the writer still stops for the count)
```

`rerender` takes the data directory's lock, so the writer must be stopped while a batch runs, and
agents' writes fail meanwhile. The subcommand:

1. takes the instance lock, dry runs included (so no deploy recreates the writer meanwhile), and
   refuses to start if a deploy didn't finish or the writer isn't healthy (a restart while it
   waits counts as unhealthy; one from before doesn't);
2. stops the writer (60 s to finish in-flight uploads) and runs the rerender dry run in a one-off
   container of the same image, to learn the image's renderer version, which every batch then
   pins with `--version`;
3. renders a batch of at most `--limit` (default 500) renditions, starts the writer, waits until
   it's healthy, then waits until it has uploaded the queued renditions (`rerender_pending` on
   `/api/status` reaches 0);
4. repeats from the stop while the batch reported `remaining` above 0.

If anything fails, or the run is interrupted, it starts the writer again before exiting. A deploy
that starts meanwhile waits for the lock for at most 30 minutes (`LOCK_WAIT_SECONDS`) and then
fails without changing anything; a long rerender can outlast that, so deploy again afterwards. Each
batch's JSON summary lists `missing` sources (in neither the local blob cache nor the bucket) and
`failed` ones (the renderer returned nothing or timed out, as at ingest); those keep their
previous rendition, and a later run retries them. Every step is safe to repeat: sources with a
current-version rendition, committed or queued, are skipped. Only the writer container is stopped
and started; the Tailscale sidecar, Docker and the host are left alone.

If **Status** (`/status`) lists failed revisions, retry or drop them first: their own renditions
stay queued until they commit or are dropped, so they show in `pending_renditions` but not in
`rerender_pending`.

## The writer's network

Without the overlay, the writer listens on `0.0.0.0` inside its container (`WAYPOINT_HOST`) and
Docker publishes it on `WRITER_BIND_ADDRESS:WRITER_HOST_PORT` (default `127.0.0.1:7410`). The
writer has no login, so keep it on loopback and put something you trust in front of it.

With `TAILSCALE=on`, the `ts-waypoint` sidecar joins the tailnet as its own node
(`TAILSCALE_HOSTNAME`, userspace networking, optional `TAILSCALE_TAGS`) and serves
`https://<hostname>.<tailnet>.ts.net`, proxying to the writer on the loopback they share. The
writer listens on `127.0.0.1` only and publishes no host port. The auth key in
`TAILSCALE_ENV_FILE` (`TS_AUTHKEY=...`) is used only for the node's first login
(`TS_AUTH_ONCE=true`); afterwards the identity lives in the `<project>_tailscale-state` volume.
Enable HTTPS certificates for the tailnet so Serve can use the node's certificate. Set
`WAYPOINT_BASE_URL` in the writer env file to the `https://…ts.net` URL, and
`WRITER_HEALTH_URL` to its `/healthz`.

The service and volume names are fixed (`writer`, `ts-waypoint`, `tailscale-state`), so a
`COMPOSE_PROJECT` keeps the same containers (`<project>-writer-1`, `<project>-ts-waypoint-1`) and
Tailscale state across upgrades.

## Public reader Workers

Each reader target is a Cloudflare Worker on a custom domain, deployed after the writer. It
needs, on the deploying host:

- `CLOUDFLARE_ENV_FILE` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a token that can
  deploy Workers and edit the zone's DNS and routes; [provisioning](../docs/provisioning.md#23-cloudflare-deploy-api-token)).
- The target's `READER_<t>_SECRETS_FILE`, with `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`,
  `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RAW_CAP_KEY`, and
  `R2_ACCOUNT_ID` or `WAYPOINT_S3_ENDPOINT` (plus `WAYPOINT_S3_REGION` if needed)
  ([configuration](../docs/configuration.md#public-reader-cloudflare-worker)). Only the keys that
  are set are uploaded. Removing a key from the file doesn't delete the Worker secret; do that
  with `wrangler secret delete`.

The deploy renders a Wrangler config from the committed
[apps/reader/wrangler.jsonc](../apps/reader/wrangler.jsonc) (compatibility settings, observability,
binding names and limits) and the target (Worker name, custom domain, Analytics Engine dataset,
rate-limit namespace). Worker Previews are always off, and so is the `workers.dev` hostname unless
`READER_<t>_WORKERS_DEV=true` (decision D55). It uploads the reader build (`dist/index.js` in a
checkout, `reader/index.js` in a bundle) unchanged. Wrangler attaches the custom domain, so don't
add DNS records by hand. Credentials reach Wrangler through its environment only, and the
secrets go through a mode-600 temporary file that's deleted right after upload.

The first deployment of a Worker has no previous version to roll back to; if its smoke test fails
because DNS or the certificate is still provisioning, raise `SMOKE_TIMEOUT_SECONDS` and run again.

`--dry-run` renders every target's config and validates it with `wrangler deploy --dry-run`, runs
the deploy steps against a stand-in Wrangler, and skips the smoke test. `DRY_RUN_LOG=<file>`
records the stand-in's calls; `DRY_RUN_FAIL_SMOKE=<target>` makes that target's smoke test fail,
to exercise the rollback ([scripts/deploy-dry-run.sh](../scripts/deploy-dry-run.sh) does both).
