# Architecture

## Components

```
 agent on agent-1 / MacBook Air / future machines
        │  MCP (local stdio server: reads files from local disk)  ─or─  HTTP (curl)
        ▼
 ┌──────────────────── tailnet (trusted) ────────────────────┐
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
   │  Reader  (Cloudflare Worker, Hono) — phase 2      │
   │  waypoint.pingstash.com — share links only        │
   └───────────────────────────▲───────────────────────┘
                               │ public internet
```

### Writer (phase 1)
- A long-running Node process on a tailnet machine; agent-1 today.
- Runs in Docker on agent-1 behind its own Tailscale sidecar node, reachable at `https://waypoint.tail7aca06.ts.net`. The host's Tailscale setup is untouched (see [infrastructure.md](infrastructure.md)).
- Serves three things:
  - the **HTTP API** for writes and reads
  - the **viewer**: collection list, collection view with file sidebar and revision picker, and a Trash view
  - **raw content**: files and renditions
- Runs a single **committer** worker, which moves queued writes into durable cloud state.
- Owns its data directory exclusively. Turso requires one process per database file. The MCP server never opens the DB; it calls the HTTP API instead. See [Data-directory lock](#data-directory-lock).
- Reuses prepared statements. See [Prepared statements and native memory](#prepared-statements-and-native-memory).
- Multiple writers are possible. Each has its own data directory, and they converge through the cloud DB.

#### Data-directory lock

`serve`, `restore` and `rerender` each take the data-directory lock before opening a database, so only one of them runs at a time, even from different containers that bind-mount the same directory.

- The lock is an OS-level POSIX record lock on `writer-lock.db`, held by Turso for as long as the process keeps that file open. The kernel drops it when the process exits, however it exits, so a crashed writer never leaves a stale lock to clean up, and nothing ever deletes the lock file.
- Process IDs aren't used for liveness. Containers have their own PID namespaces, so a PID check from another container can't see the owner. (Before this change, a second container could delete a live writer's `writer.lock`; only Turso's own lock on `waypoint.db` stopped it.)
- After taking the lock, the owner writes `writer-lock.json` with its PID, hostname (the container ID in Docker), command and start time. A process that fails to get the lock reports that owner in its error. Only the owner removes the file, while it still holds the lock.
- A leftover `writer.lock` from older versions is ignored.

#### Prepared statements and native memory

The Turso engine (`@tursodatabase/database` 0.8.2) leaks native memory for every statement it prepares: about 12.5 KB when the statement is never closed and about 2.5 KB even when it's closed. Preparing a statement per query, as the writer did until October 2026, grew RSS by 1.9 GB per 150,000 reads.

The `Db` wrapper therefore keeps a bounded LRU cache of prepared statements keyed by SQL text (256 per connection) and reuses them. Measured on agent-1 with 200,000 reads of one statement: RSS grows about 0.16 KB per query (32 MB in total, flattening as the run goes on), and each query takes about 4 µs instead of about 30 µs. Each distinct SQL string still costs one prepare, so evictions (SQL with variable `IN (…)` lists) leak about 2.5 KB each.

Running a statement prepared before a schema change aborts the process inside the engine. The cache is cleared after any statement or `exec` containing `CREATE`, `ALTER` or `DROP`, and after every pull that changed the database. A pull runs outside the connection chain, so a statement queued between the end of the pull and the reset could still run against a schema the pull changed. Only this writer's own migrations change the cloud schema, and they run at startup before anything is served, so that window isn't reachable in practice. The deploy runbook covers [memory checks](../deploy/README.md#memory).

### MCP server (phase 1)
- A small local **stdio** process on each machine where agents run, started with `npx` and configured with `WAYPOINT_URL`.
- Runs locally because agents' files are on *their* machine's disk. The MCP server reads files by path, hashes them, uploads only the blobs the writer doesn't have, and then submits the revision. Passing large files or images as base64 in tool arguments is avoided entirely.
- Agents without the MCP server can use the HTTP API's multipart endpoint with `curl`.

### Reader (phase 2)
- A Cloudflare Worker on `waypoint.pingstash.com`.
- Reads metadata from Turso through `@tursodatabase/serverless` with a **read-only** token, and reads blobs through R2's S3 API with bucket-scoped **Object Read only** credentials (D38).
- Serves only what a share link permits. See [public-reader.md](public-reader.md).

### Cloud storage
- **Turso cloud DB**: rows for collections, revisions, files, blobs, renditions, and share links. Created as a Turso Sync (`--tursodb`) database. There is one per environment.
- **R2 bucket**: blob contents, renditions, and JSON manifests for disaster recovery. Private, Standard storage class only. There is one per environment.

## Runtimes and code layout

The writer runs on **Node 24 LTS**. The reader runs on **Cloudflare Workers**. Bun is not used, because Turso Sync's native module isn't documented for Bun. Code is shared through a runtime-agnostic core:

```
packages/
  core/            runtime-agnostic: types, ID + public-ID derivation, path rules,
                   manifest merge, URL routing, Hono route handlers written against
                   Storage / Repo interfaces. Web APIs only (fetch, Web Crypto, Web Streams).
  render/          markdown → HTML renderer (runs on the writer only)
  mcp/             stdio MCP server (published for `npx`)
apps/
  writer/          Node adapter: Turso Sync, @aws-sdk/client-s3, local blob store,
                   queue.db, committer, viewer UI
  reader/          Workers adapter: read-only R2 S3 API, @tursodatabase/serverless,
                   Cache API, Analytics Engine (phase 2)
```

- `core` must never import `node:*`, `@aws-sdk/*`, `@tursodatabase/sync`, or any native module.
- The reader's build fails if anything Node-only leaks in. A separate tsconfig and the package `exports` conditions enforce this.
- Proposed tooling: a pnpm workspace with TypeScript, Hono on both runtimes, the MCP TypeScript SDK, `typeid-js`, and `@aws-sdk/client-s3` for R2.

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

**Read in public** (phase 2). The reader validates the share token against the cloud DB, resolves the path to a blob or rendition, and streams it from R2 with immutable caching.

## URLs

| URL | Meaning |
|---|---|
| `/c/<collection public id>/` | Viewer for the latest revision's head document |
| `/c/<collection public id>/<path>` | Viewer for a file in the latest revision |
| `/c/<collection public id>/r/<revision public id>/<path>` | Viewer for a file in a pinned revision |
| `/raw/r/<revision public id>/<path>` | Raw content of a file. Markdown returns its HTML rendition; add `?source` for the original. |
| `/assets/<renderer version>/<file>` | Static, non-secret JS and CSS that renditions may reference |
| `/s/<token>/c/…`, `/s/<token>/raw/r/…` | (Reader, phase 2) the shell and raw routes behind a share token. See [public-reader.md](public-reader.md#urls). |

- **The viewer** is a shell: file sidebar, revision picker, and an iframe showing the raw content.
- **Raw URLs are always pinned to a revision.** Relative links inside a document therefore resolve within the same revision even when the viewer is showing "latest".
- **The shell's URL follows the document.** The shell watches the iframe's navigation, which is possible because both are same-origin, and updates its own URL. Copying the address bar always gives a URL for what you're looking at.
- **Shared URLs follow the same rule.** A URL copied while viewing "latest" follows latest. A URL copied while viewing a pinned revision stays pinned.
- **Failed and pending revisions** are viewable on the writer that holds them. The revision picker labels them.

## Renditions

- **Created at ingest.** The writer renders markdown into renditions when content is ingested. It never renders on request. After a renderer version bump, `waypoint-writer rerender` gives existing markdown a rendition at the new version (see [Re-rendering](#re-rendering-after-a-version-bump)).
- **Self-contained.** CSS is inlined, and syntax highlighting is done at render time, also inlined. As a result a rendition displays correctly with no internet access on the tailnet, and the reader only has to stream it.
- **Assets.** If a renderer version needs JS (for example Mermaid, later), it may reference only `/assets/<renderer version>/…`. Both the writer and the reader serve that path as static files, with no token.
- **No CDNs.** Renditions never reference external CDNs.
- **Deterministic and bounded.** Output depends only on the input bytes and the renderer version, never on time, load, or host settings, because renditions are content-addressed:
  - Highlighting has no time limit, but lines over 5,000 characters and fences over 100 KB are shown as plain text.
  - Sources over 1 MB, deeply nested input, and render errors fall back to the same page template showing the escaped source as plain text, with a one-line notice.
  - Rendering runs in a worker thread with a fixed stack size, so it never blocks the writer's event loop.
- **Version policy.** Any change to renderer dependencies, CSS, language set, template, or options bumps `RENDERER_VERSION`. A golden-output hash test enforces this.
- **Front matter.** YAML front matter is shown in a collapsed "Front matter" block at the top.
- **Which version is served.** Renditions are keyed by `(source hash, renderer, renderer version)`, and several versions of the same source can coexist. The writer serves the highest version among its committed and queued renditions; the reader serves the highest committed one (`ORDER BY renderer_version DESC LIMIT 1`). A new version therefore takes over as soon as its row exists, with no change to revisions or shells.

### The reading template (renderer version 2, "Folio")

The template follows the Folio design spec (section 8). The CSS is inlined in every rendition.
- **Typography:** the system sans stack at 17px/1.65 (16.5px under 600px) with a 68ch measure, warm paper and ink colours matching the viewer, light and dark via `prefers-color-scheme`. No webfonts.
- **Headings** keep their deterministic slug `id`s and get a hover anchor: `<a class="anchor" href="#id" aria-hidden="true" tabindex="-1">#</a>` as the first child. The rendition `<title>` and the contents block use the heading text without it.
- **Contents:** when a document has 4 or more `h2`s (excluding the footnotes label), a `<details class="toc" open>` "Contents" list of them goes after the first `h1` (or after the front matter when there is no `h1`). The frame script collapses it on screens up to 600px wide; without JS it stays open.
- **GitHub alerts:** a Markdown blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (any case), with content after it, becomes `<div class="markdown-alert markdown-alert-<kind>">` with a `p.markdown-alert-title`. Blockquotes written as raw HTML are left alone.
- **Tables** are wrapped in `<div class="table-wrap" tabindex="0" role="region" aria-label="Table">`, which scrolls horizontally with CSS-only scroll shadows. On screens 900px and wider it is centred and grows as wide as its table needs: at least the text measure, at most `min(100vw − 64px, 1120px)`. Only the outermost table of a nested set is wrapped.
- **Code blocks** keep Shiki's dual-theme highlighting; fenced blocks with a simple language label get `data-lang`, shown as a small label.
- **Images** alone in a paragraph (optionally inside a link) become `<figure class="image">`, centred with a hairline border. Inline images stay inline.
- **Frame reporter.** One inline script (about 330 bytes, identical in every rendition) tells the embedding shell which document is showing. The public reader needs it because its sandboxed iframe has an opaque origin the shell cannot read. On load and on `hashchange` it calls `parent.postMessage({ type: "waypoint:location", href: location.pathname + location.hash }, "*")`, and does nothing when the rendition is the top-level page. The payload is only the path and fragment: no origin, query string, referrer, cookies, or document content. The path is the frame's own URL, which the shell set and already knows; on the reader it carries the revision capability, never the share token, and the target is `"*"` only because the rendition cannot know its parent's origin. Shells must check `event.source === frame.contentWindow` and ignore anything else. On the writer it is redundant with the same-origin URL sync, and harmless.
- **Print:** no measure limit, no anchors or contents block, and tables and code avoid page breaks.

Fallback documents (oversized, too deeply nested, or failed renders) use the same template and script.

### Re-rendering after a version bump

`waypoint-writer rerender (--all | --collection <id>) [--dry-run] [--limit <n>]` renders current-version renditions for markdown blobs that lack one. It also accepts `--renderer markdown --version <n>` and refuses a version other than the one it was built with. Operating it: [deploy/README.md](../deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade).
- **Scope:** the markdown files of committed revisions and of pending (not failed) revisions, in all collections or one (by ID or public ID), including trashed collections, excluding collections being purged. Each distinct source blob is rendered once.
- **Queue path.** Outputs go into the local blob store with `pending_blobs` and `pending_renditions` rows, exactly as at ingest. The committer then commits each queued rendition whose source blob is committed: it uploads the output, inserts its `blobs` and `renditions` rows (blob before row), clears the queue rows, and pushes. A rendition whose source is still only in a pending revision commits with that revision. See [write-path-and-sync.md](write-path-and-sync.md#other-queued-work).
- **Missing sources.** A writer bootstrapped from the cloud fetches blobs lazily, so `rerender` downloads a source that is missing locally from the bucket, like the viewer does.
- **Idempotent and resumable.** Sources that already have a current-version rendition, committed or queued, are skipped. `--limit` caps the renditions generated per run; running again continues. The JSON summary reports `sources`, `current`, `queued`, `remaining`, and the `missing` and `failed` source hashes.
- **Runs with the server stopped.** It takes the data-directory lock like `serve` and `restore`, so it refuses to run while the writer is up. The writer's committer uploads the queued work on its next start.
- **Not in DR manifests.** A revision's manifest is written once, at commit, so renditions added later are not in it. A restore from the bucket brings back the renditions recorded at ingest; run `rerender` again afterwards.
- **Agent-written HTML** is served exactly as the agent wrote it. Whatever external resources it references are its own business.
