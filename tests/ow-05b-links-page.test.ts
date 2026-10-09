// OW-05b: /links tells the truth. Segments Live · Paused in Trash · Expired · Revoked by FC1's
// live rule, a header that counts only live links, rows grouped by collection, waiting links
// listed under Live without being counted, paused links only under their segment, actions
// described by the row's label, and Revoke… / Revoke all as quiet red text.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintRevisionId, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
import { viewerCssSource } from "../apps/writer/src/viewer/css.ts";

const DAY = 86_400_000;
const PAUSED_NOTE =
  "Answers “not available” while the collection is in Trash. Restoring asks before it works again.";
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let hash: string;
/** A fixed test key (never a real one). */
const shareTokenKey = new Uint8Array(32).fill(42);

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
interface Made {
  id: string;
  pub: string;
  revision: string;
}
/** A committed collection with one revision (#1). */
async function collection(title: string, metadata: object = {}): Promise<Made> {
  const created = await app.request(
    "/api/collections",
    json({ title, metadata, files: [{ path: "index.txt", hash }] }),
  );
  const value = await jsonOf(created);
  if (typeof value.collection_id !== "string" || typeof value.revision_id !== "string")
    throw new Error(`Collection failed: ${JSON.stringify(value)}`);
  await worker.drain();
  const row = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [value.collection_id],
  );
  if (!row) throw new Error("Commit missing");
  return { id: value.collection_id, pub: row.public_id, revision: value.revision_id };
}
async function link(collectionId: string, payload: object = {}): Promise<string> {
  const response = await app.request(`/api/collections/${collectionId}/share-links`, json(payload));
  if (response.status !== 201) throw new Error(`Link failed: ${await response.text()}`);
  const shared = (await jsonOf(response)).share_link;
  const id = shared && typeof shared === "object" && "id" in shared ? shared.id : undefined;
  if (typeof id !== "string") throw new Error("No link");
  return id;
}
async function page(path: string): Promise<string> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return response.text();
}
/** The page's <main>: what the filter changes (the bar and scripts are the same everywhere). */
const mainOf = (html: string) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));
/** The segments: [href, current, label, key, count]. */
function segments(html: string): string[][] {
  const nav = html.slice(html.indexOf('<nav class="seg" aria-label="Link state"'));
  return [
    ...nav
      .slice(0, nav.indexOf("</nav>"))
      .matchAll(
        /<a href="([^"]*)"( aria-current="page")?>([^<]*)<span class="n" data-count-of="(\w+)">(\d+)<\/span><\/a>/g,
      ),
  ].map((match) => [
    match[1] ?? "",
    match[2] ? "current" : "",
    match[3] ?? "",
    match[4] ?? "",
    match[5] ?? "",
  ]);
}
/** Every row: its id, status and HTML. */
function rows(html: string): { id: string; status: string; html: string }[] {
  return [...html.matchAll(/<li class="lrow[^"]*"[\s\S]*?<\/li>/g)].map(([row]) => ({
    id: /data-link="([^"]+)"/.exec(row)?.[1] ?? "",
    status: /data-link-status="([^"]+)"/.exec(row)?.[1] ?? "",
    html: row,
  }));
}
/** The groups: each section's HTML, in page order. */
const groups = (html: string): string[] =>
  html
    .split('<section class="lgrp"')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf("</section>")));
