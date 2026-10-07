# Overview

## Problem

Development happens across a fleet of machines: agent-1 (Linux), a MacBook Air, and more later. Agents running on those machines produce artifacts that need to be looked at, often from a different machine than the one that produced them:

- HTML and markdown plan files
- Screenshots, images, and snapshots
- Research documents
- Collections of files belonging to a single run

Today these artifacts are scattered across machines' disks. Waypoint gives them one place to live, with a stable URL you can open from anywhere on the tailnet. When needed, an artifact can be shared with someone outside it.

## Goals

1. **Agents can write with no friction.** Any agent on any tailnet machine can create a collection, or add a revision to one, over MCP or HTTP and get a URL back. No auth or interactive steps are involved.
2. **Content renders instantly on the tailnet.** It is viewable the moment it is written, even if the internet is down.
3. **Nothing is lost when a machine dies.** Every collection and every revision is stored durably in the cloud. The local machines are not designed for high availability.
4. **Public access is safe.** The public side can never write. It serves only what has been explicitly shared, and knowing an ID is never enough to see anything.
5. **History is kept.** Every revision is kept forever and can be browsed with a revision picker.
6. **The design is ready to grow** into multiple writers, finer-grained access control (passwords, expiring tokens, audiences), and comments, without reworking the core schema.

## Non-goals (for now)

- Auth on the tailnet. Being on the tailnet *is* the auth.
- Uploads, edits, or comments from anyone outside the tailnet. Comments may come later, but uploads never will.
- A public index or search. If you reached the reader, it's because you were given a link.
- Grants beyond simple share links: passwords, audiences, and so on.
- A CLI. Agents are the primary writers and use MCP or HTTP. A CLI may come later.
- In-app editing of documents.
- Storage quotas or retention policies. Everything is kept, and R2's free tier is ample for now.

## Trust model

The tailnet is trusted, with full read and write access and no auth. The public internet is read-only forever, and sees only what a share link allows. Everything is stored in the cloud, but storage doesn't mean exposure. The full model (zones, credentials, share links, untrusted content, deploy pipeline, and accepted risks) is in **[trust-model.md](trust-model.md)**.

## Core principles

- **IDs identify; they don't authorize.** IDs and public IDs end up in logs, screenshots, and chat. Access always comes from a separate, revocable grant.
- **Insert-only by default.** Revisions, files, blobs, and renditions are only ever inserted. The only in-place updates are a collection's title and metadata, and a share link's revocation and expiry. This is what makes multiple writers safe under Turso's last-push-wins sync.
- **Upload the blob before inserting the row.** A row in the synced DB always refers to content that is already in the bucket, so the cloud never has dangling references.
- **Content-addressed storage.** Identical content is stored and uploaded once, however many revisions use it.
- **Local first, cloud durable.** Writes land locally and render immediately. A background committer moves them to the cloud and retries through outages.
- **Additive-only migrations.** Schema changes only add tables and columns. This is required by the Turso Sync limitations described in [data-model.md](data-model.md).
- **Keep the collection small.** Access control, comments, and logs live in their own tables that reference collections. They never become columns on `collections`.
