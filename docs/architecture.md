# Architecture

## Components

```
 agents on your machines (a Linux box, a laptop, CI, …)
        │  MCP (local stdio server: reads files from local disk)  ─or─  HTTP (curl)
        ▼
 ┌──────────── private network: tailnet (trusted) ───────────┐
 │  Writer  (Node, Hono)                                      │
 │   • HTTP API + viewer UI                                   │
 │   • blobs/       local content-addressed blob store        │
 │   • queue.db     pending writes   (local only, never synced)│
 │   • waypoint.db  Turso Sync local replica                  │
 │   • committer    queue → R2 → waypoint.db (retries)        │
 └───────────┬──────────────────────────────┬─────────────────┘
             │ conditional PUT (S3 API)      │ push / pull (Turso Sync)
             ▼                               ▼
   ┌───────────────────┐           ┌───────────────────┐
   │ R2 bucket (private)│           │ Turso cloud DB    │
   │ blobs, manifests   │           │ all metadata rows │
   └─────────▲─────────┘           └─────────▲─────────┘
             │ read-only S3 API                │ read-only token (HTTP)
   ┌─────────┴──────────────────────────────┴─────────┐
   │  Reader  (Cloudflare Worker, Hono)                │
   │  your public domain — share links only            │
   └───────────────────────────▲───────────────────────┘
                               │ public internet
```

### Writer
- A long-running Node process in Docker on one host of your private network.
- Reachable only on that network: behind its own Tailscale sidecar node at `https://<hostname>.<tailnet>.ts.net` with no host port, or on the host's loopback (`127.0.0.1:7410`) without Tailscale. The host's own Tailscale setup, if any, is untouched (D37; [self-hosting.md](self-hosting.md)).
- Serves three things:
  - the **HTTP API** for writes and reads
  - the **viewer** (the "Folio" design): Recent (collection list and search), the collection view (file sidebar, document frame, History and Links panels, revision stepping), per-revision Changes and image Gallery views, and the Links, Trash, Status and MCP setup pages. See the viewer routes in [api-and-mcp.md](api-and-mcp.md).
  - **raw content**: files and renditions
