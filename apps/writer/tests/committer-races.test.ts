import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { mintRevisionId, parseId, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import { BucketError, MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter, blobKey, manifestKey } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService, type Renderer } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";

const noop = (): void => undefined;
function gate(): { promise: Promise<void>; open: () => void } {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, open: () => release() };
}
class GateBucket extends MemoryBucket {
  gate: Promise<void> | undefined;
  entered: (() => void) | undefined;
  deleteGate: Promise<void> | undefined;
  deleteEntered: (() => void) | undefined;
  loseDeleteResponse = false;
  failManifest: BucketError | undefined;
  snapshotGate: Promise<void> | undefined;
  snapshotEntered: (() => void) | undefined;
  override async delete(key: string): Promise<void> {
    if (this.deleteGate && key.startsWith("blobs/")) {
      this.deleteEntered?.();
      await this.deleteGate;
    }
    await super.delete(key);
    if (this.loseDeleteResponse && key.startsWith("blobs/"))
      throw new BucketError("Delete response lost", "transient");
  }
  override async put(key: string, value: Uint8Array): Promise<void> {
    if (this.failManifest && key.startsWith("manifests/")) throw this.failManifest;
    if (this.snapshotGate && key.startsWith("collections/")) {
      this.snapshotEntered?.();
      await this.snapshotGate;
    }
    await super.put(key, value);
  }
  override async putIfAbsent(
    key: string,
    uploadBody: Uint8Array | (() => Readable),
  ): Promise<void> {
    if (this.gate && key.startsWith("blobs/")) {
      this.entered?.();
      await this.gate;
    }
    await super.putIfAbsent(key, uploadBody);
  }
}
let dir: string,
  waypoint: Db,
  queue: Db,
  blobs: BlobStore,
  bucket: GateBucket,
  ingest: IngestService,
  worker: WriterCommitter,
  sync: SyncLoop;
let app: ReturnType<typeof createApp>;
let renderGate: Promise<void> | undefined;
let renderEntered: (() => void) | undefined;
const client: SyncClient = {
  lastPullAt: Date.now(),
  verified: true,
  pull: () => Promise.resolve(false),
  push: () => Promise.resolve(),
  checkpoint: () => Promise.resolve(),
};
const renderer: Renderer = {
  rendererName: "race",
  rendererVersion: 1,
  async render(source) {
    if (renderGate) {
      renderEntered?.();
      await renderGate;
    }
    return {
      bytes: new TextEncoder().encode(`<p>${Buffer.from(source).toString()}</p>`),
      mime: "text/html",
    };
  },
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-races-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024 * 1024,
    sync: false,
  };
  const db = await openDatabases(config);
  waypoint = db.waypoint;
  queue = db.queue;
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  blobs = new BlobStore(dir, config.maxBlobBytes);
  bucket = new GateBucket();
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  ingest = new IngestService(waypoint, queue, blobs, reads, client, undefined, renderer);
  sync = new SyncLoop(queue, client, Date.now, waypoint);
  worker = new WriterCommitter(waypoint, queue, blobs, bucket, sync, ingest);
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    bucket,
    committer: worker,
    syncLoop: sync,
  });
  renderGate = undefined;
  renderEntered = undefined;
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  sync.stop();
  await sync.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});
async function blob(value: string): Promise<string> {
  return (await blobs.put(Readable.from([value]))).hash;
}
async function body(response: Response): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(await response.json());
}
async function post(path: string, data: unknown, method = "POST"): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function settle(): Promise<void> {
  await worker.drain();
  await sync.drain();
}

