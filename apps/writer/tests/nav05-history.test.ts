import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintRevisionId, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { endOfBranch, FIRST_REVISION, LATEST_REVISION } from "../src/viewer/lineage.ts";

// NAV-05b: History is an <ol> in display order, a log on one spine (Logbook); [ and ] follow
// parents.
// Setup as in viewer.test.ts: an in-process app, sync off, no committer.

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
const pathOf = (written: Written): string => new URL(written.url).pathname;
/** #n of a seeded list (index n - 1). */
function nth(revs: readonly Written[], n: number): Written {
  const rev = revs[n - 1];
  if (!rev) throw new Error(`no #${n}`);
  return rev;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-nav05-test-"));
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

/** #1..#5 linear, #6 on #4 (failed), #7 on #5 (left uploading): the demo's shape. */
async function seedFork(): Promise<Written[]> {
  const one = await post("/api/collections", {
    title: "Lanes",
    files: [await upload("index.md", "# 1")],
  });
  const revs = [one];
  const add = async (parent: Written, n: number) =>
    post(`/api/collections/${one.collection_id}/revisions`, {
      message: `Message ${n}`,
      parent_revision_id: parent.revision_id,
      files: [await upload("index.md", `# ${n}`)],
    });
  for (const n of [2, 3, 4, 5]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
    revs.push(await add(nth(revs, n - 1), n));
  }
  const six = await add(nth(revs, 4), 6);
  await queue.run(
    "UPDATE pending_revisions SET state='failed',last_error='Upload failed',error_kind='permanent' WHERE id=?",
    [six.revision_id],
  );
  revs.push(six, await add(nth(revs, 5), 7));
  return revs;
}
/** The long history: #1..#59 linear, #60 on #5, #61 on #59. */
const longParent = (n: number): number => (n === 60 ? 5 : n === 61 ? 59 : n - 1);
/** The History tab panel's markup. */
function historyOf(html: string): string {
  const start = html.indexOf('id="tp-history"');
  expect(start).toBeGreaterThan(-1);
  // Up to the next tab panel or the end of the panel (the revision menu comes later).
  const ends = [html.indexOf('role="tabpanel"', start), html.indexOf("</aside>", start)];
  return html.slice(start, Math.min(...ends.filter((end) => end !== -1)));
}
/** Each History row's markup, top to bottom. */
const rowsOf = (history: string): string[] =>
  history
    .split('<li class="rv')
    .slice(1)
    .map((row) => row.slice(0, row.indexOf("</li>")));
/** The day rows' words, top to bottom. */
const daysOf = (history: string): string[] =>
  [
    ...history.matchAll(
      /<li class="lb-day" aria-hidden="true"><b>([^<]*)<\/b> <span>([^<]*)<\/span><\/li>/g,
    ),
  ].map(([, word, date]) => `${word} ${date}`);
/** The shell root's data-* attribute, or undefined when absent. */
function shellData(html: string, name: string): string | undefined {
  const tag = /<div class="shell" id="shell"[^>]*>/.exec(html)?.[0] ?? "";
  return new RegExp(` data-${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("NAV-05b History", () => {
  it("lists rows in display order as an <ol> with one link per row, nodes and the branch in words", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const html = await (await app.request(`${pathOf(nth(revs, 5))}?panel=history`)).text();
    const history = historyOf(html);
    expect(history).toContain('<ol class="tl lb-log" aria-labelledby="hist-h" data-days="true">');
    expect(history).toContain(
      '<h3 id="hist-h" class="hl">Latest line <span>newest first</span></h3>',
    );
    const rows = rowsOf(history);
    expect(rows.map((row) => /<b>#(\d+)<\/b>/.exec(row)?.[1])).toEqual([
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
      "1",
    ]);
    // One day row (decorative) above the first row of each day; every row names its day for AT.
    expect(daysOf(history)).toHaveLength(1);
    expect(history.indexOf('class="lb-day"')).toBeLessThan(history.indexOf('<li class="rv'));
    for (const [i, row] of rows.entries()) {
      expect(row).toMatch(/<span class="vh" data-day-words="true">Today \d+ \w+, <\/span>/);
      expect(row).toMatch(/<time [^>]*data-fmt="time"/);
      const outside = row.replace(/<span class="acts">[\s\S]*$/, "");
      const links = [...outside.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);
      expect(links).toHaveLength(1);
      expect(links[0]).toContain('class="rvl"');
      expect(links[0]).toContain(`id="rv-${pub[6 - i]}"`);
      expect(outside).toMatch(new RegExp(`<a class="rvl"[^>]*><b>#${7 - i}</b></a>`));
    }
    expect(history).not.toContain('aria-label="Revision ');
    // #6: the branch in words and its data hooks; no other row says "not in latest".
    const six = rows[1] ?? "";
    expect(six).toContain(`<span class="br" id="rvb-${pub[5]}">on #4, not in latest</span>`);
    expect(six).toContain(`id="rvb-${pub[5]}"`);
    expect(six).toContain('data-line="0"');
    expect(six).toContain(`data-parent="${pub[3]}"`);
    expect(six).toContain(`aria-describedby="rvm-${pub[5]} rvb-${pub[5]}"`);
    expect(rows.filter((row) => row.includes("not in latest"))).toHaveLength(1);
    expect(history).not.toContain('class="fork"');
    expect(rows[0]).toContain('data-line="1"');
    expect(rows[0]).toContain('data-n="7"');
    expect(rows[0]).toContain('data-state="pending"');
    expect(rows[6]).toContain('data-parent=""');
    expect(rows[2]).toContain('aria-current="true"');
    // Each row's node says its state to the eye only; the revision on screen is circled.
    expect(six).toContain('<span class="lb-n failed" aria-hidden="true"></span>');
    expect(rows[0]).toContain('<span class="lb-n pending" aria-hidden="true"></span>');
    expect(rows[2]).toContain('<span class="lb-n pending here" aria-hidden="true"></span>');
    expect(
      [...history.matchAll(/<span class="lb-n [^"]*"([^>]*)>/g)].map(([, rest]) => rest),
    ).toEqual(Array.from({ length: 7 }, () => ' aria-hidden="true"'));
    // No lanes and no lane legend.
    expect(history).not.toContain('class="lg ');
    expect(history).not.toContain("lgd");
    // #6's actions keep their names and point at the row's link.
    for (const name of ["Retry", "Drop…", "Details"])
      expect(six).toMatch(new RegExp(`aria-describedby="rv-${pub[5]}"[^>]*>\\s*${name}<`));
    // The buttons are edited in place: their action hooks survive next to aria-describedby.
    const sixId = nth(revs, 6).revision_id;
    expect(six).toContain(
      `data-action="retry" data-ids="${sixId}" aria-describedby="rv-${pub[5]}"`,
    );
    expect(six).toContain(`data-action="drop" data-id="${sixId}" aria-describedby="rv-${pub[5]}"`);
    // FD3: both name their revision (data-n) for the flash and error toasts.
    expect(six).toContain('data-n="6"');
    expect(six.match(new RegExp(`aria-describedby="rv-${pub[5]}" data-n="6"`, "g"))).toHaveLength(
      2,
    );
  });

  it("says nothing about branches for a linear collection", async () => {
    const one = await post("/api/collections", {
      title: "Linear",
      files: [await upload("index.md", "# 1")],
    });
    await post(`/api/collections/${one.collection_id}/revisions`, {
      parent_revision_id: one.revision_id,
      files: [await upload("index.md", "# 2")],
    });
    const history = historyOf(await (await app.request(`${pathOf(one)}?panel=history`)).text());
    expect(rowsOf(history)).toHaveLength(2);
    expect(history).not.toContain("not in latest");
  });

  it("steps [ and ] along parents, with the end texts from lineage.ts", async () => {
    const revs = await seedFork();
    const pub = revs.map(pubOf);
    const shell = async (n: number) => (await app.request(pathOf(nth(revs, n)))).text();
    const five = await shell(5);
    expect(shellData(five, "newer")).toBe(pub[6]);
    expect(shellData(five, "older")).toBe(pub[3]);
    expect(shellData(five, "newer-end")).toBeUndefined();
    const six = await shell(6);
    expect(shellData(six, "older")).toBe(pub[3]);
    expect(shellData(six, "newer")).toBeUndefined();
    expect(shellData(six, "newer-end")).toBe(endOfBranch(7));
    const one = await shell(1);
    expect(shellData(one, "older")).toBeUndefined();
    expect(shellData(one, "older-end")).toBe(FIRST_REVISION);
    expect(shellData(one, "newer")).toBe(pub[1]);
    const seven = await shell(7);
    expect(shellData(seven, "newer-end")).toBe(LATEST_REVISION);
    expect(shellData(seven, "older")).toBe(pub[4]);
  });

  it("pages History, saying a branch off the page in words", async () => {
    const one = await post("/api/collections", {
      title: "Long",
      files: [await upload("index.md", "# 1")],
    });
    const manifest = JSON.stringify({
      headPath: "index.md",
      files: { "index.md": { hash: "sha256:" + "0".repeat(64), mime: "text/markdown", size: 1 } },
    });
    const ids = new Map<number, string>([[1, one.revision_id]]);
    for (let n = 2; n <= 61; n++) {
      const parent = ids.get(longParent(n));
      if (!parent) throw new Error(`no parent for #${n}`);
      const id = mintRevisionId({ now: Date.now() + n * 10 + 1000, parentId: parent });
      ids.set(n, id);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inserted in display order.
      const pub = await publicIdFor(id);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inserted in display order.
      await queue.run(
        "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          pub,
          one.collection_id,
          parent,
          "index.md",
          `Revision ${n}`,
          "{}",
          manifest,
          Date.now() + n * 10 + 1000,
          n === 60 ? "failed" : "pending",
        ],
      );
    }
    const base = `/c/${/\/c\/([^/]+)\//.exec(one.url)?.[1] ?? ""}/`;
    const page = historyOf(await (await app.request(`${base}?panel=history`)).text());
    const rows = rowsOf(page);
    expect(rows).toHaveLength(50);
    expect(/<b>#(\d+)<\/b>/.exec(rows[1] ?? "")?.[1]).toBe("60");
    expect(rows[1]).toContain("on #5, not in latest");
    expect(rows.at(-1)).toContain("<b>#12</b>");
    expect(page).toContain(
      '<p class="legend"><a href="?panel=history&amp;history=all">Show all 61</a></p>',
    );
    const all = historyOf(await (await app.request(`${base}?panel=history&history=all`)).text());
    expect(rowsOf(all)).toHaveLength(61);
    expect(all).not.toContain("Show all");
  });
});
