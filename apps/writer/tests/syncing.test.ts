// RX-11: the writer's `collection_syncing` row, kept by refreshSyncing at every queue change.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { BucketError, MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter, blobKey, type CommitterStep } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService, type Committer } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";
import { refreshSyncing, type SyncingRow } from "../src/syncing.ts";

const HOUR = 3_600_000;
/** Fails the upload of chosen blobs, permanently. */
class FailingBucket extends MemoryBucket {
  readonly failing = new Set<string>();
  override async putIfAbsent(key: string, body: Uint8Array | (() => Readable)): Promise<void> {
    for (const hash of this.failing)
      if (key === blobKey(hash)) throw new BucketError("Rejected by the test", "permanent");
    await super.putIfAbsent(key, body);
  }
}
const client: SyncClient = {
  lastPullAt: Date.now(),
  verified: true,
  pull: () => Promise.resolve(false),
  push: () => Promise.resolve(),
  checkpoint: () => Promise.resolve(),
};
let dir: string;
let waypoint: Db;
let queue: Db;
let blobs: BlobStore;
let bucket: FailingBucket;
let sync: SyncLoop;
let ingest: IngestService;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let clock: number;
let stepHook: ((step: CommitterStep) => Promise<void> | void) | undefined;
const extra: WriterCommitter[] = [];

function committer(giveUpHours = 72): WriterCommitter {
  const made = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    bucket,
    sync,
    ingest,
    () => clock,
    () => 0,
    giveUpHours,
    (step) => stepHook?.(step),
  );
  extra.push(made);
  return made;
}
/** A committer that is never woken: writes stay queued, but the syncing row is still refreshed. */
const paused = (target: WriterCommitter): Committer => ({
  wake: () => undefined,
  waitForCommit: () => Promise.resolve("pending"),
  refreshSyncing: (id) => target.refreshSyncing(id),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-syncing-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024 * 1024,
    sync: false,
  };
  const opened = await openDatabases(config);
  waypoint = opened.waypoint;
  queue = opened.queue;
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  blobs = new BlobStore(dir, config.maxBlobBytes);
  bucket = new FailingBucket();
  clock = Date.now();
  stepHook = undefined;
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  ingest = new IngestService(waypoint, queue, blobs, reads, client);
  sync = new SyncLoop(queue, client, () => clock, waypoint);
  worker = committer();
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const made of extra.splice(0)) {
    made.stop();
    await made.drain();
  }
  sync.stop();
  await sync.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

const row = (collectionId: string): Promise<SyncingRow | undefined> =>
  waypoint.get<SyncingRow>("SELECT since,until FROM collection_syncing WHERE collection_id=?", [
    collectionId,
  ]);
const createdAt = async (revisionId: string): Promise<number> =>
  (await queue.get<{ created_at: number }>("SELECT created_at FROM pending_revisions WHERE id=?", [
    revisionId,
  ]))!.created_at;
const state = async (revisionId: string): Promise<string | undefined> =>
  (
    await queue.get<{ state: string }>("SELECT state FROM pending_revisions WHERE id=?", [
      revisionId,
    ])
  )?.state;
async function file(path: string, value: string): Promise<{ path: string; hash: string }> {
  return { path, hash: (await blobs.put(Readable.from([value]))).hash };
}
/** A collection whose first revision (#1) is committed. */
async function committed(title = "Syncing"): Promise<string> {
  const first = await ingest.create({ title, files: [await file("a.txt", `${title} one`)] });
  await worker.drain();
  expect(
    await waypoint.get("SELECT id FROM revisions WHERE id=?", [first.revision_id]),
  ).toBeTruthy();
  return first.collection_id;
}
/** Queues a revision without waking the committer. */
async function queued(
  collectionId: string,
  value: string,
  extraRequest: { parent_revision_id?: string } = {},
): Promise<{ id: string; hash: string }> {
  const prior = ingest.committer;
  ingest.committer = paused(worker);
  try {
    const added = await file(`${value}.txt`, value);
    const result = await ingest.add(collectionId, { files: [added], ...extraRequest });
    return { id: result.revision_id, hash: added.hash };
  } finally {
    ingest.committer = prior;
  }
}
async function pass(target = worker): Promise<void> {
  target.wake();
  await target.drain();
}
const retry = (revisionId: string) =>
  app.request(`/api/queue/${revisionId}/retry`, { method: "POST" });

