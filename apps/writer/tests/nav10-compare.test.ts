import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintRevisionId, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

// NAV-10: Compare follows lineage. Ordered pairs, range and branch headers on the Changes page,
// History's compare mode and the no-script /c/<pub>/compare route. Setup as in NAV-05b's test:
// an in-process app, sync off, no committer.

let dir: string;
let waypoint: Db;
let queue: Db;
let services: HttpServices;
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
async function upload(path: string, content: string): Promise<{ path: string; hash: string }> {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return { path, hash };
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
/** #n of a seeded list (index n - 1). */
function nth(revs: readonly Written[], n: number): Written {
  const rev = revs[n - 1];
  if (!rev) throw new Error(`no #${n}`);
  return rev;
}
/** hono/jsx escapes ' and &; assertions compare decoded text. */
const decoded = (html: string): string => html.replaceAll("&#39;", "'").replaceAll("&amp;", "&");
async function get(path: string): Promise<{ status: number; html: string; location: string }> {
  const response = await app.request(path);
  return {
    status: response.status,
    html: decoded(await response.text()),
    location: response.headers.get("location") ?? "",
  };
}
/** The markup from `marker` up to the next `end` (or the end of the page). */
function region(html: string, marker: string, end: string): string {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`no ${marker}`);
  const stop = html.indexOf(end, start + marker.length);
  return html.slice(start, stop === -1 ? undefined : stop);
}
const filesPanel = (html: string) => region(html, 'id="tp-files"', 'role="tabpanel"');
const historyPanel = (html: string) => region(html, 'id="tp-history"', "</form>");
const bar = (html: string) => region(html, '<header class="bar cbar"', "</header>");
const cmp = (html: string) => region(html, '<div class="cmp"', "</main>");
const changesLink = (html: string) =>
  /<a hidden="" data-changes-link="true" href="([^"]*)"/.exec(html)?.[1];
const compareOpen = (html: string) =>
  /<a class="btn sm cmpbtn" href="([^"]*)" data-compare-open="true">/.exec(html)?.[1];
/** The revision menu's Compare… href (NAV-04 deleted the menu: always undefined now). */
const menuOpen = (html: string) => /<a class="mi" href="([^"]*)" data-compare-open/.exec(html)?.[1];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-nav10-test-"));
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
  services = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  };
  app = createApp(services);
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

/** #1..#5 linear, #6 on #4 (failed), #7 on #5 (left uploading): the demo's Postgres shape. */
async function seedFork(
  beforeFork?: (revs: readonly Written[]) => Promise<void>,
): Promise<Written[]> {
  const one = await post("/api/collections", {
    title: "Postgres",
    files: [await upload("index.md", "# 1")],
  });
  const revs = [one];
  const add = async (parent: Written, n: number) =>
    post(`/api/collections/${one.collection_id}/revisions`, {
      message: `Message ${n}`,
      parent_revision_id: parent.revision_id,
      files: [await upload("index.md", `# ${n}`), await upload(`step-${n}.md`, `# Step ${n}`)],
    });
  for (const n of [2, 3, 4, 5]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
    revs.push(await add(nth(revs, n - 1), n));
  }
  await beforeFork?.(revs);
  const six = await add(nth(revs, 4), 6);
  await queue.run(
    "UPDATE pending_revisions SET state='failed',last_error='Upload failed',error_kind='permanent' WHERE id=?",
    [six.revision_id],
  );
  revs.push(six, await add(nth(revs, 5), 7));
  return revs;
}
/** The pinned Changes URL of #n, optionally with a query. */
const changesOf = (revs: readonly Written[], n: number, query = "") =>
  `/c/${colOf(nth(revs, n))}/r/${pubOf(nth(revs, n))}/changes${query}`;

