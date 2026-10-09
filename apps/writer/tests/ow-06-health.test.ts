// OW-06b: getHealth's additions (project, attention, live links, the Sync off ladder), Status
// grouped by collection with the In progress slot, Home's cards and row chips, and constant
// query counts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { raw } from "hono/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { getHealth, type HealthItem } from "../src/health.ts";
import { createApp, type HttpServices } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";
import { InProgressSection } from "../src/viewer/pages/status.tsx";

const MINUTE = 60_000;
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
const count = (markup: string, needle: string) => markup.split(needle).length - 1;
/** The opening tag of the first element whose tag contains `needle`. */
const openTag = (markup: string, needle: string) =>
  [...markup.matchAll(/<[a-z]+\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(needle));

let dir: string;
let waypoint: Db;
let queue: Db;
let local: HttpServices;
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
/** Writes one revision with its own content (an unchanged manifest wouldn't make one). */
async function write(path: string, body: object): Promise<{ collection: string; id: string }> {
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
    typeof value.collection_id !== "string" ||
    typeof value.revision_id !== "string"
  )
    throw new Error("Invalid write result");
  return { collection: value.collection_id, id: value.revision_id };
}
const createCollection = (title: string, metadata: object = {}) =>
  write("/api/collections", { title, metadata });
const addRevision = (collection: string, parent: string, message?: string) =>
  write(`/api/collections/${collection}/revisions`, { parent_revision_id: parent, message });
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
let links = 0;
/** A Latest link (revision_id NULL) on the collection; the token itself isn't checked here. */
async function latestLink(collection: string): Promise<void> {
  links++;
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      `shl_${String(links).padStart(26, "0")}`,
      `token-${links}`,
      collection,
      null,
      null,
      null,
      null,
      1,
    ],
  );
}
const fail = (id: string, error = "R2 PUT blobs/sha256/9c/9c41… timed out") =>
  queue.run(
    "UPDATE pending_revisions SET state='failed',attempts=5,last_error=?,error_kind='permanent' WHERE id=?",
    [error, id],
  );
const age = (id: string, minutes: number) =>
  queue.run("UPDATE pending_revisions SET created_at=? WHERE id=?", [
    Date.now() - minutes * MINUTE,
    id,
  ]);
async function queryCount(target: ReturnType<typeof createApp>, path: string): Promise<number> {
  const spies = [
    vi.spyOn(queue, "all"),
    vi.spyOn(queue, "get"),
    vi.spyOn(waypoint, "all"),
    vi.spyOn(waypoint, "get"),
  ];
  expect((await target.request(path)).status).toBe(200);
  const total = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  spies.forEach((spy) => spy.mockRestore());
  return total;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-ow06-test-"));
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
  local = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  };
  live = { ...local, ingest: new IngestService(waypoint, queue, blobs, reads, cloud) };
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

