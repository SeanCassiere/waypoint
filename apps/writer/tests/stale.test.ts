import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { mintRevisionId } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import {
  compareStale,
  surveyStale,
  type StaleSource,
  type StaleSurveyOptions,
} from "../src/stale.ts";
import { SyncLoop } from "../src/sync-loop.ts";

const DAY = 86_400_000;
const markdown = { rendererName: "markdown", rendererVersion: 2 };
const text = { rendererName: "text", rendererVersion: 2 };

let dir: string;
let waypoint: Db;
let queue: Db;
let sync: SyncClient;
let blobs: BlobStore;
let ingest: IngestService;
let committer: WriterCommitter;

async function put(content: string): Promise<string> {
  return (await blobs.put(Readable.from([content]))).hash;
}
async function commitAll(): Promise<void> {
  committer.wake();
  await committer.drain();
}
/** A client revision ID minted `daysAgo` days ago (ingest accepts up to 7). */
function revisionAgo(daysAgo: number): string {
  return mintRevisionId({ now: Date.now() - daysAgo * DAY });
}
async function collection(
  title: string,
  files: Record<string, string>,
  revision_id?: string,
): Promise<{ collection: string; revision: string }> {
  const result = await ingest.create({
    title,
    head_path: Object.keys(files)[0]!,
    files: Object.entries(files).map(([path, hash]) => ({ path, hash })),
    ...(revision_id ? { revision_id } : {}),
  });
  return { collection: result.collection_id, revision: result.revision_id };
}
async function revise(
  collectionId: string,
  files: Record<string, string>,
  revision_id?: string,
): Promise<string> {
  const result = await ingest.add(collectionId, {
    mode: "replace",
    head_path: Object.keys(files)[0]!,
    files: Object.entries(files).map(([path, hash]) => ({ path, hash })),
    ...(revision_id ? { revision_id } : {}),
  });
  return result.revision_id;
}
let links = 0;
async function link(
  collectionId: string,
  revisionId: string | null,
  state: { expires_at?: number; revoked_at?: number } = {},
): Promise<void> {
  links++;
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      `shl_${String(links).padStart(26, "0")}`,
      `token-${links}`,
      collectionId,
      revisionId,
      null,
      state.expires_at ?? null,
      state.revoked_at ?? null,
      1,
    ],
  );
}
async function survey(
  options: Partial<StaleSurveyOptions> = {},
): Promise<ReturnType<typeof surveyStale>> {
  return surveyStale(waypoint, queue, { renderers: [markdown], now: Date.now(), ...options });
}
/** The distinct SQL strings one survey runs. */
async function statements(): Promise<Set<string>> {
  const seen = new Set<string>();
  waypoint.onStatement = (sql) => seen.add(sql);
  queue.onStatement = (sql) => seen.add(sql);
  try {
    await survey({ renderers: [markdown, text] });
  } finally {
    waypoint.onStatement = undefined;
    queue.onStatement = undefined;
  }
  return seen;
}
function byHash(stale: StaleSource[]): Map<string, StaleSource> {
  return new Map(stale.map((source) => [source.hash, source]));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-stale-"));
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
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  // No renderer at ingest: every source starts without a rendition.
  ingest = new IngestService(waypoint, queue, blobs, reads, sync);
  committer = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    new MemoryBucket(),
    new SyncLoop(queue, sync, Date.now, waypoint),
    ingest,
  );
});
afterEach(async () => {
  committer.stop();
  await committer.drain();
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("stale-rendition selection", () => {
  it("puts linked sources first, then latest revisions, then older ones, newest first", async () => {
    const [p1, p2, f1, f2, q1, q2, r1, x1, both] = await Promise.all(
      ["p1", "p2", "f1", "f2", "q1", "q2", "r1", "x1", "both"].map((name) => put(`# ${name}`)),
    );
    const pinned = await collection("Pinned", { "a.md": p1! });
    const pinnedLatest = await revise(pinned.collection, { "a.md": p2! });
    const followed = await collection("Followed", { "a.md": f1! });
    const followedLatest = await revise(followed.collection, { "a.md": f2! });
    const plain = await collection("Plain", { "a.md": q1!, "b.md": both! });
    const plainLatest = await revise(plain.collection, { "a.md": q2! });
    const revoked = await collection("Revoked", { "a.md": r1! });
    const expired = await collection("Expired", { "a.md": x1! });
    // `both` is also in a pinned revision, so it takes tier 1 there.
    const both2 = await revise(pinned.collection, { "a.md": p2!, "b.md": both! });
    await commitAll();
    await link(pinned.collection, pinned.revision);
    await link(followed.collection, null);
    await link(revoked.collection, null, { revoked_at: 1 });
    await link(expired.collection, null, { expires_at: Date.now() - 1 });
    await link(pinned.collection, both2, { expires_at: Date.now() + DAY });

    const { sources, stale } = await survey();
    expect(sources.get("markdown")).toBe(9);
    const found = byHash(stale);
    const tiers = Object.fromEntries(
      Object.entries({ p1, p2, f1, f2, q1, q2, r1, x1, both }).map(([name, hash]) => [
        name,
        [found.get(hash!)?.tier, found.get(hash!)?.revisionId],
      ]),
    );
    expect(tiers).toEqual({
      p1: [1, pinned.revision],
      // Pinned's latest (both2) carries p2 too, at tier 1.
      p2: [1, both2],
      f1: [3, followed.revision],
      f2: [1, followedLatest],
      q1: [3, plain.revision],
      q2: [2, plainLatest],
      r1: [2, revoked.revision],
      x1: [2, expired.revision],
      both: [1, both2],
    });
    expect(pinnedLatest < both2).toBe(true);
    expect(stale.every((source) => !source.settled && source.version === null)).toBe(true);
    // Priority order: tier, then newest revision first.
    expect(stale).toEqual(stale.toSorted(compareStale));
    expect(stale.map((source) => source.tier)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3]);
    const tierOne = stale.filter((source) => source.tier === 1).map((source) => source.revisionId);
    expect(tierOne).toEqual(tierOne.toSorted().toReversed());
  });

  it("orders settled collections after the others in their tier, but never skips them", async () => {
    const [a1, a2, b1, b2, c1, c2] = await Promise.all(
      ["a1", "a2", "b1", "b2", "c1", "c2"].map((name) => put(`# ${name}`)),
    );
    // Active: latest revision today. Settled: latest three days ago. Linked: as old, but shared.
    const active = await collection("Active", { "a.md": a1! }, revisionAgo(6));
    const activeLatest = await revise(active.collection, { "a.md": a2! });
    const settled = await collection("Settled", { "a.md": b1! }, revisionAgo(5));
    await revise(settled.collection, { "a.md": b2! }, revisionAgo(4));
    const linked = await collection("Linked", { "a.md": c1! }, revisionAgo(5));
    const linkedLatest = await revise(linked.collection, { "a.md": c2! }, revisionAgo(3));
    await commitAll();
    await link(linked.collection, linkedLatest);

    const { stale } = await survey({ settledMs: DAY });
    const order = stale.map((source) => [source.hash, source.tier, source.settled]);
    expect(order).toEqual([
      [c2, 1, false],
      [a2, 2, false],
      [b2, 2, true],
      // Tier 3: the active collection's older revision comes before the settled collection's,
      // although it is older, and the linked collection isn't settled.
      [c1, 3, false],
      [a1, 3, false],
      [b1, 3, true],
    ]);
    expect(stale.find((source) => source.hash === a2)?.revisionId).toBe(activeLatest);
    // With a longer settled period nothing is settled.
    const recent = await survey({ settledMs: 30 * DAY });
    expect(recent.stale.some((source) => source.settled)).toBe(false);
  });

  it("leaves out Trash unless asked, and collections being purged always", async () => {
    const [kept, trashed, queuedTrash, purged] = await Promise.all(
      ["kept", "trashed", "queued", "purged"].map((name) => put(`# ${name}`)),
    );
    await collection("Live", { "a.md": kept! });
    const bin = await collection("Bin", { "a.md": trashed! });
    const doomed = await collection("Doomed", { "a.md": purged! });
    await commitAll();
    await link(bin.collection, null);
    await waypoint.run(
      "INSERT INTO collection_tombstones (collection_id,deleted_at) VALUES (?,?)",
      [bin.collection, Date.now()],
    );
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      doomed.collection,
      Date.now(),
    ]);
    // A collection trashed while still queued (never committed).
    const pending = await collection("Pending", { "a.md": queuedTrash! });
    await queue.run("UPDATE pending_collections SET deleted_at=? WHERE id=?", [
      Date.now(),
      pending.collection,
    ]);

    const live1 = await survey();
    expect(live1.stale.map((source) => source.hash)).toEqual([kept]);
    expect(live1.sources.get("markdown")).toBe(1);
    const all = await survey({ includeTrashed: true });
    const found = byHash(all.stale);
    expect(new Set(found.keys())).toEqual(new Set([kept, trashed, queuedTrash]));
    // A trashed collection's links are paused: its latest revision is tier 2, not tier 1.
    expect(found.get(trashed!)?.tier).toBe(2);
    expect(found.has(purged!)).toBe(false);
    // Scoped to a purging collection: nothing.
    expect((await survey({ collectionId: doomed.collection, includeTrashed: true })).stale).toEqual(
      [],
    );
  });

  it("includes sources of pending revisions, which count as the latest, but not failed ones", async () => {
    const [old, draft, broken] = await Promise.all(
      ["old", "draft", "broken"].map((name) => put(`# ${name}`)),
    );
    const docs = await collection("Docs", { "a.md": old! });
    await commitAll();
    const pendingId = await revise(docs.collection, { "a.md": draft! });
    const other = await collection("Other", { "a.md": broken! });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [other.revision]);
    expect(await queue.get("SELECT 1 FROM pending_revisions WHERE id=?", [pendingId])).toBeTruthy();

    const { sources, stale } = await survey();
    expect(sources.get("markdown")).toBe(2);
    expect(stale.map((source) => [source.hash, source.tier, source.revisionId])).toEqual([
      [draft, 2, pendingId],
      [old, 3, docs.revision],
    ]);
    // Scoped to the collection: the same, from its own revisions only.
    const scoped = await survey({ collectionId: docs.collection });
    expect(scoped.stale.map((source) => source.hash)).toEqual([draft, old]);
    expect((await survey({ collectionId: other.collection })).stale).toEqual([]);
  });

  it("gives tier 1 under a Latest link to the committed revision the reader serves, not a queued one", async () => {
    const [served, queuedHash] = await Promise.all(
      ["served", "queued"].map((name) => put(`# ${name}`)),
    );
    const followed = await collection("Followed", { "a.md": served! });
    await commitAll();
    await link(followed.collection, null);
    // Not committed yet: the reader keeps serving the first revision until it is.
    const queuedId = await revise(followed.collection, { "a.md": queuedHash! });
    expect(await queue.get("SELECT 1 FROM pending_revisions WHERE id=?", [queuedId])).toBeTruthy();

    const stale = byHash((await survey()).stale);
    expect(stale.get(served!)).toMatchObject({ tier: 1, revisionId: followed.revision });
    expect(stale.get(queuedHash!)).toMatchObject({ tier: 2, revisionId: queuedId });
    await commitAll();
    const committed = byHash((await survey()).stale);
    expect(committed.get(queuedHash!)).toMatchObject({ tier: 1, revisionId: queuedId });
    expect(committed.get(served!)).toMatchObject({ tier: 3 });
  });

  it("surveys each renderer's types, and renders a hash once per renderer as its smallest type", async () => {
    const same = await put('{"same":"bytes"}\n');
    const doc = await put("# Doc");
    await collection("Kinds", {
      "x.txt": same,
      "x.json": same,
      "x.md": same,
      "doc.md": doc,
      "plot.png": await put("png"),
    });
    await commitAll();

    const both = await survey({ renderers: [markdown, text] });
    expect(Object.fromEntries(both.sources)).toEqual({ markdown: 2, text: 1 });
    const keys = both.stale.map((source) => `${source.renderer}:${source.hash}:${source.mime}`);
    expect(keys.toSorted()).toEqual(
      [
        `markdown:${same}:text/markdown`,
        `markdown:${doc}:text/markdown`,
        `text:${same}:application/json`,
      ].toSorted(),
    );
    const textOnly = await survey({ renderers: [text] });
    expect(Object.fromEntries(textOnly.sources)).toEqual({ text: 1 });
    expect(textOnly.stale.map((source) => source.mime)).toEqual(["application/json"]);
    // A renderer can be stale for a hash while another is current.
    await queue.run(
      "INSERT INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [same, "text", 2, await put("<p>"), "text/html", 1],
    );
    const after = await survey({ renderers: [markdown, text] });
    expect(after.stale.map((source) => `${source.renderer}:${source.hash}`).toSorted()).toEqual(
      [`markdown:${same}`, `markdown:${doc}`].toSorted(),
    );
  });

  it("is stale only below the current version: a newer rendition after a rollback counts", async () => {
    const [older, equal, newer, queuedNewer] = await Promise.all(
      ["older", "equal", "newer", "queued"].map((name) => put(`# ${name}`)),
    );
    await collection("Versions", {
      "a.md": older!,
      "b.md": equal!,
      "c.md": newer!,
      "d.md": queuedNewer!,
    });
    await commitAll();
    const output = await put("<p>");
    await waypoint.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,?)", [
      output,
      3,
      1,
    ]);
    const committed = async (source: string, version: number): Promise<void> => {
      await waypoint.run(
        "INSERT INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
        [source, "markdown", version, output, "text/html", 1],
      );
    };
    await committed(older!, 1);
    await committed(equal!, 2);
    // A newer release rendered these at version 3; this writer is back on version 2.
    await committed(newer!, 1);
    await committed(newer!, 3);
    await queue.run(
      "INSERT INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [queuedNewer!, "markdown", 3, output, "text/html", 1],
    );
    // Another renderer's newer version doesn't count for markdown.
    await queue.run(
      "INSERT INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [older!, "text", 9, output, "text/html", 1],
    );

    const { sources, stale } = await survey();
    expect(sources.get("markdown")).toBe(4);
    expect(stale.map((source) => [source.hash, source.version])).toEqual([[older, 1]]);
  });

  it("uses the same fixed set of statements however much there is to survey", async () => {
    await collection("One", { "a.md": await put("# a") });
    await commitAll();
    await collection("Queued", { "a.md": await put("# q") });
    const small = await statements();
    for (let index = 0; index < 5; index++) {
      const { collection: id } = await collection(`Many ${index}`, {
        "a.md": await put(`# m${index}`),
        "b.txt": await put(`m${index}`),
      });
      await revise(id, { "c.md": await put(`# n${index}`) });
    }
    await commitAll();
    await collection("Queued 2", { "a.md": await put("# q2") });
    const large = await statements();
    expect([...large].filter((sql) => !small.has(sql))).toEqual([]);
    expect(large.size).toBeLessThanOrEqual(small.size);
  });
});
