// NAV-06: Recent with nothing to list. A new writer gets the first run (one sentence, two steps,
// a touch-hidden tip); a writer whose collections are all in Trash keeps Recent's heading and
// Needs attention and points to Trash. "Sync is off. Nothing is backed up." shows on local-only
// writers only when nothing is queued (otherwise OW-06b's Needs attention note says it).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import type { Health, HealthItem } from "../src/health.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import type { Chrome } from "../src/viewer/layout.tsx";
import { AllInTrash, FirstRun } from "../src/viewer/pages/recent/home.tsx";

const LEDE =
  "Agents publish collections of files; each publish is a revision. Everything stays on your tailnet until you share it.";
const BACKUP = 'Sync is off. <a href="/status">Nothing is backed up</a>.';

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;

const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string): Promise<{ path: string; hash: string }> {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return { path, hash };
}
const written = z.object({ collection_id: z.string(), revision_id: z.string() });
async function create(title: string): Promise<z.infer<typeof written>> {
  const response = await app.request(
    "/api/collections",
    json({ title, files: [await upload("index.md", title)] }),
  );
  return written.parse(await response.json());
}
async function trash(id: string): Promise<void> {
  expect((await app.request(`/api/collections/${id}`, { method: "DELETE" })).status).toBe(200);
}
const home = async () => (await app.request("/")).text();
const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-recent-empty-test-"));
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
  await guardEnvironment(waypoint, opened.syncClient, "dev", false);
  const blobs = new BlobStore(dir, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  });
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("first run", () => {
  it("is one sentence, two steps in order and the tip, with the local-only line once", async () => {
    const html = await home();
    expect(html).toContain('<h1 class="page" id="firstrun-title">Nothing published yet</h1>');
    expect(html).toContain(`<p class="lede">${LEDE}</p>`);
    // role="list" keeps the list semantics in Safari/VoiceOver despite list-style: none.
    const start = html.indexOf('<ol class="steps" role="list">');
    expect(start).toBeGreaterThan(-1);
    const steps = html.slice(start, html.indexOf("</ol>", start));
    expect(count(steps, "<li>")).toBe(2);
    const connect = steps.indexOf("<h2>Connect an agent</h2>");
    const ask = steps.indexOf("<h2>Ask it to publish</h2>");
    expect(connect).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(connect);
    expect(steps).toContain('<a class="btn primary" href="/mcp">Connect an agent</a>');
    expect(steps).toContain(
      "For example: <code>Publish this plan to Waypoint</code>. It appears here within seconds.",
    );
    expect(html).toContain(
      '<p class="tip">Tip: press <kbd>/</kbd> to search, <kbd>?</kbd> for shortcuts.</p>',
    );
    expect(count(html, BACKUP)).toBe(1);
    expect(count(html, 'class="backup"')).toBe(1);
    expect(html).not.toContain("Sync is off on this writer");
    expect(html).not.toContain("Nothing here yet");
    expect(html).not.toContain("Everything is in Trash");
    expect(html).not.toContain("One piece of work an agent publishes");
  });
});

describe("all in Trash", () => {
  it("keeps Recent's heading and points to Trash, singular", async () => {
    await trash((await create("Only")).collection_id);
    const html = await home();
    expect(html).toContain('<h1 class="page" id="recent-title">Recent</h1>');
    expect(html).toContain("Everything is in Trash");
    expect(html).toContain(
      "1 collection is in Trash, so Recent is empty. Restore it to bring it back.",
    );
    expect(html).toContain('<a class="btn primary" href="/trash">Open Trash (1)</a>');
    expect(html).not.toContain("Nothing published yet");
  });
  it("counts every collection in Trash, plural", async () => {
    await trash((await create("One")).collection_id);
    await trash((await create("Two")).collection_id);
    const html = await home();
    expect(html).toContain(
      "2 collections are in Trash, so Recent is empty. Restore one to bring it back.",
    );
    expect(html).toContain("Open Trash (2)");
  });
  it("shows Needs attention for a failed revision and no backup line", async () => {
    const created = await create("Failing");
    await queue.run(
      "UPDATE pending_revisions SET state='failed',last_error='Upload failed',error_kind='permanent' WHERE id=?",
      [created.revision_id],
    );
    await trash(created.collection_id);
    const html = await home();
    expect(html).toContain("Everything is in Trash");
    // Today's Needs attention section, or OW-06b's `attn off` sync-off note once it lands.
    expect(html).toContain('class="attn');
    expect(html).not.toContain('class="backup"');
  });
});

describe("FirstRun and AllInTrash, rendered directly", () => {
  const base: Health = {
    state: "synced",
    label: "Synced",
    short: "Synced",
    aria: "Synced",
    failed: [],
    pending: [],
    stalled: [],
    waiting: [],
    collections: [],
    oldestPendingAt: null,
    lastPushAt: null,
    lastPullAt: null,
    cloudLastOkAt: null,
    cloudError: null,
    blockedReason: null,
    environment: "dev",
    syncEnabled: true,
  };
  const item: HealthItem = {
    id: "rev_01jabcdefghjkmnpqrstvwxyz0",
    public_id: "r7kq2m9x4b1c",
    collection_id: "col_01jabcdefghjkmnpqrstvwxyz0",
    collection_public_id: "w1h0m485bzm1",
    collection_title: "Queued",
    display_number: 1,
    message: null,
    created_at: 0,
    last_error: null,
    error_kind: null,
    source_host: null,
    state: "pending",
    first_attempt_at: null,
    attempts: 0,
    next_attempt_at: null,
    parent_revision_id: null,
    parent_state: null,
    sync: "waiting",
  };
  const chrome = (health: Partial<Health>): Chrome => ({
    health: { ...base, ...health },
    now: 0,
    host: "writer.example.test",
    liveLinkCount: 0,
    pausedLinkCount: 0,
    trashCount: 3,
    trashedPending: [],
  });
  /** Both components' markup (a JSX node stringifies to its HTML, possibly via a promise). */
  const renders = async (health: Partial<Health>) =>
    Promise.all(
      [FirstRun, AllInTrash].map(async (page): Promise<string> => {
        const node: unknown = page({ chrome: chrome(health) });
        return String(await node);
      }),
    );

  it("both render Needs attention", async () => {
    for (const html of await renders({
      state: "blocked",
      blockedReason: "Environment mismatch",
      syncEnabled: true,
    })) {
      expect(html).toContain("Sync is blocked");
      expect(html).not.toContain('class="backup"');
    }
  });
  it("show the backup line only on a local-only writer with nothing queued", async () => {
    for (const html of await renders({ syncEnabled: false, pending: [item] }))
      expect(html).not.toContain('class="backup"');
    for (const html of await renders({
      syncEnabled: false,
      failed: [{ ...item, state: "failed" }],
    }))
      expect(html).not.toContain('class="backup"');
    for (const html of await renders({ syncEnabled: false }))
      expect(count(html, 'class="backup"')).toBe(1);
    for (const html of await renders({ syncEnabled: true }))
      expect(html).not.toContain('class="backup"');
  });
  it("AllInTrash reads N from chrome.trashCount", async () => {
    const [, html] = await renders({});
    expect(html).toContain(
      "3 collections are in Trash, so Recent is empty. Restore one to bring it back.",
    );
    expect(html).toContain("Open Trash (3)");
  });
});