describe("getHealth (OW-06b)", () => {
  it("marks a stalled collection for attention and reads its project", async () => {
    const { id } = await createCollection("Runbook", { project: "infra" });
    await age(id, 11);
    let health = await getHealth(live);
    expect(health.state).toBe("stalled");
    expect(health.collections[0]).toMatchObject({
      attention: true,
      project: "infra",
      liveLinks: 0,
      followsLatest: false,
    });
    const other = await createCollection("Other");
    await fail(other.id);
    health = await getHealth(live);
    expect(health.state).toBe("failed");
    expect(health.collections.map((entry) => [entry.collection_title, entry.attention])).toEqual([
      ["Other", true],
      ["Runbook", true],
    ]);
    expect(health.collections[0]?.project).toBeNull();
  });

  it("says Sync off above failed", async () => {
    const { id } = await createCollection("Local");
    await fail(id);
    const health = await getHealth(local);
    expect(health.state).toBe("off");
    expect(health.label).toBe("Sync off");
    expect(health.failed).toHaveLength(1);
    expect(health.collections[0]?.attention).toBe(true);
  });

  it("counts live links on collections that need attention, by the live rule", async () => {
    const committed = await createCollection("Committed");
    await commitAll();
    await latestLink(committed.collection);
    const failing = await addRevision(committed.collection, committed.id);
    await fail(failing.id);
    // Never committed: its Latest link is waiting, not live.
    const queuedOnly = await createCollection("Queued only");
    await latestLink(queuedOnly.collection);
    await fail(queuedOnly.id);
    // Committed and linked, but nothing wrong: not looked up.
    const fine = await createCollection("Fine");
    await commitAll();
    await latestLink(fine.collection);
    await addRevision(fine.collection, fine.id);

    const health = await getHealth(live);
    const byTitle = new Map(health.collections.map((entry) => [entry.collection_title, entry]));
    expect(byTitle.get("Committed")).toMatchObject({
      attention: true,
      liveLinks: 1,
      followsLatest: true,
    });
    expect(byTitle.get("Queued only")).toMatchObject({
      attention: true,
      liveLinks: 0,
      followsLatest: false,
    });
    expect(byTitle.get("Fine")).toMatchObject({
      attention: false,
      liveLinks: 0,
      followsLatest: false,
    });
  });
});

/** "Runbook" (infra): #1 committed, #2 failed on #1, #3 stalled on #1. */
async function runbook() {
  const root = await createCollection("Runbook", { project: "infra" });
  await commitAll();
  const failed = await addRevision(root.collection, root.id, "Alternative");
  await fail(failed.id);
  const stalled = await addRevision(root.collection, root.id, "PgBouncer script");
  await age(stalled.id, 24);
  const health = await getHealth(live);
  const pub = health.collections[0]?.collection_public_id ?? "";
  expect(pub).not.toBe("");
  return { root, failed, stalled, pub };
}

