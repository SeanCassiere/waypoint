import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { BucketError, MemoryBucket } from "../src/bucket.ts";
import { blobKey, RENDITIONS_PER_PASS, SimulatedCrash, WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService, type Renderer } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { writerRenderer, writerRenderers } from "../src/renderer.ts";
import {
  formatRerenderSummary,
  parseRerenderArgs,
  rerender,
  rerenderRendererName,
} from "../src/rerender.ts";
import { SyncLoop } from "../src/sync-loop.ts";

class FakeRenderer implements Renderer {
  readonly rendererName = "markdown";
  calls = 0;
  readonly rendererVersion: number;
  constructor(rendererVersion: number) {
    this.rendererVersion = rendererVersion;
  }
  render(source: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (mime !== "text/markdown") return Promise.resolve(null);
    this.calls++;
    const text = new TextDecoder().decode(source);
    return Promise.resolve({
      bytes: new TextEncoder().encode(`<v${this.rendererVersion}>${text}`),
      mime: "text/html",
    });
  }
}

let dir: string;
let waypoint: Db;
let queue: Db;
let sync: SyncClient;
let blobs: BlobStore;
let bucket: MemoryBucket;
let reads: ReadModel;
let ingest: IngestService;
let committer: WriterCommitter;
let clock: number;
let steps: ((step: string) => Promise<void> | void) | undefined;