/** A row's actions: from its .acts to its meta line. */
function actsOf(row: string): string {
  const start = row.indexOf('<span class="acts">');
  return start < 0 ? "" : row.slice(start, row.indexOf('<span class="s">', start));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-ow05b-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://reader-dev.example.test",
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
  const blobs = new BlobStore(directory, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  const sync = new SyncLoop(queue, opened.syncClient, Date.now, waypoint);
  worker = new WriterCommitter(waypoint, queue, blobs, new MemoryBucket(), sync, ingest);
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey,
  });
  const bytes = new TextEncoder().encode("hello public");
  hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  if ((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status !== 200)
    throw new Error("Blob upload failed");
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

interface Seeded {
  a: Made;
  b: Made;
  c: Made;
  d: Made;
  sam: string;
  priya: string;
  never: string;
  paused: string;
  expired: string;
  revoked: string;
  waiting: string;
}
/**
 * A (#1): "Sam" (Latest, 2 h) and "Priya" (Only #1, 7 days), and an expired link. B (#1,
 * project api): an unlabelled never-expiring Latest link and a revoked one. C: a link, then
 * Trash (paused). D: the committer stops, #2 stays pending, and a link pinned to it (waiting).
 */
async function seed(): Promise<Seeded> {
  const now = Date.now();
  const a = await collection("Alpha plan");
  const b = await collection("Beta API", { project: "api" });
  const c = await collection("Gamma leak");
  const d = await collection("Delta draft");
  const sam = await link(a.id, { label: "Sam", expires_at: now + 2 * 3_600_000 });
  const priya = await link(a.id, {
    label: "Priya",
    revision_id: a.revision,
    expires_at: now + 7 * DAY,
  });
  const never = await link(b.id);
  const paused = await link(c.id, { label: "Vendor" });
  expect((await app.request(`/api/collections/${c.id}`, { method: "DELETE" })).status).toBe(200);
  const expired = await link(a.id, { label: "Old", expires_at: now + 60_000 });
  await waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [now - 4 * DAY, expired]);
  const revoked = await link(b.id, { label: "Gone" });
  expect((await app.request(`/api/share-links/${revoked}/revoke`, json({}))).status).toBe(200);
  await worker.drain();
  worker.stop();
  await worker.drain();
  // #2 stays in queue.db as the committer would leave it (as FC1's and OW-04's fixtures do).
  const second = mintRevisionId({ now: Date.now(), parentId: d.revision });
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      second,
      await publicIdFor(second),
      d.id,
      d.revision,
      "index.txt",
      "second",
      "{}",
      JSON.stringify({
        headPath: "index.txt",
        files: { "index.txt": { hash, mime: "text/plain", size: 12 } },
      }),
      Date.now(),
    ],
  );
  const waiting = await link(d.id, { label: "Waiting", revision_id: second });
  return { a, b, c, d, sam, priya, never, paused, expired, revoked, waiting };
}

