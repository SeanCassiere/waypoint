# Public reader

The reader is a Cloudflare Worker on the instance's own public domain (for example `share.example.com`) that serves shared collections to people outside the tailnet. It is **read-only forever**. There is no upload, edit, or delete path, and no admin UI.

It's optional ([self-hosting](self-hosting.md#tier-3-the-public-reader)). An instance has one reader per environment, each its own Worker on its own domain with that environment's read-only credentials (for example `waypoint-reader` on `share.example.com` for prod and `waypoint-reader-dev` on `share-dev.example.com` for dev). `upgrade.sh` deploys each one after the writer, smoke-tests it and rolls it back on failure ([deploy/README.md](../deploy/README.md#public-reader-workers); what each needs: [infrastructure.md](infrastructure.md#cloudflare-workers-public-reader)).

## Why Workers (not Railway)

- **R2 next door, free egress:** the reader reads blobs over R2's S3 API with a read-only token (D38). Egress is free, whereas Railway would charge $0.05/GB to proxy every blob.
- **Edge cache:** blobs are immutable and content-addressed, so they can be cached forever.
- **Built-in tools for future grant features:** Turnstile, the Rate Limiting binding, and WAF rules.
- **Free plan headroom:** 100k requests a day and 10 ms of CPU per request cover expected use. Markdown is pre-rendered by the writer, so the reader only looks things up and streams.

## URLs

```
/s/<token>/c/<collection public id>/[r/<revision public id>/][<path>]   viewer shell
/x/<share link id>.<cap>/r/<revision public id>/<path>             raw content
/assets/<renderer version>/<file>                                       static rendition assets
```

- **The shell token is in its path. Raw content uses a derived per-revision capability, so document scripts cannot read the full share token from their URL. Relative links and images resolve under the same capability prefix.
- **The shell** is the Folio public shell (see [Shell and static pages](#shell-and-static-pages)): a quiet letterhead, the file tabs or a "Files (N)" tree, and an iframe. It iframes the raw route **pinned to the resolved revision**, so one page never mixes files from two revisions. Share viewers never see a revision picker.
- **Pinned links:** for a share link pinned to a revision, the raw route requires `rpub` to be that revision. Anything else returns 404.
- **The bare root** `/` is a fixed explanatory page that returns **200**. Besides it, the only URLs outside `/s/` and `/x/` that aren't denials are the operational endpoints `/healthz`, `/healthz/deep` and `/robots.txt`, none of which return collection data. `/index.html`, `/s`, `/s/` and everything else get the denial page.
- **Assets:** `/assets/…` is reserved for future renderer assets. Current renditions are self-contained (D31), so there is no asset to serve and these URLs return 404.

## Access model

- **Deny by default.** Every shell request needs a valid share token; raw requests need a valid derived capability. Anything else returns **404**, never 403, so the reader never confirms that something exists. The exceptions are the bare root `/`, which has nothing to confirm (see below), and the operational endpoints `/healthz`, `/healthz/deep` and `/robots.txt`.
- **Token format:** `wps_` plus 32 bytes, base64url. The prefix lets secret scanners spot leaked tokens. Only `sha256:` followed by 64 lowercase hexadecimal SHA-256 digits of the complete token is stored in `share_links.token_hash`. The writer derives the 32 bytes as an HMAC of the link ID with a writer-only key (D50); the reader neither knows nor cares, and still just hashes the token and looks up `token_hash`.
- **Following vs. pinned:**
  - A link with `revision_id = NULL` follows the latest synced revision.
  - A link created while viewing an older revision is pinned to it.
- **No history.** Viewers of a following link see only the latest revision, because an older revision may contain something that was later removed.
- **Tombstones hide everything.** A tombstoned collection returns 404 for every link.
- **Revocation and expiry.** `revoked_at` and `expires_at` are checked on every request. Only live links are cached, for at most 5 s per isolate, so a revocation takes effect within about **5 seconds of the writer's push**. The writer starts that push immediately after the revoke (queued behind a push already in flight; if it fails, the 60 s push timer retries).
- **Created only on the tailnet.** Share links are created and revoked through the writer's API or viewer. They are never exposed through MCP (trust-model rule 6). The reader never writes them.

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

Implementation: collection snapshots remain `format_version: 1` with an optional `share_links` array. Old snapshots without the array restore as having no links. Restore inserts links after revision manifests so pinned foreign keys resolve. Merge inserts missing links and can add a revocation, but never removes one. The writer may create links for queued collections and revisions; the cloud reader returns 404 until their rows reach the cloud.

## Request handling

1. **Check the per-isolate blocked-IP map** before parsing or querying metadata. A blocked IP receives the generic 404 immediately.
2. **Parse the URL** against the routes above. If it does not match, count the denial and return 404. Allowed requests never call the Rate Limiting binding.
3. **Look up the link:** hash the shell token (or validate the raw capability and look up its share link ID), then look up `share_links` joined with `collections`, the tombstone, and the revision. Live links are cached for no more than 5 s; misses and denied links are not cached.
4. **Count the denial and return the 404 for its route family** if:
   - the link is revoked or expired
   - the collection is tombstoned
   - the revision isn't allowed by this link
   - the path isn't in the manifest
5. **Resolve the blob.** For markdown, use the newest rendition.
6. **Stream it** from R2 through the Cache API. The internal cache entries are keyed by blob hash and can live forever. The outgoing response uses `Cache-Control: private, no-cache`, so browsers recheck link status on each use.
7. **Record an access event** in Workers Analytics Engine: share link ID, collection, revision, path, and time.

Implementation values: live share-link lookups (`LOOKUP_TTL_MS`) live in isolate memory for 5 seconds (maximum 1,000 entries before clearing); unknown, revoked and tombstoned links are never cached, so each Turso read happens at most once per 5 s per link per isolate for allowed traffic, and a new link works as soon as it reaches the cloud; blob Cache API entries use same-origin internal URLs under `/__internal/blob/<hash>`, keyed only by `sha256:` hash. That route is not publicly served. The Rate Limiting binding counts denials (any denial reason) and every `/healthz/deep` request, which queries Turso and R2, permitting 30 per IP per 60 seconds; `/healthz` and allowed share requests are never counted. When it rejects a denial, that isolate blocks the IP for 60 seconds in a bounded 10,000-entry LRU map. During that window even a valid request (or a deep health probe) from the same IP receives the same 404 without a DB or R2 call; this can happen only after more than 30 denials. Blocked and ordinary denials have identical status, body, and headers. A missing binding skips rate limiting; a missing Analytics Engine binding skips access logging in local tests. All outgoing raw responses use `private, no-cache` to recheck revocation and latest-revision scope; markdown also has an ETag because a newer rendition may replace the prior one.

## Shell and static pages

The shell lives in `packages/ui/src/public-shell/`: `renderPublicShell` in `index.ts`, the stylesheet (`publicShellCss`: `sharedTokensCss` from `packages/ui/src/tokens.ts` followed by the shell's named segments in `css.ts`; writer-only tokens never reach the reader), and the script (`publicShellScript`) as readable named segments in `script.ts`. It is shared with the writer's `?as=public` preview. The reader supplies every URL: tab links (to `/s/<token>/c/<pub>/[r/<rpub>/]<path>`, written relative to the current page) and the iframe's capability prefix (`/x/<link>.<cap>/r/<rpub>/`).

- **Letterhead:** two columns. On the left, the collection title (clamped to two lines; the full title is in About) and a meta row beneath: a "Latest version" or "Snapshot" pill, then "Updated <relative>" for links that follow the latest or "Taken <date> · won't change" for single-revision links, then the link's own expiry from 30 days out ("Link expires in 6 days"), in bold ink with a clock under 24 hours (never amber: amber means pending only). On the right, "Read-only" and an "About this link" button. Times are relative and computed once at load (no timers), with the absolute local time and zone in `title` and in About; without JavaScript they show as absolute UTC ("7 Oct 2026, 22:08 UTC"). About is a light-dismiss popover (a bottom sheet on phones, with the full title on top) with three rows: what the link shows ("Shows the latest version" or "A fixed snapshot"), how long it works ("Works until <time>" or "No end date"; the writer's preview, which doesn't know which link will be used, says "Expiry depends on the link"), and "Read-only" (what can be read and downloaded). On phones the meta row spans the width with short forms ("Latest", "2 hr. ago", "Expires in 6 days") and the About button itself reads "Read-only". The link's label (the owner's private note) is never shown. The only branding is the Waypoint mark in the About footer ("Shared from Waypoint", not a link); there is no link back to the tailnet.
- **Files:** no strip for one file; one tab per file up to 8 (head first); above 8, a "Files N" button that opens the tree in a light-dismiss popover (Esc, an outside press or a press in the document closes it; it opens on the current file, and focus returns to the button); below 600 px it is a bottom sheet with a Done button and 44 px rows. On phones the tab strip scrolls the current tab into view and fades at overflowing edges. The tree lists the head first, with folders collapsed above 200 files except the current file's. Each tab and row shows a type icon (document, image, table, code, download-only, folder) referenced from one inline SVG sprite per page; files that can't be previewed end with "download · <size>"; the page title is "<file name> · <collection title>" and follows in-frame navigation. Moving the current tab changes no tab's width (each tab reserves its bold width). Tabs and tree entries are server-rendered links, so the shell works without JavaScript. Links are relative to the page (`./x.md`, `../x.md`), so they don't repeat the share token until the shell pins them to absolute URLs on the first in-frame navigation (the page's own URL, which the document in its opaque-origin frame cannot read), and only characters that change how a URL parses are percent-encoded.
- **Bounded file list:** the tree nests at most 6 folders deep (deeper folders join the file's label), folders that hold a single folder collapse into one row (`a/b/c/`), and a folder holding a single file shows as that file. Labels longer than 80 characters are shortened in the middle; `data-p` keeps the full path. The list markup, row icons and download markers included, is capped (`PUBLIC_SHELL_LIST_BUDGET`, 340,000 characters, non-ASCII counted triple); past it the list ends with "N more files aren't listed here". An ordinary 2,000-file manifest fits entirely. Relative links grow with folder depth (`../` once per level), so a page deep in a very large collection can list fewer files than the root: the 2,000-file repository-shaped manifest lists all 2,000 at the root but 1,756 on a page 9 folders deep, and the "N more files" line counts the rest. `apps/reader/tests/reader-cpu.test.ts` holds a full 2,000-file shell request under 5 ms of CPU for realistic, deep, single-folder-per-file, 512-byte ASCII and 512-byte CJK manifests, and under 7 ms for a repository-shaped manifest; for the realistic and repository shapes it decodes the rows from a Hrana-shaped database response inside the request (8 ms for every shape on CI; Workers allow 10 ms).
- **Bidi:** the title, folder names and the current file carry `dir="auto"`, and file links use `unicode-bidi: plaintext`, so a name can't reorder the text around it. Explicit bidi embedding, override and isolate characters (U+202A–U+202E, U+2066–U+2069) are shown as U+FFFD in labels and the title, so `invoice<RLO>fdp.exe` can't display as `invoiceexe.pdf`.
- **Document:** `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer">` on the capability URL. Files that can't be shown in a sandboxed frame (anything but text and images) get a download card linking to the same capability URL. The raw route serves CSV and TSV as `text/plain; charset=utf-8` for the same reason (a sandboxed frame can't start downloads).
- **Navigation:** plain page loads. Navigation is never animated (D51).
- **CSP:** `default-src 'none'; style-src 'sha256-<css>'; script-src 'sha256-<script>'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin` (popups that documents open can't reach back to the shell). The shell has exactly one inline `<style>` and one inline `<script>` and no `style` attributes or event handlers. The hashes are build-time constants in `apps/reader/src/csp-hashes.ts`, checked against the exact bodies by `apps/reader/tests/reader-csp-hashes.test.ts` (regenerate with `UPDATE_CSP_HASHES=1`), so no response waits on crypto. There are no external assets.
- **Shell script:** it formats `<time>` elements once at load (relative times with a short form for phones, and the absolute local time with zone in `title` and About; no timers) and listens for the v2 rendition's `{ type: "waypoint:location", href }` message, where `href` is the frame's `location.pathname + location.hash`. It accepts a message only when `event.source` is the iframe's own window, and treats `href` as untrusted: resolved against the iframe's URL, it must stay on the same origin under the iframe's capability prefix (`frameBase` must end in `/`; `renderPublicShell` throws otherwise), contain no `%2F` or `%5C`, and decode to a path already linked in the shell. It then moves `aria-current`, sets the iframe title and the page title (the file name and the H1's text), updates the Files button's path and icon, and calls `history.replaceState` with that link's own server-rendered URL, never with message data. A report for the file that is already current changes nothing. Before its first `history.replaceState`, the script rewrites every file link to its absolute URL, so links written relative to the original page keep pointing at the right files after the address bar follows the frame into another folder. The script is a list of small self-contained segments (time, frame location, …), emitted readable rather than minified; its hash covers the whole body.

The three static pages are fixed constants in `apps/reader/src/pages.ts` that share one `<style>` element (one hash), with no script, no links and no `style` attributes. The style (`staticCss`) is `sharedTokensCss` followed by the pages' own rules, so the static pages can't drift from the shell; its hash is `staticStyleHash` in `apps/reader/src/csp-hashes.ts`, generated like the shell hashes:

| Page | URL | Status | Headers besides `X-Robots-Tag`, `Referrer-Policy: no-referrer`, `nosniff`, `Content-Type` |
|---|---|---|---|
| Bare root | exactly `/` (GET and HEAD) | 200 | `Cache-Control: public, max-age=3600`; `Cross-Origin-Opener-Policy: same-origin`; CSP `default-src 'none'; style-src 'sha256-<static style>'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| Denial | everything else not allowed, for every reason | 404 | `Cache-Control: no-store`; the same COOP and CSP |
| Frame denial | `/x/…` denials, for every reason | 404 | `Cache-Control: no-store`; the same COOP; CSP as the others but `frame-ancestors 'self'`, so the shell's frame shows it |

Denials come in two route families, chosen from the requested path alone, never from the reason: the raw-content family (paths starting `/x/`) gets the frame denial, a small card without the Waypoint mark ("This file can't be shown right now"), and everything else gets the denial page (its title, heading and three next steps). Each denial body is byte-identical for every reason in its family, including blocked IPs and errors, with the same headers. `tests/reader-security.test.ts` checks this across 25 denial cases, GET and HEAD, and `tests/reader-browser.ts` (`pnpm test:browser:reader`, which runs the reader from source; CI runs it) checks the shell in Chromium: CSP, the message listener, token exposure, sandbox escapes and COOP. The root page carries no token or collection data, so it is safe for shared caches, and uptime checks can probe it.

## Safeguards (enforced by structure, not convention)

The reasoning behind these safeguards is in [trust-model.md](trust-model.md).

| Safeguard | How |
|---|---|
| No writes to metadata | The reader's Turso token is created with `--read-only` |
| No write code paths | The reader app contains no write routes; the core's write handlers aren't imported into the Worker build |
| No writes to blobs | The reader reads R2 over the S3 API with an **Object Read only** token scoped to one bucket (decision D38). It has no R2 binding, so it holds no credential that can write. |
| Logs never touch the main DB | Access events go to Analytics Engine |
| Not indexable | `X-Robots-Tag: noindex, nofollow` on every response; `robots.txt` disallows everything |
| No token leakage to document scripts | Raw iframes use a derived per-revision capability; `Referrer-Policy: no-referrer` is on every response |
| No enumeration | 404 for everything not explicitly allowed; rate limiting before metadata lookup |
| No stale shared caches | `Cache-Control: private` on all tokenized responses; `no-store` on denials |
| Environment isolation | The prod reader is bound only to the prod bucket and the prod DB |
| Untrusted content is sandboxed | Raw responses carry `Content-Security-Policy: sandbox …` without `allow-same-origin`, and the shell's iframe is sandboxed, so shared documents run in an opaque origin |
| Shell runs only its own code | Hash-only CSP for the one inline style and script; frame messages are validated against the frame's window and the shell's own links |

## Later

- **Password-protected links:** a password page with Turnstile, then a short-lived session token in the path.
- **Audience grants:** one grant per person, scoped to an audience of collections.
- **Comments from share viewers.** This would be the first non-read operation on the public side. It needs its own design and will never include uploads.

A raw capability is the first 22 base64url characters of HMAC-SHA256 with the 32-byte `RAW_CAP_KEY` over `share_link_id + "\n" + revision_public_id`. It remains valid only while the link is active and the revision is allowed. A following link permits only the current latest revision. The reader caches live lookups by token hash or share-link ID for 5 seconds. Undeleting a collection reactivates links that were active before deletion; purge revokes them immediately. `/healthz/deep` probes Turso and R2 and returns only `ok` or `fail`; it counts toward the per-IP limiter. `/healthz` touches nothing and isn't limited. Both keep those exact bodies (deploy smoke checks compare them) and report the build in headers: `X-Waypoint-Version` always, `X-Waypoint-Sha` when the `WAYPOINT_BUILD_SHA` Worker variable holds a commit. Blobs are fetched path-style from `WAYPOINT_S3_ENDPOINT` when it's set, else from R2's `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`; see [configuration.md](configuration.md#public-reader-cloudflare-worker).
