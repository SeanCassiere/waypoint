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

The Turso engine (`@tursodatabase/database` 0.8.2, and still 0.8.3) leaks native memory for every statement it prepares: about 12.5 KB when the statement is never closed and about 2.5 KB even when it's closed (0.8.3: about 8 KB and 2.5 KB). Preparing a statement per query, as the writer did until October 2026, grew RSS by 1.9 GB per 150,000 reads.

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

The writer runs on **Node 26 LTS**. The reader runs on **Cloudflare Workers**. Bun is not used, because Turso Sync's native module isn't documented for Bun. Code is shared through a runtime-agnostic core:

```
packages/
  core/            runtime-agnostic: types, ID + public-ID derivation, path rules,
                   manifest merge, URL routing, Hono route handlers written against
                   Storage / Repo interfaces. Web APIs only (fetch, Web Crypto, Web Streams).
  render/          markdown, text and CSV → HTML renderers (run on the writer only)
  ui/              runtime-agnostic UI shared by the writer viewer and the reader:
                   design tokens (shared, writer-only, and the frozen reading set),
                   the chrome's font (a Recursive subset, D76) and the component
                   system (D78), the SVG icon set, HTML escaping, the public shell,
                   and the frame location listener.
                   Web APIs only, like core.
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
- **Writer**: tsdown bundles `src/main.ts` into `dist/main.js`, plus two worker-thread entries in the same directory, `dist/compare-worker.js` (diffs and Changes-page fragments) and `dist/render-worker.js` (renditions). The `@waypoint/*` packages are inlined from their `dist`; npm dependencies stay external and are installed next to the bundle, so the writer declares every npm package an inlined package uses, at the same version (its tsdown config checks this). Runtime file lookups go through `src/layout.ts`, which resolves the bundle directory whether the writer runs bundled or from source. esbuild bundles the viewer's browser scripts and stylesheet into `dist/viewer/` (a turbo task of its own, `build:viewer`). The stylesheet is the shared and writer tokens (the shared ones start with the font faces), then the component system (`controlsCss` and `writerComponentsCss`), then the image stage and the file panel and tree (`stageCss`, `panelCss` and `treeCss` from `packages/ui`), followed by the partials in `src/viewer/css/`, concatenated in the order `src/viewer/css.ts` lists them; the partials' transitions live only in `95-motion.css` (the panel's are in `panelCss`, under the same reduced-motion condition).
- **MCP**: tsdown builds the server bundle (`dist/waypoint-mcp-server.mjs`, one minified file). The launcher stays on esbuild and changes as little as possible, because npx caches it indefinitely (D53; its only change since is the `WAYPOINT_MCP_ALLOW_HTTP` opt-out, D54).
- **Reader**: Wrangler bundles it, reading `core` and `ui` from their `dist`.
- **The chrome's font** (D76): `scripts/subset-recursive.sh` (fontTools, outside the repo's toolchain) subsets the pinned upstream file to `packages/ui/fonts/recursive-ui.woff2` and writes `packages/ui/src/font-data.ts`, the same bytes as base64 with their SHA-256. Both apps bundle that module through `@waypoint/ui` and serve the bytes from `CHROME_FONT_PATH`; no build step reads the `.woff2`, and a test checks that the two agree.
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
| `/raw/r/<revision public id>/<path>` | Raw content of a file. Markdown, text and CSV files return their HTML rendition (HTML files never do); add `?source` for the original. CSV and TSV files without a rendition are served as `text/plain; charset=utf-8`, so a frame shows their text instead of a blocked download. `?download` returns the original file as an attachment. |
| `/assets/<renderer version>/<file>` | Reserved for static, non-secret JS and CSS that renditions may reference. No renderer version uses it yet. |
| `/s/<token>/c/…`, `/x/<link id>.<cap>/r/…` | (Reader) the share shell behind a share token, and raw content behind a derived per-revision capability. See [public-reader.md](public-reader.md#urls). |

- **The viewer** is a shell: a bar that spells out collection › revision › file (the revision and file pills open History and Files), a side panel, and an iframe showing the raw content.
- **The Files tree** lists, in each folder, the head file first, then the folders, then the other files, each in case-insensitive, number-aware order (`ch2` before `ch10`). Folders start collapsed except the ones holding the current file (on a gallery page, the gallery's folder). Expand all / Collapse all opens or closes every folder. The folders the reader opens or closes (by their rows or the button) are remembered per collection for the browser tab (`sessionStorage`) and reopen on later pages; folders opened only to show a file, or by a filter query, are not. Without script the folders still open and close; only the button is missing. Above 200 files a filter opens every folder while it has a query and puts them back when it's cleared ([D72](decisions.md)).
- **The side panel** docks at 1100 px and wider, and the bar's panel button or `.` collapses and docks it (the choice is kept in `localStorage`); narrower, it's an overlay sheet. While it's collapsed, a mouse resting on the window's left edge or on the panel button peeks it out as a floating card over the document, which stays while the pointer is in it or something in it is in use and closes 250 ms after the pointer leaves, or at once on Esc or a followed link; the button or `.` docks it in place ([D73](decisions.md)).
- **Raw URLs are always pinned to a revision.** Relative links inside a document therefore resolve within the same revision even when the viewer is showing "latest".
- **The shell's URL follows the document.** The shell watches the iframe's navigation, which is possible because both are same-origin, and updates its own URL. Copying the address bar always gives a URL for what you're looking at.
- **Shared URLs follow the same rule.** A URL copied while viewing "latest" follows latest. A URL copied while viewing a pinned revision stays pinned.
- **Failed and pending revisions** are viewable on the writer that holds them. History labels them.

## Renditions

- **Created at ingest.** The writer renders markdown, text and CSV files into renditions when content is ingested. It never renders on request. After a renderer version bump, `waypoint-writer rerender` gives existing files a rendition at that renderer's new version (see [Re-rendering](#re-rendering-after-a-version-bump)); with `WAYPOINT_RERENDER=auto` the running writer does it itself, in the background ([Background re-rendering](#background-re-rendering)).
- **Self-contained.** CSS is inlined, and syntax highlighting is done at render time, also inlined. As a result a rendition displays correctly with no internet access on the tailnet, and the reader only has to stream it.
- **Assets.** If a renderer version needs JS (for example Mermaid, later), it may reference only `/assets/<renderer version>/…`, which both the writer and the reader would then serve as static files, with no token. No version needs this yet: renditions are self-contained, and the reader returns 404 there.
- **No CDNs.** Renditions never reference external CDNs.
- **Deterministic and bounded.** Output depends only on the input bytes and the renderer version, never on time, load, or host settings, because renditions are content-addressed:
  - Highlighting has no time limit, but lines over 5,000 characters and fences over 100 KB are shown as plain text.
  - Sources over 1 MB, deeply nested input, and render errors fall back to the same page template showing the escaped source as plain text, with a one-line notice.
  - Rendering runs in a worker thread with a fixed stack size, so it never blocks the writer's event loop.
  - Text and CSV: over 2 MB or 50,000 lines there is no rendition (the raw file is served); highlighting only up to 256 KB and 5,000 lines; a CSV table shows its first 500 rows, with cells cut at 64 K characters. The output is bounded too (16 M UTF-16 code units): formatted JSON over it is shown as authored, a CSV table over it gets the text view, and a text view over it is no rendition. At ingest and in `rerender`, a rendition larger than the blob limit is no rendition rather than a failed write.
- **Version policy.** Any change to renderer dependencies, CSS, language set, template, or options bumps `RENDERER_VERSION`. A golden-output hash test enforces this.
- **Front matter.** YAML front matter is shown in a collapsed "Front matter" block at the top.
- **Which version is served.** Renditions are keyed by `(source hash, renderer, renderer version)`, and several versions of the same source can coexist. They are served per `(source hash, renderer)`; the renderer comes from the file's MIME type (`rendererFor` in `@waypoint/core`). The writer serves the highest version among its committed and queued renditions; the reader serves the highest committed one (`ORDER BY renderer_version DESC LIMIT 1`). A new version therefore takes over as soon as its row exists, with no change to revisions or shells.
- **Agent-written HTML** is served exactly as the agent wrote it. Whatever external resources it references are its own business.
- **Changes-page fragments** (`renderFragment` in `@waypoint/render`, run in `compare-worker.ts`) aren't renditions: they're rendered per request, never stored, so they don't bump `RENDERER_VERSION`; a separate fragment golden test pins their output, including GFM callouts and relative links resolved to the head revision's writer path.

### The reading template (renderer version 5, Folio's template on Logbook's palette)

The template follows the Folio design spec (section 8). The CSS is inlined in every rendition.
- **Typography:** the system sans stack at 17px/1.65 (16.5px under 600px) with a 68ch measure, light and dark via `prefers-color-scheme`. No webfonts. Colours come from the frozen `readingTokensCss` in `@waypoint/ui`, a copy of Logbook's chrome palette (D88): the page is the shell's paper (what the frame sits on in the writer and the reader, so there is no band at its edge), cool ink, rules and code wells, links in the public blue, the chrome's neutral mark (selection, `<mark>`, a text view's `:target` line), callouts in the chrome's state colours, and the chrome's 2 px ink focus ring (`--focus`). Every text colour passes 4.5:1 on each ground it sits on, light and dark (`packages/ui/tests/tokens-contrast.test.ts`). Chrome token edits can't change renditions; the reading palette changes only with a `RENDERER_VERSION` bump.
- **Headings** keep their deterministic slug `id`s and get a hover anchor: `<a class="anchor" href="#id" aria-hidden="true" tabindex="-1">#</a>` as the first child. The rendition `<title>` and the contents block use the heading text without it.
- **Contents:** when a document has 4 or more `h2`s (excluding the footnotes label), a `<details class="toc" open>` "Contents" list of them goes after the first `h1` (or after the front matter when there is no `h1`). The frame script collapses it when the frame is up to 600px wide, checked after layout (an iframe starts at its default 300px before the shell sizes it) and again whenever the width crosses 600px, until the reader toggles it; without JS it stays open.
- **GitHub alerts:** a Markdown blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (any case), with content after it, becomes `<div class="markdown-alert markdown-alert-<kind>">` with a `p.markdown-alert-title`. Blockquotes written as raw HTML are left alone.
- **Tables** are wrapped in `<div class="table-wrap" tabindex="0" role="region" aria-label="Table">`, which scrolls horizontally with CSS-only scroll shadows. On screens 900px and wider it is centred and grows as wide as its table needs: at least the text measure, at most `min(100vw − 64px, 1120px)`. Only the outermost table of a nested set is wrapped.
- **Direction:** headings, paragraphs, list items, table cells, blockquotes, `dt`/`dd`, figure captions and contents entries carry `dir="auto"`, so right-to-left documents read right to left (an explicit `dir` in raw HTML wins).
- **Code blocks** keep Shiki's dual-theme highlighting (github-light and github-dark), with the token colours that fell under 4.5:1 on the wells or the mark shifted in their own hue (`SYNTAX_COLOURS`, checked by `packages/render/tests/syntax-contrast.test.ts`); fenced blocks with a simple language label get `data-lang`, shown as a small label.
- **Images** alone in a paragraph (optionally inside a link) become `<figure class="image">`, centred with a hairline border. Inline images stay inline.
- **Frame reporter.** One inline script (about 490 bytes with the contents-block check, identical in every rendition) tells the embedding shell which document is showing. The public reader needs it because its sandboxed iframe has an opaque origin the shell cannot read. On load and on `hashchange` it calls `parent.postMessage({ type: "waypoint:location", href: location.pathname + location.hash }, "*")`, and does nothing when the rendition is the top-level page. The payload is only the path and fragment: no origin, query string, referrer, cookies, or document content. The path is the frame's own URL, which the shell set and already knows; on the reader it carries the revision capability, never the share token, and the target is `"*"` only because the rendition cannot know its parent's origin. Shells must check `event.source === frame.contentWindow` and ignore anything else. On the writer it is redundant with the same-origin URL sync, and harmless.
- **Print:** no measure limit, no anchors or contents block, and tables and code avoid page breaks.

Fallback documents (oversized, too deeply nested, or failed renders) use the same template and script.

### Text and CSV renditions (text v2, csv v2)

Text, code, logs and JSON (`text`) and CSV/TSV (`csv`) files get a rendition on the same reading template, palette and frame reporter. HTML, XHTML and SVG never do. Each renderer has its own version constant (`TEXT_RENDERER_VERSION`, `CSV_RENDERER_VERSION`) and golden hash, so they change independently of markdown.
- **Header:** the file name in mono, a kind chip (`Shell script`, `JSON`, `Plain text`, `Table`, …) and a meta line (`41 lines · 1.3 KB`). A rendition is shared by every file with the same bytes, so it can't contain the name: its one inline `<script>` fills the name in from the frame's own URL (`textContent`, bidi controls shown as U+FFFD), then runs the frame reporter.
- **Lines:** a non-selectable gutter of line numbers, each line an `id="L<n>"` anchor (`#L23` is shareable and highlighted with `--mark`). Long lines wrap inside the code column, so continuation rows stay under the code. Copying lines yields just the source.
- **Highlighting:** Shiki with the markdown renderer's themes, syntax colours and language set, chosen by MIME type; plain text and logs stay uncoloured.
- **JSON:** a JSON file that is one line over 200 characters and parses is shown re-indented by 2 spaces, lexically (numbers, escapes and duplicate keys stay exactly as written), with a note that Download gives the file exactly as shared.
- **Escaping:** every character is escaped; bidi and invisible control characters show as visible `⟪U+XXXX⟫` markers; no link or markup comes from content.
- **CSV:** a table of the first 500 rows with a sticky header row, row numbers, right-aligned numeric columns and tabular figures, and a footer counting the rows not shown. A file that doesn't parse (an unterminated quote) or is empty gets the text view instead.

### Re-rendering after a version bump

`waypoint-writer rerender (--all | --collection <id>) [--dry-run] [--limit <n>] [--renderer markdown|text|csv]` renders current-version renditions for the files of one renderer (default `markdown`) whose renditions are stale. One renderer per run; `deploy/upgrade.sh rerender` runs all three, unless the writer re-renders by itself (`WAYPOINT_RERENDER=auto`), which it then only watches. It also accepts `--version <n>` and refuses a version other than the one it was built with. Operating it: [deploy/README.md](../deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade).
- **Scope:** the files whose MIME type picks the run's renderer (`rendererFor`) in committed revisions and of pending (not failed) revisions, in all collections or one (by ID or public ID), including trashed collections, excluding collections being purged. Each distinct source blob is rendered once, as the lexicographically smallest of its in-scope MIME types.
- **Stale means below current.** A source is stale when its newest rendition for the renderer, committed or queued, is below the renderer's current version, or it has none. A source whose newest rendition is at or above the current version is not stale: after a rollback to an older writer, `rerender` leaves alone what the newer release rendered, since readers serve the newest version anyway. (Releases up to 0.8.0 re-rendered any source without a rendition at exactly the current version.)
- **Shared selection.** The selection is `apps/writer/src/stale.ts` and rendering one source is `apps/writer/src/render-source.ts`, kept separate from the command so other callers can reuse them. The selection reads in short keyset pages with fixed statements (no new index) and ranks each stale source: tier 1 if it is in a revision pinned by an open share link, or in the revision an open Latest link serves (its collection's newest committed revision: a newer queued one is tier 2 until it commits, since the reader can't serve it yet), tier 2 if it is in a collection's latest revision, tier 3 otherwise; within a tier, collections that aren't settled (latest revision older than a set period and no open link) first, then newest revision first. A source in several revisions takes its best position. `rerender` ignores the ranking and processes sources in source-hash order; the background rerender follows it.
- **Queue path.** Outputs go into the local blob store with `pending_blobs` and `pending_renditions` rows, exactly as at ingest. The committer then commits each queued rendition whose source blob is committed: it uploads the output, inserts its `blobs` and `renditions` rows (blob before row), clears the queue rows, and pushes. A rendition whose source is still only in a pending revision commits with that revision. See [write-path-and-sync.md](write-path-and-sync.md#other-queued-work).
- **Missing sources.** A writer bootstrapped from the cloud fetches blobs lazily, so `rerender` downloads a source that is missing locally from the bucket, like the viewer does.
- **Idempotent and resumable.** Sources that aren't stale are skipped. `--limit` caps the renditions queued per run (missing and failed sources don't count toward it); running again continues. The JSON summary reports `sources`, `current`, `queued`, `remaining`, and the `missing` and `failed` source hashes. Plain `missing: X` and `failed: Y` lines follow, then a last line `remaining: N`. `remaining` excludes missing and failed sources, which another run won't fix, so a loop that repeats while it is above 0 ends. `/api/status` reports the standalone backlog as `queue.rerender_pending`, which, unlike `pending_renditions`, leaves out renditions waiting on a queued (pending or failed) revision.
- **Batched commits.** The committer commits at most 50 queued renditions per pass, then commits any new revisions before the next 50, so a large backlog never delays agents' writes. Dropping or purging a queued revision keeps rerender rows, whose source is already committed.
- **Runs with the server stopped.** It takes the data-directory lock like `serve` and `restore`, so it refuses to run while the writer is up. The writer's committer uploads the queued work on its next start.
- **Not in DR manifests.** A revision's manifest is written once, at commit, so renditions added later are not in it. A restore from the bucket brings back the renditions recorded at ingest; run `rerender` again afterwards.

### Background re-rendering

With `WAYPOINT_RERENDER=auto`, the running writer re-renders stale renditions itself, in a low-priority loop inside `serve` (`apps/writer/src/backfill.ts`, [D89](decisions.md)). It is `off` by default for now; `off` still surveys and counts, so `/api/status` can say how many renditions are stale.
- **Scope and order.** Every renderer at once, in collections outside Trash (and not being purged), in the shared selection's priority order: tier 1 first, then tier 2, then tier 3; settled collections (`WAYPOINT_RERENDER_SETTLED_DAYS`) after the others in their tier; newest revision first. A source keeps its best position per collection, and takes the best of those whose collection is still live. A collection restored from Trash has its stale sources moved to the front.
- **When it surveys.** All collections at start, every 24 hours, and 10 minutes after a pull that changed `waypoint.db` (one survey for a burst of pulls); one collection after each commit of one of its revisions and after an undelete, which replaces that collection's positions (a commit can move a Latest link to a newer revision) and moves the sources whose best position changed. Trash and purges need no hook: each source is checked again just before it's rendered. Each full survey logs its counts and how long it took.
- **When it renders.** Not before `WAYPOINT_RERENDER_DELAY_MINUTES` after start (default 45; `POST /api/rerender/start` ends the wait early). Then one source at a time, and before each: no ingest or blob upload in flight or in the last 5 seconds; with sync on, fewer than 50 standalone renditions queued (one committer pass), so the committer always keeps up and new revisions never wait behind a backlog; and no pause: the bucket account paused, standalone rendition commits failing (their retry delay), sync blocked, or its own bucket fetch failing (it retries the same source after a minute, five for an account error). With sync off there is no committer and every source is in a pending revision, so there is no backlog limit and the rendition rows wait for their revisions like ingest's.
- **One source.** Check that it's still stale and still in a live collection (any committed or pending revision that has it counts); fetch it from the bucket if it isn't local (outside any lock, as the viewer does); read it inside the GC barrier, holding its hash; render it outside the barrier, on the loop's own render worker (`createRenderers({ slots: 1 })`, started on first use and closed when the work runs out, so a crash or a stuck render never touches ingest's two workers; a crash there is no rendition, retried later, never the "could not be rendered" fallback that would replace a good older rendition) with a 30-second limit; then, inside the barrier again, store the output (held until its rows are queued) and queue `pending_blobs` and `pending_renditions` in one queue transaction that first checks the source still has a `blobs` row or is still in the pending revision of a live collection it was found in, then wake the committer. Finding that revision pages through the pending revisions outside any transaction; inside it, only that one revision and its collection are checked, so ingest never waits for a scan of every pending manifest (with sync off, that's everything stored). When that revision has gone, nothing is queued, and the source is looked for again (three tries) or dropped. A purge or Drop of a queued collection prunes queued rows in a queue transaction too, and queue transactions run one at a time on its connection, so neither can leave rows for a source it removed; an output stored just before such a removal stays on disk unreferenced, like an upload nothing used. The barrier is never held across a render: a purge's blob GC waiting for it would make every new ingest wait too. If a purge collects the source during its render, the output is dropped.
- **Skips.** A source it can't render is recorded in `queue.db`'s `rerender_skips` at the current version: `too_large` (over the text or CSV size limit, known from the file's recorded size without fetching it, or from its bytes) and `output_too_large` stay skipped until the next version; `declined`, `timeout` and `missing` (no `blobs` row, no bucket, or a permanent bucket error) are tried again after 1 hour, then 4, 16 and so on, at most 7 days apart. Rows for older versions are deleted at start.
- **Stopping.** Shutdown stops it with the committer: a survey in progress stops at its next page, and a render in flight is abandoned (its worker closed, nothing queued) and the next start renders that source again.
- **Status.** `/api/status` has a `rerender` block ([api-and-mcp.md](api-and-mcp.md#response-shapes)): the mode, a state (`off`, `waiting`, `running`, `paused`, `done`), the stale, skipped and left counts in total and per renderer, how many it has rendered since start, the rate and an estimate of the time left.
