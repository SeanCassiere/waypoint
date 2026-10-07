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
             │ R2 binding (read)              │ read-only token (HTTP)
   ┌─────────┴──────────────────────────────┴─────────┐
   │  Reader  (Cloudflare Worker, Hono) — phase 2      │
   │  waypoint.pingstash.com — share links only        │
   └───────────────────────────▲───────────────────────┘
                               │ public internet
```

### Writer (phase 1)
- A long-running Node process on a tailnet machine; agent-1 today.
- Exposed on the tailnet with `tailscale serve` over HTTPS at its MagicDNS name.
- Serves three things:
  - the **HTTP API** for writes and reads
  - the **viewer**: collection list, collection view with file sidebar and revision picker, and a Trash view
  - **raw content**: files and renditions
- Runs a single **committer** worker, which moves queued writes into durable cloud state.
- Owns its data directory exclusively. Turso requires one process per database file. The MCP server never opens the DB; it calls the HTTP API instead.
- Multiple writers are possible. Each has its own data directory, and they converge through the cloud DB.

### MCP server (phase 1)
- A small local **stdio** process on each machine where agents run, started with `npx` and configured with `WAYPOINT_URL`.
- Runs locally because agents' files are on *their* machine's disk. The MCP server reads files by path, hashes them, uploads only the blobs the writer doesn't have, and then submits the revision. Passing large files or images as base64 in tool arguments is avoided entirely.
- Agents without the MCP server can use the HTTP API's multipart endpoint with `curl`.

### Reader (phase 2)
- A Cloudflare Worker on `waypoint.pingstash.com`.
- Reads metadata from Turso through `@tursodatabase/serverless` with a **read-only** token, and reads blobs through the R2 binding.
- Serves only what a share link permits. See [public-reader.md](public-reader.md).

### Cloud storage
- **Turso cloud DB**: rows for collections, revisions, files, blobs, renditions, and later share links. Created as a Turso Sync (`--tursodb`) database. There is one per environment.
- **R2 bucket**: blob contents, renditions, and JSON manifests for disaster recovery. Private, Standard storage class only. There is one per environment.

## Runtimes and code layout

The writer runs on **Node 22 LTS**. The reader runs on **Cloudflare Workers**. Bun is not used, because Turso Sync's native module isn't documented for Bun. Code is shared through a runtime-agnostic core:

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
  reader/          Workers adapter: R2 binding, @tursodatabase/serverless,
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

- **Created at ingest.** The writer renders markdown into renditions when content is ingested. It never renders on request.
- **Self-contained.** CSS is inlined, and syntax highlighting is done at render time, also inlined. As a result a rendition displays correctly with no internet access on the tailnet, and the reader only has to stream it.
- **Assets.** If a renderer version needs JS (for example Mermaid, later), it may reference only `/assets/<renderer version>/…`. Both the writer and the reader serve that path as static files, with no token.
- **No CDNs.** Renditions never reference external CDNs.
- **Agent-written HTML** is served exactly as the agent wrote it. Whatever external resources it references are its own business.