describe("OW-05b /links", () => {
  it("counts live links only, groups rows by collection and lists waiting links uncounted", async () => {
    const s = await seed();
    const html = await page("/links");
    expect(html).toContain('<main class="wrap" id="main" data-links-page="true">');
    expect(segments(html)).toEqual([
      ["/links", "current", "Live ", "active", "3"],
      ["/links?state=paused", "", "Paused in Trash ", "paused", "1"],
      ["/links?state=expired", "", "Expired ", "expired", "1"],
      ["/links?state=revoked", "", "Revoked ", "revoked", "1"],
    ]);
    expect(html).toContain(
      '<p data-refresh="links-head"><b>3 links on 2 collections</b> are readable outside your tailnet right now. 1 expires within a day. Revoking takes effect within seconds.</p>',
    );
    // Every row carries FC1's status; Live lists the live rows and D's waiting one, newest first.
    const live = rows(html);
    expect(live.map((row) => [row.id, row.status])).toEqual([
      [s.waiting, "waiting"],
      [s.never, "active"],
      [s.priya, "active"],
      [s.sam, "active"],
    ]);
    // One section per collection, named by its h2, in order of each one's newest link.
    const [dGroup, bGroup, aGroup, extra] = groups(html);
    expect(extra).toBeUndefined();
    for (const [group, made] of [
      [dGroup, s.d],
      [bGroup, s.b],
      [aGroup, s.a],
    ] as const) {
      const heading = /aria-labelledby="(lg-\d+)"/.exec(group ?? "")?.[1];
      expect(group).toContain(`<h2 id="${heading}"><a href="/c/${made.pub}/">`);
      expect(group).toContain(
        `<a class="tab" href="/c/${made.pub}/?panel=links">Public links tab</a>`,
      );
      expect(group).toContain(`data-collection="${made.id}"`);
    }
    expect(bGroup).toContain('<span class="p">api · now #1</span>');
    expect(aGroup).toContain('<span class="p">now #1</span>');
    expect(dGroup).toContain('<span class="p">now #2</span>');
    expect(dGroup).toMatch(
      /<span class="chip xs waiting" data-link-state="waiting"><svg[^>]*>[\s\S]*?<\/svg>Opens when #2 syncs<\/span>/,
    );
    // Paused links appear only under their segment; Live has one line about them.
    expect(html).not.toContain(`data-link="${s.paused}"`);
    expect(html).toMatch(
      /<p class="legend" data-refresh="links-paused">1 paused link on a collection in Trash isn&#39;t counted\. <a href="\/links\?state=paused">Show<svg/,
    );
    expect(html).not.toContain("not counted as live");
    expect(html).not.toContain("Paused · not counted");
    expect(html).not.toContain("inactive links");
  });

  it("describes every action by its row's label and keeps Revoke… quiet red text", async () => {
    const s = await seed();
    const html = await page("/links");
    for (const row of rows(html)) {
      expect(row.html).toContain(`<span class="who" id="lw-${row.id}">`);
      const controls = [...actsOf(row.html).matchAll(/<(?:button|a|summary)\b[^>]*>/g)].map(
        ([tag]) => tag,
      );
      // Copy URL, Open, Extend… (with its popover's buttons) where it applies, and Revoke….
      expect(controls.length).toBeGreaterThanOrEqual(3);
      for (const control of controls) expect(control).toContain(`aria-describedby="lw-${row.id}"`);
      expect(actsOf(row.html)).toContain("Copy URL");
      expect(actsOf(row.html)).toMatch(
        /<button type="button" class="txtbtn danger" data-action="revoke-link" data-id="[^"]+" data-confirm="true" aria-describedby="lw-[^"]+">Revoke…<\/button>/,
      );
      expect(row.html).not.toContain("btn sm danger");
    }
    expect(html).not.toContain('aria-label="Copy URL of');
    // Never-expiring links can't be extended: an empty slot keeps the columns.
    const byId = new Map(rows(html).map((row) => [row.id, row.html]));
    const never = byId.get(s.never) ?? "";
    expect(never).not.toContain("extend-link");
    expect(never).toContain('<span class="slot" aria-hidden="true"></span>');
    expect(never).toContain('<span data-live="true">never expires</span>');
    expect(never).toContain('<i data-link-label="true">No label</i>');
    expect(byId.get(s.priya)).toContain('data-action="extend-link"');
    expect(byId.get(s.priya)).toContain('<span class="chip xs" data-shows="true">Only #1</span>');
    // Within a day: a clock, in ink at 600 (owner decision 9 Oct 2026), never amber.
    expect(byId.get(s.sam)).toMatch(/<span class="soon" data-live="true"><svg[^>]*class="ic/);
    const rules = [...viewerCssSource().matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
      selector?.includes(".lrow .soon"),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , declarations] of rules) {
      expect(declarations).toContain("var(--ink)");
      expect(declarations).not.toContain("--pending");
    }
    // The footer: Revoke all N live links… as quiet red text.
    const foot = html.slice(
      html.indexOf('<div class="lnk-foot lc-foot" data-refresh="links-foot">'),
    );
    expect(foot).toMatch(
      /^<div class="lnk-foot lc-foot" data-refresh="links-foot"><span>Expired and revoked links stay listed under their tabs; they can&#39;t be turned back on\.<\/span><button type="button" class="txtbtn danger" data-action="revoke-all" data-count="3" data-noun="live links">Revoke all 3 live links…<\/button><\/div>/,
    );
    // The Links tab card (prop unset) renders no description.
    const tab = await page(`/c/${s.a.pub}/?panel=links`);
    const copy = [...tab.matchAll(/<button[^>]*data-copy-url[^>]*>/g)];
    const open = [...tab.matchAll(/<a[^>]*data-open-url[^>]*>/g)];
    expect(copy.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    for (const [tag] of [...copy, ...open]) expect(tag).not.toContain("aria-describedby");
  });

  it("lists paused, waiting, expired and revoked links under their own URLs", async () => {
    const s = await seed();
    const paused = await page("/links?state=paused");
    expect(segments(paused).map((segment) => segment[1])).toEqual(["", "current", "", ""]);
    expect(rows(paused).map((row) => [row.id, row.status])).toEqual([[s.paused, "paused"]]);
    const row = rows(paused)[0]?.html ?? "";
    expect(row).toContain('<span class="chip xs" data-link-state="paused">Paused</span>');
    expect(row).toContain(`<span data-live="true">${PAUSED_NOTE}</span>`);
    expect(row).toContain(">Revoke…</button>");
    expect(row).not.toContain("Copy URL");
    expect(row).not.toContain("Extend…");
    expect(paused).toContain('<a class="tab" href="/trash">Trash</a>');
    expect(paused).not.toContain('data-refresh="links-paused"');
    expect(paused).not.toContain('data-refresh="links-foot"');
    // live and active are the Live segment.
    const main = mainOf(await page("/links"));
    expect(mainOf(await page("/links?state=live"))).toBe(main);
    expect(mainOf(await page("/links?state=active"))).toBe(main);
    expect(mainOf(await page("/links?state=nonsense"))).toBe(main);
    // waiting and inactive list their rows with no segment current.
    const waiting = await page("/links?state=waiting");
    expect(rows(waiting).map((item) => item.id)).toEqual([s.waiting]);
    expect(waiting).not.toContain('aria-current="page"><');
    expect(segments(waiting).every((segment) => segment[1] === "")).toBe(true);
    const inactive = await page("/links?state=inactive");
    expect(rows(inactive).map((item) => [item.id, item.status])).toEqual([
      [s.revoked, "revoked"],
      [s.expired, "expired"],
    ]);
    expect(segments(inactive).every((segment) => segment[1] === "")).toBe(true);
    for (const item of rows(inactive)) {
      expect(item.html).toContain('class="lrow dead"');
      expect(item.html).not.toContain('<span class="acts">');
    }
    expect(rows(inactive)[0]?.html).toMatch(/<span>revoked <time/);
    expect(rows(inactive)[1]?.html).toMatch(/<span>expired <time/);
    expect(await page("/links?state=expired")).toContain("Old");
    expect(await page("/links?state=revoked")).toContain("Gone");
  });

  it("revokes only live links from Revoke all; waiting, paused and expired ones stay", async () => {
    const s = await seed();
    const revoked = await app.request("/api/share-links/revoke-all?state=active", json({}));
    expect(await jsonOf(revoked)).toEqual({ revoked: 3 });
    const html = await page("/links");
    expect(segments(html).map((segment) => [segment[2], segment[4]])).toEqual([
      ["Live ", "0"],
      ["Paused in Trash ", "1"],
      ["Expired ", "1"],
      ["Revoked ", "4"],
    ]);
    expect(html).toContain(
      '<p data-refresh="links-head">Nothing is readable outside your tailnet right now.</p>',
    );
    expect(rows(html).map((row) => [row.id, row.status])).toEqual([[s.waiting, "waiting"]]);
    expect(html).not.toContain('data-refresh="links-foot"');
    expect(rows(await page("/links?state=paused")).map((row) => row.id)).toEqual([s.paused]);
  });

  it("says nothing is public on an empty Live segment", async () => {
    const html = await page("/links");
    expect(html).toContain("No public links. Nothing is readable outside your tailnet.");
    expect(html).toContain(
      '<p data-refresh="links-head">Nothing is readable outside your tailnet right now.</p>',
    );
    expect(await page("/links?state=revoked")).toContain("No revoked links.");
  });
});
