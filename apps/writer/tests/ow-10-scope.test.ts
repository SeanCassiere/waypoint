// OW-10b: every page loadCollection builds (the collection, its Changes page, the in-Trash page)
// scopes the health pill to its collection; global pages keep the writer-wide pill. Sync is "on"
// (a cloud client that never pulls or pushes), so a failed revision reads failed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp, type HttpServices } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";

const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

let dir: string;
let waypoint: Db;
let queue: Db;
let live: HttpServices;
let app: ReturnType<typeof createApp>;
let worker: WriterCommitter | undefined;
let serial = 0;
/** A sync client that's on, so `syncEnabled` is true; nothing is ever pulled or pushed. */
const cloud: SyncClient = {
  lastPullAt: 0,
  verified: true,
  pull: () => Promise.resolve(false),
  push: () => Promise.resolve(),
  checkpoint: () => Promise.resolve(),
};
interface Written {
  collection: string;
  id: string;
  /** The revision's pinned page path, /c/{pub}/r/{rpub}/. */
  path: string;
}
/** Writes one revision with its own content (an unchanged manifest wouldn't make one). */
async function write(path: string, body: object): Promise<Written> {
  const bytes = new TextEncoder().encode(`Content ${++serial}`);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  const response = await app.request(path, json({ files: [{ path: "index.md", hash }], ...body }));
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("revision_id" in value) ||
    !("url" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.revision_id !== "string" ||
    typeof value.url !== "string"
  )
    throw new Error("Invalid write result");
  return {
    collection: value.collection_id,
    id: value.revision_id,
    path: new URL(value.url).pathname,
  };
}
const createCollection = (title: string) => write("/api/collections", { title, metadata: {} });
const addRevision = (collection: string, parent: string) =>
  write(`/api/collections/${collection}/revisions`, { parent_revision_id: parent });
/** Commits everything queued so far, then stops the committer so later writes stay queued. */
async function commitAll(): Promise<void> {
  worker = new WriterCommitter(
    waypoint,
    queue,
    live.blobs,
    new MemoryBucket(),
    new SyncLoop(queue, cloud, Date.now, waypoint),
    live.ingest,
  );
  worker.wake();
  await worker.drain();
  worker.stop();
  await worker.drain();
}
const fail = (id: string) =>
  queue.run(
    "UPDATE pending_revisions SET state='failed',attempts=5,last_error='R2 PUT timed out',error_kind='permanent' WHERE id=?",
    [id],
  );
/** The pill's opening tag and its .lbl text. */
async function pill(path: string, status = 200): Promise<{ tag: string; label: string }> {
  const response = await app.request(path);
  expect(response.status).toBe(status);
  const markup = await response.text();
  const match =
    /<button[^>]*class="health[^"]*"[^>]*>[\s\S]*?<span class="lbl">([^<]*)<\/span>/.exec(markup);
  expect(match).not.toBeNull();
  const tag = /^<button[^>]*>/.exec(match?.[0] ?? "")?.[0] ?? "";
  const label = match?.[1] ?? "";
  // The accessible name starts with the visible words, on every page.
  expect(/aria-label="([^"]*)"/.exec(tag)?.[1]?.startsWith(`${label}: `)).toBe(true);
  return { tag, label };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-ow10-test-"));
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
  const blobs = new BlobStore(dir, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  live = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, cloud),
  };
  app = createApp(live);
});
afterEach(async () => {
  worker?.stop();
  await worker?.drain();
  worker = undefined;
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the scoped health pill (OW-10b)", () => {
  it("says here, elsewhere or writer-wide by page", async () => {
    const a1 = await createCollection("Alpha");
    const a2 = await addRevision(a1.collection, a1.id);
    const b1 = await createCollection("Bravo");
    await commitAll();
    const b2 = await addRevision(b1.collection, b1.id);
    await fail(b2.id);
    const aPub = a1.path.split("/")[2] ?? "";
    const bPub = b1.path.split("/")[2] ?? "";

    const here = await pill(`/c/${bPub}/`);
    expect(here.tag).toContain('data-scope="here"');
    expect(here.label).toBe("#2 failed");

    const away = await pill(`/c/${aPub}/`);
    expect(away.tag).toContain('data-scope="elsewhere"');
    expect(away.tag).toContain('class="health away"');
    expect(away.label).toBe("1 failed elsewhere");

    const changes = await pill(`${a2.path}changes`);
    expect(changes.tag).toContain('data-scope="elsewhere"');
    expect(changes.label).toBe("1 failed elsewhere");

    const [home, status] = await Promise.all([pill("/"), pill("/status")]);
    for (const global of [home, status]) {
      expect(global.tag).not.toContain("data-scope");
      expect(global.label).toBe("1 failed");
    }

    expect(
      (await app.request(`/api/collections/${a1.collection}`, { method: "DELETE" })).status,
    ).toBe(200);
    const trashed = await pill(`/c/${aPub}/`, 410);
    expect(trashed.tag).toContain('data-scope="elsewhere"');
    expect(trashed.label).toBe("1 failed elsewhere");
  });
});
