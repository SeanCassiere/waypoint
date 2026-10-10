import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp, type HttpServices } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";
import { FileTree } from "../src/viewer/components.tsx";
import { bindingFor, keyTitle } from "../src/viewer/keymap.ts";
import { NotFoundBody } from "../src/viewer/layout.tsx";

// NAV-04: the collection bar as a breadcrumb (collection › revision › file), the pill contract,
// the Copy and More menus, the 404 that keeps the bar, and A11Y-04's hidden headings. Setup as in
// NAV-10's test: an in-process app; a committer syncs #1..#5 so #5 reads "older", then stops so
// #6 (failed) and #7 (uploading) stay queued. One seed for the file: every check only reads.

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;

interface Written {
  collection_id: string;
  revision_id: string;
  url: string;
}
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(
  path: string,
  content: string,
  mime?: string,
): Promise<{ path: string; hash: string; mime?: string }> {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return mime ? { path, hash, mime } : { path, hash };
}
async function post(path: string, body: unknown): Promise<Written> {
  const response = await app.request(path, json(body));
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
  return { collection_id: value.collection_id, revision_id: value.revision_id, url: value.url };
}
const pubOf = (written: Written): string => /\/r\/([^/]+)\//.exec(written.url)?.[1] ?? "";
const colOf = (written: Written): string => /\/c\/([^/]+)\//.exec(written.url)?.[1] ?? "";
function nth(revs: readonly Written[], n: number): Written {
  const rev = revs[n - 1];
  if (!rev) throw new Error(`no #${n}`);
  return rev;
}
/** hono/jsx escapes ' and &; assertions compare decoded text. */
const decoded = (html: string): string => html.replaceAll("&#39;", "'").replaceAll("&amp;", "&");
async function get(path: string): Promise<{ status: number; html: string }> {
  const response = await app.request(path);
  return { status: response.status, html: decoded(await response.text()) };
}
/** The markup from `marker` up to the next `end` (or the end of the page). */
function region(html: string, marker: string, end: string): string {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`no ${marker}`);
  const stop = html.indexOf(end, start + marker.length);
  return html.slice(start, stop === -1 ? undefined : stop);
}
const header = (html: string) => region(html, "<header", "</header>");
const breadcrumb = (html: string) => region(html, '<nav class="bc"', "</nav>");
const text = (markup: string) => markup.replace(/<[^>]*>/g, "");
/** A component rendered on its own, as a string. */
async function rendered(node: unknown): Promise<string> {
  return String(await node);
}
/** The opening tag of the first element matching `marker` (a class or attribute snippet). */
function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}
/** An element's markup from its opening tag to its first closing `</name>`. */
function element(html: string, marker: string, name: string): string {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(`</${name}>`, at) + name.length + 3);
}

