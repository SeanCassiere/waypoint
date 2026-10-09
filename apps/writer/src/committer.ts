import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { isContentHash, type Manifest, type SyncState } from "@waypoint/core";
import { z, ZodError } from "zod";

import type { BlobStore } from "./blob-store.ts";
import { type Bucket, BucketError } from "./bucket.ts";
import { type Db, type DbHandle } from "./db.ts";
import type { Committer, IngestService } from "./ingest.ts";
import { SyncLoop } from "./sync-loop.ts";
import { type QueuedRevision, readQueued, refreshSyncing, refreshSyncingFrom } from "./syncing.ts";

type Revision = {
  id: string;
  public_id: string;
  collection_id: string;
  parent_revision_id: string | null;
  head_path: string;
  message: string | null;
  metadata: string;
  manifest_json: string;
  created_at: number;
  state: string;
  attempts: number;
  first_attempt_at: number | null;
  next_attempt_at: number | null;
};
type Collection = {
  id: string;
  public_id: string;
  title: string;
  metadata: string;
  created_at: number;
  deleted_at: number | null;
};
type Rendition = {
  source_hash: string;
  renderer: string;
  renderer_version: number;
  output_hash: string;
  output_mime: string;
  created_at: number;
};
const encoded = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
function parseManifest(json: string): Manifest {
  const value: unknown = JSON.parse(json);
  const parsed = z
    .object({
      headPath: z.string(),
      files: z.record(
        z.string(),
        z.object({ hash: z.string(), mime: z.string(), size: z.number() }),
      ),
    })
    .parse(value);
  const files: Manifest["files"] = {};
  for (const [path, entry] of Object.entries(parsed.files)) {
    if (!isContentHash(entry.hash)) throw new Error("Invalid stored blob hash");
    files[path] = { hash: entry.hash, mime: entry.mime, size: entry.size };
  }
  return { headPath: parsed.headPath, files };
}
/** Queued renditions (a rerender backlog) committed per committer pass before revisions get a turn. */
export const RENDITIONS_PER_PASS = 50;
export const blobKey = (hash: string): string => `blobs/sha256/${hash.slice(7)}`;
export const manifestKey = (id: string): string => `manifests/${id}.json`;
export const collectionKey = (id: string): string => `collections/${id}.json`;
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown failure";
class CommitValidationError extends Error {}
class AbortedAttempt extends Error {}
export class SimulatedCrash extends Error {}
export type CommitterStep =
  | "commit_after_blob_upload"
  | "commit_after_dr_objects"
  | "commit_after_rows"
  | "commit_after_queue_cleanup"
  | "purge_after_bucket"
  | "purge_after_rows"
  | "gc_after_delete_queued"
  | "gc_after_rows"
  | "gc_after_bucket_delete"
  | "delete_after_reference_snapshot"
  | "purge_mid_gc"
  | "rendition_after_blob_upload"
  | "rendition_after_rows";