describe("refreshSyncing", () => {
  it("writes a row on ingest of a revision newer than the newest committed one", async () => {
    const id = await committed();
    expect(await row(id)).toBeUndefined();
    const second = await queued(id, "two");
    const since = await createdAt(second.id);
    expect(await row(id)).toEqual({ since, until: since + 72 * HOUR });
    await queued(id, "three");
    expect(await row(id)).toEqual({ since, until: since + 72 * HOUR });
  });

  it("leaves no row for a collection that was never committed", async () => {
    ingest.committer = paused(worker);
    const created = await ingest.create({ title: "Fresh", files: [await file("a.txt", "fresh")] });
    expect(await state(created.revision_id)).toBe("pending");
    expect(await row(created.collection_id)).toBeUndefined();
  });

  it("removes the row in the commit's own transaction", async () => {
    const id = await committed();
    const second = await queued(id, "two");
    expect(await row(id)).toBeDefined();
    const atRows: unknown[] = [];
    stepHook = async (step) => {
      if (step !== "commit_after_rows") return;
      atRows.push(
        Boolean(await waypoint.get("SELECT id FROM revisions WHERE id=?", [second.id])),
        await row(id),
      );
    };
    await pass();
    expect(atRows).toEqual([true, undefined]);
    expect(await row(id)).toBeUndefined();
  });

  it("removes the row when the revision fails, brings it back on Retry and removes it on Drop", async () => {
    const id = await committed();
    const second = await queued(id, "two");
    const third = await queued(id, "three");
    expect(await row(id)).toBeDefined();
    bucket.failing.add(second.hash);
    await pass();
    expect(await state(second.id)).toBe("failed");
    expect(await state(third.id)).toBe("failed");
    expect(await row(id)).toBeUndefined();

    ingest.committer = paused(worker);
    expect((await retry(second.id)).status).toBe(200);
    expect(await state(second.id)).toBe("pending");
    const since = await createdAt(second.id);
    expect(await row(id)).toEqual({ since, until: since + 72 * HOUR });

    expect((await app.request(`/api/queue/${second.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await row(id)).toBeUndefined();
  });

  it("ignores a pending revision older than the newest committed one", async () => {
    const id = await committed();
    const first = (await waypoint.get<{ id: string }>(
      "SELECT id FROM revisions WHERE collection_id=?",
      [id],
    ))!.id;
    const second = await queued(id, "two");
    bucket.failing.add(second.hash);
    await pass();
    expect(await state(second.id)).toBe("failed");
    const third = await ingest.add(id, {
      files: [await file("three.txt", "three")],
      parent_revision_id: first,
    });
    await worker.drain();
    expect(
      await waypoint.get("SELECT id FROM revisions WHERE id=?", [third.revision_id]),
    ).toBeTruthy();
    expect(third.revision_id > second.id).toBe(true);

    ingest.committer = paused(worker);
    expect((await retry(second.id)).status).toBe(200);
    expect(await state(second.id)).toBe("pending");
    expect(await row(id)).toBeUndefined();
  });

  it("deletes the row in the purge transaction, before the collection", async () => {
    const id = await committed();
    await queued(id, "two");
    expect(await row(id)).toBeDefined();
    ingest.committer = paused(worker);
    const purge = await app.request(`/api/collections/${id}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: id }),
    });
    expect(purge.status).toBe(202);
    ingest.committer = worker;
    // A row put back just before the rows step: only the purge transaction can remove it.
    stepHook = async (step) => {
      if (step === "purge_after_bucket")
        await waypoint.run(
          "INSERT INTO collection_syncing (collection_id,since,until) VALUES (?,?,?) ON CONFLICT(collection_id) DO NOTHING",
          [id, clock, clock + HOUR],
        );
    };
    // Past the purge GC's 15-minute local blob grace period.
    clock += HOUR;
    for (let attempt = 0; attempt < 5; attempt++) {
      await pass();
      if (!(await queue.get("SELECT 1 FROM pending_purges"))) break;
      clock += HOUR;
    }
    expect(await queue.get("SELECT 1 FROM pending_purges")).toBeUndefined();
    expect(await waypoint.get("SELECT id FROM collections WHERE id=?", [id])).toBeUndefined();
    expect(await row(id)).toBeUndefined();
  });

  it("never waits on the queue inside the commit transaction (no lock-order deadlock)", async () => {
    // Drop's queue transaction reads the waypoint DB (`prunePendingStorage`), so a commit
    // transaction that read the queue could wait on it while it waits on the commit: both
    // connections would hang. Model that queue transaction while another collection commits.
    const id = await committed();
    await queued(id, "two");
    let held: Promise<unknown> | undefined;
    waypoint.onStatement = (sql) => {
      if (held || !sql.startsWith("INSERT OR IGNORE INTO revisions ")) return;
      held = queue.transaction(async (tx) => {
        await tx.get("SELECT 1 FROM pending_revisions");
        return waypoint.get("SELECT 1 FROM blobs");
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pass().then(() => "committed"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("deadlocked"), 5_000);
      }),
    ]);
    clearTimeout(timer);
    waypoint.onStatement = undefined;
    expect(outcome).toBe("committed");
    expect(held).toBeDefined();
    await held;
    expect(await row(id)).toBeUndefined();
  });

  it("accepts a waypoint transaction as tx and leaves the push to its caller", async () => {
    const id = await committed();
    await queued(id, "two");
    const expected = await row(id);
    expect(expected).toBeDefined();
    await waypoint.run("DELETE FROM collection_syncing WHERE collection_id=?", [id]);
    const push = vi.spyOn(sync, "triggerPush");
    await ingest.withCollectionLock(id, () =>
      waypoint.transaction((tx) => worker.refreshSyncing(id, tx)),
    );
    expect(await row(id)).toEqual(expected);
    expect(push).not.toHaveBeenCalled();
  });

  it("sets until from the committer's give-up hours", async () => {
    const id = await committed();
    const ten = committer(10);
    ingest.committer = paused(ten);
    const second = await ingest.add(id, { files: [await file("two.txt", "two")] });
    const since = await createdAt(second.revision_id);
    expect(await row(id)).toEqual({ since, until: since + 10 * HOUR });
  });

  it("writes nothing when the stored row already matches", async () => {
    const id = await committed();
    await queued(id, "two");
    const expected = await row(id);
    await waypoint.run("DELETE FROM collection_syncing WHERE collection_id=?", [id]);
    const writes: string[] = [];
    waypoint.onStatement = (sql) => {
      if (/collection_syncing/.test(sql) && /^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql))
        writes.push(sql);
    };
    const push = vi.spyOn(sync, "triggerPush");
    await ingest.withCollectionLock(id, () => worker.refreshSyncing(id));
    expect(writes).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await row(id)).toEqual(expected);
    await ingest.withCollectionLock(id, () => worker.refreshSyncing(id));
    expect(writes).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await refreshSyncing({ waypoint, queue, collectionId: id, giveUpHours: 72 })).toEqual({
      row: expected,
      changed: false,
    });
    expect(writes).toHaveLength(1);
    waypoint.onStatement = undefined;
  });

  it("recovers lost and stale rows at the start of each committer pass", async () => {
    const id = await committed();
    const second = await queued(id, "two");
    // Not due, so the pass leaves it queued.
    await queue.run("UPDATE pending_revisions SET next_attempt_at=? WHERE id=?", [
      clock + HOUR,
      second.id,
    ]);
    const expected = await row(id);
    expect(expected).toBeDefined();
    await waypoint.run("DELETE FROM collection_syncing WHERE collection_id=?", [id]);
    await pass();
    expect(await state(second.id)).toBe("pending");
    expect(await row(id)).toEqual(expected);

    const other = await committed("Other");
    await waypoint.run(
      "INSERT INTO collection_syncing (collection_id,since,until) VALUES (?,?,?)",
      [other, clock, clock + HOUR],
    );
    await pass();
    expect(await row(other)).toBeUndefined();
    expect(await row(id)).toEqual(expected);
  });

  it("keeps committing when one collection's recovery refresh fails", async () => {
    const stuck = await committed("Stuck");
    const id = await committed();
    const second = await queued(id, "two");
    // A stale row, so the next pass's recovery refreshes this collection.
    await waypoint.run(
      "INSERT INTO collection_syncing (collection_id,since,until) VALUES (?,?,?)",
      [stuck, clock, clock + HOUR],
    );
    const refresh = worker.refreshSyncing.bind(worker);
    vi.spyOn(worker, "refreshSyncing").mockImplementation((collectionId, tx) =>
      collectionId === stuck && !tx
        ? Promise.reject(new Error("refresh failed"))
        : refresh(collectionId, tx),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await pass();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
    expect(await waypoint.get("SELECT id FROM revisions WHERE id=?", [second.id])).toBeTruthy();
    expect(await row(id)).toBeUndefined();
    expect(await row(stuck)).toBeDefined();
  });
});
