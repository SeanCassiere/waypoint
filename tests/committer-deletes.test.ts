import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.js";
import { MemoryBucket } from "../apps/writer/src/bucket.js";
import { WriterCommitter, blobKey, type CommitterStep } from "../apps/writer/src/committer.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, type Db, type SyncClient } from "../apps/writer/src/db.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";
import { mintRevisionId, newId, parseId, publicIdFor } from "../packages/core/src/index.js";

const hashFor = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("queued bucket deletes", () => {
  let dir: string;
  let waypoint: Db;
  let queue: Db;
  let bucket: MemoryBucket;
  let blobs: BlobStore;
  let ingest: IngestService;
  let sync: SyncLoop;
  let worker: WriterCommitter | undefined;
  const client: SyncClient = {
    verified: true,
    lastPullAt: null,
    push: () => Promise.resolve(),
    pull: () => Promise.resolve(false),
    checkpoint: () => Promise.resolve(),
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "waypoint-deletes-"));
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
    ingest = new IngestService(
      waypoint,
      queue,
      blobs,
      new ReadModel(waypoint, queue, config.baseUrl),
      client,
    );
    sync = new SyncLoop(queue, client, Date.now, waypoint);
  });
  afterEach(async () => {
    worker?.stop();
    await worker?.drain();
    sync.stop();
    await sync.drain();
    await waypoint.close();
    await queue.close();
    await rm(dir, { recursive: true, force: true });
  });
  const makeWorker = (onStep?: (step: CommitterStep) => Promise<void>): WriterCommitter => {
    worker = new WriterCommitter(
      waypoint,
      queue,
      blobs,
      bucket,
      sync,
      ingest,
      Date.now,
      () => 0,
      72,
      onStep,
    );
    return worker;
  };
  async function enqueue(hash: string): Promise<void> {
    const key = blobKey(hash);
    bucket.objects.set(key, new TextEncoder().encode(hash));
    await queue.run("INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?)", [
      key,
      Date.now(),
    ]);
  }

  it("re-checks a pending blob added after the reference snapshot", async () => {
    const hash = hashFor("new queued need");
    await enqueue(hash);
    const active = makeWorker(async (step) => {
      if (step === "delete_after_reference_snapshot")
        await queue.run("INSERT OR IGNORE INTO pending_blobs (hash,size) VALUES (?,1)", [hash]);
    });
    active.wake();
    await active.drain();
    expect(bucket.objects.has(blobKey(hash))).toBe(true);
    expect(
      await queue.get("SELECT key FROM pending_r2_deletes WHERE key=?", [blobKey(hash)]),
    ).toBeTruthy();
  });

  it("executes an unreferenced queued blob delete", async () => {
    const hash = hashFor("stale bucket object");
    await enqueue(hash);
    const active = makeWorker();
    active.wake();
    await active.drain();
    expect(bucket.objects.has(blobKey(hash))).toBe(false);
    expect(
      await queue.get("SELECT key FROM pending_r2_deletes WHERE key=?", [blobKey(hash)]),
    ).toBeUndefined();
  });

  it("processes 500 deletes with 30,000 revision file references within two seconds", async () => {
    const collection = newId("col");
    const revision = mintRevisionId({ now: Date.now() });
    const referenced = hashFor("referenced by many files");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [collection, await publicIdFor(parseId(collection, "col")), "bulk", "{}", Date.now()],
    );
    await waypoint.run("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,?)", [
      referenced,
      Date.now(),
    ]);
    await waypoint.run(
      "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,NULL,'file-1',NULL,'{}',?)",
      [revision, await publicIdFor(parseId(revision, "rev")), collection, Date.now()],
    );
    await waypoint.run(
      `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<30000)
      INSERT INTO revision_files (revision_id,path,blob_hash,mime,size)
      SELECT ?, 'file-' || value, ?, 'text/plain', 1 FROM n`,
      [revision, referenced],
    );
    for (let index = 0; index < 500; index++) await enqueue(hashFor(`stale-${index}`));
    const active = makeWorker();
    const start = performance.now();
    active.wake();
    await active.drain();
    const elapsed = performance.now() - start;
    expect(
      await queue.get<{ count: number }>("SELECT count(*) AS count FROM pending_r2_deletes"),
    ).toEqual({ count: 0 });
    expect(elapsed).toBeLessThan(2000);
  }, 60000);
});
