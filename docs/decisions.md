# Decisions

Each entry records what was decided and why. Newest entries go at the bottom. All of these come from the design discussion of 2026-10-07, which was reviewed by Claude Fable at each step.

| # | Decision | Why | Rejected alternatives |
|---|---|---|---|
| D1 | **Two sides: tailnet writer(s) and a public reader.** | The tailnet is trusted; the internet isn't. | A single app with auth everywhere (needless friction for a solo tailnet) |
| D2 | **The tailnet is trusted.** No auth on writers. | The user is the only person on the tailnet. | — |
| D3 | **The public side is read-only forever and never accepts uploads.** | Keeps the attack surface minimal. Comments may come later, but uploads never will. | — |
| D4 | **Private by default. Public access only through grants, starting with share links. IDs are never credentials.** | IDs leak through logs, screenshots, and chat, and can't be revoked. | Unguessable URLs as access control; auto-publishing |
| D5 | **The cloud holds everything, private content included.** | The user's machines aren't highly available, and losing the DB isn't acceptable. | Local source of truth plus a publish-only bucket |
| D6 | **The public reader is a server, not a static bucket.** | Passwords, revocable tokens, expiry, and audiences all need a check on every request. | A static bucket behind a CDN (Fable's round-1 suggestion) |
| D7 | **The cloud DB is Turso, using Turso Sync** (`@tursodatabase/sync`). | Local reads and writes with push/pull; documented multi-writer support (row-level last-push-wins); the user's preference for managed SQLite. | Embedded replicas (writes go to the cloud, so they fail offline); libSQL `offline: true` (beta, no conflict resolution); Postgres; plain SQLite |
| D8 | **Blobs go in Cloudflare R2** (free plan, private, Standard storage class). | Free egress, S3-compatible, conditional PUT, and a native Workers binding. | — |
| D9 | **TypeScript.** The writer runs on Node 22; the reader runs on Workers. | Turso's TypeScript sync SDK is the most complete; the MCP TypeScript SDK is the reference implementation; AWS SDK v3 is the documented way to use R2. Bun is out because Turso Sync isn't documented for it. | Go (`tursogo` needs no cgo, but has no `transform` hook and thinner docs) |
| D10 | **The design must allow multiple writers.** | Future: more machines, maybe Kubernetes. | A single-writer-only design |
| D11 | **Insert-only tables.** The only update is collection title and metadata. | Under last-push-wins, insert-only rows with unique keys can't conflict. | — |
| D12 | **No `seq` column.** Revisions are ordered by ID; `#N` is computed for display. | Two writers would both choose the same `seq`. | A unique `(collection_id, seq)` |
| D13 | **Soft delete is a tombstone table,** not a `deleted_at` column. | A concurrent title edit can't resurrect a deleted collection. To revisit after spike S1. | A `deleted_at` column on `collections` |
| D14 | **Upload the blob before inserting the row.** | The cloud never references missing content. | Readers tolerating missing blobs |
| D15 | **A local write queue in a separate `queue.db`, retrying every 5–10 min, giving up after 72 h.** | Writes succeed and render during internet or R2 outages. Turso Sync can't exclude tables, so the queue can't live in the synced DB. | Requiring the internet for writes; retrying forever; giving up after 50 attempts (≈6 h, too short) |
| D16 | **IDs are TypeIDs** (`col_`, `rev_`, …; UUIDv7 in base32), with no env segment. | You can tell an ID's type from the ID itself, and IDs are time-sortable. An env segment can't prevent cross-environment mistakes; the environment guard does. | cuid2 (not sortable), `<prefix>_live_<id>` |
| D17 | **Public IDs are 12 base32 characters derived from a hash of the ID.** | Short URLs. A retried revision on two writers yields identical rows, not two URLs. | Random public IDs; exposing IDs in URLs |
| D18 | **Revisions are immutable and kept forever. "Latest" by default, with a revision picker.** | History is valuable, and content addressing makes it cheap. | Editing in place; retention limits |
| D19 | **`add_revision` defaults to merge mode.** | Agents usually change one or two files. | Replace as the default |
| D20 | **Shares follow the latest revision by default.** Sharing from a pinned revision pins it. | Matches the user's intent. Copying the URL you're viewing gives the right behavior. | Always pinning |
| D21 | **MCP and HTTP API on day one. No CLI.** The MCP server is a local stdio process that reads files by path. | Agents are the main writers, and base64 file contents in tool arguments don't scale. | A remote MCP over HTTP only; a watched folder; CLI-first |
| D22 | **No slugs.** `create_collection` returns an ID, and edits require it. | Simpler; agents carry the ID. | Stable human slugs |
| D23 | **No separate content origin on the tailnet.** | All content comes from the user's own agents, so the risk is acceptable. | Sandboxed second origin |
| D24 | **The public reader runs on Cloudflare Workers at `waypoint.pingstash.com`.** | R2 binding, free egress, edge cache, and built-in protections (Turnstile, rate limiting, WAF). | Railway (egress fees, always-on container, more to build by hand) |
| D25 | **Markdown is pre-rendered by the writer into renditions**, keyed by source hash and renderer version. | Workers' 10 ms CPU limit, instant tailnet renders, and renderer upgrades never touch revisions. | Rendering on request |
| D26 | **Access logs go to Workers Analytics Engine.** | The reader's DB token stays read-only. | Logging to the main DB |
| D27 | **Additive-only migrations.** | Turso Sync currently has bugs around renaming and dropping columns. | — |
| D28 | **No storage cap for now.** | R2's free tier is generous, and overage is cheap. | Hard cap at 9 GB |
| D29 | **Four sync states: `pending`, `committed`, `synced`, `failed`.** | "Committed" (local DB plus bucket) is not the same as "in the cloud DB". Agents and the user need to know when a write is fully durable. Uses the "synced" wording the user preferred over "published". | Three states (which over-promised durability) |
| D30 | **Clients may mint `col_` and `rev_` IDs.** Revision IDs use `max(now, parent + 1 ms)`. | Makes retries idempotent, including for `create_collection`, and tolerates clock skew between machines. | IDs minted only by the writer (a retry after a timeout returned a 409) |
| D31 | **Renditions are self-contained** (inlined CSS and highlighting). Mermaid is deferred. | They work on the tailnet without internet access, and the reader only streams. | CDN-hosted assets |
| D32 | **Purge is resumable and single-writer only in phase 1.** | Multi-writer purge needs markers and a GC grace period, to be designed before a second writer goes live. | Building multi-writer purge now |
| D33 | **`PRAGMA foreign_keys` is OFF on the synced DB.** The committer enforces invariants. | Rows pulled from other writers can arrive in any order. To be confirmed in S1. | FK enforcement |
