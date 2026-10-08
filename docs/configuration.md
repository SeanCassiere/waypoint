# Configuration reference

Every setting the writer, the MCP server and the public reader read, with defaults. The owner's instance values are in [infrastructure.md](infrastructure.md#writer-configuration) and [provisioning.md](provisioning.md); how the environment marker and local-only mode came about is in [decisions.md](decisions.md) (D54).

Values are plain environment variables (the writer, the MCP server) or Worker bindings, secrets and variables (the reader). Never commit them: they live in mode-600 env files on the host and reach the processes at runtime only.

## Writer

### Core

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WAYPOINT_ENV` | **yes** | none | `dev` or `prod`. Must match the environment marker in the local `waypoint.db`, the cloud DB and the bucket; a mismatch refuses to sync. It has no default, see [below](#why-waypoint_env-has-no-default). |
| `WAYPOINT_SYNC` | no | `on` | `on` or `off`. `off` is [local-only mode](#local-only-mode), in dev or prod. |
| `WAYPOINT_DATA_DIR` | no | `~/.local/share/waypoint/<WAYPOINT_ENV>` | Local DB, queue, blob cache and the data-directory lock. `~` and `~/` expand to the home directory. The Docker image expects a bind mount. |
| `WAYPOINT_BASE_URL` | with sync on | `http://127.0.0.1:<port>` when sync is off | The writer's own URL, as agents and browsers reach it (for example the tailnet HTTPS name). Used in returned URLs, MCP snippets and the viewer's CSRF origin checks. An HTTP(S) URL without credentials, query or fragment. |
| `WAYPOINT_PORT` | no | `7410` | Port to listen on. The writer always binds `127.0.0.1`; expose it through a proxy or sidecar. |
| `WAYPOINT_PUBLIC_BASE_URL` | no | unset (sharing off) | The public reader's origin, used to build share-link URLs. Same URL rules as `WAYPOINT_BASE_URL`. |
| `WAYPOINT_SHARE_TOKEN_KEY` | no (secret) | unset | 32 random bytes, base64url (43 characters); derives every share token (D50). Needed to create links and show their URLs. Never echoed in errors. |
| `WAYPOINT_QUEUE_GIVE_UP_HOURS` | no | `72` | How long a pending revision keeps retrying before it's marked `failed`. |
| `WAYPOINT_MAX_BLOB_MB` | no | `50` | Largest single file, in MB. |
| `WAYPOINT_MAX_FILES` | no | `2000` | Most files in one revision. |
| `WAYPOINT_MAX_REVISION_MB` | no | `500` | Largest total revision size, in MB. |
| `WAYPOINT_BUILD_SHA` | no | unset | The git commit of the build, reported as `sha` on `/healthz` and `/api/status`. The writer image sets it from the `WAYPOINT_BUILD_SHA` build arg; anything but 7 to 40 hex digits reads as unset. |

### Cloud (sync on)

