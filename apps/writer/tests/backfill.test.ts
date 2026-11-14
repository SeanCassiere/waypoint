import { mkdtemp, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { mintRevisionId, newId, type RerenderStatus } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PULL_SURVEY_DEBOUNCE_MS,
  QUIET_MS,
  RerenderBackfill,
  skipRetryAt,
  type BackfillClock,
  type BackfillDeps,
  type BackfillOptions,
} from "../src/backfill.ts";
import { BlobStore, type Activity } from "../src/blob-store.ts";
import { BucketError, MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { inSeries, openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService, type Renderer, type Rendition } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Timers that fire only when the test advances the clock. */
class FakeClock implements BackfillClock {
  time = Date.now();
  private timers = new Set<{ at: number; fn: () => void }>();
  now = (): number => this.time;
  setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.time + ms, fn };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  };
  advance(ms: number): void {
    this.time += ms;
    for (const timer of [...this.timers].toSorted((left, right) => left.at - right.at))
      if (timer.at <= this.time && this.timers.delete(timer)) timer.fn();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Records what it renders, in order; renders can be held, declined or never finish. */
class TestRenderer implements Renderer {
  readonly rendererName: string;
  readonly rendererVersion: number;
  calls: string[] = [];
  held = new Map<string, Promise<void>>();
  declined = new Set<string>();
  constructor(name: string, version: number) {
    this.rendererName = name;
    this.rendererVersion = version;
  }
  async render(source: Uint8Array): Promise<Rendition | null> {
    const text = new TextDecoder().decode(source);
    this.calls.push(text);
    const held = this.held.get(text);
    if (held) await held;
    if (this.declined.has(text)) return null;
    return { bytes: new TextEncoder().encode(`<p>${text}</p>`), mime: "text/html" };
  }
}

/**
 * Yields to I/O until `check` holds (no timers: the clock is fake). Bounded by real time, not by
 * turns: the database's work runs off the main thread, so on a loaded machine thousands of turns
 * can pass before a single query answers. The deadline stays under Vitest's 5 s test timeout, so
 * a condition that's never reached fails here, with this message.
 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one look at a time.
    if (await check()) return;
    if (performance.now() > deadline) throw new Error(`Condition not reached in ${timeoutMs} ms`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Lets pending I/O run.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Waits for the next millisecond: revision IDs of separate collections made in the same one sort
 * in no particular order.
 */
async function nextMs(): Promise<void> {
  const now = Date.now();
  await until(() => Date.now() > now);
}

let dir: string;
let waypoint: Db;
let queue: Db;
let sync: SyncClient;
let blobs: BlobStore;
let reads: ReadModel;
let ingest: IngestService;
let bucket: MemoryBucket;
let committer: WriterCommitter;
let clock: FakeClock;
let markdown: TestRenderer;
let text: TestRenderer;
let backfill: RerenderBackfill | undefined;
let closed: number;
let logs: string[];

async function put(content: string): Promise<string> {
  return (await blobs.put(Readable.from([content]))).hash;
}
async function commitAll(): Promise<void> {
  committer.wake();
  await committer.drain();
}
async function collection(
  title: string,
  files: Record<string, string>,
): Promise<{ collection: string; revision: string }> {
  const result = await ingest.create({
    title,
    head_path: Object.keys(files)[0]!,
    files: Object.entries(files).map(([path, hash]) => ({ path, hash })),
  });
  return { collection: result.collection_id, revision: result.revision_id };
}
async function revise(collectionId: string, files: Record<string, string>): Promise<string> {
  const result = await ingest.add(collectionId, {
    mode: "replace",
    head_path: Object.keys(files)[0]!,
    files: Object.entries(files).map(([path, hash]) => ({ path, hash })),
  });
  return result.revision_id;
}
let links = 0;
async function link(collectionId: string, revisionId: string | null): Promise<void> {
  links++;
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      `shl_${String(links).padStart(26, "0")}`,
      `token-${links}`,
      collectionId,
      revisionId,
      null,
      null,
      null,
      1,
    ],
  );
}
async function count(db: Db, sql: string, params: (string | number)[] = []): Promise<number> {
  return (await db.get<{ n: number }>(sql, params))?.n ?? 0;
}
const queued = (): Promise<number> => count(queue, "SELECT COUNT(*) AS n FROM pending_renditions");

