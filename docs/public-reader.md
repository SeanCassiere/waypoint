# Public reader (phase 2)

The reader is a Cloudflare Worker on **`waypoint.pingstash.com`** that serves shared collections to people outside the tailnet. It is **read-only forever**. There is no upload, edit, or delete path, and no admin UI.

It isn't built in phase 1. It is specified here so phase 1 doesn't paint it into a corner.

## Why Workers (not Railway)

- **R2 binding:** reads blobs directly, with no S3 credentials and free egress. Railway would charge $0.05/GB to proxy every blob.
- **Edge cache:** blobs are immutable and content-addressed, so they can be cached forever.
- **Built-in tools for future grant features:** Turnstile, the Rate Limiting binding, and WAF rules.
- **Free plan headroom:** 100k requests a day and 10 ms of CPU per request cover expected use. Markdown is pre-rendered by the writer, so the reader only looks things up and streams.

## URLs

```
/s/<token>/c/<collection public id>/[r/<revision public id>/][<path>]   viewer shell
/s/<token>/raw/r/<revision public id>/<path>                           raw content
/assets/<renderer version>/<file>                                       static rendition assets
```

- **The token is in the path,** not a query string, so relative links and images inside documents resolve with the token automatically.
- **The shell** is a minimal page: title, file sidebar, and an iframe. It iframes the raw route **pinned to the resolved revision**, so one page never mixes files from two revisions. Share viewers never see a revision picker.
- **Pinned links:** for a share link pinned to a revision, both routes require `rpub` to be that revision. Anything else returns 404.
- **Assets:** `/assets/…` serves the same static, non-secret JS and CSS that the writer serves, with no token. Renditions may reference them. See [architecture.md](architecture.md#renditions).

## Access model

- **Deny by default.** Every request needs a valid share token. Anything else returns **404**, never 403, so the reader never confirms that something exists.
- **Token format:** `wps_` plus 32 random bytes, base64url. The prefix lets secret scanners spot leaked tokens. Only `sha256(token)` is stored, in `share_links.token_hash`.
- **Following vs. pinned:**
  - A link with `revision_id = NULL` follows the latest synced revision.
  - A link created while viewing an older revision is pinned to it.
- **No history.** Viewers of a following link see only the latest revision, because an older revision may contain something that was later removed.
- **Tombstones hide everything.** A tombstoned collection returns 404 for every link.
- **Revocation and expiry.** `revoked_at` and `expires_at` are checked on every request. Token lookups are cached for at most 60 s, so a revocation takes effect within about a minute of the writer's push.
- **Created only on the tailnet.** Share links are created and revoked through the writer's API or viewer (and later its MCP server). The reader never writes them.

```sql
share_links (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'shl_*' AND length(id) = 30),
  token_hash    TEXT NOT NULL UNIQUE,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  revision_id   TEXT REFERENCES revisions(id),  -- NULL = follow latest
  label         TEXT,                          -- who it's for
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
)
```

- **Revoking** sets `revoked_at`. That is one of the few allowed updates, and only one human edits it, so last-push-wins is fine.
- **Disaster recovery.** Share links are included in the [collection snapshot](glossary.md#content) (token hashes only), so a restore from the bucket keeps them valid. Creating or revoking a link queues a snapshot rewrite.

## Request handling

1. **Parse the URL** against the routes above. If it doesn't match, return 404.
2. **Rate-limit** token misses per IP using the Rate Limiting binding.
3. **Look up the link:** hash the token, then look up `share_links` joined with `collections`, the tombstone, and the revision. This lookup is cached for no more than 60 s.
4. **Return 404** if:
   - the link is revoked or expired
   - the collection is tombstoned
   - the revision isn't allowed by this link
   - the path isn't in the manifest
5. **Resolve the blob.** For markdown, use the newest rendition.
6. **Stream it** from R2 through the Cache API. The internal cache entries are keyed by blob hash and can live forever. The *outgoing* response uses `Cache-Control: private, max-age=31536000, immutable`, so shared caches never keep serving a tokenized URL after revocation.
7. **Record an access event** in Workers Analytics Engine: share link ID, collection, revision, path, and time.

## Safeguards (enforced by structure, not convention)

| Safeguard | How |
|---|---|
| No writes to metadata | The reader's Turso token is created with `--read-only` |
| No write code paths | The reader app contains no write routes; the core's write handlers aren't imported into the Worker build |
| No writes to blobs | R2 bindings can't be permission-scoped; a binding can write. The reader adapter exposes only `get`/`head` behind a narrow interface, and a lint rule bans `put`/`delete` in `apps/reader`. *(Open: use the S3 API with a read-only R2 token instead.)* |
| Logs never touch the main DB | Access events go to Analytics Engine |
| Not indexable | `X-Robots-Tag: noindex, nofollow` on every response; `robots.txt` disallows everything |
| No token leakage | `Referrer-Policy: no-referrer` on every response |
| No enumeration | 404 for everything not explicitly allowed; rate limiting on token misses |
| No stale shared caches | `Cache-Control: private` on all tokenized responses |
| Environment isolation | The prod reader is bound only to the prod bucket and the prod DB |

## Later (not phase 2)

- **Password-protected links:** a password page with Turnstile, then a short-lived session token in the path.
- **Audience grants:** one grant per person, scoped to an audience of collections.
- **Comments from share viewers.** This would be the first non-read operation on the public side. It needs its own design and will never include uploads.