async function put(text: string): Promise<string> {
  return (await blobs.put(Readable.from([text]))).hash;
}
async function commitAll(): Promise<void> {
  committer.wake();
  await committer.drain();
}
async function count(db: Db, sql: string, args: (string | number)[] = []): Promise<number> {
  return (await db.get<{ n: number }>(sql, args))?.n ?? 0;
}
function newCommitter(): WriterCommitter {
  return new WriterCommitter(
    waypoint,
    queue,
    blobs,
    bucket,
    new SyncLoop(queue, sync, () => clock, waypoint),
    ingest,
    () => clock,
    () => 0,
    72,
    async (step) => steps?.(step),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-rerender-"));
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
  bucket = new MemoryBucket();
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  clock = Date.now();
  steps = undefined;
  // Content ingested by an older writer: version 1 renditions only.
  ingest = new IngestService(waypoint, queue, blobs, reads, sync, undefined, new FakeRenderer(1));
  committer = newCommitter();
});
afterEach(async () => {
  committer.stop();
  await committer.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

async function seed(): Promise<{
  alpha: string;
  beta: string;
  readme: string;
  notes: string;
  shared: string;
  image: string;
}> {
  const readme = await put("# Readme");
  const notes = await put("# Notes");
  const shared = await put("# Shared");
  const image = await put("not markdown");
  const alpha = await ingest.create({
    title: "Alpha",
    files: [
      { path: "README.md", hash: readme },
      { path: "notes.md", hash: notes },
      { path: "copy.md", hash: shared },
      { path: "plot.png", hash: image },
    ],
  });
  const beta = await ingest.create({
    title: "Beta",
    files: [{ path: "index.md", hash: shared }],
  });
  await commitAll();
  expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_revisions")).toBe(0);
  expect(await count(waypoint, "SELECT COUNT(*) AS n FROM renditions")).toBe(3);
  return {
    alpha: alpha.collection_id,
    beta: beta.collection_id,
    readme,
    notes,
    shared,
    image,
  };
}

/** Commits `total` markdown files, then queues their standalone renditions as `rerender` does. */
async function backlog(total: number): Promise<string[]> {
  const sources: string[] = [];
  for (let index = 0; index < total; index++) sources.push(await put(`# Backlog ${index}`));
  await ingest.create({
    title: "Backlog",
    head_path: "doc-0.md",
    files: sources.map((hash, index) => ({ path: `doc-${index}.md`, hash })),
  });
  await commitAll();
  for (const [index, source] of sources.entries()) {
    const text = `<v2># Backlog ${index}`;
    const output = await put(text);
    await queue.run("INSERT OR IGNORE INTO pending_blobs (hash,size) VALUES (?,?)", [
      output,
      text.length,
    ]);
    await queue.run(
      "INSERT INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [source, "markdown", 2, output, "text/html", clock],
    );
  }
  return sources;
}

describe("rerender", () => {
  it("parses its flags and rejects ambiguous or mismatched ones", () => {
    const renderer = { rendererName: "markdown", rendererVersion: 2 };
    expect(parseRerenderArgs(["--all"], renderer)).toEqual({ dryRun: false });
    expect(
      parseRerenderArgs(
        [
          "--collection",
          "col_x",
          "--dry-run",
          "--limit",
          "5",
          "--renderer",
          "markdown",
          "--version",
          "2",
        ],
        renderer,
      ),
    ).toEqual({ collection: "col_x", dryRun: true, limit: 5 });
    const invalid: Array<[string[], string]> = [
      [[], "exactly one of --all or --collection"],
      [["--all", "--collection", "col_x"], "exactly one of --all or --collection"],
      [["--collection"], "--collection needs a value"],
      [["--all", "--limit", "0"], "--limit must be a positive integer"],
      [["--all", "--limit", "1.5"], "--limit must be a positive integer"],
      [["--all", "--version", "1"], "This writer renders version 2"],
      [["--all", "--renderer", "asciidoc"], "only the markdown renderer"],
      [["--all", "--force"], "Unknown option --force"],
    ];
    for (const [args, message] of invalid)
      expect(() => parseRerenderArgs(args, renderer)).toThrow(message);
  });

  it("reports what it would do on a dry run without writing anything", async () => {
    const { image } = await seed();
    const v2 = new FakeRenderer(2);
    const summary = await rerender(waypoint, queue, blobs, v2, { dryRun: true, limit: 2 });
    expect(summary).toMatchObject({
      renderer: "markdown",
      renderer_version: 2,
      collection: null,
      dry_run: true,
      sources: 3,
      current: 0,
      queued: 2,
      remaining: 1,
      missing: [],
      failed: [],
    });
    expect(v2.calls).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_blobs")).toBe(0);
    expect(summary.missing).not.toContain(image);
  });

  it("queues one current-version rendition per markdown source, idempotently", async () => {
    const { readme, notes, shared, image } = await seed();
    const v2 = new FakeRenderer(2);
    const first = await rerender(waypoint, queue, blobs, v2, { dryRun: false });
    expect(first).toMatchObject({ sources: 3, current: 0, queued: 3, remaining: 0 });
    expect(v2.calls).toBe(3);
    const rows = await queue.all<{
      source_hash: string;
      renderer: string;
      renderer_version: number;
      output_hash: string;
      output_mime: string;
    }>(
      "SELECT source_hash,renderer,renderer_version,output_hash,output_mime FROM pending_renditions ORDER BY source_hash",
    );
    expect(rows.map((row) => row.source_hash)).toEqual([readme, notes, shared].toSorted());
    expect(rows.every((row) => row.renderer === "markdown" && row.renderer_version === 2)).toBe(
      true,
    );
    expect(rows.some((row) => row.source_hash === image)).toBe(false);
    for (const row of rows) {
      expect(row.output_mime).toBe("text/html");
      expect(await blobs.has(row.output_hash)).toBe(true);
      expect(
        await queue.get("SELECT size FROM pending_blobs WHERE hash=?", [row.output_hash]),
      ).toBeTruthy();
    }
    // The writer serves queued renditions straight away, newest version first.
    const queued = await reads.rendition(readme);
    expect(queued?.hash).toBe(rows.find((row) => row.source_hash === readme)?.output_hash);

    const again = await rerender(waypoint, queue, blobs, v2, { dryRun: false });
    expect(again).toMatchObject({ sources: 3, current: 3, queued: 0, remaining: 0 });
    expect(v2.calls).toBe(3);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(3);
  });

  it("ends its output with a plain remaining line for loops", async () => {
    await seed();
    const dry = await rerender(waypoint, queue, blobs, new FakeRenderer(2), {
      dryRun: true,
      limit: 1,
    });
    const dryLines = formatRerenderSummary(dry).split("\n");
    expect(JSON.parse(dryLines[0]!)).toEqual(dry);
    expect(dryLines.slice(1)).toEqual(["missing: 0", "failed: 0", "remaining: 2 (dry run)"]);
    const run = await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    expect(formatRerenderSummary(run).split("\n").at(-1)).toBe("remaining: 0");
  });

  it("resumes across --limit runs and scopes to one collection", async () => {
    const { alpha, beta, shared } = await seed();
    const v2 = new FakeRenderer(2);
    const publicId = (await waypoint.get<{ public_id: string }>(
      "SELECT public_id FROM collections WHERE id=?",
      [beta],
    ))!.public_id;
    const scoped = await rerender(waypoint, queue, blobs, v2, {
      dryRun: false,
      collection: publicId,
    });
    expect(scoped).toMatchObject({ collection: beta, sources: 1, queued: 1 });
    expect(
      (await queue.all<{ source_hash: string }>("SELECT source_hash FROM pending_renditions")).map(
        (row) => row.source_hash,
      ),
    ).toEqual([shared]);
    const step = await rerender(waypoint, queue, blobs, v2, {
      dryRun: false,
      collection: alpha,
      limit: 1,
    });
    expect(step).toMatchObject({ sources: 3, current: 1, queued: 1, remaining: 1 });
    const rest = await rerender(waypoint, queue, blobs, v2, { dryRun: false, collection: alpha });
    expect(rest).toMatchObject({ current: 2, queued: 1, remaining: 0 });
    await expect(
      rerender(waypoint, queue, blobs, v2, { dryRun: false, collection: "col_missing" }),
    ).rejects.toThrow("Collection not found");
  });

  it("includes sources of pending revisions and skips collections being purged", async () => {
    const { alpha } = await seed();
    const draft = await put("# Draft");
    const pending = await ingest.add(alpha, { files: [{ path: "draft.md", hash: draft }] });
    expect(pending.sync_state).toBe("pending");
    const summary = await rerender(waypoint, queue, blobs, new FakeRenderer(2), {
      dryRun: true,
      collection: alpha,
    });
    expect(summary.sources).toBe(4);
    const beta = (await waypoint.get<{ id: string }>(
      "SELECT id FROM collections WHERE title='Beta'",
    ))!.id;
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      beta,
      clock,
    ]);
    const purging = await rerender(waypoint, queue, blobs, new FakeRenderer(2), {
      dryRun: true,
      collection: beta,
    });
    expect(purging.sources).toBe(0);
  });

  it("fetches sources missing from the local store and reports ones it cannot get", async () => {
    const { readme, notes } = await seed();
    await blobs.delete(readme);
    await blobs.delete(notes);
    bucket.objects.delete(blobKey(notes));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await rerender(
      waypoint,
      queue,
      blobs,
      new FakeRenderer(2),
      { dryRun: false },
      bucket,
    );
    spy.mockRestore();
    expect(summary.missing).toEqual([notes]);
    // A missing source isn't "remaining": another run can't fix it.
    expect(summary).toMatchObject({ queued: 2, remaining: 0 });
    expect(await blobs.has(readme)).toBe(true);
    const offline = await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    expect(offline.missing).toEqual([notes]);
  });

  it("commits queued renditions through the committer, blob before row", async () => {
    const { readme, notes, shared } = await seed();
    await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    const outputs = await queue.all<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM pending_renditions",
    );
    const seen: string[] = [];
    steps = async (step) => {
      if (step !== "rendition_after_blob_upload") return;
      seen.push(step);
      // At upload time the object exists and no row references it yet.
      const uploaded = outputs.filter((item) => bucket.objects.has(blobKey(item.output_hash)));
      const rows = await count(
        waypoint,
        "SELECT COUNT(*) AS n FROM renditions WHERE renderer_version=2",
      );
      expect(rows).toBe(uploaded.length - 1);
    };
    await commitAll();
    expect(seen).toHaveLength(3);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    for (const { source_hash, output_hash } of outputs) {
      expect(bucket.objects.has(blobKey(output_hash))).toBe(true);
      expect(await waypoint.get("SELECT size FROM blobs WHERE hash=?", [output_hash])).toBeTruthy();
      expect(
        await queue.get("SELECT 1 FROM pending_blobs WHERE hash=?", [output_hash]),
      ).toBeFalsy();
      expect(
        await waypoint.get(
          "SELECT output_hash FROM renditions WHERE source_hash=? AND renderer='markdown' AND renderer_version=2",
          [source_hash],
        ),
      ).toEqual({ output_hash });
      // Both versions exist; readers pick the newest.
      expect(
        await count(waypoint, "SELECT COUNT(*) AS n FROM renditions WHERE source_hash=?", [
          source_hash,
        ]),
      ).toBe(2);
      expect((await reads.rendition(source_hash))?.hash).toBe(output_hash);
      expect(
        await waypoint.get<{ output_hash: string }>(
          "SELECT output_hash FROM renditions WHERE source_hash=? AND renderer='markdown' ORDER BY renderer_version DESC LIMIT 1",
          [source_hash],
        ),
      ).toEqual({ output_hash });
    }
    expect([readme, notes, shared].toSorted()).toEqual(
      outputs.map((item) => item.source_hash).toSorted(),
    );
    const done = await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    expect(done).toMatchObject({ current: 3, queued: 0 });
  });

  it("retries after bucket failures and a crash between upload and rows", async () => {
    await seed();
    await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false, limit: 1 });
    const [queued] = await queue.all<{ output_hash: string }>(
      "SELECT output_hash FROM pending_renditions",
    );
    bucket.fail = new BucketError("unavailable", "transient", 503);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await commitAll();
    spy.mockRestore();
    expect(
      await count(waypoint, "SELECT COUNT(*) AS n FROM renditions WHERE renderer_version=2"),
    ).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(1);

    delete bucket.fail;
    committer.stop();
    committer = newCommitter();
    steps = (step) => {
      if (step === "rendition_after_blob_upload") throw new SimulatedCrash(step);
    };
    await expect(
      (async () => {
        committer.wake();
        await committer.drain();
      })(),
    ).rejects.toThrow(SimulatedCrash);
    expect(bucket.objects.has(blobKey(queued!.output_hash))).toBe(true);
    expect(
      await count(waypoint, "SELECT COUNT(*) AS n FROM renditions WHERE renderer_version=2"),
    ).toBe(0);

    steps = undefined;
    committer = newCommitter();
    await commitAll();
    expect(
      await count(waypoint, "SELECT COUNT(*) AS n FROM renditions WHERE renderer_version=2"),
    ).toBe(1);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_blobs")).toBe(0);
  });

  it("drops queued renditions whose source is gone and whose output went missing", async () => {
    const { readme } = await seed();
    await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    const rows = await queue.all<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM pending_renditions ORDER BY source_hash",
    );
    const lost = rows.find((row) => row.source_hash !== readme)!;
    await blobs.delete(lost.output_hash);
    const orphan = await put("# Orphan");
    const orphanOutput = await put("<v2># Orphan");
    await queue.run("INSERT INTO pending_blobs (hash,size) VALUES (?,?)", [orphanOutput, 12]);
    await queue.run(
      "INSERT INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [orphan, "markdown", 2, orphanOutput, "text/html", clock],
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await commitAll();
    spy.mockRestore();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_blobs")).toBe(0);
    expect(
      await count(waypoint, "SELECT COUNT(*) AS n FROM renditions WHERE renderer_version=2"),
    ).toBe(rows.length - 1);
    expect(bucket.objects.has(blobKey(orphanOutput))).toBe(false);
    // Running rerender again recreates what was dropped.
    const again = await rerender(waypoint, queue, blobs, new FakeRenderer(2), { dryRun: false });
    expect(again.queued).toBe(1);
  });

  it("renders with the real writer renderer at the current version", async () => {
    const { alpha, readme, notes, shared } = await seed();
    const summary = await rerender(waypoint, queue, blobs, writerRenderer, {
      dryRun: false,
      collection: alpha,
      limit: 1,
    });
    expect(summary).toMatchObject({
      renderer_version: writerRenderer.rendererVersion,
      queued: 1,
      remaining: 2,
    });
    const row = await queue.get<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM pending_renditions",
    );
    if (!row) throw new Error("Missing queued rendition");
    expect([readme, notes, shared]).toContain(row.source_hash);
    const html = await readFile(blobs.path(row.output_hash), "utf8");
    expect(html).toContain('"waypoint:location"');
  });

  it("commits a rerender backlog in batches so new revisions don't wait behind it", async () => {
    await seed();
    const total = RENDITIONS_PER_PASS * 2 + 20;
    await backlog(total);
    let done = 0;
    let revisionId: string | undefined;
    let committedAfter: number | undefined;
    steps = async (step) => {
      if (step !== "rendition_after_rows") return;
      done++;
      if (done === 5) {
        // An agent writes while the backlog uploads.
        revisionId = (
          await ingest.create({ title: "Fresh", files: [{ path: "a.md", hash: await put("# A") }] })
        ).revision_id;
        committer.wake();
      }
      if (
        revisionId &&
        committedAfter === undefined &&
        (await waypoint.get("SELECT 1 FROM revisions WHERE id=?", [revisionId]))
      )
        committedAfter = done;
    };
    await commitAll();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    expect(done).toBe(total);
    // Committed right after the first batch, not after the whole backlog.
    expect(committedAfter).toBeDefined();
    expect(committedAfter!).toBeLessThanOrEqual(RENDITIONS_PER_PASS + 1);
  });

  it("keeps standalone rerender rows when a queued revision or collection is dropped", async () => {
    await seed();
    const sources = await backlog(3);
    const app = createApp({ waypoint, queue, blobs, reads, ingest });
    // A queued revision dropped from Status (prunePendingStorage).
    const fresh = await ingest.create({
      title: "Dropped",
      files: [{ path: "x.md", hash: await put("# Dropped") }],
    });
    const dropped = await app.request(`/api/queue/${fresh.revision_id}`, { method: "DELETE" });
    expect(dropped.status).toBe(200);
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(3);
    // A queued-only collection purged by the committer (dropQueuedCollection).
    const purged = await ingest.create({
      title: "Purged",
      files: [{ path: "y.md", hash: await put("# Purged") }],
    });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [purged.revision_id]);
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      purged.collection_id,
      clock,
    ]);
    // Hold the renditions back (uploads fail) while the purge runs, then let them commit.
    const uploads = vi
      .spyOn(bucket, "putIfAbsent")
      .mockRejectedValue(new BucketError("unavailable", "transient", 503));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await commitAll();
    spy.mockRestore();
    uploads.mockRestore();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_purges")).toBe(0);
    expect(
      await count(queue, "SELECT COUNT(*) AS n FROM pending_revisions WHERE collection_id=?", [
        purged.collection_id,
      ]),
    ).toBe(0);
    const left = await queue.all<{ source_hash: string; output_hash: string }>(
      "SELECT source_hash,output_hash FROM pending_renditions ORDER BY source_hash",
    );
    expect(left.map((row) => row.source_hash)).toEqual(sources.toSorted());
    for (const row of left)
      expect(
        await count(queue, "SELECT COUNT(*) AS n FROM pending_blobs WHERE hash=?", [
          row.output_hash,
        ]),
      ).toBe(1);
    committer.stop();
    committer = newCommitter();
    await commitAll();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_renditions")).toBe(0);
    for (const source of sources)
      expect(
        await count(
          waypoint,
          "SELECT COUNT(*) AS n FROM renditions WHERE source_hash=? AND renderer_version=2",
          [source],
        ),
      ).toBe(1);
  });

  it("excludes missing and failed sources from remaining, and they don't use up --limit", async () => {
    const { readme, notes, shared } = await seed();
    await blobs.delete(notes);
    // Rendering `# Shared` fails; the others render.
    const v2 = new FakeRenderer(2);
    const render = v2.render.bind(v2);
    v2.render = (source, mime) =>
      new TextDecoder().decode(source) === "# Shared"
        ? Promise.resolve(null)
        : render(source, mime);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const all = await rerender(waypoint, queue, blobs, v2, { dryRun: true });
    expect(all).toMatchObject({ queued: 3, remaining: 0 });
    // The runbook's loop: repeat while remaining > 0. Each run queues one renderable source.
    const runs: string[] = [];
    let last;
    do {
      last = await rerender(waypoint, queue, blobs, v2, { dryRun: false, limit: 1 });
      runs.push(formatRerenderSummary(last));
    } while (last.remaining > 0 && runs.length < 5);
    spy.mockRestore();
    // Only one source can be rendered, so the loop ends within two runs: the one that queues it,
    // and at most one more that finds only the missing and failed sources.
    expect(runs.length).toBeLessThanOrEqual(2);
    expect(last).toMatchObject({ remaining: 0, missing: [notes], failed: [shared] });
    expect(runs.at(-1)!.split("\n").slice(1)).toEqual(["missing: 1", "failed: 1", "remaining: 0"]);
    expect(
      (await queue.all<{ source_hash: string }>("SELECT source_hash FROM pending_renditions")).map(
        (row) => row.source_hash,
      ),
    ).toEqual([readme]);
  });

  it("counts only standalone renditions as rerender_pending, so a failed revision can't block the loop", async () => {
    await seed();
    const sources = await backlog(3);
    const app = createApp({ waypoint, queue, blobs, reads, ingest });
    const status = async (): Promise<unknown> => (await app.request("/api/status")).json();
    // A revision that failed with its own (ingest-time) rendition queued.
    const stuck = await ingest.create({
      title: "Stuck",
      files: [{ path: "stuck.md", hash: await put("# Stuck") }],
    });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [stuck.revision_id]);
    expect(await status()).toMatchObject({
      queue: { pending_renditions: 4, rerender_pending: 3 },
    });
    // The failed revision never commits, so its rendition stays queued...
    await commitAll();
    expect(await count(queue, "SELECT COUNT(*) AS n FROM pending_revisions")).toBe(1);
    // ...but the standalone backlog drains, which is what the runbook waits for.
    expect(await status()).toMatchObject({
      queue: { pending_renditions: 1, rerender_pending: 0 },
    });
    const committed = await waypoint.all<{ source_hash: string }>(
      "SELECT source_hash FROM renditions WHERE renderer_version=2 ORDER BY source_hash",
    );
    expect(committed.map((row) => row.source_hash)).toEqual(sources.toSorted());
  });

  it("picks the renderer from --renderer, markdown by default (RX-08)", () => {
    const names = ["markdown", "text", "csv"];
    expect(rerenderRendererName([], names)).toBe("markdown");
    expect(rerenderRendererName(["--all"], names)).toBe("markdown");
    expect(rerenderRendererName(["--all", "--renderer", "csv"], names)).toBe("csv");
    expect(() => rerenderRendererName(["--all", "--renderer", "nope"], names)).toThrow(
      "Unknown renderer nope; this writer has markdown, text, csv",
    );
    // A missing value is parseRerenderArgs's error.
    expect(rerenderRendererName(["--all", "--renderer"], names)).toBe("markdown");
    expect(() => parseRerenderArgs(["--all", "--renderer"], writerRenderer)).toThrow(
      "--renderer needs a value",
    );
  });

  it("re-renders the files of one renderer's types (RX-08)", async () => {
    const text = writerRenderers.all.find((renderer) => renderer.rendererName === "text");
    if (!text) throw new Error("No text renderer");
    const script = await put("#!/bin/sh\necho ok\n");
    const json = await put('{"a":1}\n');
    await ingest.create({
      title: "Kinds",
      head_path: "a.md",
      files: [
        { path: "a.md", hash: await put("# A") },
        { path: "b.sh", hash: script },
        { path: "c.json", hash: json },
        { path: "d.csv", hash: await put("a,b\n1,2\n") },
      ],
    });
    await commitAll();
    const first = await rerender(waypoint, queue, blobs, text, { dryRun: false });
    expect(first).toMatchObject({
      renderer: "text",
      renderer_version: 1,
      sources: 2,
      current: 0,
      queued: 2,
      remaining: 0,
    });
    const rows = await queue.all<{ source_hash: string; renderer: string }>(
      "SELECT source_hash,renderer FROM pending_renditions ORDER BY source_hash",
    );
    expect(rows).toEqual(
      [script, json].toSorted().map((source_hash) => ({ source_hash, renderer: "text" })),
    );
    const again = await rerender(waypoint, queue, blobs, text, { dryRun: false });
    expect(again).toMatchObject({ sources: 2, current: 2, queued: 0 });
  });

  it("renders a hash under several types once, as the smallest MIME type (RX-08)", async () => {
    const shared = await put('{"same":"bytes"}\n');
    await ingest.create({
      title: "Twins",
      head_path: "x.txt",
      files: [
        { path: "x.txt", hash: shared },
        { path: "x.json", hash: shared },
      ],
    });
    await commitAll();
    // A pending revision lists it as text/plain too.
    await ingest.create({ title: "Pending", files: [{ path: "y.txt", hash: shared }] });
    const mimes: string[] = [];
    const spy: Renderer = {
      rendererName: "text",
      rendererVersion: 1,
      render: (_source, mime) => {
        mimes.push(mime);
        return Promise.resolve({ bytes: new TextEncoder().encode("<p>"), mime: "text/html" });
      },
    };
    const summary = await rerender(waypoint, queue, blobs, spy, { dryRun: false });
    expect(summary).toMatchObject({ sources: 1, queued: 1 });
    expect(mimes).toEqual(["application/json"]);
  });

  it("fails only the source whose rendition is over the blob limit (RX-08)", async () => {
    const big = await put("big\n");
    const small = await put("small\n");
    await ingest.create({
      title: "Sizes",
      head_path: "big.txt",
      files: [
        { path: "big.txt", hash: big },
        { path: "small.txt", hash: small },
      ],
    });
    await commitAll();
    const sized: Renderer = {
      rendererName: "text",
      rendererVersion: 1,
      render: (source) =>
        Promise.resolve({
          bytes: new TextDecoder().decode(source).startsWith("big")
            ? new Uint8Array(blobs.maxBlobBytes + 1)
            : new TextEncoder().encode("<p>"),
          mime: "text/html",
        }),
    };
    const summary = await rerender(waypoint, queue, blobs, sized, { dryRun: false });
    expect(summary).toMatchObject({ sources: 2, queued: 1, failed: [big] });
    expect(
      (await queue.all<{ source_hash: string }>("SELECT source_hash FROM pending_renditions")).map(
        (row) => row.source_hash,
      ),
    ).toEqual([small]);
  });
});
