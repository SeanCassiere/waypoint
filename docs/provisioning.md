# Provisioning guide

Step-by-step instructions for obtaining every external resource and credential Waypoint needs, for both halves of the system:

- **Local writer**: the write side on your private network, with cloud sync ([Part 1](#part-1-local-writer)); [self-hosting](self-hosting.md) tiers 1 and 2.
- **Cloud reader**: the public read-only Cloudflare Worker ([Part 2](#part-2-cloud-reader)); tier 3.
- Optionally, for a repository that publishes its own releases: the CI remote cache ([Part 3](#part-3-ci-remote-cache)) and the release deploy dispatch ([Part 4](#part-4-release-deploy-dispatch)).

[infrastructure.md](infrastructure.md) is the checklist of *what* a deployment has. This page explains *how to create it*: for a new instance or environment, a rebuild, or rotating credentials. Every step can be done by a person, or handed to an agent with computer use, which reports back the values listed under **Record**. Names such as `waypoint-<env>` are conventions; use your own. Keep a note of what you created (names, scopes, expiries) with your operator notes, outside the repository.

## Ground rules

- **Two environments, never shared:** `dev` and `prod` each get their own database, bucket, and tokens. The environment guard depends on this.
- **Secrets never go into Git, images, or GitHub.** They live on the writer host in `~/.config/waypoint/` (directory mode 700, files mode 600), and the reader's are stored as Cloudflare Worker secrets. Deploys read them from those places. The exceptions are CI's Turborepo remote cache ([Part 3](#part-3-ci-remote-cache)), whose credentials reach nothing of Waypoint's, and the deploy dispatch App's key ([Part 4](#part-4-release-deploy-dispatch)), which can only start a deploy of an attested release.
- **Least privilege:** writers get read/write access; the reader gets read-only credentials only.
- **Verify every credential** using the commands below before relying on it. Each check includes a negative test, showing that the credential *can't* do what it shouldn't.
- Cloudflare shows R2 secret keys **only once**. Record them immediately.

## Env files on the writer host

| File | Used by | Contents |
|---|---|---|
| `~/.config/waypoint/prod.env` (any name; `instance.env`'s `WRITER_ENV_FILE`) | prod writer container | `WAYPOINT_*` config (including the secret `WAYPOINT_SHARE_TOKEN_KEY`), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| `~/.config/waypoint/dev.env` | a local dev writer (optional) | same keys, dev values |
| `~/.config/waypoint/ts.env` | Tailscale sidecar | `TS_AUTHKEY` only |
| `~/.config/waypoint/reader-prod.env` | reader deploy (prod) | `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`, `R2_ACCOUNT_ID`, `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RAW_CAP_KEY`; optionally `WAYPOINT_S3_ENDPOINT` (instead of `R2_ACCOUNT_ID`) and `WAYPOINT_S3_REGION` |
| `~/.config/waypoint/reader-dev.env` | reader deploy (dev) | same keys, dev values |
| `~/.config/waypoint/cloudflare.env` | reader deploy | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| `~/.config/waypoint/instance.env` | `deploy/upgrade.sh` | No secrets: the paths above, the data directory, the Tailscale settings and the reader targets ([deploy/instance.env.example](../deploy/instance.env.example)) |

Create them with `install -d -m 700 ~/.config/waypoint` and `install -m 600 /dev/null <file>`, then fill them in with an editor. Never echo secrets into shell history.

---

## Part 1: Local writer

### 1.1 Turso databases and full-access tokens

Prerequisite: the Turso CLI (`brew install tursodatabase/tap/turso`), logged in with `turso auth login`.

1. **Enable TursoDB for the organization.** In the Turso dashboard, open organization settings and turn on the **TursoDB** setting. Without it, creating a Sync-capable database fails.
2. **Create the database** (Sync-capable, via `--tursodb`), in a location near the writer host (`turso db locations` lists them) and a group of your choice (`turso group create <group> --location <location>` first if you have none):
   ```bash
   turso db create waypoint-<env> --tursodb --location <location> --group <group> --wait
   turso db show waypoint-<env> --url          # turso://waypoint-<env>-<org>.<location>.turso.io
   ```
3. **Create the writer token:** `turso db tokens create waypoint-<env> --expiration never`
4. **Record:** `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, into `<env>.env`.
5. **Verify** (read must succeed). Replace `turso://` with `https://` for the HTTP API:
   ```bash
   set -a; . ~/.config/waypoint/<env>.env; set +a
   curl -s -X POST "https://${TURSO_DATABASE_URL#turso://}/v2/pipeline" \
     -H "Authorization: Bearer $TURSO_AUTH_TOKEN" -H 'Content-Type: application/json' \
     -d '{"requests":[{"type":"execute","stmt":{"sql":"select 1"}},{"type":"close"}]}'
   ```

### 1.2 Cloudflare R2 buckets and writer tokens

1. **Enable R2.** This needs a payment method on the account even on the free plan; the checkout flow asks for one. Add a **budget alert** under Billing → Budget alerts (a low threshold such as $1). Cloudflare has no hard spending cap.
2. **Create the bucket** `waypoint-<env>` (any name works; the writer marks the bucket with `meta/environment.json` on first use, which keeps dev and prod apart; D54): R2 → Create bucket. Location: Automatic. Default storage class: **Standard** (Infrequent Access has no free tier). Leave public access, `r2.dev`, custom domains, and CORS **off**.
3. **Create the writer token:** R2 → Manage API tokens → **Create Account API token**:
   - Name `waypoint-writer-<env>`, permission **Object Read & Write**
   - **Apply to specific buckets only** → `waypoint-<env>`
   - TTL Forever, no IP filtering
4. **Record** (the secret is shown once): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, into `<env>.env`.
5. **Verify.** Use the AWS CLI with `--endpoint-url https://<account_id>.r2.cloudflarestorage.com --region auto`:
   - put, head, get, then delete a `healthcheck/` object → all succeed
   - `put-object --if-none-match '*'` on an existing key → **412**
   - `head-bucket` on the *other* environment's bucket → **403**

### 1.3 Tailscale (sidecar node for the writer)

1. **Tag owner.** In the Tailscale admin console → Access controls, add `"tagOwners": { "tag:waypoint": ["autogroup:admin"] }`. If the policy isn't allow-all, also grant access to `tag:waypoint` on `tcp:443`.
2. **Auth key:** Settings → Keys → Generate auth key.
   - Description `waypoint-sidecar`, **not reusable**, not ephemeral, pre-approved if offered
   - Tags: `tag:waypoint`; expiry 90 days
3. **Record** `TS_AUTHKEY` into `ts.env`. It's used once, at the sidecar's first login (`TS_AUTH_ONCE=true`). After that, the node identity lives in the Docker volume `waypoint_tailscale-state`. You only need a new key if that volume is lost.
4. **MagicDNS and HTTPS certificates** must be enabled for the tailnet. They are on by default.

### 1.4 Writer host

- **Docker:** `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker <user>`. No re-login is needed; `deploy/upgrade.sh` uses `sg docker`.
- **Data directory:** `install -d -m 700 ~/.local/share/waypoint/prod`, owned by uid/gid 1000 (the writer's user; `WRITER_UID` and `WRITER_GID` in `instance.env` change it).
- **Instance file:** `~/.config/waypoint/instance.env`, copied from [instance.env.example](../deploy/instance.env.example) or written with `deploy/make-instance-env.sh` ([infrastructure.md](infrastructure.md#deployment) has an example). Check it with `upgrade.sh validate`.
- **Writer config** in `prod.env`: `WAYPOINT_ENV=prod`, `WAYPOINT_BASE_URL=https://waypoint.<tailnet>.ts.net` (the URL agents and browsers use), and with a public reader `WAYPOINT_PUBLIC_BASE_URL=https://share.example.com`. A dev writer uses its own dev reader's domain in `dev.env`. Every key: [configuration.md](configuration.md#writer).
- **Automatic deploys** (optional): a self-hosted GitHub Actions runner on this host, registered only to your private ops repository, with the label `waypoint-deploy`, running as this user (for example as a systemd **user** unit with linger enabled, so it survives logouts): [self-hosting.md](self-hosting.md#optional-automatic-deploys-on-release).
- **Share token key:** sharing also needs `WAYPOINT_SHARE_TOKEN_KEY`, 32 random bytes in base64url (43 characters), from which the writer derives every link's token (D50). Generate it with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in `prod.env`; generate a **separate** one for `dev.env`. Without it, the writer warns once at startup, can't create links or show their URLs, and can still list, extend and revoke existing links. Rotating it doesn't break existing links, but their URLs can no longer be copied from the writer; see [trust-model.md](trust-model.md#share-links).

---

## Part 2: Cloud reader

The reader is a Cloudflare Worker per environment, on a custom domain in a zone of your Cloudflare account: for example `waypoint-reader` at `share.example.com` (prod) and `waypoint-reader-dev` at `share-dev.example.com` (dev). All of its data credentials are **read-only** (decision D38).

### 2.1 Turso read-only tokens

```bash
turso db tokens create waypoint-<env> --read-only --expiration never
```

- **Record:** `TURSO_DATABASE_URL` (same as the writer's) and `TURSO_READONLY_TOKEN`, into `reader-<env>.env`.
- **Verify** with the `/v2/pipeline` request from 1.1, using this token:
  - `SELECT count(*) FROM collections` → succeeds
  - `DELETE FROM meta WHERE 0` (matches no rows, so it's harmless even if allowed) → must be **rejected** with `BLOCKED` ("SQL write operations are forbidden"). The HTTP status is still 200; the error is in the pipeline result.

### 2.2 R2 read-only tokens

R2 → Manage API tokens → **Create Account API token**:
- Name `waypoint-reader-<env>`, permission **Object Read only**
- **Apply to specific buckets only** → `waypoint-<env>`
- TTL Forever, no IP filtering

**Record** `R2_READER_ACCESS_KEY_ID` and `R2_READER_SECRET_ACCESS_KEY` into `reader-<env>.env`, plus `R2_ACCOUNT_ID` and `R2_BUCKET`. (Another S3-compatible store uses the `WAYPOINT_S3_ENDPOINT` and `WAYPOINT_S3_REGION` settings instead of `R2_ACCOUNT_ID`, for writer and reader alike; see [configuration.md](configuration.md). `upgrade.sh` uploads whichever of these keys the file sets.) Generate `RAW_CAP_KEY` as 32 random bytes with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in the same file.

**Verify:**
- `list-objects-v2 --max-keys 1` on its own bucket → **200**
- `put-object healthcheck/readonly-probe.txt` → **403**
- `head-bucket` on the other environment's bucket → **403**

### 2.3 Cloudflare deploy API token

My Profile → API Tokens → Create Token → **Custom token**, named `waypoint-reader-deploy`:

| Resource | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Account Settings | Read |
| Account | Workers Tail | Read |
| Account | Account Analytics | Read |
| Account | Workers R2 Storage | Read |
| Zone | Workers Routes | Edit |
| Zone | DNS | Edit |

- **Scope:** account resources = only your account; zone resources = only the reader's zone. No IP filtering; an expiry is optional (track it if you set one).
- **Record:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, into `cloudflare.env`. This token deploys from the instance's host and **is never added to GitHub secrets**.
- **Verify:**
  ```bash
  curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  ```
  For a full check: deploy a throwaway Worker on a throwaway custom domain (`custom_domain: true`, `workers_dev: false`), `curl` it, then run `wrangler delete`.
- **Known quirks:**
  - `wrangler whoami` can't show the email (the token lacks User Details Read). This is harmless.
  - `wrangler delete` may print `Authentication error [code: 10000]` while listing KV namespaces *after* deleting successfully. This is also harmless.
  - Always set `CLOUDFLARE_ACCOUNT_ID` so wrangler doesn't need membership permissions.

### 2.4 Platform features

- **Workers Analytics Engine** stores the reader's access events. Enable it once under Workers & Pages → Analytics Engine; it's free. The dataset is created automatically on the first write.
- **Rate Limiting binding** throttles protected reader requests. The docs list it for the Free plan; it needs wrangler ≥ 4.36.
- **Workers plan:** Free, with 100k requests/day and 10 ms CPU per request. The reader never renders anything, which keeps it within that.

### 2.5 DNS and the zone

- Hostnames: one per reader target, for example `share.example.com` (prod) and `share-dev.example.com` (dev), set as `READER_<target>_DOMAIN` in `instance.env`. **Don't create DNS records by hand.** Attaching a Worker custom domain creates the record and the certificate. Before the first deploy, check that neither hostname nor a wildcard covering it already has a record.
- Zone rules that matter: redirect rules, Bot Fight Mode and WAF custom rules must not match the reader's hostnames, or they break share links and the deploy's smoke test (which needs `/healthz`, `/healthz/deep`, `/` and `/robots.txt` to reach the Worker). Recheck them when the zone configuration changes.

### 2.6 Where the reader's secrets go

The values in `reader-<env>.env` are uploaded with `wrangler secret bulk` by `deploy/upgrade.sh`, running on the instance's host with `cloudflare.env`. The temporary JSON file is mode 600 and removed right after the upload. Values never appear in a Wrangler config, the repo, or CI logs.

Reader deploys turn each Worker's `workers.dev` route and Worker Previews off (D55), unless a target sets `READER_<target>_WORKERS_DEV=true`, so a reader is reachable only on its custom domain.

---

## Part 3: CI remote cache

CI's Turborepo tasks share a remote cache on Vercel, with signed artifacts (D52; trust model: [trust-model.md](trust-model.md#deploy-pipeline)). It's optional: without these values turbo uses only its local cache, which is how fork PRs and local machines run.

1. **Vercel team.** Any Vercel account works; the cache doesn't need a Vercel project. Its slug (Team Settings → General → Team URL) is the GitHub **repository variable** `TURBO_TEAM`: `gh variable set TURBO_TEAM --body <slug>`.
2. **Access token.** Vercel → Account Settings → Tokens → Create, scoped to that team, with an expiry you'll track. Store it as the **repository secret** `TURBO_TOKEN`: `gh secret set TURBO_TOKEN` (paste at the prompt, so it doesn't land in shell history).
3. **Signing key.** At least 32 random bytes, for example `openssl rand -base64 48 | gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY`. `remoteCache.signature: true` in `turbo.json` makes turbo sign every upload with it (HMAC-SHA256) and ignore any download without a valid signature.

- **Record:** nothing locally. The three values live only in GitHub (Settings → Secrets and variables → Actions). Never put them in `~/.config/waypoint/`, Dockerfiles or the deploy runner's environment: deploys never use the remote cache.
- **Verify:** on a PR, a CI job's turbo summary prints `Remote caching enabled`, and a rerun of the job shows `cache hit` for its tasks. A fork PR (or `TURBO_TOKEN=` locally) prints `Remote caching disabled` and still passes.
- **Rotate:** create the new token or key, `gh secret set` it, then delete the old token in Vercel. A new signing key makes every existing artifact fail verification, so the next CI run is a full cache miss that repopulates the cache.

## Part 4: Release deploy dispatch

Optional, for an instance that deploys every release automatically through a private ops repository (D56; [releasing.md](releasing.md#deploy-dispatch)). The release workflow starts the ops repository's deploy workflow with a GitHub App token.

1. **GitHub App.** GitHub → Settings → Developer settings → GitHub Apps → New: no webhook, one repository permission, **Actions: Read and write**, installable only on your account. Install it on the ops repository only.
2. **Private key.** Generate one in the App's settings and store it as the secret `DEPLOY_APP_PRIVATE_KEY` of a `release` **environment** whose deployment branches are limited to `main`: `gh secret set DEPLOY_APP_PRIVATE_KEY --env release < key.pem`, then delete `key.pem`.
3. **Variables.** `gh variable set DEPLOY_APP_CLIENT_ID --body <client ID>` and `gh variable set DEPLOY_DISPATCH_REPO --body <owner>/<ops repo>` (and `DEPLOY_DISPATCH_WORKFLOW` if its file isn't `deploy.yml`).

- **Record:** the App's name and client ID in your infrastructure notes; the key lives only in the environment.
- **Verify:** the `dispatch` job of the next release run succeeds and the ops repository shows a Deploy run started by the App.
- **Rotate:** [releasing.md](releasing.md#rotating-the-app-key).

---

## Rotating a credential

1. Create the new credential using the steps above, and verify it, including the negative checks.
2. Replace the value in the env file on the writer host (a reader's secrets file, for a reader credential).
3. Redeploy the affected component: run `upgrade.sh` again at the deployed version ([deploy/README.md](../deploy/README.md)). A changed writer env file changes the writer's Compose config, and a changed secrets file the reader's secrets, so either redeploys; `--force` redeploys anyway. Confirm health.
4. Revoke the old credential in Turso (`turso db tokens invalidate` invalidates **all** tokens for that database, so re-issue the others first) or in Cloudflare (delete the old token).