describe("NAV-10 Changes page: ordered pairs", () => {
  it("redirects a reversed pair to the ordered URL and says so", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const reversed = await app.request(changesOf(revs, 2, `?base=${pub[6]}`));
    expect(reversed.status).toBe(302);
    expect(reversed.headers.get("location")).toBe(
      `/c/${col}/r/${pub[6]}/changes?base=${pub[1]}&swapped=1`,
    );
    expect(reversed.headers.get("cache-control")).toBe("no-store");
    const page = await get(reversed.headers.get("location") ?? "");
    expect(page.status).toBe(200);
    expect(cmp(page.html)).toContain(
      '<p class="cmpnote" role="status">Swapped to #2 → #7 so additions read as additions.</p>',
    );
    // Other links never carry swapped=1; a parent pair reversed drops ?base= and keeps the view.
    expect(page.html).not.toMatch(/href="[^"]*swapped/);
    const parent = await app.request(changesOf(revs, 4, `?base=${pub[4]}&view=source`));
    expect(parent.headers.get("location")).toBe(
      `/c/${col}/r/${pub[4]}/changes?swapped=1&view=source`,
    );
  });

  it("answers an unknown base with a 404 around the parent comparison", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const missing = await publicIdFor(mintRevisionId({ now: Date.now() + 99_999 }));
    expect(pub).not.toContain(missing);
    const page = await get(changesOf(revs, 7, `?base=${missing}`));
    expect(page.status).toBe(404);
    const head = `/c/${col}/r/${pub[6]}/changes`;
    expect(cmp(page.html)).toContain(
      `<p class="cmphead cmperr"><b>#? isn't in this collection any more.</b> <a href="${head}">Compare with the parent #5 instead ›</a></p>`,
    );
    // Neither the error nor History's Compare…/Cancel links carry the bad base back.
    expect(cmp(page.html)).not.toContain(missing);
    expect(historyPanel(page.html)).not.toContain(missing);
    expect(page.html).not.toContain("first revision");
    expect(page.html.toLowerCase()).not.toContain("everything is new");
    expect(filesPanel(page.html)).toContain("Comparing #7 with its parent #5");
    expect(bar(page.html)).toContain("changes from #5");
    expect(changesLink(page.html)).toBe(head);
    expect(page.html).not.toContain("These changes are readable here only");
    expect(compareOpen(page.html)).toContain(`r=${pub[4]}&r=${pub[6]}`);
    // .cmp holds only the error (and the hidden d link): no header, no cards.
    expect(cmp(page.html)).not.toContain("cmpnote");
    expect(cmp(page.html)).not.toContain("<h2>");
    // A root's error links to its own first-revision page.
    const root = await get(changesOf(revs, 1, `?base=${missing}`));
    expect(root.status).toBe(404);
    expect(cmp(root.html)).toContain(
      `<a href="/c/${col}/r/${pub[0]}/changes">See what #1 added ›</a>`,
    );
  });

  it("answers the same revision twice with a 400 around the parent comparison", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const page = await get(changesOf(revs, 7, `?base=${pub[6]}`));
    expect(page.status).toBe(400);
    expect(cmp(page.html)).toContain(
      `<b>Pick two different revisions.</b> <a href="?panel=history&compare=1&r=${pub[6]}">Choose revisions to compare ›</a>`,
    );
    expect(filesPanel(page.html)).toContain("Comparing #7 with its parent #5");
    expect(changesLink(page.html)).not.toContain("base=");
  });

  it("compares two separate histories as unrelated, not missing", async () => {
    await seedFork();
    const one = await post("/api/collections", {
      title: "Two roots",
      files: [await upload("index.md", "# A")],
    });
    const two = await post(`/api/collections/${one.collection_id}/revisions`, {
      parent_revision_id: one.revision_id,
      files: [await upload("index.md", "# B")],
    });
    const id = mintRevisionId({ now: Date.now() + 60_000 });
    const three = await publicIdFor(id);
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        three,
        one.collection_id,
        null,
        "index.md",
        "Second root",
        "{}",
        JSON.stringify({
          headPath: "index.md",
          files: {
            "index.md": { hash: "sha256:" + "0".repeat(64), mime: "text/markdown", size: 1 },
          },
        }),
        Date.now() + 60_000,
        "failed",
      ],
    );
    const page = await get(`/c/${colOf(one)}/r/${three}/changes?base=${pubOf(two)}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain(
      '<h2>#3 compared with #2 <span class="chip xs">different histories</span></h2>',
    );
    expect(page.html).toContain("#2 and #3 share no earlier revision.");
    expect(page.html).not.toContain("isn't in this collection");
    expect(page.html).not.toContain('class="forkcard"');
    expect(filesPanel(page.html)).toContain("Comparing two unrelated histories.");
    expect(bar(page.html)).toContain("#2 #3 branches");
  });
});

describe("NAV-10 Changes page: headers", () => {
  it("draws a range: steps, what it skips, the status line and the crumb", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const url = changesOf(revs, 7, `?base=${pub[1]}`);
    const page = await get(url);
    expect(page.status).toBe(200);
    expect(page.html).toContain("<h2>Changes from #2 to #7</h2>");
    expect(page.html).toContain(
      "Everything that changed after “Message 2” (#2), up to “Message 7” (#7)",
    );
    const strip = region(page.html, '<div class="incl">', "</ol>");
    expect(strip).toContain('<span class="lbl">Includes</span>');
    const chips = [...strip.matchAll(/<a class="(stepchip[^"]*)" href="([^"]*)"><b>#(\d+)<\/b>/g)];
    expect(chips.map(([, , , n]) => n)).toEqual(["3", "4", "5", "7"]);
    expect(chips.map(([, , href]) => href)).toEqual(
      [2, 3, 4, 6].map((i) => `/c/${col}/r/${pub[i]}/changes`),
    );
    expect(chips.map(([, cls]) => cls)).toEqual([
      "stepchip pending",
      "stepchip pending",
      "stepchip pending",
      "stepchip pending",
    ]);
    expect(strip.match(/<span class="arr" aria-hidden="true">→<\/span>/g)).toHaveLength(3);
    expect(page.html).toMatch(
      new RegExp(
        `<p class="excl"><svg[^>]*>.*?</svg> Not included: #6 \\(branch off #4, failed\\)\\. <a href="/c/${col}/r/${pub[5]}/changes">What #6 changed ›</a></p>`,
      ),
    );
    // The status line comes first in <main>, above .cmp, with the range segment.
    const main = region(page.html, '<main class="main"', "</main>");
    expect(main.indexOf("data-status")).toBeGreaterThan(-1);
    expect(main.indexOf("data-status")).toBeLessThan(main.indexOf('<div class="cmp"'));
    expect(main).toContain(
      "These changes are readable here only; public links see nothing yet, so the parts from #3, #4, #5 and #7 aren't public yet.",
    );
    expect(changesLink(page.html)).toBe(url);
    expect(bar(page.html)).toContain("#2 → #7 changes");
    expect(bar(page.html)).toMatch(
      /<a class="pill rev"[^>]*><svg[^>]*>.*?<\/svg>#2 → #7 changes<\/a>/,
    );
    expect(filesPanel(page.html)).toContain(
      "Changes from #2 to #7 across 4 revisions: #3, #4, #5, #7. To change the range, use Compare… in History.",
    );
  });

  it("labels a skipped revision on the latest line without a link", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const page = await get(changesOf(revs, 6, `?base=${pub[0]}`));
    expect(page.html).toContain("Not included: #5 (on the latest line, not under #6).");
    expect(page.html).not.toContain("What #5 changed");
    expect(page.html).toContain("<h2>Changes from #1 to #6</h2>");
  });

  it("compares two branches with the fork card", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const page = await get(changesOf(revs, 6, `?base=${pub[4]}`));
    expect(page.status).toBe(200);
    expect(page.html).toContain(
      '<h2>#6 compared with #5 <span class="chip xs">different branches</span></h2>',
    );
    expect(page.html).toContain(
      "#5 and #6 both build on #4, so this shows how the two versions differ, not what either one changed.",
    );
    const card = region(page.html, '<div class="forkcard">', "</div></div>");
    expect(card).toMatch(/<svg class="fork"[^>]* aria-hidden="true">/);
    expect(card.match(/<circle /g)).toHaveLength(3);
    const links = [...card.matchAll(/<a class="btn sm" href="([^"]*)">([^<]*)<\/a>/g)].map(
      ([, href, text]) => [text, href],
    );
    expect(links).toEqual([
      ["What #6 changed (vs #4)", `/c/${col}/r/${pub[5]}/changes`],
      ["What #5 changed (vs #4)", `/c/${col}/r/${pub[4]}/changes`],
      ["Swap sides", `/c/${col}/r/${pub[4]}/changes?base=${pub[5]}`],
    ]);
    expect(bar(page.html)).toContain("#5 #6 branches");
    expect(filesPanel(page.html)).toContain("Comparing two branches that split at #4.");
  });

  it("keeps the parent header, without the old not-its-parent wording", async () => {
    const revs = await seedFork();
    const page = await get(changesOf(revs, 5));
    expect(page.html).toContain("<h2>Changes in #5</h2>");
    expect(page.html).toContain(" · compared with its parent #4");
    expect(page.html).not.toContain("(not its parent)");
    expect(filesPanel(page.html)).toContain(
      "Comparing #5 with its parent #4. To compare other revisions, use Compare… in History.",
    );
    expect(bar(page.html)).toContain("changes from #4");
    // #5 is uploading: its own part isn't public yet.
    expect(page.html).toContain(
      "These changes are readable here only; public links see nothing yet, so #5's part isn't public yet.",
    );
  });
});