function makeBackfill(
  options: Partial<BackfillOptions> = {},
  deps: Partial<BackfillDeps> = {},
): RerenderBackfill {
  backfill = new RerenderBackfill(
    {
      waypoint,
      queue,
      blobs,
      ingest,
      renderers: [markdown, text],
      closeRenderers: () => {
        closed++;
        return Promise.resolve();
      },
      ...deps,
    },
    {
      mode: "auto",
      delayMs: 0,
      settledMs: 30 * DAY,
      sync: false,
      clock,
      log: (line) => logs.push(line),
      ...options,
    },
  );
  return backfill;
}
/** Starts the loop and waits until it has nothing to do right now. */
async function started(created: RerenderBackfill): Promise<RerenderBackfill> {
  created.start();
  await created.whenIdle();
  return created;
}
async function advance(ms: number): Promise<void> {
  clock.advance(ms);
  await backfill?.whenIdle();
}
function status(standalone = 0): RerenderStatus {
  if (!backfill) throw new Error("No backfill");
  return backfill.status(standalone);
}
/** A committer stand-in: counts wakes, commits nothing. */
function stubCommitter(): {
  wakes: number;
  wake(): void;
  accountError: string | null;
  renditionsRetryAt: number | null;
} {
  return {
    wakes: 0,
    wake() {
      this.wakes++;
    },
    accountError: null,
    renditionsRetryAt: null,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-backfill-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1_000_000,
    sync: false,
  };
  const opened = await openDatabases(config);
  waypoint = opened.waypoint;
  queue = opened.queue;
  sync = opened.syncClient;
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  blobs = new BlobStore(dir, 1_000_000);
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  // No renderer at ingest: every source starts without a rendition, so all are stale.
  ingest = new IngestService(waypoint, queue, blobs, reads, sync);
  bucket = new MemoryBucket();
  committer = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    bucket,
    new SyncLoop(queue, sync, Date.now, waypoint),
    ingest,
  );
  clock = new FakeClock();
  markdown = new TestRenderer("markdown", 3);
  text = new TestRenderer("text", 2);
  backfill = undefined;
  closed = 0;
  logs = [];
});
afterEach(async () => {
  backfill?.stop();
  await backfill?.drain();
  committer.stop();
  await committer.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("background rerender: delay and gates", () => {
  it("surveys at start but renders nothing until the delay has passed", async () => {
    const [a, b] = await Promise.all([put("# a"), put("# b")]);
    await collection("Docs", { "a.md": a, "b.md": b });
    const start = clock.now();
    makeBackfill({ delayMs: 45 * MINUTE });
    expect(status()).toMatchObject({ state: "waiting", stale: null, left: null, renderers: [] });
    await started(backfill!);
    expect(status()).toMatchObject({
      mode: "auto",
      state: "waiting",
      starts_at: start + 45 * MINUTE,
      surveyed_at: start,
      stale: 2,
      left: 2,
    });
    expect(logs).toEqual([
      expect.stringMatching(
        /^Rerender survey: 2 stale \(markdown v3: 2 of 2, text v2: 0 of 0\) in \d+ ms$/,
      ),
    ]);
    await advance(45 * MINUTE - 1);
    expect(markdown.calls).toEqual([]);
    await advance(1);
    expect(markdown.calls.toSorted()).toEqual(["# a", "# b"]);
    expect(await queued()).toBe(2);
    expect(status()).toMatchObject({
      state: "done",
      starts_at: null,
      stale: 0,
      left: 0,
      rendered: 2,
    });
    // Its worker is closed once the work runs out.
    expect(closed).toBe(1);
  });

  it("waits for ingests and blob uploads, and 5 s of quiet after them", async () => {
    await collection("Docs", { "a.md": await put("# a") });
    const ingestActivity: Activity = { active: 1, started: 1 };
    const blobActivity: Activity = { active: 0, started: 0 };
    makeBackfill(
      {},
      {
        ingest: {
          gcBarrier: ingest.gcBarrier,
          withBlobHold: (fn) => ingest.withBlobHold(fn),
          activity: () => ingestActivity,
        },
        blobs: new (class extends BlobStore {
          override activity(): Activity {
            return blobActivity;
          }
        })(dir, 1_000_000),
      },
    );
    await started(backfill!);
    await advance(10_000);
    expect(markdown.calls).toEqual([]);
    expect(status().state).toBe("running");
    // The ingest ends; an upload starts.
    ingestActivity.active = 0;
    blobActivity.active = 1;
    blobActivity.started = 1;
    await advance(10_000);
    expect(markdown.calls).toEqual([]);
    blobActivity.active = 0;
    await advance(4_000);
    expect(markdown.calls).toEqual([]);
    // Another upload came and went between two looks: it counts too.
    blobActivity.started = 2;
    await advance(1_000);
    await advance(4_000);
    expect(markdown.calls).toEqual([]);
    await advance(1_000);
    expect(markdown.calls).toEqual(["# a"]);
  });

  it("pauses while the bucket account is paused, sync is blocked or rendition commits fail", async () => {
    await collection("Docs", { "a.md": await put("# a") });
    const committerStub = stubCommitter();
    const syncLoop = { blocked: false };
    committerStub.accountError = "Account suspended";
    makeBackfill({}, { committer: committerStub, syncLoop });
    await started(backfill!);
    expect(status()).toMatchObject({ state: "paused", paused_reason: "account_paused", left: 1 });
    committerStub.accountError = null;
    syncLoop.blocked = true;
    expect(status()).toMatchObject({ state: "paused", paused_reason: "sync_blocked" });
    syncLoop.blocked = false;
    committerStub.renditionsRetryAt = clock.now() + 10 * MINUTE;
    expect(status()).toMatchObject({ state: "paused", paused_reason: "bucket_error" });
    await advance(5 * MINUTE);
    expect(markdown.calls).toEqual([]);
    await advance(5 * MINUTE);
    expect(markdown.calls).toEqual(["# a"]);
    expect(status()).toMatchObject({ state: "done", paused_reason: null });
  });

  it("pauses on a failing bucket fetch and tries the same source again after it", async () => {
    const hash = await put("# remote");
    await collection("Docs", { "a.md": hash });
    await commitAll();
    // Only in the bucket now, as on a writer bootstrapped from the cloud.
    await unlink(blobs.path(hash));
    bucket.fail = new BucketError("Bucket unreachable", "transient", 503);
    makeBackfill({}, { bucket });
    await started(backfill!);
    expect(status()).toMatchObject({ state: "paused", paused_reason: "bucket_error", left: 1 });
    delete bucket.fail;
    await advance(MINUTE);
    expect(markdown.calls).toEqual(["# remote"]);
    expect(status()).toMatchObject({ state: "done", skipped: 0 });
  });

  it("keeps fewer than one committer pass of standalone renditions queued (sync on)", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Distinct blobs, in order.
      files[`doc-${String(index).padStart(2, "0")}.md`] = await put(`# doc ${index}`);
    await collection("Many", files);
    await commitAll();
    const committerStub = stubCommitter();
    makeBackfill({ sync: true }, { committer: committerStub, syncLoop: { blocked: false } });
    await started(backfill!);
    expect(markdown.calls).toHaveLength(50);
    expect(await queued()).toBe(50);
    expect(committerStub.wakes).toBeGreaterThanOrEqual(51);
    expect(status(50)).toMatchObject({ state: "running", left: 10, rendered: 50 });
    // The committer commits ten: ten more are rendered, and no more.
    await queue.run(
      "DELETE FROM pending_renditions WHERE rowid IN (SELECT rowid FROM pending_renditions LIMIT 10)",
    );
    await advance(5_000);
    expect(markdown.calls).toHaveLength(60);
    expect(await queued()).toBe(50);
    // Not done until the queued renditions are committed.
    expect(status(50)).toMatchObject({ state: "running", left: 0 });
    expect(status(0)).toMatchObject({ state: "done", left: 0 });
  });
});

describe("background rerender: order, skips and races", () => {
  it("renders in tier order and the committer commits every rendition", async () => {
    const [p1, p2, f1, f2] = await Promise.all(
      ["p1", "p2", "f1", "f2"].map((name) => put(`# ${name}`)),
    );
    const plain = await collection("Plain", { "a.md": p1! });
    await revise(plain.collection, { "a.md": p2! });
    const followed = await collection("Followed", { "a.md": f1! });
    await revise(followed.collection, { "a.md": f2! });
    await commitAll();
    await link(plain.collection, plain.revision);
    await link(followed.collection, null);
    makeBackfill({ sync: true }, { committer, bucket, syncLoop: { blocked: false } });
    await started(backfill!);
    // Tier 1 (the Latest link's revision, the pinned one; newest first), tier 2, tier 3.
    expect(markdown.calls).toEqual(["# f2", "# p1", "# p2", "# f1"]);
    await until(async () => {
      await committer.drain();
      return (await queued()) === 0;
    });
    expect(
      await count(
        waypoint,
        "SELECT COUNT(*) AS n FROM renditions WHERE renderer='markdown' AND renderer_version=3",
      ),
    ).toBe(4);
    expect(status(0)).toMatchObject({ state: "done", rendered: 4 });
  });

  it("records skips and backs off from 1 hour, x4, until the next version for size", async () => {
    expect(skipRetryAt("declined", 1, 0)).toBe(HOUR);
    expect(skipRetryAt("timeout", 2, 0)).toBe(4 * HOUR);
    expect(skipRetryAt("missing", 3, 0)).toBe(16 * HOUR);
    expect(skipRetryAt("declined", 4, 0)).toBe(64 * HOUR);
    expect(skipRetryAt("declined", 5, 0)).toBe(7 * DAY);
    expect(skipRetryAt("declined", 40, 0)).toBe(7 * DAY);
    expect(skipRetryAt("too_large", 1, 0)).toBeNull();
    expect(skipRetryAt("output_too_large", 1, 0)).toBeNull();

    const [bad, big, gone, fine, old] = await Promise.all([
      put("# bad"),
      put("0123456789abcdef"),
      put("# gone"),
      put("# fine"),
      put("# old skip"),
    ]);
    await collection("Docs", {
      "bad.md": bad,
      "big.txt": big,
      "gone.md": gone,
      "fine.md": fine,
      "old.md": old,
    });
    await unlink(blobs.path(gone));
    markdown.declined.add("# bad");
    // A row for an older version goes at start; one at the current version counts as a skip.
    await queue.run(
      "INSERT INTO rerender_skips (source_hash,renderer,renderer_version,reason,attempts,at,retry_at) VALUES (?,?,?,?,?,?,?)",
      [fine, "markdown", 2, "declined", 3, 1, 2],
    );
    await queue.run(
      "INSERT INTO rerender_skips (source_hash,renderer,renderer_version,reason,attempts,at,retry_at) VALUES (?,?,?,?,?,?,?)",
      [old, "markdown", 3, "timeout", 2, clock.now(), clock.now() + 3 * HOUR],
    );
    makeBackfill({ maxSourceBytes: { text: 8 } });
    await started(backfill!);
    const skips = async (): Promise<unknown[]> =>
      queue.all(
        "SELECT source_hash,renderer,renderer_version,reason,attempts,at,retry_at FROM rerender_skips ORDER BY reason",
      );
    const now = clock.now();
    expect(await skips()).toEqual([
      {
        source_hash: bad,
        renderer: "markdown",
        renderer_version: 3,
        reason: "declined",
        attempts: 1,
        at: now,
        retry_at: now + HOUR,
      },
      {
        source_hash: gone,
        renderer: "markdown",
        renderer_version: 3,
        reason: "missing",
        attempts: 1,
        at: now,
        retry_at: now + HOUR,
      },
      {
        source_hash: old,
        renderer: "markdown",
        renderer_version: 3,
        reason: "timeout",
        attempts: 2,
        at: now,
        retry_at: now + 3 * HOUR,
      },
      {
        source_hash: big,
        renderer: "text",
        renderer_version: 2,
        reason: "too_large",
        attempts: 1,
        at: now,
        retry_at: null,
      },
    ]);
    expect(markdown.calls.toSorted()).toEqual(["# bad", "# fine"]);
    expect(text.calls).toEqual([]);
    expect(status()).toMatchObject({ state: "done", stale: 4, skipped: 4, left: 0 });
    expect(status().renderers).toEqual([
      { renderer: "markdown", version: 3, stale: 3, skipped: 3, left: 0 },
      { renderer: "text", version: 2, stale: 1, skipped: 1, left: 0 },
    ]);

    // An hour on: `bad` and `gone` are tried again, and back off to 4 hours.
    await advance(HOUR - 1);
    expect(markdown.calls).toHaveLength(2);
    await advance(1);
    expect(markdown.calls).toHaveLength(3);
    const later = clock.now();
    expect(
      await queue.all(
        "SELECT source_hash,attempts,retry_at FROM rerender_skips WHERE reason IN ('declined','missing') ORDER BY reason",
      ),
    ).toEqual([
      { source_hash: bad, attempts: 2, retry_at: later + 4 * HOUR },
      { source_hash: gone, attempts: 2, retry_at: later + 4 * HOUR },
    ]);
    // The renderer takes `bad` now; `old` is retried and rendered on the way.
    markdown.declined.clear();
    await advance(2 * HOUR);
    expect(markdown.calls.at(-1)).toBe("# old skip");
    await advance(2 * HOUR);
    expect(markdown.calls.at(-1)).toBe("# bad");
    expect(await queue.all("SELECT reason FROM rerender_skips ORDER BY reason")).toEqual([
      { reason: "missing" },
      { reason: "too_large" },
    ]);
    expect(status()).toMatchObject({ stale: 2, skipped: 2, left: 0 });
    // Too large stays skipped until the next version.
    await advance(8 * DAY);
    expect(text.calls).toEqual([]);
  });

  it("records a timeout and starts the next source on a fresh worker", async () => {
    const [slow, quick] = await Promise.all([put("# slow"), put("# quick")]);
    // Newest first: `slow` comes first.
    await collection("Quick", { "a.md": quick });
    await collection("Slow", { "a.md": slow });
    markdown.held.set("# slow", new Promise(() => undefined));
    makeBackfill({ timeoutMs: 30_000 });
    backfill!.start();
    await until(() => markdown.calls.includes("# slow"));
    clock.advance(30_000);
    await until(() => markdown.calls.includes("# quick"));
    await backfill!.whenIdle();
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(await queue.all("SELECT reason,attempts FROM rerender_skips")).toEqual([
      { reason: "timeout", attempts: 1 },
    ]);
    expect(await queued()).toBe(1);
  });

  it("never holds the GC barrier while rendering: a purge collects the source, and its output is dropped", async () => {
    const [doomed, kept] = await Promise.all([put("# doomed"), put("# kept")]);
    const purged = await collection("Purged", { "a.md": doomed });
    await collection("Kept", { "a.md": kept });
    await commitAll();
    const release = deferred();
    markdown.held.set("# doomed", release.promise);
    makeBackfill({ sync: true }, { committer, bucket, syncLoop: { blocked: false } });
    backfill!.start();
    await until(() => markdown.calls.includes("# doomed"));
    // Meanwhile: Trash, purge, and blob GC (the source is old enough to collect).
    await waypoint.run(
      "INSERT INTO collection_tombstones (collection_id,deleted_at) VALUES (?,?)",
      [purged.collection, 1],
    );
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      purged.collection,
      Date.now(),
    ]);
    const past = new Date(Date.now() - DAY);
    await utimes(blobs.path(doomed), past, past);
    // An ingest isn't held up either.
    await collection("During", { "a.md": await put("# during") });
    await commitAll();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_purges")).toBe(0);
    expect(await waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [doomed])).toBeUndefined();
    release.resolve();
    await backfill!.whenIdle();
    await until(async () => {
      await committer.drain();
      return (await queued()) === 0;
    });
    expect(
      await queue.get("SELECT 1 FROM pending_renditions WHERE source_hash=?", [doomed]),
    ).toBeUndefined();
    expect(
      await waypoint.get("SELECT 1 FROM renditions WHERE source_hash=?", [doomed]),
    ).toBeUndefined();
    expect(await waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [doomed])).toBeUndefined();
    expect(await waypoint.get("SELECT 1 FROM renditions WHERE source_hash=?", [kept])).toBeTruthy();
    expect(status(0)).toMatchObject({ state: "done", stale: 0, rendered: 1 });
  });

  it.each(["purge", "drop"] as const)(
    "queues nothing for a source a %s removed while its output was being stored",
    async (removal) => {
      const doomed = await put("# doomed");
      const gone = await collection("Gone", { "a.md": doomed });
      const app = createApp({ waypoint, queue, blobs, reads, ingest });
      // Hold the output's store: after the backfill has looked at its source, before its rows.
      const storing = deferred();
      const release = deferred();
      const store = blobs.put.bind(blobs);
      blobs.put = async (source, claimedHash, options) => {
        if (options?.background && claimedHash === undefined) {
          storing.resolve();
          await release.promise;
        }
        return store(source, claimedHash, options);
      };
      makeBackfill({ sync: false });
      backfill!.start();
      await storing.promise;
      // The removal prunes queued rows now, then waits for the backfill's barrier section.
      const removed = app.request(
        removal === "purge"
          ? `/api/collections/${gone.collection}/purge`
          : `/api/queue/${gone.revision}`,
        removal === "purge"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ confirm: gone.collection }),
            }
          : { method: "DELETE" },
      );
      await until(
        async () => (await count(queue, "SELECT COUNT(*) AS n FROM pending_revisions")) === 0,
      );
      release.resolve();
      expect((await removed).status).toBe(removal === "purge" ? 202 : 200);
      await backfill!.whenIdle();
      expect(markdown.calls).toEqual(["# doomed"]);
      expect(await queued()).toBe(0);
      expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_blobs")).toBe(0);
      expect(status()).toMatchObject({ state: "done", stale: 0, rendered: 0 });
    },
  );

  it.each([5, 120])(
    "checks one known revision inside the queue transaction, not every pending one (%i others pending), and looks again outside it",
    async (others) => {
      // Pending revisions without the source, older than both that have it, sync off: no
      // renderer for their files, so they only add to what a scan would read.
      const filler = newId("col");
      const files = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `img-${index}.png`,
          { hash: `sha256:${index.toString(16).padStart(64, "0")}`, mime: "image/png", size: 1 },
        ]),
      );
      await queue.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO pending_collections (id,public_id,title,created_at) VALUES (?,?,?,?)",
          [filler, "filler", "Filler", 1],
        );
        await inSeries(
          Array.from({ length: others }, (_, index) => index),
          (index) =>
            tx.run(
              "INSERT INTO pending_revisions (id,public_id,collection_id,head_path,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,'pending')",
              [
                mintRevisionId({ now: Date.now() - 60_000 + index }),
                `filler-${index}`,
                filler,
                "img-0.png",
                JSON.stringify({ files }),
                1,
              ],
            ),
        );
      });
      const shared = await put("# shared");
      await nextMs();
      // Found through the newer one, which goes to Trash while its output is stored.
      await collection("Older", { "a.md": shared });
      await nextMs();
      const newer = await collection("Newer", { "a.md": shared });
      const storing = deferred();
      const release = deferred();
      const store = blobs.put.bind(blobs);
      blobs.put = async (source, claimedHash, options) => {
        if (options?.background && claimedHash === undefined) {
          storing.resolve();
          await release.promise;
        }
        return store(source, claimedHash, options);
      };
      // What each queue transaction runs, on either database, and every page looked through.
      const transactions: string[][] = [];
      let current: string[] | undefined;
      const transaction = queue.transaction.bind(queue);
      queue.transaction = (fn) =>
        transaction(async (tx) => {
          current = [];
          transactions.push(current);
          try {
            return await fn(tx);
          } finally {
            current = undefined;
          }
        });
      let pages = 0;
      queue.onStatement = (sql) => {
        current?.push(sql);
        if (sql.includes("instr(manifest_json")) pages++;
      };
      waypoint.onStatement = (sql) => current?.push(sql);
      try {
        makeBackfill({ sync: false });
        backfill!.start();
        await storing.promise;
        await queue.run("UPDATE pending_collections SET deleted_at=1 WHERE id=?", [
          newer.collection,
        ]);
        release.resolve();
        await backfill!.whenIdle();
      } finally {
        queue.onStatement = undefined;
        waypoint.onStatement = undefined;
      }
      expect(markdown.calls).toEqual(["# shared"]);
      expect(await queued()).toBe(1);
      expect(status()).toMatchObject({ state: "done", stale: 0, rendered: 1 });
      // Both transactions, the one that found the Newer revision gone and the one that queued
      // through the Older revision, ran the same few statements however many are pending.
      const known =
        "SELECT p.collection_id FROM pending_revisions p, json_each(p.manifest_json,'$.files') f WHERE p.id=? AND p.state='pending' AND json_extract(f.value,'$.hash')=? LIMIT 1";
      expect(
        transactions.map((statements) => statements.filter((sql) => !sql.startsWith("INSERT"))),
      ).toEqual([
        [
          "SELECT 1 FROM blobs WHERE hash=?",
          known,
          "SELECT 1 FROM pending_purges WHERE collection_id=?",
          "SELECT 1 FROM collection_tombstones WHERE collection_id=?",
          "SELECT 1 FROM pending_collections WHERE id=? AND deleted_at IS NOT NULL",
        ],
        [
          "SELECT 1 FROM blobs WHERE hash=?",
          known,
          "SELECT 1 FROM pending_purges WHERE collection_id=?",
          "SELECT 1 FROM collection_tombstones WHERE collection_id=?",
          "SELECT 1 FROM pending_collections WHERE id=? AND deleted_at IS NOT NULL",
        ],
      ]);
      // The look outside them went through the pending revisions in pages, up to Older.
      expect(pages).toBe(Math.floor(others / 50) + 1);
    },
  );

  it("renders a source shared with another live collection when the one it was found through goes to Trash", async () => {
    const shared = await put("# shared");
    await collection("Older", { "a.md": shared });
    await nextMs();
    // The newer revision is the source's best position.
    const newer = await collection("Newer", { "a.md": shared });
    makeBackfill({ delayMs: MINUTE });
    await started(backfill!);
    expect(status()).toMatchObject({ stale: 1 });
    await queue.run("UPDATE pending_collections SET deleted_at=1 WHERE id=?", [newer.collection]);
    await advance(MINUTE);
    expect(markdown.calls).toEqual(["# shared"]);
    expect(await queued()).toBe(1);
    expect(status()).toMatchObject({ state: "done", stale: 0, rendered: 1 });
  });

  it("drops a source whose collection went to Trash or a purge before its turn", async () => {
    const [trashed, live] = await Promise.all([put("# trashed"), put("# live")]);
    const gone = await collection("Gone", { "a.md": trashed });
    await collection("Live", { "a.md": live });
    makeBackfill({ delayMs: MINUTE });
    await started(backfill!);
    expect(status()).toMatchObject({ stale: 2 });
    await queue.run("UPDATE pending_collections SET deleted_at=1 WHERE id=?", [gone.collection]);
    await advance(MINUTE);
    expect(markdown.calls).toEqual(["# live"]);
    expect(status()).toMatchObject({ state: "done", stale: 0 });
  });
});

