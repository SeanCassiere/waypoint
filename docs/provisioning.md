# Provisioning guide

Step-by-step instructions for obtaining every external resource and credential Waypoint needs, for both halves of the system:

- **Local writer**: the tailnet write side ([Part 1](#part-1-local-writer)). Phase 1; provisioned.
- **Cloud reader**: the public read-only Cloudflare Worker ([Part 2](#part-2-cloud-reader)). Phase 2; provisioned and live.

[infrastructure.md](infrastructure.md) is the checklist of *what* exists. This page explains *how to create it again*: for a new environment, a rebuild, or rotating credentials. Every step can be done by a person, or handed to an agent with computer use, which reports back the values listed under **Record**.

## Ground rules

- **Two environments, never shared:** `dev` and `prod` each get their own database, bucket, and tokens. The environment guard depends on this.
- **Secrets never go into Git, images, or GitHub.** They live on the writer host in `~/.config/waypoint/` (directory mode 700, files mode 600), and the reader's are stored as Cloudflare Worker secrets. Deploys read them from those places.
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
| `~/.config/waypoint/reader-prod.env` | reader deploy (prod) | `TURSO_DATABASE_URL`, `TURSO_READONLY_TOKEN`, `R2_ACCOUNT_ID`, `R2_READER_ACCESS_KEY_ID`, `R2_READER_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RAW_CAP_KEY` |
| `~/.config/waypoint/reader-dev.env` | reader deploy (dev) | same keys, dev values |
| `~/.config/waypoint/cloudflare.env` | reader deploy | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |

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
2. **Create the bucket** `waypoint-<env>`: R2 → Create bucket. Location: Automatic. Default storage class: **Standard** (Infrequent Access has no free tier). Leave public access, `r2.dev`, custom domains, and CORS **off**.
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

- **Docker:** `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker <user>`. No re-login is needed; the deploy script uses `sg docker`.
- **Data directory:** `install -d -m 700 ~/.local/share/waypoint/prod`, owned by uid/gid 1000.
- **Self-hosted GitHub Actions runner:** see "Reinstalling the existing runner" in [deploy/README.md](../deploy/README.md). Repo-scoped, label `waypoint-deploy`, running as a systemd **user** unit, with linger enabled.
- **Writer config** in `prod.env`: `WAYPOINT_ENV=prod`, `WAYPOINT_BASE_URL=https://waypoint.tail7aca06.ts.net`, `WAYPOINT_PUBLIC_BASE_URL=https://waypoint.pingstash.com`, `WAYPOINT_PORT=7410`. Dev sharing uses `WAYPOINT_PUBLIC_BASE_URL=https://waypoint-dev.pingstash.com` in `dev.env`. See [infrastructure.md](infrastructure.md#writer-configuration).
- **Share token key:** sharing also needs `WAYPOINT_SHARE_TOKEN_KEY`, 32 random bytes in base64url (43 characters), from which the writer derives every link's token (D49). Generate it with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in `prod.env`; generate a **separate** one for `dev.env`. Without it, the writer starts with sharing off and warns once. Rotating it doesn't break existing links, but their URLs can no longer be copied from the writer; see [trust-model.md](trust-model.md#share-links).

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

**Record** `R2_READER_ACCESS_KEY_ID` and `R2_READER_SECRET_ACCESS_KEY` into `reader-<env>.env`, plus `R2_ACCOUNT_ID` and `R2_BUCKET`. Generate `RAW_CAP_KEY` as 32 random bytes with `openssl rand -base64 32 | tr "+/" "-_" | tr -d "="` and record it in the same file.

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

The seven values in `reader-<env>.env` are uploaded with `wrangler secret bulk` by the deploy pipeline, running on the self-hosted runner with `cloudflare.env`. The temporary JSON file is mode 600 and removed on exit. Values never appear in `wrangler.jsonc`, the repo, or CI logs.

PR previews also get the `reader-prod.env` values; see 2.7.

### 2.7 PR previews

PR previews are Worker Previews of the prod Worker `waypoint-reader` (decision D49; operations in [deploy/README.md](../deploy/README.md#pr-previews)). They need no new credential, but they depend on four things being in place.

- **Wrangler ≥ 4.135.** Worker Previews are in open beta, and `wrangler preview` first shipped in 4.135. The reader pins 4.147.0.
- **The `workers.dev` route and previews enabled on `waypoint-reader`.** Its Worker settings must show `{enabled: true, previews_enabled: true}`. The prod deploy sets both from `workers_dev: true` and `preview_urls: true` in `wrangler.jsonc`. They were first enabled on 2026-10-08, by hand through the API, right after confirming the Access app below. The call was `POST /accounts/<account>/workers/scripts/waypoint-reader/subdomain` with `{"enabled":true,"previews_enabled":true}`. The custom domain `waypoint.pingstash.com` keeps `previews_enabled: false`.
- **The Cloudflare Access app.** Zero Trust → Access → Applications → `fb19dcb4-9f87-47dc-a038-1b41cef93d0f`, "Waypoint reader workers.dev and previews", a self-hosted app with these hostnames:
  - `waypoint-reader.seancassiere.workers.dev`
  - `*-waypoint-reader.seancassiere.workers.dev` (every preview, deployment and version URL)

  It has one Allow policy (the owner's email), with login by One-time PIN or Cloudflare. The team domain is `seancassiere.cloudflareaccess.com`.
  - **Verify with no credentials:** `curl -sI https://waypoint-reader.seancassiere.workers.dev/healthz`, and the same for any `<anything>-waypoint-reader…` hostname. Each must answer `302` to `https://seancassiere.cloudflareaccess.com/cdn-cgi/access/login/<that hostname>`.
  - **Never** add `waypoint.pingstash.com` to this app or any other Access app, and never widen the policy. If the app changes, disable the Worker's `workers.dev` route and previews first. Do that in `wrangler.jsonc` (`workers_dev: false`, `preview_urls: false` in the prod env) **and** with the API call above (`false` for both), and disable the Preview workflow. A change made only in the dashboard or API is undone by the next prod deploy, which applies `wrangler.jsonc`. Every prod deploy fails and rolls back unless `waypoint-reader.seancassiere.workers.dev` redirects to Access, so while it's disabled, remove that check from `deploy-reader.sh` in the same change.
  - The deploy token can't read Access apps, by design: it has no Access permissions, and shouldn't get any. Check the app in the dashboard.
- **Preview secrets and bindings.**
  - Previews don't inherit production secrets, so the Preview workflow sends the seven `reader-prod.env` values with every preview deployment (`wrangler preview --secrets-file`, from a mode-600 temporary file). Keep the dashboard's Preview base config empty. `--ignore-base-config` only takes effect when a preview is created (Wrangler sends it on the create request, at a PR's first push); later deployments to that preview send their full runtime env, bindings and secrets, so the base config isn't what they run with either way.
  - Bindings come only from the `previews` block of the prod env in `wrangler.jsonc`: Analytics Engine dataset `waypoint_access_preview` (created on first write, like the others) and rate-limit namespace `1003`.
  - Rotating a prod reader credential reaches existing previews on their next push. Closing and reopening a PR also re-uploads.

**Cleanup.** Closing a PR deletes its preview. To find and delete leftovers, see [deploy/README.md](../deploy/README.md#pr-previews). Deleting a preview removes all of its deployments and their secrets.

---

## Rotating a credential

1. Create the new credential using the steps above, and verify it, including the negative checks.
2. Replace the value in the env file on the writer host. For the reader, redeploy, or re-run `wrangler secret put`.
3. Redeploy the affected component: merge to `main`, or follow the manual steps in [deploy/README.md](../deploy/README.md). Confirm health.
4. Revoke the old credential in Turso (`turso db tokens invalidate` invalidates **all** tokens for that database, so re-issue the others first) or in Cloudflare (delete the old token).