let revs: Written[] = [];
let col = "";
let pub: string[] = [];
let gallery: Written;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-nav04-test-"));
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
  const services: HttpServices = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  };
  // A cloud that accepts every push, as the demo writer runs.
  const cloud: SyncClient = {
    lastPullAt: Date.now(),
    verified: true,
    pull: () => Promise.resolve(false),
    push: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
  const ingest = new IngestService(waypoint, queue, blobs, reads, cloud);
  const syncLoop = new SyncLoop(queue, cloud, Date.now, waypoint);
  const committer = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    new MemoryBucket(),
    syncLoop,
    ingest,
  );
  ingest.committer = committer;
  app = createApp({ ...services, ingest, committer, syncLoop, environment: "dev" });
  syncLoop.start();
  try {
    // #1..#5 linear (#5 adds extensions.md), synced; #6 on #4 failed; #7 on #5 uploading.
    const one = await post("/api/collections", {
      title: "Postgres 17 upgrade runbook",
      metadata: { project: "infra" },
      files: [await upload("runbook.md", "# Runbook 1")],
    });
    revs = [one];
    const add = async (parent: Written, n: number, extra: { path: string; hash: string }[] = []) =>
      post(`/api/collections/${one.collection_id}/revisions`, {
        message: `Message ${n}`,
        parent_revision_id: parent.revision_id,
        files: [await upload("runbook.md", `# Runbook ${n}`), ...extra],
      });
    for (const n of [2, 3, 4]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
      revs.push(await add(nth(revs, n - 1), n));
    }
    revs.push(await add(nth(revs, 4), 5, [await upload("extensions.md", "# Extensions")]));
    for (let i = 0; i < 200; i++) {
      committer.wake();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
      await new Promise((resolve) => setTimeout(resolve, 25));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
      const rows = await reads.revisions(one.collection_id);
      if (rows.length === 5 && rows.every((row) => row.sync_state === "synced")) break;
    }
    committer.stop();
    const six = await add(nth(revs, 4), 6);
    await queue.run(
      "UPDATE pending_revisions SET state='failed',last_error='Upload failed',error_kind='permanent' WHERE id=?",
      [six.revision_id],
    );
    revs.push(six, await add(nth(revs, 5), 7));
    col = colOf(one);
    pub = revs.map(pubOf);
    gallery = await post("/api/collections", {
      title: "Checkout screenshot audit",
      head_path: "index.md",
      files: [
        await upload("index.md", "# Shots"),
        await upload("shots/a.png", "a", "image/png"),
        await upload("shots/b.png", "b", "image/png"),
      ],
    });
  } finally {
    committer.stop();
    syncLoop.stop();
  }
}, 30_000);
afterAll(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

const doc = (n: number, path = "runbook.md") => `/c/${col}/r/${pub[n - 1]}/${path}`;
/** The revision pill's text on #n's document page. */
const words = async (n: number) =>
  text(element(breadcrumb((await get(doc(n))).html), 'class="pill rev"', "a"));

describe("NAV-04 collection bar", () => {
  it("spells out Recent / infra / title › #5 older › runbook.md as a breadcrumb list", async () => {
    const { status, html } = await get(doc(5));
    expect(status).toBe(200);
    const bar = header(html);
    expect(bar).toContain('<header class="bar cbar">');
    expect(bar).toContain('<nav class="bc" aria-label="Breadcrumb"><ol>');
    const nav = breadcrumb(html);
    expect([...nav.matchAll(/<li class="([^"]*)"/g)].map(([, cls]) => cls)).toEqual([
      "anc",
      "anc",
      "ttl",
      "crumb rev",
      "crumb file",
    ]);
    expect(nav).toContain('<a href="/">Recent</a>');
    expect(nav).toContain('<a href="/?q=project%3Ainfra" title="infra">infra</a>');
    expect(nav).toContain('<h1 data-title-text="true">Postgres 17 upgrade runbook</h1>');
    // Separators are CSS alt text: none in the DOM.
    expect(text(nav)).not.toMatch(/[/›]/);
    const pill = element(nav, 'class="pill rev"', "a");
    expect(pill).toContain(
      'href="?panel=history" data-action="panel-tab" data-tab="history" aria-controls="panel" aria-expanded=',
    );
    expect(pill).toContain('<b>#5</b> <span class="l">older</span>');
    expect(pill).toContain("<svg");
    expect(pill).not.toContain("aria-label");
    const file = element(nav, 'class="pill file"', "a");
    expect(file).toContain('data-tab="files"');
    expect(file).toContain('aria-controls="panel"');
    expect(file).toContain('<span class="mono">runbook.md</span>');
    // Files is the default tab, so the file crumb is the pressed one.
    expect(tagOf(file, "pill file")).toContain('aria-expanded="true"');
    expect(tagOf(pill, "pill rev")).toContain('aria-expanded="false"');
    const idsub = region(nav, '<span class="idsub"', "</li>");
    expect(tagOf(idsub, "idsub")).toContain('aria-hidden="true"');
    expect(text(idsub)).toBe("#5 older · runbook.md");
    const find = tagOf(bar, 'commandfor="find"');
    expect(find).toContain('aria-label="Find"');
    expect(find).toContain('aria-keyshortcuts="/"');
    expect(bar).toContain("Copy link");
    expect(bar.indexOf('popovertarget="health-pop"')).toBeGreaterThan(-1);
    expect(bar.indexOf('popovertarget="health-pop"')).toBeLessThan(
      bar.indexOf('popovertarget="more-menu"'),
    );
    // ?panel=history presses the pill instead.
    const history = breadcrumb((await get(`${doc(5)}?panel=history`)).html);
    expect(tagOf(history, "pill rev")).toContain('aria-expanded="true"');
    expect(tagOf(history, "pill file")).toContain('aria-expanded="false"');
  });

  it("takes every tooltip and the panel toggle's name from the keymap", async () => {
    const bar = header((await get(doc(5))).html);
    expect(tagOf(bar, "pill rev")).toContain(`title="${keyTitle("history")}"`);
    expect(tagOf(bar, "pill file")).toContain(`title="${keyTitle("files")}"`);
    expect(tagOf(bar, 'commandfor="find"')).toContain(`title="${keyTitle("find")}"`);
    const toggle = tagOf(bar, 'data-action="panel-toggle"');
    expect(toggle).toContain(`title="${keyTitle("panel")}"`);
    expect(toggle).toContain(`aria-label="${bindingFor("panel").title}"`);
    expect(tagOf(bar, "iconbtn back")).toContain('title="Recent / infra"');
  });

  it("has no revision menu and no Public chip in the bar", async () => {
    for (const path of [doc(5), `/c/${col}/r/${pub[4]}/changes`]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      const { html } = await get(path);
      expect(html).not.toContain('id="rev-menu"');
      expect(html).not.toContain('popovertarget="rev-menu"');
      expect(header(html)).not.toContain('class="chip public');
    }
    const shots = await get(`/c/${colOf(gallery)}/r/${pubOf(gallery)}/gallery/shots/`);
    expect(shots.status).toBe(200);
    expect(shots.html).not.toContain("rev-menu");
  });

  it("words the pill latest · uploading, failed and older", async () => {
    expect(await words(7)).toBe("#7 latest · uploading");
    expect(await words(6)).toBe("#6 failed");
    expect(await words(5)).toBe("#5 older");
  });

  it("gives the tab bar's Files and History the pill contract and icons", async () => {
    const tabbar = region((await get(doc(5))).html, '<nav class="tabbar"', "</nav>");
    for (const tab of ["files", "history"]) {
      const tag = tagOf(tabbar, `data-tab="${tab}"`);
      expect(tag).toContain('data-action="panel-tab"');
      expect(tag).toContain('aria-controls="panel"');
      expect(tag).toContain("aria-expanded=");
    }
    const items = tabbar.split("<button").slice(1);
    expect(items).toHaveLength(4);
    for (const item of items) expect(item).toContain("<svg");
  });

  it("renders three hidden headings on the document page, two on Changes, one on Gallery", async () => {
    const page = (await get(doc(5))).html;
    const aside = page.indexOf('<aside class="panel" id="panel"');
    expect(page.slice(page.indexOf(">", aside) + 1)).toMatch(
      /^<h2 class="vh">Files and history<\/h2>/,
    );
    const status = page.indexOf('<h2 class="vh">Sync and sharing status</h2>');
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(page.indexOf("data-status"));
    const document = page.indexOf('<h2 class="vh">Document: runbook.md</h2>');
    expect(document).toBeGreaterThan(status);
    expect(document).toBeLessThan(page.indexOf('class="frame'));
    const changes = (await get(`/c/${col}/r/${pub[4]}/changes`)).html;
    expect(changes).toContain('<h2 class="vh">Files and history</h2>');
    const changesStatus = changes.indexOf('<h2 class="vh">Sync and sharing status</h2>');
    expect(changesStatus).toBeGreaterThan(-1);
    expect(changesStatus).toBeLessThan(changes.indexOf("data-status"));
    expect(changes).not.toContain("Document: ");
    const shots = (await get(`/c/${colOf(gallery)}/r/${pubOf(gallery)}/gallery/shots/`)).html;
    expect(shots).toContain('<h2 class="vh">Files and history</h2>');
    expect(shots).not.toContain("Sync and sharing status");
  });

  it("collapses the handoff preview and pins the IDs in the Copy menu's footer", async () => {
    const page = (await get(doc(5))).html;
    const menu = region(page, 'id="copy-menu"', 'id="more-menu"');
    expect(menu).toContain('<div class="mbox has-list"><div class="mbody">');
    const body = menu.slice(menu.indexOf('class="mbody"'), menu.indexOf('class="mfoot"'));
    const foot = menu.slice(menu.indexOf('class="mfoot"'));
    // A11Y-AUDIT: the Preview disclosure follows the menu (its list), not inside it.
    expect(body).toMatch(
      /<\/button><\/div><details class="handoff-d"><summary>Preview<\/summary><pre class="handoff" data-handoff="true">/,
    );
    expect(body).toContain('data-kind="latest"');
    expect(body).toContain('data-kind="pinned"');
    expect(foot).toContain('data-label="collection ID"');
    expect(foot).toContain('data-label="revision ID"');
    expect(foot).not.toContain("data-kind=");
    expect(menu).not.toContain("<details open");
  });

  it("puts Copy link's three actions in More for tablets", async () => {
    const more = region((await get(doc(5))).html, 'id="more-menu"', "</div></div>");
    const items = [...more.matchAll(/<button[^>]*class="mi midonly"[^>]*>[\s\S]*?<\/button>/g)].map(
      ([item]) => item,
    );
    expect(items.map((item) => text(item))).toEqual([
      "Link to latestc",
      "Link to this revision (#5)⇧C",
      "Handoff blocka",
    ]);
    expect(items[0]).toContain('data-action="copy-link" data-kind="latest"');
    expect(items[1]).toContain('data-kind="pinned"');
    expect(items[2]).toContain('data-action="copy-handoff"');
    for (const item of items) {
      expect(item).toContain('popovertarget="more-menu"');
      expect(item).toContain('popovertargetaction="hide"');
    }
    expect(more).toContain('<div class="lbl midonly">Copy link</div>');
    // The group leads the menu's other items. Sharing is off in this app, so Share… (which
    // stays first, before the group) is checked by tests/browser/viewer/NAV-04.ts at 390 px.
    expect(more).not.toContain("Share…");
    expect(more.indexOf("Link to latest")).toBeGreaterThan(-1);
    expect(more.indexOf("Link to latest")).toBeLessThan(more.indexOf("Rename…"));
  });

  it("keeps Done on Changes and shows no file crumb there", async () => {
    const { html } = await get(`/c/${col}/r/${pub[4]}/changes`);
    const bar = header(html);
    expect(bar).not.toContain("crumb file");
    expect(bar).toContain('class="pill rev"');
    const done = tagOf(bar, "data-done");
    expect(done).toContain('class="btn sm ghost done"');
    expect(done).not.toContain("hide-sm");
  });

  it("keeps the bar on a 404 for a file that isn't in the revision", async () => {
    const missing = await get(doc(4, "extensions.md"));
    expect(missing.status).toBe(404);
    const bar = header(missing.html);
    expect(bar).toContain('<header class="bar cbar">');
    expect(bar).toContain('<h1 data-title-text="true">Postgres 17 upgrade runbook</h1>');
    expect(bar).not.toContain("data-action");
    expect(bar).not.toContain("aria-expanded");
    expect(tagOf(bar, "pill rev")).toContain(`href="/c/${col}/r/${pub[3]}/?panel=history"`);
    expect(bar).toContain('commandfor="find"');
    expect(bar).not.toContain("copy-menu");
    expect(bar).not.toContain("more-menu");
    const main = region(missing.html, '<main class="wrap narrow notfound" id="main">', "</main>");
    expect(main).toContain("<h2>Not found</h2>");
    expect(text(main)).toContain("This file isn't in #4: extensions.md.");
    expect(main).toContain(`<a class="btn primary" href="/c/${col}/extensions.md">`);
    expect(text(main)).toContain("Open extensions.md in latest");
    expect(main).toContain(`<a class="btn" href="/c/${col}/r/${pub[3]}/">Open its head file</a>`);
    // Not in latest either: no "in latest" button.
    const nowhere = await get(doc(4, "nowhere.md"));
    expect(nowhere.status).toBe(404);
    expect(nowhere.html).not.toContain("in latest");
    expect(nowhere.html).toContain("Open its head file");
  });

  // A11Y-AUDIT: the residual semantics the audit's browser scenarios rely on.
  it("reads the Files tree's change marks as words, never as aria-label on a span", async () => {
    const files = region((await get(doc(5))).html, 'id="tp-files"', 'id="tp-history"');
    expect(files).toContain(
      '<span class="k m"><span aria-hidden="true">~</span><span class="vh">changed</span></span>',
    );
    expect(files).toContain(
      '<span class="k a"><span aria-hidden="true">+</span><span class="vh">added</span></span>',
    );
    expect(files).not.toMatch(/<span[^>]*aria-label=/);
    expect(files).not.toContain("modified");
    // No compare base (glyphs: null): the dot is decoration only, with no word.
    const bare = await rendered(
      FileTree({
        files: [{ path: "a.md", hash: "sha256:a", mime: "text/markdown", size: 1, url: "" }],
        head: "a.md",
        pub: "c",
        rpub: "r",
        pinned: false,
        current: "a.md",
        glyphs: null,
      }),
    );
    expect(bare).toContain('<span class="k"><span aria-hidden="true">·</span></span>');
    expect(bare).not.toContain('class="vh"');
  });

  it("keeps the Copy and More menus inside the bar's banner", async () => {
    for (const path of [doc(5), `/c/${col}/r/${pub[4]}/changes`]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two pages, one at a time.
      const bar = header((await get(path)).html);
      // The Copy menu's role is on its list, which owns the pinned footer (A11Y-AUDIT).
      expect(bar).toContain(
        '<div id="copy-menu" class="menu" popover="auto"><div class="mbox has-list"><div class="mbody"><div role="menu" aria-label="Copy" aria-owns="copy-menu-foot">',
      );
      expect(bar).toContain('<div class="mfoot" id="copy-menu-foot">');
      expect(bar).toContain('<div id="more-menu" class="menu" popover="auto" role="menu"');
    }
  });

  it("renders NotFoundBody's heading as an h1 unless asked for an h2", async () => {
    expect((await get("/nope")).html).toContain("<h1>Not found</h1>");
    expect(await rendered(NotFoundBody({ path: "x" }))).toContain("<h1>Not found</h1>");
    const h2 = await rendered(NotFoundBody({ path: "x", level: "h2" }));
    expect(h2).toContain("<h2>Not found</h2>");
    expect(h2).not.toContain("<h1>");
  });
});
