import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import {
  WriterCommitter,
  SimulatedCrash,
  blobKey,
  collectionKey,
  manifestKey,
  type CommitterStep,
} from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
import { mintRevisionId, newId, parseId, publicIdFor } from "../packages/core/src/index.ts";

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
async function server(bin: string, file: string, p: number): Promise<ChildProcess> {
  const child = spawn(bin, [file, "--sync-server", `127.0.0.1:${p}`], { stdio: "ignore" });
  for (let remaining = 100; remaining > 0; remaining--) {
    try {
      await fetch(`http://127.0.0.1:${p}`, { signal: AbortSignal.timeout(200) });
      return child;
    } catch {
      await delay(50);
    }
  }
  throw new Error("Sync server did not start");
}
function config(dir: string, p: number): Config {
  return {
    environment: "dev",
    dataDir: dir,
    baseUrl: `http://127.0.0.1:${p}`,
    port: p,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024 * 1024,
    sync: true,
    tursoUrl: `http://127.0.0.1:${p}`,
    tursoAuthToken: "test",
  };
}
type Harness = {
  waypoint: Db;
  queue: Db;
  blobs: BlobStore;
  sync: SyncLoop;
  worker: WriterCommitter;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
};
async function open(cfg: Config, bucket: MemoryBucket, crash?: CommitterStep): Promise<Harness> {
  const db = await openDatabases(cfg);
  await guardEnvironment(db.waypoint, db.syncClient, "dev");
  await migrate(db.waypoint, waypointMigrations);
  await migrate(db.queue, queueMigrations);
  const blobs = new BlobStore(cfg.dataDir, cfg.maxBlobBytes);
  const reads = new ReadModel(db.waypoint, db.queue, cfg.baseUrl);
  const ingest = new IngestService(db.waypoint, db.queue, blobs, reads, db.syncClient);
  const sync = new SyncLoop(db.queue, db.syncClient, Date.now, db.waypoint);
  let worker: WriterCommitter;
  worker = new WriterCommitter(
    db.waypoint,
    db.queue,
    blobs,
    bucket,
    sync,
    ingest,
    Date.now,
    Math.random,
    72,
    crash
      ? (step) => {
          if (step === crash) {
            worker.stop();
            throw new SimulatedCrash(step);
          }
        }
      : undefined,
  );
  ingest.committer = worker;
  const app = createApp({
    waypoint: db.waypoint,
    queue: db.queue,
    blobs,
    reads,
    ingest,
    bucket,
    committer: worker,
    syncLoop: sync,
    environment: "dev",
  });
  return {
    app,
    waypoint: db.waypoint,
    queue: db.queue,
    blobs,
    sync,
    worker,
    async close() {
      worker.stop();
      sync.stop();
      await Promise.allSettled([worker.drain(), sync.drain()]);
      await db.waypoint.close();
      await db.queue.close();
    },
  };
}
async function queuedRevision(
  h: Harness,
  values: string[],
): Promise<{ collection: string; revision: string; hashes: string[] }> {
  const collection = newId("col");
  const revision = mintRevisionId({ now: Date.now() });
  const entries = await Promise.all(
    values.map(async (value) => await h.blobs.put(Readable.from([value]))),
  );
  for (const entry of entries)
    await h.queue.run("INSERT INTO pending_blobs (hash,size) VALUES (?,?)", [
      entry.hash,
      entry.size,
    ]);
  await h.queue.run(
    "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
    [collection, await publicIdFor(parseId(collection, "col")), "crash", "{}", Date.now()],
  );
  await h.queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      revision,
      await publicIdFor(parseId(revision, "rev")),
      collection,
      null,
      "a.txt",
      null,
      "{}",
      JSON.stringify({
        headPath: "a.txt",
        files: Object.fromEntries(
          entries.map((entry, index) => [
            index === 0 ? "a.txt" : `b${index}.txt`,
            { hash: entry.hash, mime: "text/plain", size: entry.size },
          ]),
        ),
      }),
      Date.now(),
    ],
  );
  return { collection, revision, hashes: entries.map((entry) => entry.hash) };
}
async function assertCloud(cfg: Config, revision: string, hashes: string[]): Promise<void> {
  const cloud = await openDatabases({ ...cfg, dataDir: `${cfg.dataDir}-cloud-reader` });
  try {
    await cloud.syncClient.pull();
    expect(
      await cloud.waypoint.all("SELECT id FROM revisions WHERE id=?", [revision]),
    ).toHaveLength(1);
    for (const hash of hashes)
      expect(await cloud.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])).toBeTruthy();
    expect(
      await cloud.waypoint.all(
        "SELECT rf.blob_hash FROM revision_files rf LEFT JOIN blobs b ON b.hash=rf.blob_hash WHERE b.hash IS NULL",
      ),
    ).toHaveLength(0);
  } finally {
    await cloud.waypoint.close();
    await cloud.queue.close();
  }
}
const commitSteps: CommitterStep[] = [
  "commit_after_blob_upload",
  "commit_after_dr_objects",
  "commit_after_rows",
  "commit_after_queue_cleanup",
];
async function assertGcRowsBeforeFileRemoval(first: Harness, hash: string): Promise<void> {
  expect(await first.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])).toBeUndefined();
  expect((await stat(first.blobs.path(hash))).isFile()).toBe(true);
  expect(
    await first.queue.get("SELECT key FROM pending_r2_deletes WHERE key=?", [blobKey(hash)]),
  ).toBeTruthy();
}
describe("committer crash recovery with a fresh process state", () => {
  it.skipIf(!process.env.TURSODB_BIN).each(commitSteps)(
    "recovers from %s",
    async (point) => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-crash-"));
      const p = await port();
      const child = await server(bin, join(dir, "cloud.db"), p);
      const cfg = config(join(dir, "writer"), p);
      const bucket = new MemoryBucket();
      try {
        const first = await open(cfg, bucket, point);
        const item = await queuedRevision(first, ["one", "two"]);
        first.worker.wake();
        await expect(first.worker.drain()).rejects.toThrow(SimulatedCrash);
        await first.close();
        const restarted = await open(cfg, bucket);
        try {
          restarted.worker.wake();
          await restarted.worker.drain();
          await restarted.sync.push();
          expect(
            await restarted.waypoint.all("SELECT id FROM revisions WHERE id=?", [item.revision]),
          ).toHaveLength(1);
          expect(
            await restarted.waypoint.all("SELECT id FROM collections WHERE id=?", [
              item.collection,
            ]),
          ).toHaveLength(1);
          expect(
            await restarted.waypoint.all("SELECT path FROM revision_files WHERE revision_id=?", [
              item.revision,
            ]),
          ).toHaveLength(2);
          expect(await restarted.queue.all("SELECT id FROM pending_revisions")).toHaveLength(0);
          expect(await restarted.queue.all("SELECT hash FROM pending_blobs")).toHaveLength(0);
          expect(await restarted.queue.all("SELECT revision_id FROM unpushed")).toHaveLength(0);
          expect(
            await restarted.waypoint.all(
              "SELECT rf.blob_hash FROM revision_files rf LEFT JOIN blobs b ON b.hash=rf.blob_hash WHERE b.hash IS NULL",
            ),
          ).toHaveLength(0);
          expect(await (await restarted.app.request("/api/status")).json()).toMatchObject({
            environment: "dev",
            queue: { pending_revisions: 0, unpushed: 0 },
            sync_blocked: false,
          });
          expect(bucket.objects.has(manifestKey(item.revision))).toBe(true);
          expect(bucket.objects.has(collectionKey(item.collection))).toBe(true);
          for (const hash of item.hashes) expect(bucket.objects.has(blobKey(hash))).toBe(true);
          await assertCloud(cfg, item.revision, item.hashes);
        } finally {
          await restarted.close();
        }
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
    60000,
  );

  it
    .skipIf(!process.env.TURSODB_BIN)
    .each([
      "purge_after_bucket",
      "purge_after_rows",
      "gc_after_delete_queued",
      "gc_after_rows",
      "purge_mid_gc",
      "gc_after_bucket_delete",
    ] as CommitterStep[])(
    "resumes %s",
    async (point) => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-purge-crash-"));
      const p = await port();
      const child = await server(bin, join(dir, "cloud.db"), p);
      const cfg = config(join(dir, "writer"), p);
      const bucket = new MemoryBucket();
      try {
        const setup = await open(cfg, bucket);
        const item = await queuedRevision(setup, ["purge-only", "shared"]);
        setup.worker.wake();
        await setup.worker.drain();
        await setup.sync.push();
        const otherCollection = newId("col");
        const otherRevision = mintRevisionId({ now: Date.now() + 1 });
        await setup.waypoint.run(
          "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
          [
            otherCollection,
            await publicIdFor(parseId(otherCollection, "col")),
            "other",
            "{}",
            Date.now(),
          ],
        );
        await setup.waypoint.run(
          "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            otherRevision,
            await publicIdFor(parseId(otherRevision, "rev")),
            otherCollection,
            null,
            "shared.txt",
            null,
            "{}",
            Date.now(),
          ],
        );
        await setup.waypoint.run(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
          [otherRevision, "shared.txt", item.hashes[1]!, "text/plain", 6],
        );
        await setup.sync.push();
        await utimes(
          setup.blobs.path(item.hashes[0]!),
          new Date(Date.now() - 16 * 60_000),
          new Date(Date.now() - 16 * 60_000),
        );
        await setup.close();
        const first = await open(cfg, bucket, point);
        await first.queue.run(
          "INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)",
          [item.collection, Date.now()],
        );
        first.worker.wake();
        await expect(first.worker.drain()).rejects.toThrow(SimulatedCrash);
        if (point === "gc_after_rows") await assertGcRowsBeforeFileRemoval(first, item.hashes[0]!);
        await first.close();
        const restarted = await open(cfg, bucket);
        try {
          restarted.worker.wake();
          await restarted.worker.drain();
          await restarted.sync.push();
          expect(
            await restarted.queue.all("SELECT collection_id FROM pending_purges"),
          ).toHaveLength(0);
          expect(
            await restarted.waypoint.all("SELECT id FROM collections WHERE id=?", [
              item.collection,
            ]),
          ).toHaveLength(0);
          expect(
            await restarted.waypoint.all("SELECT id FROM revisions WHERE id=?", [item.revision]),
          ).toHaveLength(0);
          expect(bucket.objects.has(manifestKey(item.revision))).toBe(false);
          expect(bucket.objects.has(collectionKey(item.collection))).toBe(false);
          expect(bucket.objects.has(blobKey(item.hashes[0]!))).toBe(false);
          expect(bucket.objects.has(blobKey(item.hashes[1]!))).toBe(true);
          expect(
            await restarted.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [item.hashes[1]!]),
          ).toBeTruthy();
          expect(await restarted.queue.all("SELECT revision_id FROM unpushed")).toHaveLength(0);
          expect(await (await restarted.app.request("/api/status")).json()).toMatchObject({
            queue: { pending_purges: 0, unpushed: 0 },
          });
          const cloud = await openDatabases({ ...cfg, dataDir: `${cfg.dataDir}-purge-reader` });
          try {
            await cloud.syncClient.pull();
            expect(
              await cloud.waypoint.get("SELECT id FROM collections WHERE id=?", [item.collection]),
            ).toBeUndefined();
            expect(
              await cloud.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [item.hashes[1]!]),
            ).toBeTruthy();
            expect(
              await cloud.waypoint.all(
                "SELECT rf.blob_hash FROM revision_files rf LEFT JOIN blobs b ON b.hash=rf.blob_hash WHERE b.hash IS NULL",
              ),
            ).toHaveLength(0);
          } finally {
            await cloud.waypoint.close();
            await cloud.queue.close();
          }
        } finally {
          await restarted.close();
        }
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
    60000,
  );
});