describe("background rerender: recompute, sync off, stop", () => {
  it("puts an undeleted collection's sources at the front", async () => {
    const [a, b, c] = await Promise.all([put("# a"), put("# b"), put("# c")]);
    const restored = await collection("Restored", { "a.md": a });
    await collection("B", { "a.md": b });
    await nextMs();
    await collection("C", { "a.md": c });
    const app = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      backfill: makeBackfill({ delayMs: 10 * MINUTE }),
    });
    expect(
      (await app.request(`/api/collections/${restored.collection}`, { method: "DELETE" })).status,
    ).toBe(200);
    await started(backfill!);
    expect(status()).toMatchObject({ stale: 2 });
    expect(
      (await app.request(`/api/collections/${restored.collection}/undelete`, { method: "POST" }))
        .status,
    ).toBe(200);
    await backfill!.whenIdle();
    expect(status()).toMatchObject({ stale: 3 });
    await advance(10 * MINUTE);
    // Without the undelete, `a` (the oldest latest revision) would come last.
    expect(markdown.calls).toEqual(["# a", "# c", "# b"]);
  });

  it("surveys a collection after a commit, everything 10 minutes after a changed pull, and every 24 hours", async () => {
    await collection("First", { "a.md": await put("# first") });
    makeBackfill();
    await started(backfill!);
    expect(markdown.calls).toEqual(["# first"]);
    const committed = await collection("Committed", { "a.md": await put("# committed") });
    backfill!.collectionChanged(committed.collection);
    await backfill!.whenIdle();
    // Surveyed at once; rendered after 5 s without ingests (this test's own just ran).
    expect(status()).toMatchObject({ left: 1 });
    expect(markdown.calls.at(-1)).toBe("# first");
    await advance(QUIET_MS);
    expect(markdown.calls.at(-1)).toBe("# committed");
    expect(logs).toHaveLength(1);

    await collection("Pulled", { "a.md": await put("# pulled") });
    backfill!.pullChanged();
    await backfill!.whenIdle();
    backfill!.pullChanged();
    await advance(PULL_SURVEY_DEBOUNCE_MS - 1);
    expect(markdown.calls.at(-1)).toBe("# committed");
    await advance(1);
    expect(status()).toMatchObject({ left: 1 });
    await advance(QUIET_MS);
    expect(markdown.calls.at(-1)).toBe("# pulled");
    expect(logs).toHaveLength(2);

    await collection("Daily", { "a.md": await put("# daily") });
    await advance(DAY - PULL_SURVEY_DEBOUNCE_MS - 1);
    expect(markdown.calls.at(-1)).toBe("# pulled");
    await advance(PULL_SURVEY_DEBOUNCE_MS + 1);
    expect(status()).toMatchObject({ left: 1 });
    await advance(QUIET_MS);
    expect(markdown.calls.at(-1)).toBe("# daily");
    expect(logs).toHaveLength(3);
  });

  it("refreshes the priorities a collection survey finds: a commit moves the Latest link's tier", async () => {
    const served = await put("# served");
    const docs = await collection("Docs", { "a.md": served });
    await commitAll();
    await link(docs.collection, null);
    // Queued, not committed: the Latest link still serves the first revision.
    await revise(docs.collection, { "a.md": await put("# next") });
    makeBackfill(
      { sync: true, delayMs: HOUR },
      { committer, bucket, syncLoop: { blocked: false } },
    );
    await started(backfill!);
    expect(status()).toMatchObject({ stale: 2 });
    // The second revision commits: the link serves it now, and the first is an older revision.
    await commitAll();
    backfill!.collectionChanged(docs.collection);
    await backfill!.whenIdle();
    await advance(HOUR);
    await until(() => markdown.calls.length === 2);
    expect(markdown.calls).toEqual(["# next", "# served"]);
  });

  it("keeps a source's best position from another collection when a collection survey lowers it", async () => {
    const shared = await put("# shared");
    const pinned = await collection("Pinned", { "a.md": shared });
    const other = await collection("Other", { "a.md": shared });
    await commitAll();
    await link(pinned.collection, pinned.revision);
    // Tier 2 in both, newer: comes before `shared` unless the pinned link keeps it in tier 1.
    await revise(other.collection, { "a.md": await put("# other next") });
    makeBackfill(
      { sync: true, delayMs: HOUR },
      { committer, bucket, syncLoop: { blocked: false } },
    );
    await started(backfill!);
    await commitAll();
    // In `Other`, `shared` is now an older revision (tier 3); in `Pinned` it's still tier 1.
    backfill!.collectionChanged(other.collection);
    await backfill!.whenIdle();
    await advance(HOUR);
    await until(() => markdown.calls.length === 2);
    expect(markdown.calls).toEqual(["# shared", "# other next"]);
  });

  it("abandons a full survey between pages when stopped, so shutdown doesn't wait for it", async () => {
    for (let index = 0; index < 10; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Distinct collections, in order.
      await collection(`Docs ${index}`, { "a.md": await put(`# doc ${index}`) });
    await commitAll();
    let filePages = 0;
    waypoint.onStatement = (sql) => {
      if (!sql.startsWith("SELECT path, blob_hash, mime, size FROM revision_files")) return;
      filePages++;
      backfill!.stop();
    };
    try {
      makeBackfill({ sync: true }, { committer, bucket, syncLoop: { blocked: false } });
      backfill!.start();
      await backfill!.drain();
    } finally {
      waypoint.onStatement = undefined;
    }
    expect(filePages).toBe(1);
    expect(logs).toEqual([]);
    expect(status()).toMatchObject({ surveyed_at: null, stale: null });
    expect(markdown.calls).toEqual([]);
  });

  it("with sync off, renders sources of pending revisions without a backlog limit", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Distinct blobs, in order.
      files[`doc-${String(index).padStart(2, "0")}.md`] = await put(`# doc ${index}`);
    await collection("Local", files);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_revisions")).toBe(1);
    expect(await count(waypoint, "SELECT COUNT(*) AS n FROM blobs")).toBe(0);
    makeBackfill({ sync: false });
    await started(backfill!);
    expect(markdown.calls).toHaveLength(60);
    expect(await queued()).toBe(60);
    // The rows wait for their revision; with sync off nothing commits them, and that's done.
    expect(status(60)).toMatchObject({ state: "done", left: 0, rendered: 60 });
  });

  it("stops mid-render without queueing anything, and drains", async () => {
    await collection("Docs", { "a.md": await put("# a") });
    const release = deferred();
    markdown.held.set("# a", release.promise);
    makeBackfill();
    backfill!.start();
    await until(() => markdown.calls.length === 1);
    backfill!.stop();
    await backfill!.drain();
    expect(closed).toBe(1);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await queued()).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM rerender_skips")).toBe(0);
  });

  it("only counts in off mode", async () => {
    await collection("Docs", { "a.md": await put("# a") });
    makeBackfill({ mode: "off" });
    await started(backfill!);
    await advance(2 * DAY);
    expect(markdown.calls).toEqual([]);
    expect(status()).toMatchObject({
      mode: "off",
      state: "off",
      starts_at: null,
      paused_reason: null,
      stale: 1,
      skipped: 0,
      left: 1,
      rendered: 0,
      rate_per_minute: null,
      eta_ms: null,
    });
  });
});