- Runs a single **committer** worker, which moves queued writes into durable cloud state.
- Owns its data directory exclusively. Turso requires one process per database file. The MCP server never opens the DB; it calls the HTTP API instead. See [Data-directory lock](#data-directory-lock).
- Reuses prepared statements. See [Prepared statements and native memory](#prepared-statements-and-native-memory).
- Compresses text responses (viewer HTML, CSS, JS, JSON, text files and renditions over 1 KB) with Brotli, or gzip for clients without it. Images and other binaries, range responses and the MCP downloads under `/mcp/` are sent as they are. A compressed response's ETag is weak (`W/"…"`), which revalidation accepts, and every candidate carries `Vary: Accept-Encoding`. Compressed bodies of immutable responses are cached (about 16 MB).
- Multiple writers are possible. Each has its own data directory, and they converge through the cloud DB.

#### Data-directory lock

`serve`, `restore` and `rerender` each take the data-directory lock before opening a database, so only one of them runs at a time, even from different containers that bind-mount the same directory.

- The lock is an OS-level POSIX record lock on `writer-lock.db`, held by Turso for as long as the process keeps that file open. The kernel drops it when the process exits, however it exits, so a crashed writer never leaves a stale lock to clean up, and nothing ever deletes the lock file.
- Process IDs aren't used for liveness. Containers have their own PID namespaces, so a PID check from another container can't see the owner. (Before this change, a second container could delete a live writer's `writer.lock`; only Turso's own lock on `waypoint.db` stopped it.)
- After taking the lock, the owner writes `writer-lock.json` with its PID, hostname (the container ID in Docker), command and start time. A process that fails to get the lock reports that owner in its error. Only the owner removes the file, while it still holds the lock.
- A leftover `writer.lock` from older versions is ignored.

#### Prepared statements and native memory

The Turso engine (`@tursodatabase/database` 0.8.2) leaks native memory for every statement it prepares: about 12.5 KB when the statement is never closed and about 2.5 KB even when it's closed. Preparing a statement per query, as the writer did until October 2026, grew RSS by 1.9 GB per 150,000 reads.

The `Db` wrapper therefore keeps a bounded LRU cache of prepared statements keyed by SQL text (256 per connection) and reuses them. Measured on a Linux x64 host with 200,000 reads of one statement: RSS grows about 0.16 KB per query (32 MB in total, flattening as the run goes on), and each query takes about 4 µs instead of about 30 µs. Each distinct SQL string still costs one prepare, so evictions (SQL with variable `IN (…)` lists) leak about 2.5 KB each.

Running a statement prepared before a schema change aborts the process inside the engine. The cache is cleared after any statement or `exec` containing `CREATE`, `ALTER` or `DROP`, and after every pull that changed the database. A pull runs outside the connection chain, so a statement queued between the end of the pull and the reset could still run against a schema the pull changed. Only this writer's own migrations change the cloud schema, and they run at startup before anything is served, so that window isn't reachable in practice. The deploy runbook covers [memory checks](../deploy/README.md#memory).

### MCP server
- A small local **stdio** process on each machine where agents run, started with `npx` and configured with `WAYPOINT_URL`.
- Runs locally because agents' files are on *their* machine's disk. The MCP server reads files by path, hashes them, uploads only the blobs the writer doesn't have, and then submits the revision. Passing large files or images as base64 in tool arguments is avoided entirely.
- Agents without the MCP server can use the HTTP API's multipart endpoint with `curl`.

### Reader
- A Cloudflare Worker on the instance's own domain, one per environment (for example `share.example.com` for prod and a dev twin on `share-dev.example.com`). `upgrade.sh` deploys each one after the writer ([deploy/README.md](../deploy/README.md#public-reader-workers)).
- Reads metadata from Turso through `@tursodatabase/serverless` with a **read-only** token, and reads blobs through R2's S3 API with bucket-scoped **Object Read only** credentials (D38).
- Serves only what a share link permits. See [public-reader.md](public-reader.md).

### Cloud storage
- **Turso cloud DB**: rows for collections, revisions, files, blobs, renditions, and share links. Created as a Turso Sync (`--tursodb`) database. There is one per environment.
- **R2 bucket**: blob contents, renditions, and JSON manifests for disaster recovery. Private, Standard storage class only. There is one per environment, marked with `meta/environment.json`. Any S3-compatible store works through `WAYPOINT_S3_ENDPOINT` ([configuration.md](configuration.md)).

With `WAYPOINT_SYNC=off` (local-only mode) a writer uses neither: everything stays in its data directory, with no cloud durability and no public sharing.

## Runtimes and code layout

The writer runs on **Node 24 LTS**. The reader runs on **Cloudflare Workers**. Bun is not used, because Turso Sync's native module isn't documented for Bun. Code is shared through a runtime-agnostic core:

```
packages/
  core/            runtime-agnostic: types, ID + public-ID derivation, path rules,
                   manifest merge, URL routing, Hono route handlers written against
                   Storage / Repo interfaces. Web APIs only (fetch, Web Crypto, Web Streams).
  render/          markdown → HTML renderer (runs on the writer only)
  ui/              runtime-agnostic UI shared by the writer viewer and the reader:
                   design tokens, HTML escaping, the public shell, and the frame
                   location listener. Web APIs only, like core.
  mcp/             stdio MCP server, and the launcher tarball the writer serves for `npx`
apps/
  writer/          Node adapter: Turso Sync, @aws-sdk/client-s3, local blob store,
                   queue.db, committer, viewer UI
  reader/          Workers adapter: read-only R2 S3 API, @tursodatabase/serverless,
                   Cache API, Analytics Engine
tests/             @waypoint/integration-tests: cross-package tests, checks of built
                   artifacts, and the real-Chromium browser checks
```

- `core` and `ui` must never import `node:*`, `@aws-sdk/*`, `@tursodatabase/sync`, or any native module.
- The reader's build fails if anything Node-only leaks in. A separate tsconfig and the package `exports` conditions enforce this.
- Tooling: a pnpm workspace with TypeScript, Hono on both runtimes, the MCP TypeScript SDK, `typeid-js`, and `@aws-sdk/client-s3` for R2.

### Builds

TypeScript only type-checks; bundlers emit everything ([D53](decisions.md)).

- **Libraries** (`core`, `ui`, `render`): tsdown emits ESM to `dist/`, one module per source file, with `.d.ts` that oxc generates from `isolatedDeclarations` source. `render` has a second entry, `dist/render-worker.js`, the worker thread it starts next to itself.
- **Writer**: tsdown bundles `src/main.ts` into `dist/main.js`, plus two worker-thread entries in the same directory, `dist/compare-worker.js` (diffs and Changes-page fragments) and `dist/render-worker.js` (renditions). The `@waypoint/*` packages are inlined from their `dist`; npm dependencies stay external and are installed next to the bundle, so the writer declares every npm package an inlined package uses, at the same version (its tsdown config checks this). Runtime file lookups go through `src/layout.ts`, which resolves the bundle directory whether the writer runs bundled or from source. esbuild bundles the viewer's browser scripts and stylesheet into `dist/viewer/` (a turbo task of its own, `build:viewer`).
- **MCP**: tsdown builds the server bundle (`dist/waypoint-mcp-server.mjs`, one minified file). The launcher stays on esbuild and changes as little as possible, because npx caches it indefinitely (D53; its only change since is the `WAYPOINT_MCP_ALLOW_HTTP` opt-out, D54).
- **Reader**: Wrangler bundles it, reading `core` and `ui` from their `dist`.
- **Source condition.** Each library's `exports` starts with a `@waypoint/source` condition pointing at `src/`. Type checking (`customConditions`), lint and tests (Vitest's resolve conditions) use it, so none of them needs a build; runtime code and bundles use `dist`. Relative imports name the real `.ts` file and the libraries use only erasable syntax, so Node 24 runs the source directly: in tests, the render and diff worker threads start from `src/` with `--conditions=@waypoint/source`.
- **Tests** live in their package (`packages/*/tests`, `apps/*/tests`). CPU-budget and wall-clock tests are a separate Vitest project and turbo task (`test:timing`) that runs alone after the others. Cross-package tests and checks of built artifacts (the MCP tarball and launcher, the writer process, the bundled renderer, the packages the reader bundle inlines, the browser checks) are in `tests/`, whose turbo tasks build the writer and MCP first (and, for `test`, the reader).
- **Image**: the Dockerfile prunes the workspace to the writer and the MCP package (`turbo prune --docker`), builds them with turbo's caches off, and keeps the writer bundle with its production npm dependencies (`pnpm deploy`).

## Data flow summary

**Write.** An agent calls an MCP tool, and the MCP server calls the writer API, which ingests the write:
1. Blobs go into the local store.
2. Renditions are generated.
3. A pending revision is added to `queue.db`.

The agent gets a URL back at once, and the content is viewable on the tailnet. The committer then:
1. Uploads the blobs and the manifest to R2.
2. Inserts the rows into `waypoint.db`.
3. Calls `push()` to send them to the cloud DB.

Details are in [write-path-and-sync.md](write-path-and-sync.md).

**Read on the tailnet.** The writer resolves the URL against `waypoint.db`, then `queue.db`. It streams the blob from the local store, falling back to R2 and caching locally on a miss.

**Read in public.** The reader validates the share token against the cloud DB, resolves the path to a blob or rendition, and streams it from R2 with immutable caching.

## URLs

| URL | Meaning |
|---|---|
| `/c/<collection public id>/` | Viewer for the latest revision's head document |
| `/c/<collection public id>/<path>` | Viewer for a file in the latest revision |
| `/c/<collection public id>/r/<revision public id>/<path>` | Viewer for a file in a pinned revision |
| `/raw/r/<revision public id>/<path>` | Raw content of a file. Markdown returns its HTML rendition; add `?source` for the original. |
| `/assets/<renderer version>/<file>` | Reserved for static, non-secret JS and CSS that renditions may reference. No renderer version uses it yet. |
| `/s/<token>/c/…`, `/x/<link id>.<cap>/r/…` | (Reader) the share shell behind a share token, and raw content behind a derived per-revision capability. See [public-reader.md](public-reader.md#urls). |

- **The viewer** is a shell: file sidebar, revision picker, and an iframe showing the raw content.
- **Raw URLs are always pinned to a revision.** Relative links inside a document therefore resolve within the same revision even when the viewer is showing "latest".
- **The shell's URL follows the document.** The shell watches the iframe's navigation, which is possible because both are same-origin, and updates its own URL. Copying the address bar always gives a URL for what you're looking at.
- **Shared URLs follow the same rule.** A URL copied while viewing "latest" follows latest. A URL copied while viewing a pinned revision stays pinned.
- **Failed and pending revisions** are viewable on the writer that holds them. The revision picker labels them.

## Renditions

- **Created at ingest.** The writer renders markdown into renditions when content is ingested. It never renders on request. After a renderer version bump, `waypoint-writer rerender` gives existing markdown a rendition at the new version (see [Re-rendering](#re-rendering-after-a-version-bump)).
- **Self-contained.** CSS is inlined, and syntax highlighting is done at render time, also inlined. As a result a rendition displays correctly with no internet access on the tailnet, and the reader only has to stream it.
- **Assets.** If a renderer version needs JS (for example Mermaid, later), it may reference only `/assets/<renderer version>/…`, which both the writer and the reader would then serve as static files, with no token. No version needs this yet: renditions are self-contained, and the reader returns 404 there.
- **No CDNs.** Renditions never reference external CDNs.
- **Deterministic and bounded.** Output depends only on the input bytes and the renderer version, never on time, load, or host settings, because renditions are content-addressed:
  - Highlighting has no time limit, but lines over 5,000 characters and fences over 100 KB are shown as plain text.
  - Sources over 1 MB, deeply nested input, and render errors fall back to the same page template showing the escaped source as plain text, with a one-line notice.
  - Rendering runs in a worker thread with a fixed stack size, so it never blocks the writer's event loop.
- **Version policy.** Any change to renderer dependencies, CSS, language set, template, or options bumps `RENDERER_VERSION`. A golden-output hash test enforces this.
- **Front matter.** YAML front matter is shown in a collapsed "Front matter" block at the top.
- **Which version is served.** Renditions are keyed by `(source hash, renderer, renderer version)`, and several versions of the same source can coexist. The writer serves the highest version among its committed and queued renditions; the reader serves the highest committed one (`ORDER BY renderer_version DESC LIMIT 1`). A new version therefore takes over as soon as its row exists, with no change to revisions or shells.
- **Agent-written HTML** is served exactly as the agent wrote it. Whatever external resources it references are its own business.

### The reading template (renderer version 2, "Folio")

The template follows the Folio design spec (section 8). The CSS is inlined in every rendition.
- **Typography:** the system sans stack at 17px/1.65 (16.5px under 600px) with a 68ch measure, warm paper and ink colours matching the viewer, light and dark via `prefers-color-scheme`. No webfonts.
- **Headings** keep their deterministic slug `id`s and get a hover anchor: `<a class="anchor" href="#id" aria-hidden="true" tabindex="-1">#</a>` as the first child. The rendition `<title>` and the contents block use the heading text without it.
- **Contents:** when a document has 4 or more `h2`s (excluding the footnotes label), a `<details class="toc" open>` "Contents" list of them goes after the first `h1` (or after the front matter when there is no `h1`). The frame script collapses it when the frame is up to 600px wide, checked after layout (an iframe starts at its default 300px before the shell sizes it) and again whenever the width crosses 600px, until the reader toggles it; without JS it stays open.
- **GitHub alerts:** a Markdown blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (any case), with content after it, becomes `<div class="markdown-alert markdown-alert-<kind>">` with a `p.markdown-alert-title`. Blockquotes written as raw HTML are left alone.
- **Tables** are wrapped in `<div class="table-wrap" tabindex="0" role="region" aria-label="Table">`, which scrolls horizontally with CSS-only scroll shadows. On screens 900px and wider it is centred and grows as wide as its table needs: at least the text measure, at most `min(100vw − 64px, 1120px)`. Only the outermost table of a nested set is wrapped.
- **Direction:** headings, paragraphs, list items, table cells, blockquotes, `dt`/`dd`, figure captions and contents entries carry `dir="auto"`, so right-to-left documents read right to left (an explicit `dir` in raw HTML wins).
- **Code blocks** keep Shiki's dual-theme highlighting; fenced blocks with a simple language label get `data-lang`, shown as a small label.
- **Images** alone in a paragraph (optionally inside a link) become `<figure class="image">`, centred with a hairline border. Inline images stay inline.
- **Frame reporter.** One inline script (about 490 bytes with the contents-block check, identical in every rendition) tells the embedding shell which document is showing. The public reader needs it because its sandboxed iframe has an opaque origin the shell cannot read. On load and on `hashchange` it calls `parent.postMessage({ type: "waypoint:location", href: location.pathname + location.hash }, "*")`, and does nothing when the rendition is the top-level page. The payload is only the path and fragment: no origin, query string, referrer, cookies, or document content. The path is the frame's own URL, which the shell set and already knows; on the reader it carries the revision capability, never the share token, and the target is `"*"` only because the rendition cannot know its parent's origin. Shells must check `event.source === frame.contentWindow` and ignore anything else. On the writer it is redundant with the same-origin URL sync, and harmless.
- **Print:** no measure limit, no anchors or contents block, and tables and code avoid page breaks.

Fallback documents (oversized, too deeply nested, or failed renders) use the same template and script.

### Re-rendering after a version bump

`waypoint-writer rerender (--all | --collection <id>) [--dry-run] [--limit <n>]` renders current-version renditions for markdown blobs that lack one. It also accepts `--renderer markdown --version <n>` and refuses a version other than the one it was built with. Operating it: [deploy/README.md](../deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade).
- **Scope:** the markdown files of committed revisions and of pending (not failed) revisions, in all collections or one (by ID or public ID), including trashed collections, excluding collections being purged. Each distinct source blob is rendered once.
- **Queue path.** Outputs go into the local blob store with `pending_blobs` and `pending_renditions` rows, exactly as at ingest. The committer then commits each queued rendition whose source blob is committed: it uploads the output, inserts its `blobs` and `renditions` rows (blob before row), clears the queue rows, and pushes. A rendition whose source is still only in a pending revision commits with that revision. See [write-path-and-sync.md](write-path-and-sync.md#other-queued-work).
- **Missing sources.** A writer bootstrapped from the cloud fetches blobs lazily, so `rerender` downloads a source that is missing locally from the bucket, like the viewer does.
- **Idempotent and resumable.** Sources that already have a current-version rendition, committed or queued, are skipped. `--limit` caps the renditions queued per run (missing and failed sources don't count toward it); running again continues. The JSON summary reports `sources`, `current`, `queued`, `remaining`, and the `missing` and `failed` source hashes. Plain `missing: X` and `failed: Y` lines follow, then a last line `remaining: N`. `remaining` excludes missing and failed sources, which another run won't fix, so a loop that repeats while it is above 0 ends. `/api/status` reports the standalone backlog as `queue.rerender_pending`, which, unlike `pending_renditions`, leaves out renditions waiting on a queued (pending or failed) revision.
- **Batched commits.** The committer commits at most 50 queued renditions per pass, then commits any new revisions before the next 50, so a large backlog never delays agents' writes. Dropping or purging a queued revision keeps rerender rows, whose source is already committed.
- **Runs with the server stopped.** It takes the data-directory lock like `serve` and `restore`, so it refuses to run while the writer is up. The writer's committer uploads the queued work on its next start.
- **Not in DR manifests.** A revision's manifest is written once, at commit, so renditions added later are not in it. A restore from the bucket brings back the renditions recorded at ingest; run `rerender` again afterwards.
