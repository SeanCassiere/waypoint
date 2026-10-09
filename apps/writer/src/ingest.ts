import {
  buildManifest,
  manifestsEqual,
  newId,
  mintRevisionId,
  validateClientId,
  publicIdFor,
  parseId,
  inferMime,
  normalizeMime,
  isContentHash,
  validatePath,
  pinnedRevisionUrl,
  latestCollectionUrl,
  WaypointError,
  type CreateCollectionRequest,
  type AddRevisionRequest,
  type ManifestEntry,
  type SyncState,
  type WriteResult,
  DEFAULT_LIMITS,
} from "@waypoint/core";

import type { BlobStore } from "./blob-store.ts";
import { inSeries, type Db, type SyncClient } from "./db.ts";
import { GcBarrier } from "./gc-barrier.ts";
import { ReadModel } from "./read-model.ts";
export interface Committer {
  /** The collection-commit step must run inside withCollectionLock(collectionId, fn). */
  wake(): void;
  waitForCommit(revisionId: string, timeoutMs: number): Promise<SyncState>;
  /** RX-11: recompute the collection's syncing row; the caller holds the collection lock. */
  refreshSyncing?(collectionId: string): Promise<void>;
}
export class NoopCommitter implements Committer {
  wake(): void {}
  waitForCommit(): Promise<SyncState> {
    return Promise.resolve("pending");
  }
}
export interface Rendition {
  bytes: Uint8Array;
  mime: string;
}
export interface Renderer {
  rendererName: string;
  rendererVersion: number;
  render(source: Uint8Array, mime: string): Promise<Rendition | null>;
}
export class NullRenderer implements Renderer {
  rendererName = "none";
  rendererVersion = 0;
  render(): Promise<null> {
    return Promise.resolve(null);
  }
}
export class IngestService {
  readonly gcBarrier = new GcBarrier();
  private locks = new Map<string, Promise<unknown>>();
  private ingesting = new Map<string, number>();
  private inUseHashes = new Map<string, number>();
  readonly waypoint: Db;
  readonly queue: Db;
  readonly blobs: BlobStore;
  readonly reads: ReadModel;
  readonly sync: SyncClient;
  committer: Committer;
  readonly renderer: Renderer;
  readonly maxFiles: number;
  readonly maxRevisionBytes: number;
  constructor(
    waypoint: Db,
    queue: Db,
    blobs: BlobStore,
    reads: ReadModel,
    sync: SyncClient,
    committer: Committer = new NoopCommitter(),
    renderer: Renderer = new NullRenderer(),
    maxFiles: number = DEFAULT_LIMITS.maxFiles,
    maxRevisionBytes: number = DEFAULT_LIMITS.maxRevisionBytes,
  ) {
    this.waypoint = waypoint;
    this.queue = queue;
    this.blobs = blobs;
    this.reads = reads;
    this.sync = sync;
    this.committer = committer;
    this.renderer = renderer;
    this.maxFiles = maxFiles;
    this.maxRevisionBytes = maxRevisionBytes;
  }
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(fn);
    this.locks.set(id, task);
    void task
      .finally(() => {
        if (this.locks.get(id) === task) this.locks.delete(id);
      })
      .catch(() => undefined);
    return task;
  }
  private async result(
    collectionId: string,
    revisionId: string,
    unchanged: boolean,
  ): Promise<WriteResult> {
    const collection = await this.reads.collection(collectionId);
    const revision = await this.reads.revision(revisionId);
    if (!collection || !revision) throw new WaypointError("not_found", "Revision not found");
    const list = await this.reads.revisions(collectionId);
    return {
      collection_id: collectionId,
      revision_id: revisionId,
      display_number: list.find((x) => x.id === revisionId)?.display_number ?? 0,
      url: pinnedRevisionUrl(this.reads.baseUrl, collection.public_id, revision.public_id),
      latest_url: latestCollectionUrl(this.reads.baseUrl, collection.public_id),
      sync_state: revision.sync_state ?? "synced",
      unchanged,
    };
  }
  withCollectionLock<T>(collectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.locked(collectionId, fn);
  }
  withGcExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.gcBarrier.write(fn);
  }
  isCollectionIngesting(id: string): boolean {
    return (this.ingesting.get(id) ?? 0) > 0;
  }
  isBlobInUse(hash: string): boolean {
    return (this.inUseHashes.get(hash) ?? 0) > 0;
  }
  private holdHash(hash: string, held: Set<string>): void {
    if (held.has(hash)) return;
    held.add(hash);
    this.inUseHashes.set(hash, (this.inUseHashes.get(hash) ?? 0) + 1);
  }
  private releaseHashes(held: Set<string>): void {
    for (const hash of held) {
      const count = (this.inUseHashes.get(hash) ?? 1) - 1;
      if (count) this.inUseHashes.set(hash, count);
      else this.inUseHashes.delete(hash);
    }
  }
  private async duringIngest<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.ingesting.set(id, (this.ingesting.get(id) ?? 0) + 1);
    try {
      return await this.locked(id, () => this.gcBarrier.read(fn));
    } finally {
      const count = (this.ingesting.get(id) ?? 1) - 1;
      if (count) this.ingesting.set(id, count);
      else this.ingesting.delete(id);
    }
  }
  async create(request: CreateCollectionRequest): Promise<WriteResult> {
    const now = Date.now();
    const id = request.collection_id ?? newId("col");
    const queued = await this.duringIngest(id, async () => {
      if (await this.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [id]))
        throw new WaypointError("conflict", "Collection purge is in progress");
      const existing = await this.reads.collection(id);
      if (existing) {
        const revisions = await this.reads.revisions(id);
        const first = revisions[0];
        if (request.revision_id && first?.id === request.revision_id)
          return { revisionId: first.id, unchanged: false, wake: false };
        throw new WaypointError("revision_conflict", "Collection ID already used");
      }
      if (request.collection_id) validateClientId(id, { prefix: "col", now });
      if (!request.title?.trim()) throw new WaypointError("validation_failed", "Title is required");
      return this.write(id, { ...request, mode: "replace" }, true, now);
    });
    return this.finish(id, queued);
  }
  async add(collectionId: string, request: AddRevisionRequest): Promise<WriteResult> {
    const queued = await this.duringIngest(collectionId, async () =>
      this.write(collectionId, request, false, Date.now()),
    );
    return this.finish(collectionId, queued);
  }
  private async finish(
    collectionId: string,
    queued: { revisionId: string; unchanged: boolean; wake: boolean },
  ): Promise<WriteResult> {
    if (queued.wake) {
      this.committer.wake();
      await this.committer.waitForCommit(queued.revisionId, 5000);
    }
    return this.result(collectionId, queued.revisionId, queued.unchanged);
  }
  private async write(
    collectionId: string,
    request: AddRevisionRequest & { title?: string; files?: CreateCollectionRequest["files"] },
    creating: boolean,
    now: number,
  ): Promise<{ revisionId: string; unchanged: boolean; wake: boolean }> {
    const collection = await this.reads.collection(collectionId);
    if (!creating) {
      if (!collection) throw new WaypointError("collection_not_found", "Collection not found");
      if (collection.deleted_at != null)
        throw new WaypointError("collection_deleted", "Collection is deleted");
      const purge = await this.queue.get(
        "SELECT collection_id FROM pending_purges WHERE collection_id=?",
        [collectionId],
      );
      if (purge) throw new WaypointError("collection_purged", "Collection is being purged");
    }
    if (!creating && request.revision_id) {
      const retried = await this.reads.revision(request.revision_id);
      if (retried) {
        if (
          retried.collection_id === collectionId &&
          (request.parent_revision_id === undefined ||
            request.parent_revision_id === retried.parent_revision_id)
        )
          return { revisionId: retried.id, unchanged: false, wake: false };
        throw new WaypointError("revision_conflict", "Revision ID already used");
      }
    }
    let parentId = request.parent_revision_id;
    if (!creating && !parentId) {
      if (this.sync.lastPullAt === null || now - this.sync.lastPullAt > 30000) {
        // The pull continues in the background if the two-second wait expires.
        // SyncClient keeps it single-flight; local SQL is free to proceed.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.sync.pull().catch(() => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 2000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const all = await this.reads.revisions(collectionId);
      const newest = all.at(-1);
      if (newest?.sync_state === "failed")
        throw new WaypointError("parent_failed", "Newest revision failed", {
          revision_id: newest.id,
        });
      parentId = (await this.reads.latest(collectionId))?.id;
    }
    let parent = parentId ? await this.reads.revision(parentId) : undefined;
    if (parentId && (!parent || parent.collection_id !== collectionId))
      throw new WaypointError("parent_not_found", "Parent revision not found", {
        revision_id: parentId,
      });
    if (parent?.sync_state === "failed")
      throw new WaypointError("parent_failed", "Parent revision failed", {
        revision_id: parent.id,
      });
    const id = request.revision_id ?? mintRevisionId({ now, ...(parentId ? { parentId } : {}) });
    const existing = await this.reads.revision(id);
    if (existing) {
      if (
        existing.collection_id === collectionId &&
        existing.parent_revision_id === (parentId ?? null)
      )
        return { revisionId: id, unchanged: false, wake: false };
      throw new WaypointError("revision_conflict", "Revision ID already used");
    }
    if (request.revision_id)
      validateClientId(id, { prefix: "rev", now, ...(parentId ? { parentId } : {}) });
    const held = new Set<string>();
    try {
      const files: Record<string, ManifestEntry> = {};
      const seenPaths = new Set<string>();
      const pendingBlobs = new Map<string, number>();
      await inSeries(request.files ?? [], async (file) => {
        if (
          !file ||
          typeof file.path !== "string" ||
          typeof file.hash !== "string" ||
          !isContentHash(file.hash)
        )
          throw new WaypointError("validation_failed", "Invalid file");
        const normalizedPath = validatePath(file.path);
        if (seenPaths.has(normalizedPath))
          throw new WaypointError("path_case_conflict", "Duplicate file path");
        seenPaths.add(normalizedPath);
        this.holdHash(file.hash, held);
        if (!(await this.blobs.has(file.hash)))
          throw new WaypointError("blob_missing", `Blob missing: ${file.hash}`);
        const size = await this.blobs.size(file.hash);
        Object.defineProperty(files, normalizedPath, {
          value: { hash: file.hash, mime: normalizeMime(file.mime ?? inferMime(file.path)), size },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        if (!(await this.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [file.hash])))
          pendingBlobs.set(file.hash, size);
      });
      const mode = creating ? "replace" : (request.mode ?? "merge");
      const manifest = buildManifest({
        mode,
        ...(parent ? { parent: parent.manifest } : {}),
        files,
        ...(request.remove ? { remove: request.remove } : {}),
        ...(request.head_path ? { headPath: request.head_path } : {}),
        limits: {
          maxBlobBytes: this.blobs.maxBlobBytes,
          maxFiles: this.maxFiles,
          maxRevisionBytes: this.maxRevisionBytes,
        },
      });
      for (const entry of Object.values(manifest.files)) this.holdHash(entry.hash, held);
      if (parent && manifestsEqual(parent.manifest, manifest))
        return { revisionId: parent.id, unchanged: true, wake: false };
      const publicId = await publicIdFor(parseId(id, "rev"));
      const collectionPublicId = creating
        ? await publicIdFor(parseId(collectionId, "col"))
        : collection!.public_id;
      const renditions: { source: string; output: string; mime: string; size: number }[] = [];
      const renderedSources = new Set<string>();
      await inSeries(Object.values(manifest.files), async (entry) => {
        if (entry.mime !== "text/markdown") return;
        if (renderedSources.has(entry.hash)) return;
        renderedSources.add(entry.hash);
        const existingRendition =
          (await this.queue.get(
            "SELECT source_hash FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
            [entry.hash, this.renderer.rendererName, this.renderer.rendererVersion],
          )) ??
          (await this.waypoint.get(
            "SELECT source_hash FROM renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
            [entry.hash, this.renderer.rendererName, this.renderer.rendererVersion],
          ));
        if (existingRendition) return;
        const source = await readFile(this.blobs.path(entry.hash));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rendered: Rendition | null;
        try {
          rendered = await Promise.race([
            this.renderer.render(source, entry.mime),
            new Promise<null>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Renderer timeout")), 5000);
            }),
          ]);
        } catch {
          return;
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (rendered) {
          const output = await this.blobs.put(ReadableFromBytes(rendered.bytes));
          this.holdHash(output.hash, held);
          renditions.push({
            source: entry.hash,
            output: output.hash,
            mime: rendered.mime,
            size: output.size,
          });
          pendingBlobs.set(output.hash, output.size);
        }
      });
      await this.queue
        .transaction(async (tx) => {
          const duplicate = await tx.get<{
            collection_id: string;
            parent_revision_id: string | null;
          }>("SELECT collection_id,parent_revision_id FROM pending_revisions WHERE id=?", [id]);
          if (duplicate) throw new WaypointError("revision_conflict", "Revision ID already used");
          if (creating)
            await tx.run(
              "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
              [
                collectionId,
                collectionPublicId,
                request.title!,
                JSON.stringify(request.metadata ?? {}),
                now,
              ],
            );
          await inSeries(pendingBlobs, ([hash, size]) =>
            tx.run("INSERT OR IGNORE INTO pending_blobs (hash,size) VALUES (?,?)", [hash, size]),
          );
          await inSeries(renditions, (rendition) =>
            tx.run(
              "INSERT OR IGNORE INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
              [
                rendition.source,
                this.renderer.rendererName,
                this.renderer.rendererVersion,
                rendition.output,
                rendition.mime,
                now,
              ],
            ),
          );
          // Minted IDs may precede rendering; updated_at uses this late transaction timestamp.
          const insertedAt = Date.now();
          await tx.run(
            "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
            [
              id,
              publicId,
              collectionId,
              parentId ?? null,
              manifest.headPath,
              request.message ?? null,
              JSON.stringify(request.metadata ?? {}),
              JSON.stringify(manifest),
              insertedAt,
              "pending",
            ],
          );
        })
        .catch((error) => {
          if (
            error instanceof Error &&
            /UNIQUE constraint|PRIMARY KEY constraint/i.test(error.message)
          )
            throw new WaypointError("revision_conflict", "ID already used");
          throw error;
        });
      await this.committer.refreshSyncing?.(collectionId);
      return { revisionId: id, unchanged: false, wake: true };
    } finally {
      this.releaseHashes(held);
    }
  }
}
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
function ReadableFromBytes(bytes: Uint8Array): Readable {
  return Readable.from([Buffer.from(bytes)]);
}