async function json(response: Response): Promise<unknown> {
  return response.json();
}
/** The `rerender` block of an /api/status response. */
async function rerenderBlock(response: Response): Promise<unknown> {
  const body = await json(response);
  return body && typeof body === "object" && "rerender" in body ? body.rerender : undefined;
}

describe("background rerender over HTTP", () => {
  it("reports the rerender block in /api/status in each state", async () => {
    const [a, b, c] = await Promise.all([put("# a"), put("# b"), put("# c")]);
    // Newest first: c, b, a.
    await collection("A", { "a.md": a });
    await nextMs();
    await collection("B", { "a.md": b });
    await nextMs();
    await collection("C", { "a.md": c });
    const committerStub = stubCommitter();
    const app = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      backfill: makeBackfill({ delayMs: 45 * MINUTE }, { committer: committerStub }),
    });
    const block = async (): Promise<unknown> => rerenderBlock(await app.request("/api/status"));
    expect(await block()).toMatchObject({
      state: "waiting",
      surveyed_at: null,
      stale: null,
      skipped: null,
      left: null,
      renderers: [],
    });
    const start = clock.now();
    await started(backfill!);
    expect(await block()).toEqual({
      mode: "auto",
      state: "waiting",
      starts_at: start + 45 * MINUTE,
      paused_reason: null,
      surveyed_at: start,
      stale: 3,
      skipped: 0,
      left: 3,
      rendered: 0,
      rate_per_minute: null,
      eta_ms: null,
      renderers: [
        { renderer: "markdown", version: 3, stale: 3, skipped: 0, left: 3 },
        { renderer: "text", version: 2, stale: 0, skipped: 0, left: 0 },
      ],
    });
    committerStub.accountError = "Account suspended";
    await advance(45 * MINUTE);
    expect(await block()).toMatchObject({
      state: "paused",
      paused_reason: "account_paused",
      starts_at: null,
      left: 3,
    });
    committerStub.accountError = null;
    // Two rendered, the third held: running, at two a minute.
    const held = deferred();
    markdown.held.set("# a", held.promise);
    clock.advance(30_000);
    await until(() => markdown.calls.includes("# a"));
    expect(await block()).toMatchObject({
      state: "running",
      paused_reason: null,
      left: 1,
      rendered: 2,
      rate_per_minute: 2,
      eta_ms: 30_000,
    });
    held.resolve();
    await backfill!.whenIdle();
    expect(await block()).toMatchObject({
      state: "done",
      stale: 0,
      left: 0,
      rendered: 3,
      eta_ms: null,
    });
  });

  it("ends the delay on a same-origin POST /api/rerender/start, and refuses cross-origin ones", async () => {
    await collection("Docs", { "a.md": await put("# a") });
    const app = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      backfill: makeBackfill({ delayMs: 45 * MINUTE }),
    });
    await started(backfill!);
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://example.test" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One refusal at a time.
      const refused = await app.request("/api/rerender/start", { method: "POST", headers });
      expect(refused.status).toBe(403);
    }
    expect(status().state).toBe("waiting");
    const response = await app.request("/api/rerender/start", {
      method: "POST",
      headers: { origin: "http://localhost:7410", "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      mode: "auto",
      state: "running",
      starts_at: null,
      left: 1,
    });
    await backfill!.whenIdle();
    expect(markdown.calls).toEqual(["# a"]);
    expect(status().state).toBe("done");
    // Again once done: nothing to end, same answer shape.
    expect(await json(await app.request("/api/rerender/start", { method: "POST" }))).toMatchObject({
      state: "done",
    });
  });

  it("refuses to start in off mode, and omits the block on a writer without a backfill", async () => {
    const off = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      backfill: makeBackfill({ mode: "off" }),
    });
    await started(backfill!);
    const refused = await off.request("/api/rerender/start", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ error: { code: "conflict" } });
    expect(await rerenderBlock(await off.request("/api/status"))).toMatchObject({ state: "off" });
    const plain = createApp({ waypoint, queue, blobs, reads, ingest });
    expect(await json(await plain.request("/api/status"))).not.toHaveProperty("rerender");
    expect((await plain.request("/api/rerender/start", { method: "POST" })).status).toBe(409);
  });
});