All of these are read only when `WAYPOINT_SYNC` is `on`. The names keep their `R2_` prefix for existing env files, but any S3-compatible store works.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TURSO_DATABASE_URL` | yes | none | The Turso Sync (`--tursodb`) cloud DB. |
| `TURSO_AUTH_TOKEN` | yes (secret) | none | Full-access token for that DB. |
| `R2_ACCESS_KEY_ID` | yes (secret) | none | S3 access key with read and write on the bucket. |
| `R2_SECRET_ACCESS_KEY` | yes (secret) | none | Its secret. |
| `R2_BUCKET` | yes | none | Bucket name. Any name works; the bucket's [environment marker](#bucket-environment-marker) keeps dev and prod apart. |
| `R2_ACCOUNT_ID` | unless `WAYPOINT_S3_ENDPOINT` is set | none | Cloudflare account ID; the endpoint becomes `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Must be a hostname label (letters, digits, `-`). |
| `WAYPOINT_S3_ENDPOINT` | no | R2's endpoint | Any S3-compatible endpoint, for example `http://minio:9000` or `https://s3.us-east-1.amazonaws.com`. An HTTP(S) URL without credentials, query or fragment; a trailing `/` is ignored. Requests are always path-style (`<endpoint>/<bucket>/<key>`), which R2, MinIO and most S3-compatible stores accept. The store must support `If-None-Match: *` on `PutObject`. On AWS S3 the key also needs `s3:ListBucket` on the bucket: without it a `HEAD` for a missing key answers 403, not 404, so a fresh bucket's missing [marker](#bucket-environment-marker) reads as an account error and the committer pauses instead of writing it. |
| `WAYPOINT_S3_REGION` | no | `auto` | SigV4 signing region. `auto` is right for R2; AWS S3 needs the bucket's region; MinIO usually accepts `us-east-1`. |

### MCP artifacts served by the writer

| Variable | Default | Meaning |
|---|---|---|
| `WAYPOINT_MCP_TARBALL` | `/app/static/waypoint-mcp.tgz` in the image, else `packages/mcp/dist/waypoint-mcp.tgz` | The launcher tarball served at `/mcp/waypoint-mcp.tgz`. |
| `WAYPOINT_MCP_LAUNCHER` | `/app/static/launcher.mjs`, else `packages/mcp/dist/launcher.mjs` | Hashed for `/mcp/version`. |
| `WAYPOINT_MCP_SERVER` | `/app/static/waypoint-mcp-server.mjs`, else `packages/mcp/dist/waypoint-mcp-server.mjs` | The server bundle served at `/mcp/server.mjs`. |
| `WAYPOINT_MCP_SKILL` | `/app/static/skills/waypoint/SKILL.md`, else `skills/waypoint/SKILL.md` | Served at `/mcp/skill/SKILL.md`. |

### Build arguments (writer image)

| Argument | Default | Meaning |
|---|---|---|
| `WAYPOINT_BUILD_SHA` | empty | Baked into the image as the `WAYPOINT_BUILD_SHA` env var. `deploy/deploy.sh` passes `git rev-parse HEAD`. |

The version itself comes from the root `package.json` (`WAYPOINT_VERSION` in `@waypoint/core`, kept equal by a test), so every image and bundle knows it without a build argument.

### Local-only mode

`WAYPOINT_SYNC=off` runs the writer with no cloud at all, in dev or prod: no Turso, no bucket, no public reader.

- **No cloud durability.** Everything lives only in `WAYPOINT_DATA_DIR`. Back it up yourself. `/status` shows a persistent warning, and `/api/status` (so `waypoint_status`) returns it in `warnings` as `{ "code": "local_only", "message": … }`. The writer also logs it at startup.
- **No public sharing.** The public reader reads from the cloud DB and the bucket, so links stay "activating" and can't be served until sync is configured.
- **`restore` refuses** before touching the data directory: there's nothing to restore from.
- **A data directory keeps its mode.** A directory whose `waypoint.db` is a cloud-synced replica (it has `waypoint.db-info`, Turso Sync's state) can't be opened with sync off, and a `waypoint.db` created with sync off can't be opened with sync on. Writing to a replica without sync would fork it from the cloud DB, and a local-only database has no sync state to push. Use a separate data directory for each mode. There is no migration from local-only to synced yet. A first synced start that fails (the cloud unreachable, a wrong token or URL) leaves only an empty `waypoint.db` and no `waypoint.db-info`; an empty database counts as absent in either mode, so the next start simply retries the bootstrap. Turso Sync writes the whole bootstrapped `waypoint.db` before `waypoint.db-info`, so a first synced start killed in between leaves a full database with no sync state. The writer marks a first sync in progress with `waypoint.db-bootstrap` (removed once it succeeds), and refuses such a directory in either mode with a message that says the first sync was interrupted; delete its `waypoint.db*` files (a partial copy of the cloud DB) or use a new data directory.

### Bucket environment marker

The bucket holds `meta/environment.json`, `{ "format_version": 1, "environment": "dev" | "prod", "created_at": … }`. Before its first bucket request, a writer reads it:

- **Missing** (a new bucket, or one from before the marker existed): the writer writes its own environment with `If-None-Match: *` and reads it back, so when two writers race, one marker wins. A missing marker is never a failure.
- **Matching:** remembered for the life of the process.
- **Another environment, or unreadable:** an account error. The committer pauses and retries every 5 minutes, `/status` shows "Bucket account paused:" followed by the reason (the health pill reads "Sync blocked"), and `restore` stops. Nothing else in the bucket is read or written.
- **The check itself fails:** a transient error (network, 5xx, throttling) is retried like any other and the check runs again on the next request. Any other failure (say the marker deleted between the `HEAD` and the `GET`) is reported as an account error too, so it pauses the committer rather than failing whichever revision's upload triggered the check.

Together with the cloud DB's `meta.environment` ([write-path-and-sync.md](write-path-and-sync.md#environment-guard)), this replaces the old rule that the bucket be named `waypoint-<env>`.

### Why `WAYPOINT_ENV` has no default

`WAYPOINT_ENV` picks the default data directory. Defaulting it to `prod` would let a stray `WAYPOINT_SYNC=off node dist/main.js serve` on a host that also runs a prod writer open `~/.local/share/waypoint/prod`; the data-directory lock and the sync-mode check would stop it, but only after the fact. Requiring it keeps the choice explicit, at the cost of one line in every env file.

## MCP server (the agent's machine)

Set in the agent's MCP config, not on the writer.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WAYPOINT_URL` | yes | none | The writer's base URL. |
| `WAYPOINT_MCP_ALLOW_HTTP` | no | unset | `1` silences the launcher's warning that `WAYPOINT_URL` uses plain HTTP, for any host. Loopback, `*.localhost` and `*.ts.net` hosts never warn. A launcher cached before this setting existed ignores it and keeps warning until the npx cache is cleared. |
| `WAYPOINT_MCP_PIN` | no | unset | `embedded` runs the server copy embedded in the launcher and skips fetching, for debugging. |
| `WAYPOINT_MCP_CACHE_DIR` | no | `$XDG_CACHE_HOME`, else `~/.cache` | Where the launcher caches server bundles (under `waypoint-mcp/`). |
| `WAYPOINT_SOURCE_HOST` | no | the machine's hostname | The host name recorded in revision metadata (`source_host`) and the `X-Waypoint-Client` header. |
| `WAYPOINT_MAX_FILES`, `WAYPOINT_MAX_BLOB_MB`, `WAYPOINT_MAX_REVISION_MB` | no | `2000`, `50`, `500` | Client-side limits checked before uploading; keep them in line with the writer's. |

## Public reader (Cloudflare Worker)

Secrets are uploaded with `wrangler secret bulk`; bindings come from `wrangler.jsonc`.

| Name | Kind | Required | Meaning |
|---|---|---|---|
| `TURSO_DATABASE_URL` | secret | yes | The cloud DB (same URL as the writer's). |
| `TURSO_READONLY_TOKEN` | secret | yes | A **read-only** token for it (D38). |
| `R2_READER_ACCESS_KEY_ID` | secret | yes | S3 access key with **object read only** on the bucket. |
| `R2_READER_SECRET_ACCESS_KEY` | secret | yes | Its secret. |
| `R2_BUCKET` | secret | yes | Bucket name. |
| `R2_ACCOUNT_ID` | secret | unless `WAYPOINT_S3_ENDPOINT` is set | Cloudflare account ID for R2's endpoint. |
| `WAYPOINT_S3_ENDPOINT` | secret or variable | no | S3-compatible endpoint, as for the writer (path-style). |
| `WAYPOINT_S3_REGION` | secret or variable | no (`auto`) | SigV4 signing region, as for the writer. |
| `RAW_CAP_KEY` | secret | yes | 32 random bytes, base64url; derives raw-content capabilities (D40). |
| `WAYPOINT_BUILD_SHA` | variable | no | The commit deployed; `deploy/deploy-reader.sh` sets it with `wrangler deploy --var`. Reported in `X-Waypoint-Sha`. |
| `TOKEN_MISS_LIMITER` | Rate Limiting binding | no | Counts denials and deep health probes per IP; missing skips rate limiting. |
| `ACCESS_LOG` | Analytics Engine binding | no | Access log; missing skips logging. |

The Worker reads all of these, but this repo's reader deploy scripts (`deploy/deploy-reader.sh`, via `deploy/reader-env.sh`) still accept only the seven R2-era secrets and require `R2_ACCOUNT_ID`. Until the generic deploy tooling lands, a reader on another S3-compatible store needs `WAYPOINT_S3_ENDPOINT` (and `WAYPOINT_S3_REGION`) set by hand, with `wrangler secret put` or as a `vars` entry in its Wrangler config.

## Version reporting

| Endpoint | Shape |
|---|---|
| Writer `GET /healthz` | `{ "ok": true, "version": "0.0.0", "sha": "<40 hex>" \| null }`. Health gates read `ok` only. |
| Writer `GET /api/status`, `waypoint_status` | `version`, `sha` and `warnings` alongside the queue data; `waypoint_status` adds `mcp.version`, the running MCP server's version. |
| Writer `/status` page | Version and short commit in the header. |
| Reader `GET /healthz`, `GET /healthz/deep` | Body stays exactly `ok` (or `fail` with 503 for the deep check); headers `X-Waypoint-Version` and, when recorded, `X-Waypoint-Sha`. |