describe("NAV-10 History compare mode", () => {
  it("pre-ticks the parent and the revision, or the Changes page's base and head", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const changes = await get(changesOf(revs, 7, `?base=${pub[1]}&panel=history`));
    const open = compareOpen(changes.html) ?? "";
    expect(open).toContain(`base=${pub[1]}`);
    expect(open).toContain(`r=${pub[1]}&r=${pub[6]}`);
    expect(open).toContain("panel=history&compare=1");
    const doc = await get(`/c/${col}/r/${pub[4]}/index.md`);
    expect(compareOpen(doc.html)).toBe(`?panel=history&compare=1&r=${pub[3]}&r=${pub[4]}`);
    // NAV-04 deleted the revision menu: History's is the only Compare….
    expect(menuOpen(doc.html)).toBeUndefined();
  });

  it("gives History's Compare… on Changes the range's pre-ticks (the menu's are gone)", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    // A range keeps its base and pre-ticks base then head.
    const range = await get(changesOf(revs, 7, `?base=${pub[1]}`));
    expect(menuOpen(range.html)).toBeUndefined();
    expect(compareOpen(range.html)).toBe(
      `?base=${pub[1]}&panel=history&compare=1&r=${pub[1]}&r=${pub[6]}`,
    );
    // The 404 and 400 pages drop the bad or same base and pre-tick the parent and the head.
    const missing = await publicIdFor(mintRevisionId({ now: Date.now() + 99_999 }));
    for (const base of [missing, pub[6]]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      const page = await get(changesOf(revs, 7, `?base=${base}`));
      expect(menuOpen(page.html)).toBeUndefined();
      expect(compareOpen(page.html)).toBe(`?panel=history&compare=1&r=${pub[4]}&r=${pub[6]}`);
    }
  });

  it("renders the mode from the URL: a GET form, ticks, inert links, footer", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const path = `/c/${col}/r/${pub[4]}/index.md`;
    const page = await get(`${path}?panel=history&compare=1&r=${pub[3]}&r=${pub[4]}`);
    const history = historyPanel(page.html);
    expect(history).toContain(
      `<form class="hist" method="get" action="/c/${col}/compare" data-compare-form="true"><input type="hidden" name="from" value="${path}"/>`,
    );
    expect(history).toMatch(
      /<input type="checkbox" id="cmp-on" class="cmp-on" hidden="" data-compare-on="true" checked=""/,
    );
    expect(history).toContain('<legend class="cmpleg">Tick two revisions to compare</legend>');
    expect(history).toContain('<span class="hl-on">Tick two revisions</span>');
    expect(history).toMatch(
      /<a class="btn sm" href="\?panel=history" data-compare-cancel="true">Cancel<\/a>/,
    );
    const boxes = [
      ...history.matchAll(
        /<input type="checkbox" name="r" value="([^"]+)" aria-labelledby="([^"]+)"( checked="")?\/>/g,
      ),
    ];
    expect(boxes.map(([, value]) => value)).toEqual([6, 5, 4, 3, 2, 1, 0].map((i) => pub[i]));
    for (const [, value, labelled] of boxes) expect(labelled).toBe(`rv-${value} rvm-${value}`);
    expect(boxes.filter(([, , , checked]) => checked).map(([, value]) => value)).toEqual([
      pub[4],
      pub[3],
    ]);
    const links = [...history.matchAll(/<a class="rvl"[^>]*>/g)].map(([tag]) => tag);
    expect(links).toHaveLength(7);
    for (const link of links) expect(link).toContain('inert=""');
    expect(history).toContain(
      '<p class="cmpscope" role="status" data-compare-status="true">#4 → #5 · 1 step on the latest line.</p>',
    );
    expect(history).toContain(
      '<button class="btn primary cmpgo" data-compare-go="true">Compare #4 → #5</button>',
    );
    // Retry and Drop stay type="button" inside the form.
    expect(history).not.toMatch(/<button class="btn sm( danger)?" data-action/);
    const again = await get(`${path}?panel=history&compare=1&err=pick2&r=${pub[3]}&r=${pub[4]}`);
    expect(historyPanel(again.html)).toContain(
      '<p class="cmpscope" role="status" data-compare-status="true">Pick two revisions.</p>',
    );
    // A range with a skipped branch: in-range tint and the branch row's note.
    const range = historyPanel(
      (await get(`${path}?panel=history&compare=1&r=${pub[1]}&r=${pub[6]}`)).html,
    );
    expect(range).toContain(
      "#2 → #7 · 4 steps on the latest line. #6 is a branch off #4, so it isn't included.",
    );
    expect(range).toContain(
      '<span class="cmpnote" data-cmp-note="true">Not included: a branch</span>',
    );
    expect(range.match(/<li class="rv[^"]* inr"/g)).toHaveLength(3);
    // Outside the mode nothing is ticked or inert, and the notes are empty and hidden.
    const off = historyPanel((await get(`${path}?panel=history`)).html);
    expect(off).not.toContain('checked=""');
    expect(off).not.toContain("inert");
    expect(off).toContain('<span class="cmpnote" data-cmp-note="true" hidden=""></span>');
  });

  it("renders ticks below History's first page, and Show all keeps the mode", async () => {
    // #1..#54 linear: the first page (50) runs #54..#5.
    const one = await post("/api/collections", {
      title: "Long",
      files: [await upload("index.md", "# 1")],
    });
    const revs = [one];
    for (let n = 2; n <= 54; n += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
      const files = [await upload("index.md", `# ${n}`)];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
      const next = await post(`/api/collections/${one.collection_id}/revisions`, {
        message: `Message ${n}`,
        parent_revision_id: nth(revs, n - 1).revision_id,
        files,
      });
      revs.push(next);
    }
    const pub = revs.map(pubOf);
    const col = colOf(one);
    const boxesOf = (html: string) =>
      [
        ...historyPanel(html).matchAll(
          /<input type="checkbox" name="r" value="([^"]+)" aria-labelledby="[^"]+"( checked="")?\/>/g,
        ),
      ].map(([, value, checked]) => ({ value, checked: Boolean(checked) }));
    const showAll = (html: string) =>
      /<p class="legend"><a href="([^"]*)">Show all 54<\/a><\/p>/.exec(historyPanel(html))?.[1];
    const path = `/c/${col}/r/${pub[2]}/index.md`;
    // Outside the mode: NAV-05b's first page and its plain Show all.
    const off = await get(`${path}?panel=history`);
    expect(boxesOf(off.html)).toHaveLength(50);
    expect(showAll(off.html)).toBe("?panel=history&history=all");
    // The client's lineage gets what lies below the page: here only #5's parent, #4.
    const belowOf = (html: string) =>
      /<fieldset class="cmpset"(?: data-below="([^"]*)")?>/.exec(historyPanel(html))?.[1];
    expect(belowOf(off.html)).toMatch(new RegExp(`^${pub[3]}::4:[a-z]+$`));
    const open = compareOpen(off.html) ?? "";
    expect(open).toBe(`?panel=history&compare=1&r=${pub[1]}&r=${pub[2]}`);
    // In the mode the page runs down to the oldest tick, so both picks are checked boxes.
    const on = await get(`${path}${open}`);
    const boxes = boxesOf(on.html);
    expect(boxes.map((box) => box.value)).toEqual(pub.slice(1).toReversed());
    expect(boxes.filter((box) => box.checked).map((box) => box.value)).toEqual([pub[2], pub[1]]);
    expect(historyPanel(on.html)).toContain("#2 → #3 · 1 step on the latest line.");
    expect(historyPanel(on.html)).toContain("Compare #2 → #3");
    // Show all keeps compare mode and its ticks (without script it is the only way down).
    const all = showAll(on.html) ?? "";
    expect(all).toBe(`?panel=history&history=all&compare=1&r=${pub[1]}&r=${pub[2]}`);
    const everything = await get(`${path}${all}`);
    const allBoxes = boxesOf(everything.html);
    expect(allBoxes).toHaveLength(54);
    expect(belowOf(everything.html)).toBeUndefined();
    expect(allBoxes.filter((box) => box.checked).map((box) => box.value)).toEqual([pub[2], pub[1]]);
    expect(showAll(everything.html)).toBeUndefined();
    // The no-script err=pick2 return renders its ticks too.
    const back = await get(`${path}?panel=history&compare=1&err=pick2&r=${pub[0]}`);
    expect(
      boxesOf(back.html)
        .filter((box) => box.checked)
        .map((box) => box.value),
    ).toEqual([pub[0]]);
  });

  it("drops the old picker and hides Compare… for a single revision", async () => {
    const revs = await seedFork();
    const pages = [
      `/c/${colOf(nth(revs, 1))}/`,
      changesOf(revs, 7),
      changesOf(revs, 7, `?base=${pubOf(nth(revs, 2))}`),
    ];
    for (const path of pages) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      const { html } = await get(path);
      expect(html).not.toContain('id="compare"');
      expect(html).not.toContain('commandfor="compare"');
      expect(html).toContain("data-compare-open");
    }
    const single = await post("/api/collections", {
      title: "Single",
      files: [await upload("index.md", "# Only")],
    });
    expect((await get(`/c/${colOf(single)}/`)).html).not.toContain("data-compare-open");
  });
});