describe("committer race regressions", () => {
  it("does not commit a pending collection purged during upload", async () => {
    const h = await blob("secret");
    const hold = gate();
    bucket.gate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.entered = resolve;
    });
    const creating = post("/api/collections", {
      title: "secret",
      files: [{ path: "a.txt", hash: h }],
    });
    await entered;
    const queued = await queue.get<{ id: string; collection_id: string }>(
      "SELECT id,collection_id FROM pending_revisions",
    );
    expect(queued).toBeTruthy();
    expect(
      (
        await post(`/api/collections/${queued!.collection_id}/purge`, {
          confirm: queued!.collection_id,
        })
      ).status,
    ).toBe(202);
    hold.open();
    await creating;
    await settle();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [queued!.id])).toBeUndefined();
    expect(
      await waypoint.get("SELECT id FROM collections WHERE id=?", [queued!.collection_id]),
    ).toBeUndefined();
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [h])).toBeUndefined();
    expect(bucket.objects.has(blobKey(h))).toBe(false);
    expect(bucket.objects.has(manifestKey(queued!.id))).toBe(false);
  });
  it("does not resurrect a revision dropped during upload", async () => {
    const first = await blob("first");
    const created = await body(
      await post("/api/collections", { title: "one", files: [{ path: "a.txt", hash: first }] }),
    );
    const collectionId = z.string().parse(created.collection_id);
    const second = await blob("second");
    const hold = gate();
    bucket.gate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.entered = resolve;
    });
    const adding = post(`/api/collections/${collectionId}/revisions`, {
      files: [{ path: "b.txt", hash: second }],
    });
    await entered;
    const queued = await queue.get<{ id: string }>("SELECT id FROM pending_revisions");
    expect(queued).toBeTruthy();
    expect((await app.request(`/api/queue/${queued!.id}`, { method: "DELETE" })).status).toBe(200);
    hold.open();
    await adding;
    await settle();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [queued!.id])).toBeUndefined();
    expect(bucket.objects.has(manifestKey(queued!.id))).toBe(false);
    expect(bucket.objects.has(blobKey(second))).toBe(false);
  });
  it("requeues an uploaded blob delete when the drop's earlier delete ran before upload finished", async () => {
    const root = await blob("drop root");
    const created = await body(
      await post("/api/collections", { title: "drop", files: [{ path: "root.txt", hash: root }] }),
    );
    const id = z.string().parse(created.collection_id);
    const orphan = await blob("uploaded after drop");
    const hold = gate();
    bucket.gate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.entered = resolve;
    });
    const adding = post(`/api/collections/${id}/revisions`, {
      files: [{ path: "orphan.txt", hash: orphan }],
    });
    await entered;
    const queued = await queue.get<{ id: string }>("SELECT id FROM pending_revisions");
    expect(queued).toBeTruthy();
    expect((await app.request(`/api/queue/${queued!.id}`, { method: "DELETE" })).status).toBe(200);
    // The drop's delete can finish before a blocked upload reaches the bucket.
    await queue.run("DELETE FROM pending_r2_deletes WHERE key=?", [blobKey(orphan)]);
    hold.open();
    await adding;
    await settle();
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [queued!.id])).toBeUndefined();
    expect(bucket.objects.has(blobKey(orphan))).toBe(false);
    expect(
      await queue.get("SELECT key FROM pending_r2_deletes WHERE key=?", [blobKey(orphan)]),
    ).toBeUndefined();
  });
  it("keeps an uploaded hash with a committed blobs row when a queued revision is dropped", async () => {
    const shared = await blob("committed shared blob");
    const created = await body(
      await post("/api/collections", {
        title: "shared",
        files: [{ path: "root.txt", hash: shared }],
      }),
    );
    const id = z.string().parse(created.collection_id);
    const revision = mintRevisionId({ now: Date.now() + 1 });
    await queue.run("INSERT INTO pending_blobs (hash,size) VALUES (?,?)", [
      shared,
      (await stat(blobs.path(shared))).size,
    ]);
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
      [
        revision,
        await publicIdFor(parseId(revision, "rev")),
        id,
        z.string().parse(created.revision_id),
        "shared.txt",
        null,
        "{}",
        JSON.stringify({
          headPath: "shared.txt",
          files: { "shared.txt": { hash: shared, mime: "text/plain", size: 21 } },
        }),
        Date.now(),
      ],
    );
    const hold = gate();
    bucket.gate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.entered = resolve;
    });
    worker.wake();
    await entered;
    expect((await app.request(`/api/queue/${revision}`, { method: "DELETE" })).status).toBe(200);
    hold.open();
    await settle();
    expect(bucket.objects.has(blobKey(shared))).toBe(true);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [shared])).toBeTruthy();
    expect(
      await queue.get("SELECT key FROM pending_r2_deletes WHERE key=?", [blobKey(shared)]),
    ).toBeUndefined();
  });
  it("deletes an uploaded blob after a committed collection is purged mid-upload", async () => {
    const first = await blob("root");
    const created = await body(
      await post("/api/collections", { title: "purge", files: [{ path: "a.txt", hash: first }] }),
    );
    const id = z.string().parse(created.collection_id);
    const second = await blob("later secret");
    const hold = gate();
    bucket.gate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.entered = resolve;
    });
    const adding = post(`/api/collections/${id}/revisions`, {
      files: [{ path: "b.txt", hash: second }],
    });
    await entered;
    expect((await post(`/api/collections/${id}/purge`, { confirm: id })).status).toBe(202);
    hold.open();
    await adding;
    await settle();
    expect(bucket.objects.has(blobKey(second))).toBe(false);
  });
  it("keeps a shared blob while another collection is ingesting it", async () => {
    const shared = await blob("shared");
    const a = await body(
      await post("/api/collections", { title: "A", files: [{ path: "a.txt", hash: shared }] }),
    );
    const bFirst = await blob("b-first");
    const b = await body(
      await post("/api/collections", { title: "B", files: [{ path: "x.txt", hash: bFirst }] }),
    );
    await utimes(
      blobs.path(shared),
      new Date(Date.now() - 16 * 60_000),
      new Date(Date.now() - 16 * 60_000),
    );
    const md = await blob("# md");
    const hold = gate();
    renderGate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      renderEntered = resolve;
    });
    const adding = post(`/api/collections/${z.string().parse(b.collection_id)}/revisions`, {
      files: [
        { path: "shared.txt", hash: shared },
        { path: "doc.md", hash: md },
      ],
    });
    await entered;
    const aid = z.string().parse(a.collection_id);
    expect((await post(`/api/collections/${aid}/purge`, { confirm: aid })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bucket.objects.has(blobKey(shared))).toBe(true);
    hold.open();
    const added = await body(await adding);
    await settle();
    expect(
      await waypoint.get("SELECT id FROM revisions WHERE id=?", [
        z.string().parse(added.revision_id),
      ]),
    ).toBeTruthy();
    expect(bucket.objects.has(blobKey(shared))).toBe(true);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [shared])).toBeTruthy();
  });
});