describe("Status and Home (OW-06b)", () => {
  it("groups Needs attention by collection, with rows that explain each revision", async () => {
    const { failed, stalled, pub } = await runbook();
    const html = await (await app.request("/status")).text();
    expect(html).toContain("Runbook needs you.");
    expect(html).toContain(
      "#2 failed to sync and #3 has stalled. Other machines and public links still see",
    );
    expect(html).toContain("Everything else is synced.");
    expect(html).toContain('<div class="d">stopped trying; needs Retry or Drop</div>');
    expect(html).toContain('<div class="d">stalled = no upload progress for 10 min</div>');
    expect(html).toContain("stalled · 0 uploading normally");
    expect(count(html, "uploading normally")).toBe(1);
    expect(html).toContain('<section aria-labelledby="sec-attn" data-status-section="attention">');
    expect(html).toContain('Needs attention <span class="n">1 collection</span>');
    expect(html).toContain(`<section class="sgrp" id="attn-${pub}" aria-labelledby="sg-${pub}">`);
    expect(html).toContain('<span class="proj">infra</span>');
    expect(html).toContain("No public links · nothing public is affected");
    expect(html).toContain('<div class="lin2" role="group" aria-label="Revision lines">');
    expect(html).toContain(`<li class="srow" id="${failed.id}">`);
    expect(html).toContain(`<li class="srow" id="${stalled.id}">`);
    expect(html).toMatch(/<span class="sc f"><svg[^>]*>.*?<\/svg>#2 failed<\/span>/);
    expect(html).toMatch(/<span class="sc p"><svg[^>]*>.*?<\/svg>#3 stalled<\/span>/);
    const retry = openTag(html, `data-ids="${failed.id}"`);
    expect(retry).toContain('data-action="retry" data-ids=');
    expect(retry).toContain('data-n="2"');
    expect(retry).toContain('data-title="Runbook"');
    expect(retry).toContain(`aria-describedby="sh-${failed.id}"`);
    expect(html).toContain(`>Retry #2</button>`);
    for (const [id, n] of [
      [failed.id, 2],
      [stalled.id, 3],
    ] as const) {
      const drop = openTag(html, `data-id="${id}"`);
      expect(drop).toContain('data-action="drop"');
      expect(drop).toContain(`data-n="${n}"`);
      expect(drop).toContain('data-title="Runbook"');
      expect(html).toContain(`>Drop #${n}…</button>`);
    }
    // Stalled rows have no Retry.
    expect(html).not.toContain(`data-ids="${stalled.id}"`);
    expect(html).toContain(
      `<p class="x" id="sh-${failed.id}">The bucket didn&#39;t accept a file after 5 attempts, so the writer stopped trying. #2 is readable on this writer only.</p>`,
    );
    expect(html).toContain("No upload progress for 24 min. The writer keeps trying on its own.");
    expect(html).toContain('<code class="e">R2 PUT blobs/sha256/9c/9c41… timed out</code>');
    expect(html).toContain(
      '<p class="legend">Home, the health pill and this page use the same rule: a revision is <b>stalled</b> after 10 minutes without upload progress.</p>',
    );
    expect(html).toContain(
      '<section aria-labelledby="sec-progress" data-status-section="progress">',
    );
    expect(html).toContain("Nothing is uploading.");
    expect(html.toLowerCase()).not.toContain("stuck");
    // The pill's popover lists the stalled revision on its own row.
    expect(html).toMatch(/<dt>Stalled<\/dt><dd><a href="[^"]+">Runbook #3<\/a><\/dd>/);

    // Another collection uploading normally lands under In progress, with its own Drop.
    const other = await createCollection("Other");
    const after = await (await app.request("/status")).text();
    const drop = openTag(after, `data-id="${other.id}"`);
    expect(drop).toContain('data-n="1"');
    expect(drop).toContain('data-title="Other"');
    expect(after).toContain(`<li class="srow" id="${other.id}">`);
    expect(after).toMatch(/<span class="sc p"><svg[^>]*>.*?<\/svg>#1 uploading<\/span>/);
    expect(after).toContain('<span class="n" data-progress-count="true">1</span>');
    expect(after).not.toContain("Nothing is uploading.");
    expect(after).not.toContain("Everything else is synced.");
    expect(after).toContain("stalled · 1 uploading normally");
  });

  it("renders Home's card, strip and row chips; sync off shows the note only when queued", async () => {
    const { failed } = await runbook();
    const home = await (await app.request("/")).text();
    const retry = openTag(home, `data-ids="${failed.id}"`);
    expect(retry).toContain('data-n="2"');
    expect(retry).toContain('data-title="Runbook"');
    expect(home).toContain(">Retry #2</button>");
    expect(home).toContain('<div class="lin2" role="group" aria-label="Revision lines">');
    expect(home).toMatch(/<span class="chip xs failed"><svg[^>]*>.*?<\/svg>#2 failed<\/span>/);
    expect(home).toMatch(/<span class="chip xs pending"><svg[^>]*>.*?<\/svg>#3 stalled<\/span>/);
    expect(home.toLowerCase()).not.toContain("stuck");

    const off = createApp(local);
    const queuedOff = await (await off.request("/")).text();
    expect(queuedOff).toContain('<p class="attn off" role="note">');
    expect(queuedOff).not.toContain('class="ag"');
    expect(queuedOff).not.toContain("chip xs failed");
    await queue.run("DELETE FROM pending_revisions");
    const empty = await (await off.request("/")).text();
    expect(empty).toContain("Runbook");
    expect(empty).not.toContain("attn off");
  });

  it("names a waiting revision's parent when the parent is on another page", async () => {
    let parent = await createCollection("Long chain");
    const ids = [parent.id];
    for (let index = 0; index < 50; index++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision is the next one's parent.
      parent = await addRevision(parent.collection, parent.id);
      ids.push(parent.id);
    }
    // One second apart, newest first: the first page shows #51…#2, and #2's parent #1 is on the
    // second page. All under 10 minutes old, so nothing stalls and the chain stays In progress.
    const start = Date.now() - 2 * MINUTE;
    await Promise.all(
      ids.map((id, index) =>
        queue.run("UPDATE pending_revisions SET created_at=? WHERE id=?", [
          start + index * 1000,
          id,
        ]),
      ),
    );
    const pages = await Promise.all(
      ["/status", "/status?pending=50"].map(async (path) => {
        const response = await app.request(path);
        expect(response.status).toBe(200);
        const html = await response.text();
        return html.slice(html.indexOf('data-status-section="progress"'));
      }),
    );
    const chips = pages.flatMap((html) => [...html.matchAll(/#\d+ waiting[^<]*/g)].map(([m]) => m));
    // #1 is uploading; #2…#51 each wait for the one before, on whichever page it is.
    expect(chips).toHaveLength(50);
    expect(chips).toContain("#2 waiting for #1");
    for (const chip of chips) {
      expect(chip).toMatch(/^#\d+ waiting for #\d+$/);
      const [, n, of] = /^#(\d+) waiting for #(\d+)$/.exec(chip) ?? [];
      expect({ chip, of: Number(of) }).toEqual({ chip, of: Number(n) - 1 });
    }
  });

  it("links Details to the Status page that shows the collection's group", async () => {
    const older = await createCollection("Older");
    await commitAll();
    const lone = await addRevision(older.collection, older.id);
    await fail(lone.id);
    await age(lone.id, 5);
    const busy = await createCollection("Busy");
    await commitAll();
    const failed: string[] = [];
    for (let index = 0; index < 51; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One write at a time, like an agent.
      failed.push((await addRevision(busy.collection, busy.id)).id);
    await Promise.all(failed.map((id) => fail(id)));
    const health = await getHealth(live);
    const pubOf = (collection: string) =>
      health.collections.find((group) => group.collection_id === collection)?.collection_public_id;
    const [busyPub, olderPub] = [pubOf(busy.collection), pubOf(older.collection)];
    // Busy's 51 failed revisions fill the first page, so Older's group starts on the second.
    expect(health.collections.map((group) => group.collection_public_id)).toEqual([
      busyPub,
      olderPub,
    ]);
    const home = await (await app.request("/")).text();
    expect(home).toContain(`href="/status#attn-${busyPub}"`);
    expect(home).toContain(`href="/status?failed=50#attn-${olderPub}"`);
    const first = await (await app.request("/status")).text();
    expect(first).toContain(`id="attn-${busyPub}"`);
    expect(first).not.toContain(`id="attn-${olderPub}"`);
    const second = await (await app.request("/status?failed=50")).text();
    expect(second).toContain(`id="attn-${olderPub}"`);
  });

  it("keeps /status and / query counts constant as one collection's queue grows", async () => {
    const { root } = await runbook();
    const status = await queryCount(app, "/status");
    const home = await queryCount(app, "/");
    for (let index = 0; index < 20; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One write at a time, like an agent.
      await addRevision(root.collection, root.id);
    expect(await queryCount(app, "/status")).toBe(status);
    expect(await queryCount(app, "/")).toBe(home);
  });
});

const item = (n: number): HealthItem => ({
  id: `rev_${n}`,
  public_id: `pub${n}`,
  collection_id: "col_x",
  collection_public_id: "xpub",
  collection_title: "X",
  display_number: n,
  message: null,
  created_at: 1_800_000_000_000,
  last_error: null,
  error_kind: null,
  source_host: null,
  state: "pending",
  first_attempt_at: null,
  attempts: 0,
  next_attempt_at: null,
  parent_revision_id: null,
  parent_state: null,
  sync: "uploading",
});
const render = async (props: Parameters<typeof InProgressSection>[0]) =>
  String(await InProgressSection(props));
const base = { now: 1_800_000_000_000, syncEnabled: true };

describe("InProgressSection", () => {
  it("lists extra rows inside its list and counts them", async () => {
    const html = await render({
      ...base,
      items: [],
      window: { from: 0, total: 0 },
      extra: [raw('<li class="srow">x</li>')],
      extraCount: 1,
    });
    expect(html).toContain(
      '<ul class="srows" data-status-progress="true"><li class="srow">x</li></ul>',
    );
    expect(html).toContain('<span class="n" data-progress-count="true">1</span>');
    expect(html).not.toContain("Nothing is uploading.");
  });

  it("renders after inside the section, after the list and its pager", async () => {
    const items = Array.from({ length: 50 }, (_, index) => item(index + 1));
    const html = await render({
      ...base,
      items,
      window: { from: 0, total: 120 },
      after: raw('<p class="legend">x</p>'),
    });
    const at = html.indexOf('<p class="legend">x</p>');
    expect(at).toBeGreaterThan(html.indexOf("</ul>"));
    expect(at).toBeGreaterThan(html.indexOf('data-more="pending"'));
    expect(html.indexOf('data-more="pending"')).toBeGreaterThan(0);
    expect(html.endsWith('<p class="legend">x</p></section>')).toBe(true);
    const without = await render({ ...base, items: [item(1)], window: { from: 0, total: 1 } });
    expect(without.endsWith("</ul></section>")).toBe(true);
    expect(without).toContain(
      'data-action="drop" data-id="rev_1" data-n="1" data-title="X" aria-describedby="pt-rev_1">Drop #1…</button>',
    );
  });

  it("counts every queued revision plus the extras in its heading", async () => {
    const items = Array.from({ length: 50 }, (_, index) => item(index + 1));
    const html = await render({
      ...base,
      items,
      window: { from: 0, total: 120 },
      extraCount: 2,
    });
    expect(html).toContain('<span class="n" data-progress-count="true">122</span>');
  });

  it("always renders its list, empty or not, and the empty state only with no rows at all", async () => {
    const empty = await render({ ...base, items: [], window: { from: 0, total: 0 } });
    expect(empty).toContain('<ul class="srows" data-status-progress="true"></ul>');
    expect(empty).toContain("Nothing is uploading.");
    const purging = await render({
      ...base,
      items: [],
      window: { from: 0, total: 0 },
      extraCount: 1,
    });
    expect(purging).toContain('<ul class="srows" data-status-progress="true"></ul>');
    expect(purging).not.toContain("Nothing is uploading.");
  });

  it("names each row's collection, so rows of two collections with the same number differ", async () => {
    const other: HealthItem = {
      ...item(1),
      id: "rev_y1",
      public_id: "puby1",
      collection_id: "col_y",
      collection_public_id: "ypub",
      collection_title: "Y",
    };
    const html = await render({ ...base, items: [item(1), other], window: { from: 0, total: 2 } });
    expect(html).toContain('<a class="ct" id="pt-rev_1" href="/c/xpub/r/pub1/">X</a>');
    expect(html).toContain('<a class="ct" id="pt-rev_y1" href="/c/ypub/r/puby1/">Y</a>');
    expect(html).toContain('data-id="rev_1" data-n="1" data-title="X" aria-describedby="pt-rev_1"');
    expect(html).toContain(
      'data-id="rev_y1" data-n="1" data-title="Y" aria-describedby="pt-rev_y1"',
    );
  });

  it("falls back to its own rows for a waiting revision's parent", async () => {
    const child = { ...item(9), parent_revision_id: "rev_8", sync: "waiting" as const };
    const html = await render({ ...base, items: [child, item(8)], window: { from: 0, total: 2 } });
    expect(html).toContain("#9 waiting for #8");
    const alone = await render({ ...base, items: [child], window: { from: 0, total: 1 } });
    expect(alone).toContain("#9 waiting<");
  });
});