describe("NAV-10 /c/<pub>/compare", () => {
  it("orders two picks into the canonical Changes URL", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const from = `/c/${col}/r/${pub[4]}/index.md`;
    const compare = async (query: string) => {
      const response = await app.request(`/c/${col}/compare?from=${from}${query}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.headers.get("location");
    };
    expect(await compare(`&r=${pub[6]}&r=${pub[1]}`)).toBe(
      `/c/${col}/r/${pub[6]}/changes?base=${pub[1]}`,
    );
    expect(await compare(`&r=${pub[3]}&r=${pub[4]}`)).toBe(`/c/${col}/r/${pub[4]}/changes`);
    expect(await compare(`&r=${pub[4]}&r=${pub[5]}`)).toBe(
      `/c/${col}/r/${pub[5]}/changes?base=${pub[4]}`,
    );
    expect(await compare(`&r=${pub[6]?.toUpperCase()}&r=${pub[1]}&r=${pub[1]}`)).toBe(
      `/c/${col}/r/${pub[6]}/changes?base=${pub[1]}`,
    );
    expect(await compare(`&r=${pub[4]}`)).toBe(
      `${from}?panel=history&compare=1&err=pick2&r=${pub[4]}`,
    );
    expect(await compare(`&r=${pub[1]}&r=${pub[4]}&r=${pub[6]}`)).toBe(
      `${from}?panel=history&compare=1&err=pick2&r=${pub[1]}&r=${pub[4]}&r=${pub[6]}`,
    );
    expect(await compare(`&r=nothere&r=${pub[4]}`)).toBe(
      `${from}?panel=history&compare=1&err=pick2&r=${pub[4]}`,
    );
  });

  it("only goes back inside the collection, and never puts a control character in Location", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const col = colOf(nth(revs, 1));
    const home = `/c/${col}/`;
    const back = async (from: string) => {
      const response = await app.request(
        `/c/${col}/compare?from=${encodeURIComponent(from)}&r=${pub[4]}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("x-injected")).toBeNull();
      return (response.headers.get("location") ?? "").split("?")[0];
    };
    for (const from of [
      "https://evil.example/",
      "/c/other/",
      `/c/${col}//evil.example`,
      `/c/${col}/../../x`,
      `/c/${col}/%2e%2e/x`,
      `/c/${col}/a?b`,
      `/c/${col}/a\\b`,
      `/c/${col}/\r\nX-Injected:1`,
      `/c/${col}/\nX-Injected:1`,
    ])
      // oxlint-disable-next-line eslint/no-await-in-loop -- One request at a time.
      expect({ from, back: await back(from) }).toEqual({ from, back: home });
    // Already-encoded CR/LF, as a browser would send it.
    const raw = await app.request(
      `/c/${col}/compare?from=/c/${col}/%0d%0aX-Injected:1&r=${pub[4]}`,
    );
    expect(raw.headers.get("x-injected")).toBeNull();
    expect(raw.headers.get("location")?.startsWith(`${home}?`)).toBe(true);
    expect(await back(`/c/${col}/r/${pub[4]}/notes/a%20b.md`)).toBe(
      `/c/${col}/r/${pub[4]}/notes/a%20b.md`,
    );
  });

  it("treats a missing or trashed collection, and a path without from, as the collection's", async () => {
    const revs = await seedFork();
    const col = colOf(nth(revs, 1));
    expect((await app.request("/c/zzzzzzzzzzzz/compare?from=/c/zzzzzzzzzzzz/")).status).toBe(404);
    // A root file named "compare" still opens without `from`.
    const named = await post("/api/collections", {
      title: "Named compare",
      files: [await upload("compare", "plain text"), await upload("index.md", "# Head")],
      head_path: "index.md",
    });
    const file = await app.request(`/c/${colOf(named)}/compare`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain('data-path="compare"');
    await app.request(`/api/collections/${nth(revs, 1).collection_id}`, { method: "DELETE" });
    const trashed = await app.request(`/c/${col}/compare?from=/c/${col}/&r=x`);
    expect(trashed.status).toBe(302);
    expect(trashed.headers.get("location")).toBe(`/c/${col}/`);
  });
});