export class WriterCommitter implements Committer {
  private running = false;
  /** RX-11: the collection's queued revisions, read by `attempt()` just before its commit
   *  transaction; consumed by `refreshSyncing` inside it. */
  private commitQueued: { collectionId: string; queued: readonly QueuedRevision[] } | undefined;
  private stopping = false;
  private rerun = false;
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<() => void>();
  private abortController = new AbortController();
  accountError: string | null = null;
  lastUploadAt: number | null = null;
  private renditionsRetryAt: number | null = null;
  /** Where the next pass resumes in pending_renditions; null starts from the beginning. */
  private renditionCursor: Pick<Rendition, "source_hash" | "renderer" | "renderer_version"> | null =
    null;
  readonly waypoint: Db;
  readonly queue: Db;
  readonly blobs: BlobStore;
  readonly bucket: Bucket;
  readonly sync: SyncLoop;
  readonly lock: Pick<IngestService, "withCollectionLock"> &
    Partial<Pick<IngestService, "withGcExclusive" | "isBlobInUse">>;
  readonly now: () => number;
  readonly random: () => number;
  readonly giveUpHours: number;
  readonly onStep: ((step: CommitterStep) => Promise<void> | void) | undefined;
  readonly onCommitted: ((collectionId: string) => void) | undefined;
  constructor(
    waypoint: Db,
    queue: Db,
    blobs: BlobStore,
    bucket: Bucket,
    sync: SyncLoop,
    lock: Pick<IngestService, "withCollectionLock"> &
      Partial<Pick<IngestService, "withGcExclusive" | "isBlobInUse">>,
    now: () => number = Date.now,
    random: () => number = Math.random,
    giveUpHours = 72,
    onStep?: (step: CommitterStep) => Promise<void> | void,
    onCommitted?: (collectionId: string) => void,
  ) {
    this.waypoint = waypoint;
    this.queue = queue;
    this.blobs = blobs;
    this.bucket = bucket;
    this.sync = sync;
    this.lock = lock;
    this.now = now;
    this.random = random;
    this.giveUpHours = giveUpHours;
    this.onStep = onStep;
    this.onCommitted = onCommitted;
  }
  private async step(name: CommitterStep): Promise<void> {
    await this.onStep?.(name);
  }
  wake(): void {
    if (this.stopping || this.accountError) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) this.rerun = true;
    else {
      this.active = this.run();
      void this.active.catch((error: unknown) => {
        if (!(error instanceof SimulatedCrash))
          console.error(`Committer pass failed: ${reason(error)}`);
      });
    }
  }
  async drain(): Promise<void> {
    await this.active;
  }
  async waitForCommit(id: string, timeoutMs: number): Promise<SyncState> {
    const state = async (): Promise<SyncState> => {
      if (await this.waypoint.get("SELECT id FROM revisions WHERE id=?", [id]))
        return (await this.queue.get("SELECT revision_id FROM unpushed WHERE revision_id=?", [
          id,
        ])) || (await this.queue.get("SELECT id FROM pending_revisions WHERE id=?", [id]))
          ? "committed"
          : "synced";
      const row = await this.queue.get<{ state: string }>(
        "SELECT state FROM pending_revisions WHERE id=?",
        [id],
      );
      return row?.state === "failed" || !row ? "failed" : "pending";
    };
    let result = await state();
    if (result !== "pending") return result;
    if (this.accountError) return "pending";
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.waiters.delete(done);
            resolve();
          },
          Math.min(100, until - Date.now()),
        );
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        this.waiters.add(done);
      });
      result = await state();
      if (result !== "pending") return result;
      if (this.accountError) return "pending";
    }
    return result;
  }
  private notify(): void {
    for (const wake of this.waiters) wake();
  }
  private delay(): number {
    return 300_000 + Math.floor(this.random() * 300_000);
  }
  private async run(): Promise<void> {
    this.running = true;
    let passFailed = false;
    try {
      await this.recoverSyncing();
      do {
        this.rerun = false;
        const rows = await this.queue.all<Revision>(
          "SELECT * FROM pending_revisions WHERE state='pending' ORDER BY id",
        );
        for (const row of rows) {
          if (this.stopping || this.accountError) break;
          if (
            row.next_attempt_at !== null &&
            row.next_attempt_at > this.now() &&
            !(await this.waypoint.get("SELECT id FROM revisions WHERE id=?", [row.id]))
          )
            continue;
          await this.attempt(row);
        }
        if (!this.stopping && !this.accountError) await this.processOther();
      } while (this.rerun && !this.stopping);
    } catch (error) {
      passFailed = true;
      throw error;
    } finally {
      this.running = false;
      this.notify();
      let next: { at: number | null } | undefined;
      try {
        next = await this.queue.get<{ at: number | null }>(
          "SELECT MIN(at) AS at FROM (SELECT COALESCE(next_attempt_at,0) AS at FROM pending_revisions WHERE state='pending' UNION ALL SELECT COALESCE(next_attempt_at,0) FROM pending_snapshots UNION ALL SELECT COALESCE(next_attempt_at,0) FROM pending_r2_deletes UNION ALL SELECT COALESCE(next_attempt_at,0) FROM pending_purges)",
        );
      } catch (error) {
        passFailed = true;
        console.error(`Committer scheduling failed: ${reason(error)}`);
      }
      const nextAt =
        next?.at != null && this.renditionsRetryAt !== null
          ? Math.min(next.at, this.renditionsRetryAt)
          : (next?.at ?? this.renditionsRetryAt);
      if (!this.stopping && (this.accountError || passFailed || nextAt != null)) {
        const wait = this.accountError
          ? 300_000
          : passFailed
            ? 5_000
            : Math.max(1, nextAt! - this.now());
        this.timer = setTimeout(() => {
          if (this.accountError) this.accountError = null;
          this.wake();
        }, wait);
        this.timer.unref();
      }
    }
  }
  private async fail(row: Revision, error: unknown): Promise<void> {
    if (this.stopping) return;
    if (error instanceof BucketError && error.kind === "account") {
      this.accountError = error.message;
      this.notify();
      return;
    }
    const first = row.first_attempt_at ?? this.now();
    const permanent =
      error instanceof BucketError
        ? error.kind === "permanent"
        : error instanceof CommitValidationError ||
          error instanceof ZodError ||
          (error instanceof Error &&
            /blob.*missing|collection_purged|parent_failed/i.test(error.message));
    const exhausted = this.now() - first >= this.giveUpHours * 3_600_000;
    const failed = permanent || exhausted;
    await this.queue.run(
      "UPDATE pending_revisions SET state=?,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),next_attempt_at=?,last_error=?,error_kind=? WHERE id=?",
      [
        failed ? "failed" : "pending",
        first,
        failed ? null : this.now() + this.delay(),
        reason(error),
        permanent ? "permanent" : "transient",
        row.id,
      ],
    );
    if (failed) await this.cascade(row.id);
    if (failed)
      await this.lock.withCollectionLock(row.collection_id, () =>
        this.refreshSyncing(row.collection_id),
      );
    this.notify();
  }
  /** RX-11: recompute the collection's syncing row. The caller holds the collection lock; pass the
   *  commit's waypoint transaction as `tx` when called inside it. Triggers a push when it changed
   *  (outside a transaction).
   *
   *  Inside the commit transaction, the queue facts come from `commitQueued`, which `attempt()`
   *  reads before it opens the transaction: the transaction must never wait on the queue
   *  connection, because a queue transaction (Drop's `prunePendingStorage`) may be waiting on the
   *  waypoint one. Any other `tx` caller reads the queue inside its transaction and takes on that
   *  risk. */
  async refreshSyncing(collectionId: string, tx?: DbHandle): Promise<void> {
    const preread = tx ? this.commitQueued : undefined;
    if (tx && preread?.collectionId === collectionId) {
      this.commitQueued = undefined;
      await refreshSyncingFrom({
        waypoint: tx,
        queued: preread.queued,
        collectionId,
        giveUpHours: this.giveUpHours,
      });
      return;
    }
    const { changed } = await refreshSyncing({
      waypoint: tx ?? this.waypoint,
      queue: this.queue,
      collectionId,
      giveUpHours: this.giveUpHours,
    });
    if (changed && !tx) this.sync.triggerPush();
  }
  /**
   * RX-11 crash recovery: refreshes every collection with queued revisions or a syncing row, so a
   * write lost between a queue change and its refresh is corrected on the next pass.
   */
  private async recoverSyncing(): Promise<void> {
    const ids = new Set([
      ...(
        await this.queue.all<{ collection_id: string }>(
          "SELECT DISTINCT collection_id FROM pending_revisions",
        )
      ).map((row) => row.collection_id),
      ...(
        await this.waypoint.all<{ collection_id: string }>(
          "SELECT collection_id FROM collection_syncing",
        )
      ).map((row) => row.collection_id),
    ]);
    // One collection's failure must not hold up every commit behind a cosmetic note; the next
    // pass tries it again.
    for (const id of ids)
      await this.lock
        .withCollectionLock(id, () => this.refreshSyncing(id))
        .catch((error: unknown) => {
          console.error(`Syncing row refresh failed for ${id}: ${reason(error)}`);
        });
  }
  private async cascade(parentId: string): Promise<void> {
    const children = await this.queue.all<{ id: string }>(
      "SELECT id FROM pending_revisions WHERE parent_revision_id=?",
      [parentId],
    );
    for (const child of children) {
      await this.queue.run(
        "UPDATE pending_revisions SET state='failed',error_kind='permanent',last_error='parent_failed',next_attempt_at=NULL WHERE id=?",
        [child.id],
      );
      await this.cascade(child.id);
    }
  }
  private async attempt(row: Revision): Promise<void> {
    const uploaded = new Map<string, number>();
    let manifestWritten = false;
    let snapshotWritten = false;
    try {
      if (await this.waypoint.get("SELECT id FROM revisions WHERE id=?", [row.id])) {
        await this.lock.withCollectionLock(row.collection_id, () => this.cleanup(row));
        return;
      }
      if (row.parent_revision_id) {
        const parent = await this.queue.get<{ state: string }>(
          "SELECT state FROM pending_revisions WHERE id=?",
          [row.parent_revision_id],
        );
        if (parent?.state === "failed") throw new CommitValidationError("parent_failed");
        if (parent) {
          await this.queue.run("UPDATE pending_revisions SET next_attempt_at=? WHERE id=?", [
            parent.state === "pending" ? this.now() + this.delay() : this.now(),
            row.id,
          ]);
          return;
        }
        if (
          !(await this.waypoint.get("SELECT id FROM revisions WHERE id=?", [
            row.parent_revision_id,
          ]))
        )
          throw new CommitValidationError("parent_failed");
      }
      const collection =
        (await this.queue.get<Collection>("SELECT * FROM pending_collections WHERE id=?", [
          row.collection_id,
        ])) ??
        (await this.waypoint.get<Collection>("SELECT * FROM collections WHERE id=?", [
          row.collection_id,
        ]));
      if (
        !collection ||
        (await this.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [
          row.collection_id,
        ]))
      )
        throw new CommitValidationError("collection_purged");
      await this.queue.run(
        "UPDATE pending_revisions SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?",
        [this.now(), row.id],
      );
      const manifest = parseManifest(row.manifest_json);
      const renditions = await this.renditions(manifest);
      const hashes = new Set([
        ...Object.values(manifest.files).map((entry) => entry.hash),
        ...renditions.map((item) => item.output_hash),
      ]);
      for (const hash of hashes) {
        if (this.stopping) throw new AbortedAttempt("Committer stopping");
        const pending = await this.queue.get<{ size: number }>(
          "SELECT size FROM pending_blobs WHERE hash=?",
          [hash],
        );
        if (!pending) continue;
        let size: number;
        try {
          size = (await stat(this.blobs.path(hash))).size;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            throw new CommitValidationError(`Blob missing: ${hash}`);
          throw error;
        }
        if (size !== pending.size) throw new CommitValidationError(`Blob size changed: ${hash}`);
        await this.bucket.putIfAbsent(
          blobKey(hash),
          () => createReadStream(this.blobs.path(hash)),
          {
            contentType: "application/octet-stream",
            contentLength: size,
            checksumSHA256: Buffer.from(hash.slice(7), "hex").toString("base64"),
            signal: this.abortController.signal,
          },
        );
        uploaded.set(hash, size);
        this.lastUploadAt = this.now();
        await this.step("commit_after_blob_upload");
      }
      if (this.stopping) throw new AbortedAttempt("Committer stopping");
      const drRenditions = [];
      for (const rendition of renditions) {
        const output =
          (await this.queue.get<{ size: number }>("SELECT size FROM pending_blobs WHERE hash=?", [
            rendition.output_hash,
          ])) ??
          (await this.waypoint.get<{ size: number }>("SELECT size FROM blobs WHERE hash=?", [
            rendition.output_hash,
          ]));
        drRenditions.push({ ...rendition, output_size: output?.size ?? 0 });
      }
      const revisionObject = {
        id: row.id,
        public_id: row.public_id,
        collection_id: row.collection_id,
        parent_revision_id: row.parent_revision_id,
        head_path: row.head_path,
        message: row.message,
        metadata: row.metadata,
        created_at: row.created_at,
      };
      await this.bucket.put(
        manifestKey(row.id),
        encoded({
          format_version: 1,
          revision: revisionObject,
          files: manifest.files,
          renditions: drRenditions,
        }),
        this.abortController.signal,
      );
      manifestWritten = true;
      this.lastUploadAt = this.now();
      if (this.stopping) throw new AbortedAttempt("Committer stopping");
      const uploadedCollection = await this.queue.get<Collection>(
        "SELECT * FROM pending_collections WHERE id=?",
        [row.collection_id],
      );
      if (uploadedCollection) {
        await this.bucket.put(
          collectionKey(row.collection_id),
          encoded({
            format_version: 1,
            updated_at: this.now(),
            collection: {
              id: uploadedCollection.id,
              public_id: uploadedCollection.public_id,
              title: uploadedCollection.title,
              metadata: uploadedCollection.metadata,
              created_at: uploadedCollection.created_at,
            },
            tombstone:
              uploadedCollection.deleted_at === null
                ? null
                : {
                    collection_id: row.collection_id,
                    deleted_at: uploadedCollection.deleted_at,
                    note: null,
                  },
            share_links: await this.waypoint.all(
              "SELECT id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE collection_id=? ORDER BY id",
              [row.collection_id],
            ),
          }),
          this.abortController.signal,
        );
        snapshotWritten = true;
        this.lastUploadAt = this.now();
      }
      await this.step("commit_after_dr_objects");
      if (this.stopping) throw new AbortedAttempt("Committer stopping");
      await this.lock.withCollectionLock(row.collection_id, async () => {
        const current = await this.queue.get<Revision>(
          "SELECT * FROM pending_revisions WHERE id=?",
          [row.id],
        );
        if (!current || current.state !== "pending" || current.manifest_json !== row.manifest_json)
          throw new AbortedAttempt("Revision dropped or changed during upload");
        if (row.parent_revision_id) {
          if (
            await this.queue.get("SELECT 1 FROM pending_revisions WHERE id=?", [
              row.parent_revision_id,
            ])
          )
            throw new AbortedAttempt("Parent is not committed");
          if (
            !(await this.waypoint.get("SELECT id FROM revisions WHERE id=?", [
              row.parent_revision_id,
            ]))
          )
            throw new CommitValidationError("parent_failed");
        }
        const pendingCollection = await this.queue.get<Collection>(
          "SELECT * FROM pending_collections WHERE id=?",
          [row.collection_id],
        );
        if (
          (await this.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [
            row.collection_id,
          ])) ||
          (!pendingCollection &&
            !(await this.waypoint.get("SELECT id FROM collections WHERE id=?", [
              row.collection_id,
            ])))
        )
          throw new CommitValidationError("collection_purged");
        if (JSON.stringify(pendingCollection) !== JSON.stringify(uploadedCollection)) {
          this.rerun = true;
          throw new AbortedAttempt("Collection changed during snapshot upload");
        }
        // RX-11: the queue facts for the syncing row, read before the waypoint transaction opens
        // (see `refreshSyncing`); the collection lock keeps them current until it commits.
        this.commitQueued = {
          collectionId: row.collection_id,
          queued: await readQueued(this.queue, row.collection_id),
        };
        await this.waypoint.transaction(async (tx) => {
          if (pendingCollection) {
            await tx.run(
              "INSERT OR IGNORE INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
              [
                pendingCollection.id,
                pendingCollection.public_id,
                pendingCollection.title,
                pendingCollection.metadata,
                pendingCollection.created_at,
              ],
            );
            if (pendingCollection.deleted_at !== null)
              await tx.run(
                "INSERT OR IGNORE INTO collection_tombstones (collection_id,deleted_at,note) VALUES (?,?,NULL)",
                [pendingCollection.id, pendingCollection.deleted_at],
              );
          }
          const col = await tx.get<{ id: string; public_id: string }>(
            "SELECT id,public_id FROM collections WHERE id=?",
            [row.collection_id],
          );
          if (!col || col.public_id !== (pendingCollection?.public_id ?? col.public_id))
            throw new CommitValidationError("Collection INSERT OR IGNORE collision");
          for (const [hash, size] of uploaded)
            await tx.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,?)", [
              hash,
              size,
              this.now(),
            ]);
          for (const hash of hashes)
            if (!(await tx.get("SELECT hash FROM blobs WHERE hash=?", [hash])))
              throw new CommitValidationError(`Referenced blob has no row: ${hash}`);
          for (const rendition of renditions) {
            await tx.run(
              "INSERT OR IGNORE INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
              [
                rendition.source_hash,
                rendition.renderer,
                rendition.renderer_version,
                rendition.output_hash,
                rendition.output_mime,
                rendition.created_at,
              ],
            );
            const saved = await tx.get<{ output_hash: string }>(
              "SELECT output_hash FROM renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
              [rendition.source_hash, rendition.renderer, rendition.renderer_version],
            );
            if (saved?.output_hash !== rendition.output_hash)
              throw new CommitValidationError("Rendition INSERT OR IGNORE collision");
          }
          await tx.run(
            "INSERT OR IGNORE INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
            [
              row.id,
              row.public_id,
              row.collection_id,
              row.parent_revision_id,
              row.head_path,
              row.message,
              row.metadata,
              row.created_at,
            ],
          );
          const saved = await tx.get<{ id: string; public_id: string; collection_id: string }>(
            "SELECT id,public_id,collection_id FROM revisions WHERE id=?",
            [row.id],
          );
          if (
            !saved ||
            saved.public_id !== row.public_id ||
            saved.collection_id !== row.collection_id
          )
            throw new CommitValidationError("Revision INSERT OR IGNORE collision");
          for (const [path, entry] of Object.entries(manifest.files)) {
            await tx.run(
              "INSERT OR IGNORE INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
              [row.id, path, entry.hash, entry.mime, entry.size],
            );
            const file = await tx.get<{ blob_hash: string }>(
              "SELECT blob_hash FROM revision_files WHERE revision_id=? AND path=?",
              [row.id, path],
            );
            if (file?.blob_hash !== entry.hash)
              throw new CommitValidationError("Revision file INSERT OR IGNORE collision");
          }
          await this.refreshSyncing(row.collection_id, tx);
        });
        await this.step("commit_after_rows");
        await this.cleanup(row);
        await this.step("commit_after_queue_cleanup");
      });
    } catch (error) {
      this.commitQueued = undefined;
      if (error instanceof SimulatedCrash) throw error;
      if (
        error instanceof AbortedAttempt ||
        (error instanceof CommitValidationError && error.message === "collection_purged")
      )
        await this.queueStaleDeletes(row, uploaded, manifestWritten, snapshotWritten);
      if (error instanceof AbortedAttempt) {
        this.notify();
        return;
      }
      await this.fail(row, error);
    }
  }
  private async queueStaleDeletes(
    row: Revision,
    uploaded: Map<string, number>,
    manifestWritten: boolean,
    snapshotWritten: boolean,
  ): Promise<void> {
    await this.queue.transaction(async (tx) => {
      if (manifestWritten)
        await tx.run(
          "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [manifestKey(row.id), this.now()],
        );
      if (
        snapshotWritten &&
        !(await this.waypoint.get("SELECT id FROM collections WHERE id=?", [row.collection_id]))
      )
        await tx.run(
          "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [collectionKey(row.collection_id), this.now()],
        );
      for (const hash of uploaded.keys()) {
        if (await this.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [hash])) continue;
        await tx.run(
          "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [blobKey(hash), this.now()],
        );
      }
    });
  }
  private async renditions(manifest: Manifest): Promise<Rendition[]> {
    const sources = Object.values(manifest.files).map((entry) => entry.hash);
    const result: Rendition[] = [];
    for (const source of new Set(sources))
      result.push(
        ...(await this.queue.all<Rendition>(
          "SELECT * FROM pending_renditions WHERE source_hash=?",
          [source],
        )),
        ...(await this.waypoint.all<Rendition>("SELECT * FROM renditions WHERE source_hash=?", [
          source,
        ])),
      );
    return [
      ...new Map(
        result.map((r) => [`${r.source_hash}:${r.renderer}:${r.renderer_version}`, r]),
      ).values(),
    ];
  }
  private async cleanup(row: Revision): Promise<void> {
    const manifest = parseManifest(row.manifest_json);
    const committedRenditions = await this.renditions(manifest);
    const hashes = new Set([
      ...Object.values(manifest.files).map((file) => file.hash),
      ...committedRenditions.map((item) => item.output_hash),
    ]);
    await this.queue.transaction(async (tx) => {
      await tx.run("DELETE FROM pending_revisions WHERE id=?", [row.id]);
      await tx.run("DELETE FROM pending_collections WHERE id=?", [row.collection_id]);
      for (const hash of hashes)
        if (await this.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash]))
          await tx.run("DELETE FROM pending_blobs WHERE hash=?", [hash]);
      for (const rendition of committedRenditions)
        if (
          await this.waypoint.get(
            "SELECT 1 FROM renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
            [rendition.source_hash, rendition.renderer, rendition.renderer_version],
          )
        )
          await tx.run(
            "DELETE FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
            [rendition.source_hash, rendition.renderer, rendition.renderer_version],
          );
      await tx.run("INSERT OR IGNORE INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
        row.id,
        this.now(),
      ]);
      await tx.run("DELETE FROM pending_r2_deletes WHERE key=?", [manifestKey(row.id)]);
      await tx.run("DELETE FROM pending_r2_deletes WHERE key=?", [
        collectionKey(row.collection_id),
      ]);
    });
    this.notify();
    this.onCommitted?.(row.collection_id);
    this.sync.triggerPush();
    await this.queue.run(
      "UPDATE pending_revisions SET next_attempt_at=NULL WHERE parent_revision_id=? AND state='pending'",
      [row.id],
    );
    this.rerun = true;
  }
  /**
   * Renditions queued without a revision (`waypoint-writer rerender`) whose source blob is
   * already committed. Blob before row: the output is uploaded and gets its `blobs` row in the
   * same transaction as the `renditions` row, or before it. Renditions whose source is still
   * only in a pending revision are left for that revision's commit.
   */
  private async commitRenditions(): Promise<void> {
    if (this.renditionsRetryAt !== null && this.renditionsRetryAt > this.now()) return;
    this.renditionsRetryAt = null;
    let pendingSources: Set<string> | undefined;
    // A rerender backlog can hold thousands of rows. Each pass takes the next batch after a
    // cursor and asks for another pass, so new revisions are committed between batches.
    const after = this.renditionCursor;
    const batch = await this.queue.all<Rendition>(
      after
        ? "SELECT * FROM pending_renditions WHERE source_hash>? OR (source_hash=? AND (renderer>? OR (renderer=? AND renderer_version>?))) ORDER BY source_hash,renderer,renderer_version LIMIT ?"
        : "SELECT * FROM pending_renditions ORDER BY source_hash,renderer,renderer_version LIMIT ?",
      after
        ? [
            after.source_hash,
            after.source_hash,
            after.renderer,
            after.renderer,
            after.renderer_version,
            RENDITIONS_PER_PASS,
          ]
        : [RENDITIONS_PER_PASS],
    );
    const last = batch.at(-1);
    this.renditionCursor = batch.length === RENDITIONS_PER_PASS && last ? last : null;
    if (this.renditionCursor) this.rerun = true;
    for (const rendition of batch) {
      if (this.stopping || this.accountError) return;
      const key = [rendition.source_hash, rendition.renderer, rendition.renderer_version] as const;
      if (!(await this.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [rendition.source_hash]))) {
        pendingSources ??= await this.pendingSources();
        if (!pendingSources.has(rendition.source_hash))
          await this.dropRendition(rendition, "source blob is no longer stored");
        continue;
      }
      try {
        const pending = await this.queue.get<{ size: number }>(
          "SELECT size FROM pending_blobs WHERE hash=?",
          [rendition.output_hash],
        );
        let uploaded: number | undefined;
        if (pending) {
          let size: number;
          try {
            size = (await stat(this.blobs.path(rendition.output_hash))).size;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              await this.dropRendition(rendition, "output blob missing locally");
              continue;
            }
            throw error;
          }
          if (size !== pending.size) {
            await this.dropRendition(rendition, "output blob size changed");
            continue;
          }
          await this.bucket.putIfAbsent(
            blobKey(rendition.output_hash),
            () => createReadStream(this.blobs.path(rendition.output_hash)),
            {
              contentType: "application/octet-stream",
              contentLength: size,
              checksumSHA256: Buffer.from(rendition.output_hash.slice(7), "hex").toString("base64"),
              signal: this.abortController.signal,
            },
          );
          uploaded = size;
          this.lastUploadAt = this.now();
          await this.step("rendition_after_blob_upload");
        }
        if (this.stopping) return;
        const committed = await this.waypoint.transaction(async (tx) => {
          if (uploaded !== undefined)
            await tx.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,?)", [
              rendition.output_hash,
              uploaded,
              this.now(),
            ]);
          if (!(await tx.get("SELECT 1 FROM blobs WHERE hash=?", [rendition.source_hash])))
            return false;
          if (!(await tx.get("SELECT 1 FROM blobs WHERE hash=?", [rendition.output_hash])))
            throw new CommitValidationError(`Referenced blob has no row: ${rendition.output_hash}`);
          // Insert-only: if another writer already stored this key, its row stands.
          await tx.run(
            "INSERT OR IGNORE INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
            [...key, rendition.output_hash, rendition.output_mime, rendition.created_at],
          );
          return true;
        });
        if (!committed) {
          if (uploaded !== undefined)
            await this.queue.run(
              "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
              [blobKey(rendition.output_hash), this.now()],
            );
          continue;
        }
        await this.step("rendition_after_rows");
        await this.queue.transaction(async (tx) => {
          await tx.run(
            "DELETE FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=? AND output_hash=?",
            [...key, rendition.output_hash],
          );
          if (await this.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [rendition.output_hash]))
            await tx.run("DELETE FROM pending_blobs WHERE hash=?", [rendition.output_hash]);
        });
        this.sync.triggerPush();
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        if (error instanceof BucketError && error.kind === "account") {
          this.accountError = error.message;
          this.notify();
          return;
        }
        if (this.stopping) return;
        console.error(`Rendition commit failed: ${reason(error)}`);
        this.renditionsRetryAt = this.now() + this.delay();
        return;
      }
    }
  }
  private async pendingSources(): Promise<Set<string>> {
    const sources = new Set<string>();
    for (const item of await this.queue.all<{ manifest_json: string }>(
      "SELECT manifest_json FROM pending_revisions",
    ))
      for (const file of Object.values(parseManifest(item.manifest_json).files))
        sources.add(file.hash);
    return sources;
  }
  private async dropRendition(rendition: Rendition, why: string): Promise<void> {
    console.error(
      `Dropping queued rendition of ${rendition.source_hash} (${rendition.renderer} v${rendition.renderer_version}): ${why}`,
    );
    const sources = await this.pendingSources();
    await this.queue.transaction(async (tx) => {
      await tx.run(
        "DELETE FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=? AND output_hash=?",
        [
          rendition.source_hash,
          rendition.renderer,
          rendition.renderer_version,
          rendition.output_hash,
        ],
      );
      if (
        !sources.has(rendition.output_hash) &&
        !(await tx.get("SELECT 1 FROM pending_renditions WHERE output_hash=?", [
          rendition.output_hash,
        ]))
      )
        await tx.run("DELETE FROM pending_blobs WHERE hash=?", [rendition.output_hash]);
    });
  }
  private async processOther(): Promise<void> {
    await this.commitRenditions();
    if (this.stopping || this.accountError) return;
    for (const row of await this.queue.all<{
      collection_id: string;
      requested_at: number;
      next_attempt_at: number | null;
    }>("SELECT * FROM pending_snapshots")) {
      if (this.stopping || this.accountError) break;
      if (row.next_attempt_at !== null && row.next_attempt_at > this.now()) continue;
      try {
        const collection = await this.waypoint.get<Collection>(
          "SELECT * FROM collections WHERE id=?",
          [row.collection_id],
        );
        const tombstone = await this.waypoint.get(
          "SELECT * FROM collection_tombstones WHERE collection_id=?",
          [row.collection_id],
        );
        const shareLinks = await this.waypoint.all(
          "SELECT id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE collection_id=? ORDER BY id",
          [row.collection_id],
        );
        if (collection) {
          await this.bucket.put(
            collectionKey(row.collection_id),
            encoded({
              format_version: 1,
              updated_at: this.now(),
              collection,
              tombstone: tombstone ?? null,
              share_links: shareLinks,
            }),
            this.abortController.signal,
          );
          this.lastUploadAt = this.now();
        }
        await this.lock.withCollectionLock(row.collection_id, async () => {
          const current = await this.queue.get<{ requested_at: number }>(
            "SELECT requested_at FROM pending_snapshots WHERE collection_id=?",
            [row.collection_id],
          );
          if (!current) {
            if (
              !(await this.waypoint.get("SELECT 1 FROM collections WHERE id=?", [
                row.collection_id,
              ])) ||
              (await this.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [
                row.collection_id,
              ]))
            )
              await this.queue.run(
                "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
                [collectionKey(row.collection_id), this.now()],
              );
            return;
          }
          if (current.requested_at !== row.requested_at) return;
          const latest = await this.waypoint.get<Collection>(
            "SELECT * FROM collections WHERE id=?",
            [row.collection_id],
          );
          const latestTombstone = await this.waypoint.get(
            "SELECT * FROM collection_tombstones WHERE collection_id=?",
            [row.collection_id],
          );
          const latestShareLinks = await this.waypoint.all(
            "SELECT id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE collection_id=? ORDER BY id",
            [row.collection_id],
          );
          if (
            JSON.stringify(latest) !== JSON.stringify(collection) ||
            JSON.stringify(latestTombstone) !== JSON.stringify(tombstone) ||
            JSON.stringify(latestShareLinks) !== JSON.stringify(shareLinks)
          ) {
            this.rerun = true;
            return;
          }
          await this.queue.run(
            "DELETE FROM pending_snapshots WHERE collection_id=? AND requested_at=?",
            [row.collection_id, row.requested_at],
          );
        });
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        await this.otherFailure(
          "pending_snapshots",
          "collection_id",
          row.collection_id,
          row.requested_at,
          error,
        );
      }
    }
    const deletes = await this.queue.all<{
      key: string;
      requested_at: number;
      next_attempt_at: number | null;
    }>("SELECT * FROM pending_r2_deletes");
    const dueDeletes = deletes.some(
      (row) => row.next_attempt_at === null || row.next_attempt_at <= this.now(),
    );
    const needed =
      dueDeletes && deletes.some((row) => row.key.startsWith("blobs/sha256/"))
        ? await this.neededHashes()
        : new Set<string>();
    if (dueDeletes) await this.step("delete_after_reference_snapshot");
    for (const row of deletes) {
      if (this.stopping || this.accountError) break;
      if (row.next_attempt_at !== null && row.next_attempt_at > this.now()) continue;
      try {
        const hash = row.key.startsWith("blobs/sha256/")
          ? `sha256:${row.key.slice(13)}`
          : undefined;
        const referenced = hash
          ? needed.has(hash) || Boolean(this.lock.isBlobInUse?.(hash))
          : false;
        const hasRow = hash
          ? Boolean(await this.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [hash]))
          : false;
        const pending = hash
          ? Boolean(await this.queue.get("SELECT 1 FROM pending_blobs WHERE hash=?", [hash]))
          : false;
        if (hash && (hasRow || referenced || pending)) {
          if (hasRow && referenced)
            await this.queue.run("DELETE FROM pending_r2_deletes WHERE key=? AND requested_at=?", [
              row.key,
              row.requested_at,
            ]);
          else
            await this.queue.run(
              "UPDATE pending_r2_deletes SET next_attempt_at=? WHERE key=? AND requested_at=?",
              [this.now() + this.delay(), row.key, row.requested_at],
            );
          continue;
        }
        await this.bucket.delete(row.key, this.abortController.signal);
        if (hash) await this.step("gc_after_bucket_delete");
        await this.queue.run("DELETE FROM pending_r2_deletes WHERE key=? AND requested_at=?", [
          row.key,
          row.requested_at,
        ]);
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        await this.otherFailure("pending_r2_deletes", "key", row.key, row.requested_at, error);
      }
    }
    for (const row of await this.queue.all<{
      collection_id: string;
      requested_at: number;
      next_attempt_at: number | null;
      step: number;
    }>("SELECT * FROM pending_purges")) {
      if (this.stopping || this.accountError) break;
      if (row.next_attempt_at !== null && row.next_attempt_at > this.now()) continue;
      try {
        const wait = await this.lock.withCollectionLock(row.collection_id, () => this.purge(row));
        // A grace wait is a scheduled retry, not a failure: attempts and
        // last_error stay as they are.
        if (wait)
          await this.queue.run(
            "UPDATE pending_purges SET next_attempt_at=? WHERE collection_id=? AND requested_at=?",
            [wait.waitUntil, row.collection_id, row.requested_at],
          );
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        await this.otherFailure(
          "pending_purges",
          "collection_id",
          row.collection_id,
          row.requested_at,
          error,
        );
      }
    }
  }
  private async otherFailure(
    table: "pending_snapshots" | "pending_r2_deletes" | "pending_purges",
    column: "collection_id" | "key",
    id: string,
    requestedAt: number,
    error: unknown,
  ): Promise<void> {
    if (error instanceof BucketError && error.kind === "account") {
      this.accountError = error.message;
      this.notify();
      return;
    }
    if (this.stopping) return;
    await this.queue.run(
      `UPDATE ${table} SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE ${column}=? AND requested_at=?`,
      [this.now() + this.delay(), reason(error), id, requestedAt],
    );
  }
  private async neededHashes(): Promise<Set<string>> {
    const sources = new Set<string>();
    for (const row of await this.waypoint.all<{ blob_hash: string }>(
      "SELECT blob_hash FROM revision_files",
    ))
      sources.add(row.blob_hash);
    const queued = await this.queue.all<{ manifest_json: string }>(
      "SELECT manifest_json FROM pending_revisions",
    );
    for (const item of queued)
      for (const file of Object.values(parseManifest(item.manifest_json).files))
        sources.add(file.hash);
    const needed = new Set(sources);
    const outputs = await this.queue.all<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM pending_renditions",
    );
    const reused = await this.waypoint.all<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM renditions",
    );
    for (const item of [...outputs, ...reused])
      if (sources.has(item.source_hash)) needed.add(item.output_hash);
    return needed;
  }
  private async dropQueuedCollection(id: string): Promise<void> {
    const unused = await this.queue.transaction(async (tx) => {
      await tx.run("DELETE FROM pending_revisions WHERE collection_id=?", [id]);
      await tx.run("DELETE FROM pending_collections WHERE id=?", [id]);
      const queued = await tx.all<{ manifest_json: string }>(
        "SELECT manifest_json FROM pending_revisions",
      );
      const sources = new Set<string>();
      for (const item of queued)
        for (const file of Object.values(parseManifest(item.manifest_json).files))
          sources.add(file.hash);
      for (const item of await tx.all<Rendition>("SELECT * FROM pending_renditions")) {
        // Rerender rows stand alone: their source is already committed, not in a dropped revision.
        if (
          !sources.has(item.source_hash) &&
          !(await this.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [item.source_hash]))
        )
          await tx.run(
            "DELETE FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
            [item.source_hash, item.renderer, item.renderer_version],
          );
        else sources.add(item.output_hash);
      }
      const unusedHashes = (await tx.all<{ hash: string }>("SELECT hash FROM pending_blobs"))
        .map((item) => item.hash)
        .filter((hash) => !sources.has(hash));
      for (const hash of unusedHashes) {
        await tx.run(
          "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [blobKey(hash), this.now()],
        );
        await tx.run("DELETE FROM pending_blobs WHERE hash=?", [hash]);
      }
      return unusedHashes;
    });
    const remove = async () => {
      for (const hash of unused)
        if (
          !this.lock.isBlobInUse?.(hash) &&
          !(await this.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash]))
        )
          await this.blobs.delete(hash);
    };
    if (this.lock.withGcExclusive) await this.lock.withGcExclusive(remove);
    else await remove();
    this.rerun = true;
  }
  /**
   * Runs the purge from its recorded step. Returns `{ waitUntil }` when blob GC
   * deferred a file still inside the 15-minute grace window; the final push and
   * the row's delete then wait for the next attempt.
   */
  private async purge(row: {
    collection_id: string;
    requested_at: number;
    step: number;
  }): Promise<{ waitUntil: number } | null> {
    const id = row.collection_id;
    if (row.step === 0) {
      await this.queue.run("DELETE FROM pending_snapshots WHERE collection_id=?", [id]);
      const committed = await this.waypoint.all<{ id: string }>(
        "SELECT id FROM revisions WHERE collection_id=?",
        [id],
      );
      const queued = await this.queue.all<{ id: string }>(
        "SELECT id FROM pending_revisions WHERE collection_id=?",
        [id],
      );
      for (const rev of [...committed, ...queued])
        await this.bucket.delete(manifestKey(rev.id), this.abortController.signal);
      await this.bucket.delete(collectionKey(id), this.abortController.signal);
      await this.dropQueuedCollection(id);
      await this.queue.run(
        "UPDATE pending_purges SET step=1,attempts=0,last_error=NULL WHERE collection_id=?",
        [id],
      );
      await this.step("purge_after_bucket");
    }
    if (row.step <= 1) {
      const purged = await this.waypoint.all<{ id: string }>(
        "SELECT id FROM revisions WHERE collection_id=?",
        [id],
      );
      for (const rev of purged)
        await this.queue.run("DELETE FROM unpushed WHERE revision_id=?", [rev.id]);
      await this.waypoint.transaction(async (tx) => {
        await tx.run("DELETE FROM collection_syncing WHERE collection_id=?", [id]);
        await tx.run("DELETE FROM share_links WHERE collection_id=?", [id]);
        await tx.run(
          "DELETE FROM revision_files WHERE revision_id IN (SELECT id FROM revisions WHERE collection_id=?)",
          [id],
        );
        await tx.run("DELETE FROM revisions WHERE collection_id=?", [id]);
        await tx.run("DELETE FROM collection_tombstones WHERE collection_id=?", [id]);
        await tx.run("DELETE FROM collections WHERE id=?", [id]);
      });
      await this.sync.push();
      await this.queue.run(
        "UPDATE pending_purges SET step=2,attempts=0,last_error=NULL WHERE collection_id=?",
        [id],
      );
      await this.step("purge_after_rows");
    }
    const gc = async (): Promise<number | null> => {
      let youngest: number | null = null;
      const needed = await this.neededHashes();
      for (const blob of await this.waypoint.all<{ hash: string }>("SELECT hash FROM blobs")) {
        if (needed.has(blob.hash)) continue;
        if (this.lock.isBlobInUse?.(blob.hash)) continue;
        try {
          const { mtimeMs } = await stat(this.blobs.path(blob.hash));
          if (this.now() - mtimeMs < 15 * 60_000) {
            youngest = Math.max(youngest ?? mtimeMs, mtimeMs);
            continue;
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (this.lock.isBlobInUse?.(blob.hash)) continue;
        await this.queue.run(
          "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [blobKey(blob.hash), this.now()],
        );
        await this.step("gc_after_delete_queued");
        await this.waypoint.transaction(async (tx) => {
          await tx.run("DELETE FROM renditions WHERE source_hash=? OR output_hash=?", [
            blob.hash,
            blob.hash,
          ]);
          await tx.run("DELETE FROM blobs WHERE hash=?", [blob.hash]);
        });
        await this.step("gc_after_rows");
        await this.blobs.delete(blob.hash);
        await this.step("purge_mid_gc");
      }
      // mtimeMs is fractional; next_attempt_at is an INTEGER column.
      return youngest === null ? null : Math.ceil(youngest) + 15 * 60_000;
    };
    const graceUntil = this.lock.withGcExclusive ? await this.lock.withGcExclusive(gc) : await gc();
    if (graceUntil !== null) return { waitUntil: graceUntil };
    await this.sync.push();
    await this.queue.run("DELETE FROM pending_purges WHERE collection_id=?", [id]);
    this.rerun = true;
    return null;
  }
  stop(): void {
    this.stopping = true;
    this.abortController.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