describe("second review regressions", () => {
  it("queues blob deletion when a pending collection had uploaded before manifest failure", async () => {
    const h = await blob("pending secret");
    bucket.failManifest = new BucketError("manifest down", "transient");
    const created = await body(
      await post("/api/collections", { title: "pending", files: [{ path: "a.txt", hash: h }] }),
    );
    bucket.failManifest = undefined;
    expect(bucket.objects.has(blobKey(h))).toBe(true);
    const id = z.string().parse(created.collection_id);
    expect((await post(`/api/collections/${id}/purge`, { confirm: id })).status).toBe(202);
    await settle();
    expect(bucket.objects.has(blobKey(h))).toBe(false);
  }, 12000);
  it("queues blob deletion when purging a committed collection with a failed queued revision", async () => {
    const root = await blob("root for purge");
    const created = await body(
      await post("/api/collections", { title: "root", files: [{ path: "a.txt", hash: root }] }),
    );
    const id = z.string().parse(created.collection_id);
    const h = await blob("queued secret");
    bucket.failManifest = new BucketError("manifest down", "transient");
    await post(`/api/collections/${id}/revisions`, { files: [{ path: "b.txt", hash: h }] });
    bucket.failManifest = undefined;
    expect(bucket.objects.has(blobKey(h))).toBe(true);
    expect((await post(`/api/collections/${id}/purge`, { confirm: id })).status).toBe(202);
    await settle();
    expect(bucket.objects.has(blobKey(h))).toBe(false);
  }, 12000);
  it("queues blob deletion when dropping a failed revision", async () => {
    const root = await blob("root for drop");
    const created = await body(
      await post("/api/collections", { title: "root", files: [{ path: "a.txt", hash: root }] }),
    );
    const id = z.string().parse(created.collection_id);
    const h = await blob("failed secret");
    bucket.failManifest = new BucketError("invalid manifest", "permanent");
    const added = await body(
      await post(`/api/collections/${id}/revisions`, { files: [{ path: "b.txt", hash: h }] }),
    );
    bucket.failManifest = undefined;
    expect(bucket.objects.has(blobKey(h))).toBe(true);
    expect(
      (await app.request(`/api/queue/${z.string().parse(added.revision_id)}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    await settle();
    expect(bucket.objects.has(blobKey(h))).toBe(false);
  });
  it("does not block unrelated ingest during a stalled bucket delete", async () => {
    const h = await blob("garbage");
    const a = await body(
      await post("/api/collections", { title: "A", files: [{ path: "a.txt", hash: h }] }),
    );
    const b = await body(
      await post("/api/collections", {
        title: "B",
        files: [{ path: "b.txt", hash: await blob("B root") }],
      }),
    );
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(h), old, old);
    const hold = gate();
    bucket.deleteGate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.deleteEntered = resolve;
    });
    const aid = z.string().parse(a.collection_id);
    expect((await post(`/api/collections/${aid}/purge`, { confirm: aid })).status).toBe(202);
    await entered;
    const adding = post(`/api/collections/${z.string().parse(b.collection_id)}/revisions`, {
      files: [{ path: "c.txt", hash: await blob("unrelated") }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await queue.get("SELECT id FROM pending_revisions WHERE collection_id=?", [
        z.string().parse(b.collection_id),
      ]),
    ).toBeTruthy();
    hold.open();
    await adding;
    await settle();
  }, 10000);
  it("re-uploads a hash after a lost bucket-delete response", async () => {
    const h = await blob("reused after delete");
    const a = await body(
      await post("/api/collections", { title: "A", files: [{ path: "a.txt", hash: h }] }),
    );
    const b = await body(
      await post("/api/collections", {
        title: "B",
        files: [{ path: "b.txt", hash: await blob("B root") }],
      }),
    );
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(h), old, old);
    bucket.loseDeleteResponse = true;
    const aid = z.string().parse(a.collection_id);
    await post(`/api/collections/${aid}/purge`, { confirm: aid });
    await settle();
    expect(bucket.objects.has(blobKey(h))).toBe(false);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [h])).toBeUndefined();
    bucket.loseDeleteResponse = false;
    expect(await blob("reused after delete")).toBe(h);
    const added = await body(
      await post(`/api/collections/${z.string().parse(b.collection_id)}/revisions`, {
        files: [{ path: "c.txt", hash: h }],
      }),
    );
    await settle();
    expect(added.sync_state).not.toBe("failed");
    expect(bucket.objects.has(blobKey(h))).toBe(true);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [h])).toBeTruthy();
  });
  it("writes a committed edit snapshot without holding its collection lock", async () => {
    const h = await blob("committed snapshot source");
    const created = await body(
      await post("/api/collections", { title: "before", files: [{ path: "a.txt", hash: h }] }),
    );
    const id = z.string().parse(created.collection_id);
    const hold = gate();
    bucket.snapshotGate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.snapshotEntered = resolve;
    });
    const firstPatch = post(`/api/collections/${id}`, { title: "middle" }, "PATCH");
    await entered;
    const secondPatch = post(`/api/collections/${id}`, { title: "after" }, "PATCH");
    const race = await Promise.race([
      secondPatch.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500)),
    ]);
    expect(race).toBe("done");
    hold.open();
    await firstPatch;
    await settle();
    expect(Buffer.from(bucket.objects.get(`collections/${id}.json`)!).toString()).toContain(
      '"title":"after"',
    );
  }, 10000);
  it("writes a pending collection snapshot without holding its collection lock", async () => {
    const h = await blob("snapshot source");
    const hold = gate();
    bucket.snapshotGate = hold.promise;
    const entered = new Promise<void>((resolve) => {
      bucket.snapshotEntered = resolve;
    });
    const creating = post("/api/collections", {
      title: "before",
      files: [{ path: "a.txt", hash: h }],
    });
    await entered;
    const row = await queue.get<{ collection_id: string }>(
      "SELECT collection_id FROM pending_revisions",
    );
    const patch = post(`/api/collections/${row!.collection_id}`, { title: "after" }, "PATCH");
    const race = await Promise.race([
      patch.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500)),
    ]);
    expect(race).toBe("done");
    hold.open();
    await creating;
    await settle();
    expect(
      Buffer.from(bucket.objects.get(`collections/${row!.collection_id}.json`)!).toString(),
    ).toContain('"title":"after"');
  }, 10000);
});

describe("GC protection", () => {
  it("refreshes the mtime when an existing local blob is uploaded again", async () => {
    const h = await blob("same content");
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(h), old, old);
    await blob("same content");
    expect((await stat(blobs.path(h))).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });
  it("keeps a reused rendition output whose source remains queued", async () => {
    const source = await blob("# shared markdown");
    const a = await body(
      await post("/api/collections", { title: "A", files: [{ path: "a.md", hash: source }] }),
    );
    const output = await waypoint.get<{ output_hash: string }>(
      "SELECT output_hash FROM renditions WHERE source_hash=?",
      [source],
    );
    expect(output).toBeTruthy();
    bucket.fail = new BucketError("offline", "transient");
    const b = await body(
      await post("/api/collections", { title: "B", files: [{ path: "b.md", hash: source }] }),
    );
    expect(b.sync_state).toBe("pending");
    delete bucket.fail;
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(source), old, old);
    await utimes(blobs.path(output!.output_hash), old, old);
    const id = z.string().parse(a.collection_id);
    await post(`/api/collections/${id}/purge`, { confirm: id });
    await settle();
    expect(bucket.objects.has(blobKey(source))).toBe(true);
    expect(bucket.objects.has(blobKey(output!.output_hash))).toBe(true);
    expect(
      await waypoint.get("SELECT output_hash FROM renditions WHERE source_hash=?", [source]),
    ).toBeTruthy();
  }, 12000);
  it("keeps a fresh unreferenced blob through the fifteen-minute GC grace", async () => {
    const h = await blob("fresh GC blob");
    const a = await body(
      await post("/api/collections", { title: "A", files: [{ path: "a.txt", hash: h }] }),
    );
    const id = z.string().parse(a.collection_id);
    await post(`/api/collections/${id}/purge`, { confirm: id });
    await settle();
    expect(bucket.objects.has(blobKey(h))).toBe(true);
    expect(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [h])).toBeTruthy();
    // The grace is a scheduled wait, not an error (OW-14): no last_error, no attempt counted, and
    // the next try is the youngest deferred blob's mtime, rounded up, plus 15 minutes.
    const { mtimeMs } = await stat(blobs.path(h));
    const row = z
      .object({
        step: z.number(),
        last_error: z.string().nullable(),
        attempts: z.number(),
        next_attempt_at: z.number(),
      })
      .parse(
        await queue.get(
          "SELECT step,last_error,attempts,next_attempt_at FROM pending_purges WHERE collection_id=?",
          [id],
        ),
      );
    expect(row).toMatchObject({ step: 2, last_error: null, attempts: 0 });
    expect(Number.isInteger(row.next_attempt_at)).toBe(true);
    expect(row.next_attempt_at).toBe(Math.ceil(mtimeMs) + 900_000);
  });
});