describe("NAV-10 range segment with synced revisions", () => {
  it(
    "says which part isn't public yet when public links see an older revision",
    { timeout: 30_000 },
    async () => {
      // A committer with a cloud that accepts every push, as the demo writer runs: #1..#5 sync,
      // then it stops so #6 (failed) and #7 (uploading) stay queued.
      const cloud: SyncClient = {
        lastPullAt: Date.now(),
        verified: true,
        pull: () => Promise.resolve(false),
        push: () => Promise.resolve(),
        checkpoint: () => Promise.resolve(),
      };
      const ingest = new IngestService(waypoint, queue, services.blobs, services.reads, cloud);
      const syncLoop = new SyncLoop(queue, cloud, Date.now, waypoint);
      const committer = new WriterCommitter(
        waypoint,
        queue,
        services.blobs,
        new MemoryBucket(),
        syncLoop,
        ingest,
      );
      ingest.committer = committer;
      app = createApp({ ...services, ingest, committer, syncLoop, environment: "dev" });
      syncLoop.start();
      try {
        const revs = await seedFork(async (linear) => {
          for (let i = 0; i < 200; i++) {
            committer.wake();
            // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
            await new Promise((resolve) => setTimeout(resolve, 25));
            // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
            const rows = await services.reads.revisions(nth(linear, 1).collection_id);
            if (rows.length === 5 && rows.every((row) => row.sync_state === "synced")) break;
          }
          committer.stop();
        });
        const pub = revs.map(pubOf);
        const page = await get(changesOf(revs, 7, `?base=${pub[1]}`));
        expect(page.html).toContain(
          "These changes are readable here only; public links see #5, so #7's part isn't public yet.",
        );
      } finally {
        committer.stop();
        syncLoop.stop();
      }
    },
  );
});
