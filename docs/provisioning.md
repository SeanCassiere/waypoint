# Provisioning guide

Step-by-step instructions for obtaining every external resource and credential Waypoint needs, for both halves of the system:

- **Local writer**: the tailnet write side ([Part 1](#part-1-local-writer)). Phase 1; provisioned.
- **Cloud reader**: the public read-only Cloudflare Worker ([Part 2](#part-2-cloud-reader)). Phase 2; provisioned and live.

[infrastructure.md](infrastructure.md) is the checklist of *what* exists. This page explains *how to create it again*: for a new environment, a rebuild, or rotating credentials. Every step can be done by a person, or handed to an agent with computer use, which reports back the values listed under **Record**.

## Ground rules

- **Two environments, never shared:** `dev` and `prod` each get their own database, bucket, and tokens. The environment guard depends on this.
- **Secrets never go into Git, images, or GitHub.** They live on the writer host in `~/.config/waypoint/` (directory mode 700, files mode 600), and the reader's are stored as Cloudflare Worker secrets. Deploys read them from those places. The one exception is CI's Turborepo remote cache ([Part 3](#part-3-ci-remote-cache)), whose credentials are GitHub secrets because they reach nothing of Waypoint's.
- **Least privilege:** writers get read/write access; the reader gets read-only credentials only.
- **Verify every credential** using the commands below before relying on it. Each check includes a negative test, showing that the credential *can't* do what it shouldn't.
- Cloudflare shows R2 secret keys **only once**. Record them immediately.

Current values, for reference: Cloudflare account `2129f9f79b31857b67e19f0a431942a9`; Turso org `seancassiere`, group `waypoint`, location `aws-ap-southeast-2`; zone `pingstash.com`.

## Env files on the writer host

| File | Used by | Contents |
|---|---|---|
| `~/.config/waypoint/prod.env` | prod writer container | `WAYPOINT_*` config (including the secret `WAYPOINT_SHARE_TOKEN_KEY`), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| `~/.config/waypoint/dev.env` | local dev writer | same keys, dev values |
| `~/.config/waypoint/ts.env` | Tailscale sidecar | `TS_AUTHKEY` only |
| `~/.config/waypoint/reader-prod.env` | reader deploy (prod) | `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`, `R2_ACCOUNT_ID`, `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RAW_CAP_KEY`; optionally `WAYPOINT_S3_ENDPOINT` (instead of `R2_ACCOUNT_ID`) and `WAYPOINT_S3_REGION` |
| `~/.config/waypoint/reader-dev.env` | reader deploy (dev) | same keys, dev values |
| `~/.config/waypoint/cloudflare.env` | reader deploy | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| `~/.config/waypoint/instance.env` | `deploy/upgrade.sh` | No secrets: the paths above, the data directory, the Tailscale settings and the reader targets ([deploy/instance.env.example](../deploy/instance.env.example); the owner's values are in [infrastructure.md](infrastructure.md#deployment-p1)) |

Create them with `install -d -m 700 ~/.config/waypoint` and `install -m 600 /dev/null <file>`, then fill them in with an editor. Never echo secrets into shell history.

---

## Part 1: Local writer

### 1.1 Turso databases and full-access tokens

Prerequisite: the Turso CLI (`brew install tursodatabase/tap/turso`), logged in with `turso auth login`.

1. **Enable TursoDB for the organization.** In the Turso dashboard, open organization settings and turn on the **TursoDB** setting. Without it, creating a Sync-capable database fails.
2. **Create the database** (Sync-capable, via `--tursodb`):
   ```bash
   turso db create waypoint-<env> --tursodb --location aws-ap-southeast-2 --group waypoint --wait
   turso db show waypoint-<env> --url          # turso://waypoint-<env>-<org>.aws-ap-southeast-2.turso.io
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

### 1.4 Writer host (agent-1)

- **Docker:** `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker <user>`. No re-login is needed; `deploy/upgrade.sh` uses `sg docker`.
- **Data directory:** `install -d -m 700 ~/.local/share/waypoint/prod`, owned by uid/gid 1000.
- **Self-hosted GitHub Actions runner:** see [Reinstalling the deploy runner](infrastructure.md#reinstalling-the-deploy-runner). Repo-scoped, label `waypoint-deploy`, running as a systemd **user** unit, with linger enabled.
- **Instance file:** `~/.config/waypoint/instance.env`, written with `deploy/make-instance-env.sh` ([infrastructure.md](infrastructure.md#deployment-p1)). Check it with `bash deploy/upgrade.sh validate`.
- **Writer config** in `prod.env`: `WAYPOINT_ENV=prod`, `WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net`, `WAYPOINT_PUBLIC_BASE_URL=https://waypoint.pingstash.com`, `WAYPOINT_PORT=7410`. Dev sharing uses `WAYPOINT_PUBLIC_BASE_URL=https://waypoint-dev.pingstash.com` in `dev.env`. See [infrastructure.md](infrastructure.md#writer-configuration).
- **Share token key:** sharing also needs `WAYPOINT_SHARE_TOKEN_KEY`, 32 random bytes in base64url (43 characters), from which the writer derives every link's token (D50). Generate it with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in `prod.env`; generate a **separate** one for `dev.env`. Without it, the writer warns once at startup, can't create links or show their URLs, and can still list, extend and revoke existing links. Rotating it doesn't break existing links, but their URLs can no longer be copied from the writer; see [trust-model.md](trust-model.md#share-links).

---

## Part 2: Cloud reader

The reader is a Cloudflare Worker per environment: `waypoint-reader` at `waypoint.pingstash.com` (prod) and `waypoint-reader-dev` at `waypoint-dev.pingstash.com` (dev). All of its data credentials are **read-only** (decision D38).

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

**Record** `R2_READER_ACCESS_KEY_ID` and `R2_READER_SECRET_ACCESS_KEY` into `reader-<env>.env`, plus `R2_ACCOUNT_ID` and `R2_BUCKET`. (Another S3-compatible store would use the `WAYPOINT_S3_ENDPOINT` and `WAYPOINT_S3_REGION` settings instead of `R2_ACCOUNT_ID`, for writer and reader alike; see [configuration.md](configuration.md). The owner's deploy scripts upload only the seven values above.) Generate `RAW_CAP_KEY` as 32 random bytes with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in the same file.

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

- **Scope:** account resources = only this account; zone resources = only `pingstash.com`. No IP filtering, no expiry.
- **Record:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, into `cloudflare.env`. This token deploys from the self-hosted runner and **is never added to GitHub secrets**.
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

- Hostnames: `waypoint.pingstash.com` (prod) and `waypoint-dev.pingstash.com` (dev). **Don't create DNS records by hand.** Attaching a Worker custom domain creates the record and the certificate. Before attaching, check that neither hostname nor a `*.pingstash.com` wildcard already has a record.
- Zone rules that matter: the existing "Root redirect" (`pingstash.com` and `www` → `seancassiere.com`) doesn't match the Waypoint hostnames. Bot Fight Mode is off. There are no WAF custom rules. Recheck these if the zone configuration changes.

### 2.6 Where the reader's secrets go

The values in `reader-<env>.env` are uploaded with `wrangler secret bulk` by `deploy/upgrade.sh`, running on the self-hosted runner with `cloudflare.env`. The temporary JSON file is mode 600 and removed right after the upload. Values never appear in a Wrangler config, the repo, or CI logs.

The reader deploys turn every Worker's `workers.dev` route and Worker Previews off (D55). PR previews (D49) are gone: to finish removing them, delete the Cloudflare Access app `fb19dcb4-9f87-47dc-a038-1b41cef93d0f` ("Waypoint reader workers.dev and previews") and any preview still listed under Workers & Pages → `waypoint-reader` → Previews (`wrangler preview delete --name pr-<n> --skip-confirmation`, with `cloudflare.env` loaded). Until the first deploy through `upgrade.sh`, the prod Worker's `workers.dev` hostname stays on behind that app, so delete the app only after that deploy.

---

## Part 3: CI remote cache

CI's Turborepo tasks share a remote cache on Vercel, with signed artifacts (D52; trust model: [trust-model.md](trust-model.md#deploy-pipeline)). It's optional: without these values turbo uses only its local cache, which is how fork PRs and local machines run.

1. **Vercel team.** Any Vercel account works; the cache doesn't need a Vercel project. Its slug (Team Settings → General → Team URL) is the GitHub **repository variable** `TURBO_TEAM`: `gh variable set TURBO_TEAM --body <slug>`.
2. **Access token.** Vercel → Account Settings → Tokens → Create, scoped to that team, with an expiry you'll track. Store it as the **repository secret** `TURBO_TOKEN`: `gh secret set TURBO_TOKEN` (paste at the prompt, so it doesn't land in shell history).
3. **Signing key.** At least 32 random bytes, for example `openssl rand -base64 48 | gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY`. `remoteCache.signature: true` in `turbo.json` makes turbo sign every upload with it (HMAC-SHA256) and ignore any download without a valid signature.

- **Record:** nothing locally. The three values live only in GitHub (Settings → Secrets and variables → Actions). Never put them in `~/.config/waypoint/`, Dockerfiles or the deploy runner's environment: deploys never use the remote cache.
- **Verify:** on a PR, a CI job's turbo summary prints `Remote caching enabled`, and a rerun of the job shows `cache hit` for its tasks. A fork PR (or `TURBO_TOKEN=` locally) prints `Remote caching disabled` and still passes.
- **Rotate:** create the new token or key, `gh secret set` it, then delete the old token in Vercel. A new signing key makes every existing artifact fail verification, so the next CI run is a full cache miss that repopulates the cache.

---

## Rotating a credential

1. Create the new credential using the steps above, and verify it, including the negative checks.
2. Replace the value in the env file on the writer host. For the reader, redeploy, or re-run `wrangler secret put`.
3. Redeploy the affected component: merge to `main`, or follow the manual steps in [deploy/README.md](../deploy/README.md). Confirm health.
4. Revoke the old credential in Turso (`turso db tokens invalidate` invalidates **all** tokens for that database, so re-issue the others first) or in Cloudflare (delete the old token).
