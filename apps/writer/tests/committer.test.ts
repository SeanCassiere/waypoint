import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { newId, mintRevisionId, publicIdFor, parseId } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { BucketError, MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter, blobKey, collectionKey, manifestKey } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, waypointMigrations, queueMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { restore } from "../src/restore.ts";
import { SyncLoop } from "../src/sync-loop.ts";

let dir: string;
let waypoint: Db;
let queue: Db;
let blobs: BlobStore;
let bucket: MemoryBucket;
let worker: WriterCommitter;
let clock: number;
let collectionId: string;
let revisionId: string;
let hash: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-committer-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024,
    sync: false,
  };
  const opened = await openDatabases(config);
  waypoint = opened.waypoint;
  queue = opened.queue;
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  blobs = new BlobStore(dir, 1024);
  bucket = new MemoryBucket();
  clock = Date.now();
  const sync = new SyncLoop(queue, opened.syncClient, () => clock);
  const ingest = new IngestService(
    waypoint,
    queue,
    blobs,
    new ReadModel(waypoint, queue, config.baseUrl),
    opened.syncClient,
  );
  worker = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    bucket,
    sync,
    ingest,
    () => clock,
    () => 0,
    72,
  );
  collectionId = newId("col");
  revisionId = mintRevisionId({ now: clock });
  const blob = await blobs.put(Readable.from(["hello"]));
  hash = blob.hash;
  await queue.run("INSERT INTO pending_blobs (hash,size) VALUES (?,?)", [hash, blob.size]);
  await queue.run(
    "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
    [collectionId, await publicIdFor(parseId(collectionId, "col")), "hello", "{}", clock],
  );
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      revisionId,
      await publicIdFor(parseId(revisionId, "rev")),
      collectionId,
      null,
      "a.txt",
      null,
      "{}",
      JSON.stringify({
        headPath: "a.txt",
        files: { "a.txt": { hash, mime: "text/plain", size: 5 } },
      }),
      clock,
    ],
  );
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});
async function processed(): Promise<void> {
  worker.wake();
  await worker.waitForCommit(revisionId, 1000);
  await worker.drain();
}
describe("committer", () => {
  it("uploads before inserting, writes DR objects and cleans queue", async () => {
    await processed();
    expect(await bucket.head(blobKey(hash))).toBe(true);
    expect(await bucket.head(manifestKey(revisionId))).toBe(true);
    expect(await bucket.head(collectionKey(collectionId))).toBe(true);
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeTruthy();
    expect(
      await queue.get("SELECT id FROM pending_revisions WHERE id=?", [revisionId]),
    ).toBeUndefined();
  });
  it("passes the SHA256 checksum of each uploaded hash to the bucket", async () => {
    const put = vi.spyOn(bucket, "putIfAbsent");
    await processed();
    expect(put).toHaveBeenCalledWith(
      blobKey(hash),
      expect.any(Function),
      expect.objectContaining({
        checksumSHA256: Buffer.from(hash.slice(7), "hex").toString("base64"),
      }),
    );
  });
  it("does not invent a blobs row for a hash it did not upload", async () => {
    await queue.run("DELETE FROM pending_blobs WHERE hash=?", [hash]);
    await processed();
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])).toBeUndefined();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeUndefined();
    expect(
      await queue.get("SELECT state,last_error FROM pending_revisions WHERE id=?", [revisionId]),
    ).toMatchObject({
      state: "failed",
      last_error: `Referenced blob has no row: ${hash}`,
    });
  });
  it("fails permanently when INSERT OR IGNORE hides a revision public ID collision", async () => {
    const col = await queue.get<{ public_id: string }>(
      "SELECT public_id FROM pending_collections WHERE id=?",
      [collectionId],
    );
    const rev = await queue.get<{ public_id: string }>(
      "SELECT public_id FROM pending_revisions WHERE id=?",
      [revisionId],
    );
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [collectionId, col!.public_id, "existing", "{}", clock],
    );
    const another = mintRevisionId({ now: clock + 1 });
    await waypoint.run(
      "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [another, rev!.public_id, collectionId, null, "a.txt", null, "{}", clock],
    );
    await processed();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeUndefined();
    expect(
      await queue.get("SELECT state,last_error FROM pending_revisions WHERE id=?", [revisionId]),
    ).toMatchObject({
      state: "failed",
      last_error: "Revision INSERT OR IGNORE collision",
    });
  });
  it("treats a preexisting blob object as success", async () => {
    await bucket.put(blobKey(hash), new TextEncoder().encode("hello"));
    await processed();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeTruthy();
  });
  it("marks a revision failed if its pending collection was purged", async () => {
    await queue.run("DELETE FROM pending_collections WHERE id=?", [collectionId]);
    await processed();
    expect(
      await queue.get("SELECT state,error_kind,last_error FROM pending_revisions WHERE id=?", [
        revisionId,
      ]),
    ).toEqual({ state: "failed", error_kind: "permanent", last_error: "collection_purged" });
  });
  it("retries a bucket outage and gives up after 72 hours", async () => {
    bucket.fail = new BucketError("offline", "transient");
    await processed();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeUndefined();
    expect(
      (
        await queue.get<{ state: string }>("SELECT state FROM pending_revisions WHERE id=?", [
          revisionId,
        ])
      )?.state,
    ).toBe("pending");
    clock += 73 * 3_600_000;
    await processed();
    expect(
      (
        await queue.get<{ state: string }>("SELECT state FROM pending_revisions WHERE id=?", [
          revisionId,
        ])
      )?.state,
    ).toBe("failed");
  });
  it("logs a pass failure and re-arms without an unhandled rejection", async () => {
    bucket.fail = new BucketError("offline", "transient");
    const original = queue.run.bind(queue);
    let inject = true;
    const run = vi.spyOn(queue, "run").mockImplementation(async (sql, args) => {
      if (inject && sql.startsWith("UPDATE pending_revisions SET state=")) {
        inject = false;
        throw new Error("database is locked");
      }
      return original(sql, args);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker.wake();
      await expect(worker.drain()).rejects.toThrow("database is locked");
      expect(log).toHaveBeenCalledWith("Committer pass failed: database is locked");
      expect(vi.getTimerCount()).toBe(1);
      run.mockRestore();
      delete bucket.fail;
      worker.wake();
      await worker.drain();
      expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeTruthy();
    } finally {
      worker.stop();
      run.mockRestore();
      log.mockRestore();
      vi.useRealTimers();
    }
  });
  it("fails immediately on a permanent bucket error", async () => {
    bucket.fail = new BucketError("denied", "permanent");
    await processed();
    expect(
      (
        await queue.get<{ state: string }>("SELECT state FROM pending_revisions WHERE id=?", [
          revisionId,
        ])
      )?.state,
    ).toBe("failed");
  });
  it("bounds revision retries to five through ten minutes", async () => {
    bucket.fail = new BucketError("offline", "transient");
    await processed();
    expect(
      await queue.get("SELECT next_attempt_at FROM pending_revisions WHERE id=?", [revisionId]),
    ).toEqual({ next_attempt_at: clock + 300_000 });
    worker.stop();
    await worker.drain();
    worker = new WriterCommitter(
      waypoint,
      queue,
      blobs,
      bucket,
      worker.sync,
      worker.lock,
      () => clock,
      () => 1,
      72,
    );
    await queue.run("UPDATE pending_revisions SET next_attempt_at=NULL WHERE id=?", [revisionId]);
    await processed();
    expect(
      await queue.get("SELECT next_attempt_at FROM pending_revisions WHERE id=?", [revisionId]),
    ).toEqual({ next_attempt_at: clock + 600_000 });
  });
  it("arms no idle timer and retries the earliest due item across four tables", async () => {
    bucket.fail = new BucketError("offline", "transient");
    const other = newId("col");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [other, await publicIdFor(parseId(other, "col")), "other", "{}", clock],
    );
    await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
      other,
      clock,
    ]);
    await queue.run("INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?)", [
      "stale",
      clock,
    ]);
    const purgeCollection = newId("col");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [purgeCollection, await publicIdFor(parseId(purgeCollection, "col")), "purge", "{}", clock],
    );
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      purgeCollection,
      clock,
    ]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker.wake();
      await worker.drain();
      for (const table of [
        "pending_revisions",
        "pending_snapshots",
        "pending_r2_deletes",
        "pending_purges",
      ])
        expect(
          await queue.get<{ attempts: number }>(`SELECT attempts FROM ${table}`),
        ).toMatchObject({ attempts: 1 });
      expect(vi.getTimerCount()).toBe(1);
      await queue.run("UPDATE pending_revisions SET next_attempt_at=?", [clock + 5 * 60_000]);
      await queue.run("UPDATE pending_snapshots SET next_attempt_at=?", [clock + 2 * 60_000]);
      await queue.run("UPDATE pending_r2_deletes SET next_attempt_at=?", [clock + 3 * 60_000]);
      await queue.run("UPDATE pending_purges SET next_attempt_at=?", [clock + 4 * 60_000]);
      worker.wake();
      await worker.drain();
      clock += 2 * 60_000;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await worker.drain();
      expect(await queue.get("SELECT attempts FROM pending_snapshots")).toEqual({ attempts: 2 });
      expect(await queue.get("SELECT attempts FROM pending_r2_deletes")).toEqual({ attempts: 1 });
      expect(await queue.get("SELECT attempts FROM pending_purges")).toEqual({ attempts: 1 });
      expect(await queue.get("SELECT attempts FROM pending_revisions")).toEqual({ attempts: 1 });
      clock += 100 * 3_600_000;
      await queue.run("UPDATE pending_snapshots SET next_attempt_at=NULL");
      await queue.run("UPDATE pending_r2_deletes SET next_attempt_at=NULL");
      await queue.run("UPDATE pending_purges SET next_attempt_at=NULL");
      worker.wake();
      await worker.drain();
      for (const table of ["pending_snapshots", "pending_r2_deletes", "pending_purges"]) {
        const item = await queue.get<{ attempts: number; last_error: string }>(
          `SELECT attempts,last_error FROM ${table}`,
        );
        expect(item?.attempts).toBeGreaterThan(1);
        expect(item?.last_error).toBe("offline");
      }
      expect(await queue.all("SELECT collection_id FROM pending_purges")).toHaveLength(1);
    } finally {
      worker.stop();
      vi.useRealTimers();
    }
  });
  it("runs another pass when woken during a snapshot pass", async () => {
    await queue.run("DELETE FROM pending_revisions");
    await queue.run("DELETE FROM pending_collections");
    await queue.run("DELETE FROM pending_blobs");
    const first = newId("col");
    const second = newId("col");
    for (const id of [first, second])
      await waypoint.run(
        "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
        [id, await publicIdFor(parseId(id, "col")), id, "{}", clock],
      );
    await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
      first,
      clock,
    ]);
    const original = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, body) => {
      await original(key, body);
      if (key === collectionKey(first)) {
        await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
          second,
          clock,
        ]);
        worker.wake();
      }
    });
    worker.wake();
    await worker.drain();
    expect(bucket.objects.has(collectionKey(second))).toBe(true);
    expect(await queue.all("SELECT collection_id FROM pending_snapshots")).toHaveLength(0);
  });
  it("does not arm a timer with an empty queue", async () => {
    await queue.run("DELETE FROM pending_revisions");
    await queue.run("DELETE FROM pending_collections");
    await queue.run("DELETE FROM pending_blobs");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker.wake();
      await worker.drain();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      worker.stop();
      vi.useRealTimers();
    }
  });
  it("stops between upload steps when shutdown begins mid-pass", async () => {
    const original = bucket.putIfAbsent.bind(bucket);
    vi.spyOn(bucket, "putIfAbsent").mockImplementation(async (...args) => {
      await original(...args);
      worker.stop();
    });
    worker.wake();
    await worker.drain();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeUndefined();
    expect(await queue.get("SELECT state FROM pending_revisions WHERE id=?", [revisionId])).toEqual(
      { state: "pending" },
    );
    expect(bucket.objects.has(manifestKey(revisionId))).toBe(false);
  });
  it("pauses on an account bucket error without failing the revision", async () => {
    bucket.fail = new BucketError("AccessDenied", "account");
    await processed();
    expect(worker.accountError).toBe("AccessDenied");
    expect(await queue.get("SELECT state FROM pending_revisions WHERE id=?", [revisionId])).toEqual(
      { state: "pending" },
    );
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeUndefined();
  });
  it("returns pending immediately while paused and retries after five minutes", async () => {
    bucket.fail = new BucketError("RequestTimeTooSkewed", "account");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker.wake();
      await worker.drain();
      const start = performance.now();
      expect(await worker.waitForCommit(revisionId, 5000)).toBe("pending");
      expect(performance.now() - start).toBeLessThan(1000);
      expect(
        await queue.get("SELECT state FROM pending_revisions WHERE id=?", [revisionId]),
      ).toEqual({ state: "pending" });
      expect(vi.getTimerCount()).toBe(1);
      delete bucket.fail;
      clock += 300_000;
      await vi.advanceTimersByTimeAsync(300_000);
      await worker.drain();
      expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeTruthy();
      expect(worker.accountError).toBeNull();
    } finally {
      worker.stop();
      vi.useRealTimers();
    }
  });
  it("cascades parent failure to queued descendants", async () => {
    const child = mintRevisionId({ now: clock + 1, parentId: revisionId });
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
      [
        child,
        await publicIdFor(parseId(child, "rev")),
        collectionId,
        revisionId,
        "a.txt",
        null,
        "{}",
        JSON.stringify({
          headPath: "a.txt",
          files: { "a.txt": { hash, mime: "text/plain", size: 5 } },
        }),
        clock + 1,
      ],
    );
    bucket.fail = new BucketError("denied", "permanent");
    await processed();
    expect(
      await queue.get("SELECT state,last_error FROM pending_revisions WHERE id=?", [child]),
    ).toEqual({ state: "failed", last_error: "parent_failed" });
    await queue.run(
      "UPDATE pending_revisions SET state='pending',attempts=0,first_attempt_at=NULL,next_attempt_at=NULL,last_error=NULL,error_kind=NULL WHERE id IN (?,?)",
      [revisionId, child],
    );
    delete bucket.fail;
    worker.wake();
    await worker.drain();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [child])).toBeTruthy();
  });
  it("replays queue cleanup after the waypoint transaction already committed", async () => {
    const col = await queue.get<{ public_id: string }>(
      "SELECT public_id FROM pending_collections WHERE id=?",
      [collectionId],
    );
    const rev = await queue.get<{ public_id: string }>(
      "SELECT public_id FROM pending_revisions WHERE id=?",
      [revisionId],
    );
    await waypoint.run(
      "INSERT OR IGNORE INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [collectionId, col!.public_id, "hello", "{}", clock],
    );
    await waypoint.run(
      "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [revisionId, rev!.public_id, collectionId, null, "a.txt", null, "{}", clock],
    );
    await processed();
    expect(
      await queue.get("SELECT id FROM pending_revisions WHERE id=?", [revisionId]),
    ).toBeUndefined();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [revisionId])).toBeTruthy();
  });
  it("commits a pending deleted collection as a tombstone", async () => {
    await queue.run("UPDATE pending_collections SET deleted_at=? WHERE id=?", [
      clock,
      collectionId,
    ]);
    await processed();
    expect(
      await waypoint.get("SELECT deleted_at FROM collection_tombstones WHERE collection_id=?", [
        collectionId,
      ]),
    ).toEqual({ deleted_at: clock });
  });
  it("writes snapshots after a committed collection edit and tombstone", async () => {
    await processed();
    clock += 1;
    await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
      collectionId,
      clock,
    ]);
    await waypoint.run("UPDATE collections SET title='edited' WHERE id=?", [collectionId]);
    worker.wake();
    await worker.drain();
    expect(Buffer.from(bucket.objects.get(collectionKey(collectionId))!).toString()).toContain(
      '"title":"edited"',
    );
    clock += 1;
    await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
      collectionId,
      clock,
    ]);
    await waypoint.run(
      "INSERT INTO collection_tombstones (collection_id,deleted_at) VALUES (?,?)",
      [collectionId, clock],
    );
    worker.wake();
    await worker.drain();
    expect(Buffer.from(bucket.objects.get(collectionKey(collectionId))!).toString()).toContain(
      "deleted_at",
    );
    clock += 1;
    await queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
      collectionId,
      clock,
    ]);
    await waypoint.run("DELETE FROM collection_tombstones WHERE collection_id=?", [collectionId]);
    worker.wake();
    await worker.drain();
    expect(Buffer.from(bucket.objects.get(collectionKey(collectionId))!).toString()).toContain(
      '"tombstone":null',
    );
  });
  it("restores a committed collection from bucket objects", async () => {
    await processed();
    const missingParent = mintRevisionId({ now: clock + 2 });
    const orphan = mintRevisionId({ now: clock + 3, parentId: missingParent });
    await bucket.put(
      manifestKey(orphan),
      new TextEncoder().encode(
        JSON.stringify({
          revision: {
            id: orphan,
            public_id: await publicIdFor(parseId(orphan, "rev")),
            collection_id: collectionId,
            parent_revision_id: missingParent,
            head_path: "a.txt",
            message: null,
            metadata: "{}",
            created_at: clock + 3,
          },
          files: { "a.txt": { hash, mime: "text/plain", size: 5 } },
          renditions: [],
        }),
      ),
    );
    const otherDir = await mkdtemp(join(tmpdir(), "waypoint-restore-"));
    const config: Config = {
      environment: "dev",
      dataDir: otherDir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    };
    const other = await openDatabases(config);
    try {
      await migrate(other.waypoint, waypointMigrations);
      await migrate(other.queue, queueMigrations);
      const summary = await restore(
        other.waypoint,
        bucket,
        new SyncLoop(other.queue, other.syncClient),
        "from-bucket",
      );
      expect(summary).toEqual({ collections: 1, revisions: 1, ignored: 1 });
      expect(await other.waypoint.all("SELECT path,blob_hash FROM revision_files")).toEqual([
        { path: "a.txt", blob_hash: hash },
      ]);
      expect(
        (
          await restore(
            other.waypoint,
            bucket,
            new SyncLoop(other.queue, other.syncClient),
            "merge",
          )
        ).revisions,
      ).toBe(0);
      await expect(
        restore(other.waypoint, bucket, new SyncLoop(other.queue, other.syncClient), "from-bucket"),
      ).rejects.toThrow("empty cloud DB");
    } finally {
      await other.waypoint.close();
      await other.queue.close();
      await rm(otherDir, { recursive: true, force: true });
    }
  });
  it("refills a wiped local blob from the bucket on a raw request", async () => {
    await processed();
    await blobs.delete(hash);
    const reads = new ReadModel(waypoint, queue, "http://localhost:7410");
    const ingest = new IngestService(waypoint, queue, blobs, reads, {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    });
    const app = createApp({ waypoint, queue, blobs, reads, ingest, bucket });
    const rev = await waypoint.get<{ public_id: string }>(
      "SELECT public_id FROM revisions WHERE id=?",
      [revisionId],
    );
    const get = vi.spyOn(bucket, "get");
    const responses = await Promise.all(
      Array.from({ length: 5 }, async () => await app.request(`/raw/r/${rev!.public_id}/a.txt`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
    }
    expect(get).toHaveBeenCalledTimes(1);
    expect(await blobs.has(hash)).toBe(true);
    await blobs.delete(hash);
    bucket.fail = new BucketError("offline", "transient");
    const unavailable = await app.request(`/raw/r/${rev!.public_id}/a.txt`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "bucket_unavailable" } });
    delete bucket.fail;
    await bucket.delete(blobKey(hash));
    const missing = await app.request(`/raw/r/${rev!.public_id}/a.txt`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    bucket.objects.set(blobKey(hash), new TextEncoder().encode("corrupt"));
    const corrupt = await app.request(`/raw/r/${rev!.public_id}/a.txt`);
    expect(corrupt.status).toBe(502);
    expect(await corrupt.json()).toMatchObject({ error: { code: "bucket_corrupt" } });
    await waypoint.run("DELETE FROM blobs WHERE hash=?", [hash]);
    get.mockClear();
    const absent = await app.request(`/raw/r/${rev!.public_id}/a.txt`);
    expect(absent.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
  it("purges DR objects and metadata while keeping a shared blob", async () => {
    await processed();
    const otherId = newId("col");
    const otherRev = mintRevisionId({ now: clock + 1 });
    await queue.run(
      "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
      [otherId, await publicIdFor(parseId(otherId, "col")), "other", "{}", clock],
    );
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
      [
        otherRev,
        await publicIdFor(parseId(otherRev, "rev")),
        otherId,
        null,
        "a.txt",
        null,
        "{}",
        JSON.stringify({
          headPath: "a.txt",
          files: { "a.txt": { hash, mime: "text/plain", size: 5 } },
        }),
        clock + 1,
      ],
    );
    worker.wake();
    await worker.drain();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [otherRev])).toBeTruthy();
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      collectionId,
      clock,
    ]);
    worker.wake();
    await worker.drain();
    expect(
      await waypoint.get("SELECT id FROM collections WHERE id=?", [collectionId]),
    ).toBeUndefined();
    expect(await bucket.head(manifestKey(revisionId))).toBe(false);
    expect(await bucket.head(collectionKey(collectionId))).toBe(false);
    expect(await bucket.head(blobKey(hash))).toBe(true);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])).toBeTruthy();
  });
  it.each([1, 2])("resumes purge from completed step %i", async (step) => {
    await processed();
    await utimes(blobs.path(hash), new Date(clock - 16 * 60_000), new Date(clock - 16 * 60_000));
    await bucket.delete(manifestKey(revisionId));
    await bucket.delete(collectionKey(collectionId));
    if (step === 2) {
      await waypoint.run("DELETE FROM revision_files WHERE revision_id=?", [revisionId]);
      await waypoint.run("DELETE FROM revisions WHERE id=?", [revisionId]);
      await waypoint.run("DELETE FROM collections WHERE id=?", [collectionId]);
    }
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,?)", [
      collectionId,
      clock,
      step,
    ]);
    worker.wake();
    await worker.drain();
    expect(
      await queue.get("SELECT step FROM pending_purges WHERE collection_id=?", [collectionId]),
    ).toBeUndefined();
    expect(
      await waypoint.get("SELECT id FROM collections WHERE id=?", [collectionId]),
    ).toBeUndefined();
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])).toBeUndefined();
    expect(await bucket.head(blobKey(hash))).toBe(false);
  });
});
