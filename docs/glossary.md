# Glossary

These are the canonical terms. Code, API fields, and the other docs use them exactly as defined here. If a term needs to change, change it here first.

## The system

**Waypoint**
A self-hosted, private store for the artifacts agents produce: plans, screenshots, research docs, run output. Agents write to it over MCP or HTTP. Anything stored in it can be viewed at a stable URL from any machine on the tailnet. A collection can be shared outside the tailnet with a link. Technically, a Waypoint **instance** is the writer(s), the reader, the cloud DB, and the bucket, the last three optional.
"Waypoint" names the product only. There is no entity called "a waypoint": the thing you create, view, and share is a [collection](#content).

**Tailnet**
The owner's private Tailscale network: their machines and the agents running on them. Everything on the tailnet is **trusted**. An instance without Tailscale has the writer host's loopback as its private network instead, with the same trust. See [trust-model.md](trust-model.md).

**Writer**
A Waypoint instance running on the tailnet in *write mode*. It accepts writes from agents, renders content, serves the viewer, keeps a local replica of the database, and syncs to the cloud. Writers have no auth: being on the tailnet is the credential. An instance runs one writer today, and the design allows several.

**Reader**
An instance's Cloudflare Worker on its own public domain (one per environment), running in *read mode*. It's optional. It faces the public internet, is read-only forever, and serves only what a [share link](#access) permits.

**Viewer**
The writer's web UI (the "Folio" design). Server-rendered pages: **Recent** (home), the **collection shell** (top bar, a Files / History / Links panel, one status line, and an iframe showing the current file), **Changes** (rendered diffs between two revisions), a folder **gallery**, **Public links**, **Trash**, **Status**, and **Connect an agent**. Every page outside a collection shares one bar with Recent, Public links and Trash tabs. It uses native web primitives (popovers, `<dialog>`, invoker commands, `<details>`, CSS anchor positioning, `@starting-style` transitions); script is limited to URL sync, clipboard, fetch-based actions and keyboard shortcuts.

**Links**
The viewer's share-link management: the **Links** tab in a collection's panel (that collection's links, with Extend, Revoke and Revoke all) and the global **Public links** page (`/links`, filtered by Live, Paused in Trash, Expired and Revoked; Live counts only links the reader would serve, and lists waiting links without counting them).

**Public preview**
The writer showing a collection as a share viewer would see it (`?as=public`): the reader's public shell and the revision the reader would serve (the newest synced one, or the pinned one), with no share link needed and without leaving the tailnet. A band after the skip link names the revision a Latest or Only link shows and links back to the revision the owner came from; a failed or still-uploading target gets an explanation page instead.

**Trash view**
The part of the viewer that lists soft-deleted (tombstoned) collections and lets you undelete or purge them. It has two lists: **Being purged** first (purges still erasing, with their step) and then **In Trash** (the collections you can restore or purge).

**Read mark**
What this browser remembers about a collection you read: the newest revision you opened (localStorage `wp:read:<public ID>`). Recent marks a collection unread when it has newer revisions, and links to the changes since then. Mark all read sets every mark on the page. Read marks never leave the browser.

**Cloud DB**
The Turso database that holds every collection's metadata rows. It is the durable source of truth for rows.

**Bucket**
The private Cloudflare R2 bucket (or another S3-compatible one). It holds every blob, plus DR manifests and collection snapshots. It is the durable source of truth for file contents. It is never publicly listable or readable directly.

**Environment**
`dev` or `prod`. Each environment has its own cloud DB, bucket, and writer data directory.

**Environment guard**
A writer's check, made at startup and before every push, that its config, its local DB, and the cloud DB all agree on the environment, plus a check of the bucket's environment marker before the first bucket request. If they don't agree, the writer refuses to sync.

## Content

**Collection**
The unit you create, view, and share. It is a named, growing history of revisions, for example "Auth refactor plan" or "Run 2026-10-07 screenshot audit". The collection itself holds very little: an ID, a public ID, a title, free-form metadata, and a creation time. Its content lives in its revisions.

**Project**
A collection's group name, set in metadata as `project`. Recent groups and filters by it; search with `project:`.

**Tag**
A label in the collection's `tags` metadata. A collection can have several; search with `tag:`.

**Written on**
The host the agent published from (`source_host`), set automatically and read-only in the writer; search with `host:`.

**Revision**
An immutable snapshot of a collection's files at one point in time. Every write (`create_collection`, `add_revision`) creates exactly one new revision. The exception is a write that changes nothing: then the parent revision is returned and nothing is created. Revisions are never edited, never deleted individually, and kept forever.

**Latest revision**
The newest revision in a collection that is not `failed`, meaning the one with the highest ID. Collection URLs show the latest revision by default.

**Pinned revision**
A specific revision addressed explicitly in a URL. It never changes.

**Latest URL / pinned URL**
`/c/<collection>/…` follows the latest revision. `/c/<collection>/r/<revision>/…` is pinned to one revision. Copying the URL you're viewing gives the right one for sharing.

**Parent revision**
The revision a new revision was built from. In merge mode, the parent's files are the starting point. A collection's first revision has no parent.

**Fork**
Two revisions that share the same parent. This can happen when two writers revise the same revision before seeing each other's work. It isn't an error. "Latest" is still the highest ID, and History draws the branch in its own lane beside the latest line ('Branch off #4 · not in latest').

**Display number (`#N`)**
The human-friendly position of a revision in its collection (#1, #2, …). It is computed each time it's shown, never stored, and never used in URLs, because it can shift if a fork arrives out of order.

**Manifest**
The complete `path → blob` listing of one revision, plus its head path. Each revision has a full manifest, never a diff against its parent. It is stored as `revision_files` rows.

**File** (revision file)
One manifest entry: a path, the blob it points to, a MIME type, and a size. The same blob can appear in many files across many revisions.

**Path**
A file's location within a revision, such as `plan.html` or `img/shot-1.png`. Paths are relative, use forward slashes, and are case-sensitive. A revision may not contain two paths that differ only by case. Because of paths, relative links between files in a collection just work.

**Head document**
A revision's entry point: the file you see first when opening a collection. Every revision has exactly one head path, and it must exist in that revision's manifest. When it isn't given, it is inferred in this order: `index.html`, `index.md`, `README.md`, the only file.

**Blob**
An immutable piece of file content, identified by its content hash. It is stored once no matter how many files or revisions reference it. A blob that didn't change between revisions isn't stored or uploaded again.

**Content hash**
A blob's identity: `sha256:<64 lowercase hex chars>`. The algorithm prefix leaves room for others later.

**Local blob store**
A writer's on-disk, content-addressed copy of blobs. It holds newly ingested content before upload and also serves as the read cache, filled from the bucket on demand.

**Rendition**
A derived blob that a renderer produces from a source blob, for example a markdown file rendered to self-contained HTML. Renditions are keyed by `(source hash, renderer, renderer version)` and generated by the writer at ingest. Neither the viewer nor the reader ever renders on request. A renderer upgrade adds new renditions and never changes revisions.

**Rendition v3**
The current markdown renderer version (`RENDERER_VERSION = 3`): the Folio reading template on the frozen `readingTokensCss` palette, plus a small inline script that reports the frame's location to the embedding shell. Older versions remain in storage; the newest version wins when serving.

**Rerender**
`waypoint-writer rerender`: the operator subcommand that gives existing markdown a rendition at the current renderer version after a version bump. Run with the writer stopped; see [deploy/README.md](../deploy/README.md#re-rendering-markdown-after-a-renderer-upgrade).

**DR manifest**
A JSON copy of one revision (its row, files, and renditions) written to the bucket at `manifests/<revision id>.json`. Together with collection snapshots, these let the cloud DB be rebuilt from the bucket alone.

**Collection snapshot**
A JSON copy of one collection's row and tombstone state, written to the bucket at `collections/<collection id>.json`. It also includes the collection's share links, as token hashes only. It is rewritten whenever any of these change.

## Identity

**ID** (primary key)
The internal, permanent identity of a row. IDs use TypeID format: a 3-letter type prefix, an underscore, then a time-sortable UUIDv7 in lowercase base32, for example `rev_01j9qz8k7cfyva3xr6m2hg5e4n`. You can tell from an ID what kind of thing it is. Agents and the API refer to everything by ID.

**Public ID**
The short identifier used in URLs, for example `7f3k9m2qxv8h`: 12 lowercase base32 characters derived from a hash of the ID. Collections and revisions have one. A public ID is **not a secret and never grants access**.

## Writing

**Merge mode** (default for `add_revision`)
The new revision starts from the parent revision's manifest. Paths listed in `remove` are deleted, files you send are added or overwritten by path, and everything else carries over unchanged.

**Replace mode**
The files you send make up the complete manifest of the new revision.

**Ingest**
Accepting a write. Blobs are stored in the local blob store, renditions are generated, and a pending revision is recorded in the queue. Once ingest finishes, the content can be viewed on the tailnet.

**Queue**
The writer's local-only database (`queue.db`) of work that hasn't reached the cloud yet: pending collections and revisions, blob uploads, snapshot rewrites, and purges. It is never synced. Its contents are invisible to other writers.

**Pending collection**
A collection created on this writer that hasn't been committed yet. It exists only in the queue. Edits and deletes still work on it. See [write-path-and-sync.md](write-path-and-sync.md#pending-collections).

**Committer**
The single background worker on each writer that turns queued work into durable cloud state. It uploads blobs to the bucket, writes DR manifests and snapshots, inserts rows into the synced DB, and retries on failure.

**Commit**
Moving a pending revision from the queue into the writer's synced local DB (`waypoint.db`). This happens only after all of the revision's blobs (including renditions) and its DR manifest are in the bucket.

**Push / Pull**
Turso Sync operations. Push sends local committed changes to the cloud DB. Pull brings other writers' changes down.

**Sync state**
Where a revision is in its lifecycle:
- `pending`: in the queue. Viewable on the tailnet only through this writer.
- `committed`: blobs and DR manifest are in the bucket, and rows are in the local synced DB. Not yet pushed to the cloud DB, but recoverable from the bucket.
- `synced`: pushed to the cloud DB. Fully durable and visible to other writers and the reader.
- `failed`: retries ran out or the error is permanent. Stays in the queue and stays viewable on this writer.

The viewer also tells queued revisions apart: **waiting** (its parent is still queued), **stalled** (no progress for 10 minutes: an error is recorded, or the committer hasn't picked it up), and **uploading** (anything else that is pending). A failed revision is **failed**.

## Lifecycle

**Tombstone**
A row marking a collection as deleted (soft delete). Tombstoned collections disappear from lists and from the reader, and show up in the Trash view. Deleting the tombstone undoes it.

**Purge**
Permanent deletion of a collection: all its revisions, files, DR manifests, snapshot, and any blobs no longer referenced elsewhere, both in the cloud and locally. It is the one exception to "nothing is ever deleted", meant for content that should never have been stored, such as a leaked secret.

**Being purged**
A collection whose purge was accepted and is still erasing. It is listed first on Trash and under In progress on Status, with its step (bucket › database › files); it can't be restored. Its links were revoked when the purge was confirmed.

**Restore**
Rebuilding state from durable storage. A new writer bootstraps from the cloud DB. If the cloud DB is lost, it is rebuilt from the bucket's DR manifests and collection snapshots. Restore is an operator subcommand of the writer (`waypoint-writer restore`), not an agent-facing CLI.

## Access

**Share link**
A database row granting the public reader access to one collection. It either follows the latest revision or pins one revision. It can be revoked and can expire. Share links are created only from the tailnet. They are the first and simplest kind of grant.

**Live link**
A link the public reader serves right now.

**Paused link**
Unrevoked and unexpired, on a collection in Trash; Restore asks whether to turn it back on.

**Waiting link**
Unrevoked and unexpired, but its target hasn't synced: Only #N while #N uploads, or Latest with nothing synced; it opens once the revision syncs.

**Share token**
The secret inside a share link's URL: `wps_` plus 32 bytes in base64url, derived from the link's ID with the writer's share token key (D50), as in `https://share.example.com/s/<token>/c/<public id>/`. Only its hash is stored.

**Capability URL**
A URL whose secret part is the whole credential: anyone holding it has access until it's revoked or expires. Share links are capability URLs.

**Raw capability**
The derived, per-revision secret in the reader's raw content URLs (`/x/<share link id>.<cap>/r/<revision public id>/<path>`): an HMAC of the link ID and revision public ID under `RAW_CAP_KEY`. The shell's iframe uses it, so document scripts never see the full share token, and it stops working when the link does.

**Access event**
A record of one reader request (share link, collection, revision, path, time), written to Workers Analytics Engine and never to the cloud DB.

**Grant** (future)
The general idea of "this credential may see this content". Share links are grants scoped to one collection, with optional expiry. Future grants may add passwords or audience scope.

**Audience** (future)
A named group, such as "work" or "client-acme", that collections can be shared with. Each person gets their own grant, so access can be revoked individually.
