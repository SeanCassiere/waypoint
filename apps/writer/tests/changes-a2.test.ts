import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// OW-12b: rendered table diffs, the fold's context table, GFM callouts and relative links that
// resolve into the head revision on the Changes page.

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-changes-a2-"));
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

const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return { path, hash };
}
async function write(path: string, body: unknown): Promise<Record<string, string>> {
  const response = await app.request(path, json(body));
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("bad write");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
/** Two revisions of one file; returns #2's Changes URL and its pinned path `/c/<c>/r/<r>/`. */
async function pair(path: string, before: string, after: string) {
  const first = await write("/api/collections", {
    title: "A2",
    head_path: path,
    files: [await upload(path, before)],
  });
  const second = await write(`/api/collections/${first.collection_id}/revisions`, {
    message: "Second",
    mode: "replace",
    files: [await upload(path, after)],
  });
  const pinned = new URL(second.url ?? "").pathname;
  return { changes: `${pinned}changes`, pinned };
}
async function page(path: string): Promise<string> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return response.text();
}
/** The first `div.blk` holding a `table.dt`, up to the end of its table wrapper. */
const tableBlock = (html: string) =>
  /<div class="blk [^"]*"[^>]*>(?:(?!<div class="blk )[\s\S])*?<\/table><\/div>/.exec(html)?.[0] ??
  "";
const unescape = (href: string) => href.replaceAll("&amp;", "&");
const steady = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `Steady paragraph ${from + index}.`);
const rollback = (rows: string[]) =>
  `# Rollback\n\n| Failure point | Action | Expected downtime |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
/** A ten-row table whose fifth row reads `changed`. */
const tenRows = (changed: string) =>
  `# Ten\n\n| N | Value |\n| - | - |\n${Array.from({ length: 10 }, (_, index) =>
    index === 4 ? `| 5 | ${changed} |` : `| ${index + 1} | value ${index + 1} |`,
  ).join("\n")}\n`;
/** Blank-line separated tables are consecutive table blocks: one unit, two tables. */
const twoTables = (value: string) =>
  `# Two\n\n| A |\n| - |\n| ${value} apples |\n\n| B |\n| - |\n| 2 |\n`;
/** A relative link in a folded block and in the changed last block. */
const linkDoc = (hours: string) =>
  [
    "# Docs",
    "Read [next](b.md) first.",
    ...steady(1, 4),
    `Then [next](b.md), retry for ${hours} hours.`,
  ].join("\n\n");
/** A relative link to `<target>.md` in a paragraph and in a table cell. */
const linkTable = (target: string) =>
  `# Docs\n\nThen [next](${target}.md) for details.\n\n| Step | See |\n| --- | --- |\n| one | [next](${target}.md) |\n`;
/** The HTML of a Changes page's first lazy fold. */
async function firstFold(changes: string): Promise<string> {
  return page(unescape(/data-fold="([^"]+)"/.exec(await page(changes))?.[1] ?? ""));
}

describe("rendered table diffs", () => {
  it("renders a changed table as a table with a gutter, row classes and a caption", async () => {
    const { changes } = await pair(
      "runbook.md",
      rollback([
        "| `--check` fails | Abort; nothing changed | 0 min |",
        "| Upgrade fails before start | Restore from backup | ~1 h |",
      ]),
      rollback([
        "| `--check` fails | Abort; nothing changed | 0 min |",
        "| Upgrade fails before start | Restore 15.8 data dir from snapshot | 25 min |",
        "| Errors after resume | Promote the logical replica | 4 min |",
      ]),
    );
    const html = await page(changes);
    const block = tableBlock(html);
    expect(block).toMatch(
      /^<div class="blk mod" data-change="table, 1 row changed, 1 added" tabindex="-1">/,
    );
    expect(block).toContain('<div class="tx rd"><div class="dtwrap"><table class="dt">');
    expect(block).toContain('<caption class="srcnote">Table · 1 row changed, 1 added</caption>');
    expect(block).toContain('<th class="g"><span class="vh">Change</span></th>');
    expect(block.match(/<tr class="r-mod">/g)).toHaveLength(1);
    expect(block.match(/<tr class="r-add">/g)).toHaveLength(1);
    expect(block.match(/<tr class="r-ctx">/g)).toHaveLength(1);
    const changed = /<tr class="r-mod">[\s\S]*?<\/tr>/.exec(block)?.[0] ?? "";
    expect(changed).toContain("<del>");
    expect(changed).toContain("<ins>");
    // Inline Markdown in cells, and no pipe source.
    expect(block).toContain("<code>--check</code>");
    expect(block).not.toContain("| ");
  });

  it("keeps one context row either side and folds the rest into gap rows", async () => {
    const { changes } = await pair("ten.md", tenRows("old"), tenRows("new"));
    const block = tableBlock(await page(changes));
    expect(block.match(/<tr class="r-[a-z]+">/g)).toEqual([
      '<tr class="r-gap">',
      '<tr class="r-ctx">',
      '<tr class="r-mod">',
      '<tr class="r-ctx">',
      '<tr class="r-gap">',
    ]);
    expect(block).toMatch(/<tr class="r-ctx">[\s\S]*?value 4[\s\S]*?<tr class="r-mod">/);
    expect(block).toMatch(/<tr class="r-mod">[\s\S]*?<tr class="r-ctx">[\s\S]*?value 6/);
    expect(block).toContain('<td colspan="2">⋯ 3 unchanged rows</td>');
    expect(block).toContain('<td colspan="2">⋯ 4 unchanged rows</td>');
    expect(block).not.toContain("value 1<");
    expect(block).not.toContain("value 10<");
  });

  it("gives a wholly added table the add bar and + gutters", async () => {
    const { changes } = await pair(
      "added.md",
      "# Added\n\nIntro.\n",
      "# Added\n\nIntro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toMatch(/^<div class="blk add" data-change="table, 2 added" tabindex="-1">/);
    expect(block).toContain('<caption class="srcnote">Table · 2 added</caption>');
    expect(block).toContain('<span class="mk"><span aria-hidden="true">+</span>');
    expect(
      block.match(/<tr class="r-add"><td class="g"><span aria-hidden="true">\+<\/span>/g),
    ).toHaveLength(2);
    expect(block).not.toContain("r-mod");
  });

  it("says what changed when only the column alignment did", async () => {
    const { changes } = await pair(
      "align.md",
      "# Align\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
      "# Align\n\n| A | B |\n| :- | -: |\n| 1 | 2 |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toMatch(
      /^<div class="blk mod" data-change="table, 1 row changed" tabindex="-1">/,
    );
    expect(block).toContain('<caption class="srcnote">Table · 1 row changed</caption>');
  });

  it("shows a context row under a changed header", async () => {
    const { changes } = await pair(
      "header.md",
      "# Header\n\n| Old | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n",
      "# Header\n\n| New | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain('<th><span class="dc"><del>Old</del><ins>New</ins></span></th>');
    expect(block.match(/<tr class="r-[a-z]+">/g)).toEqual([
      '<tr class="r-ctx">',
      '<tr class="r-gap">',
    ]);
    expect(block).toContain('<td><span class="dc">1</span></td>');
    expect(block).toContain("⋯ 2 unchanged rows");
  });

  it("marks a cell whose formatting alone changed", async () => {
    const { changes } = await pair(
      "format.md",
      "# Format\n\n| A | B |\n| - | - |\n| **one** | `two` |\n",
      "# Format\n\n| A | B |\n| - | - |\n| one | two |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain(
      '<td><span class="dc"><strong><del>one</del></strong><ins>one</ins></span></td>',
    );
    expect(block).toContain(
      '<td><span class="dc"><code><del>two</del></code><ins>two</ins></span></td>',
    );
  });

  it("diffs a cell whole when a change beside a delimiter decides its formatting", async () => {
    const { changes } = await pair(
      "spaced.md",
      "# Spaced\n\n| A | B |\n| - | - |\n| x | Wait *2* min |\n| y | ~~deprecated~~ flag |\n",
      "# Spaced\n\n| A | B |\n| - | - |\n| x | Wait * 2 * min |\n| y | ~~ deprecated ~~ flag |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain(
      '<td><span class="dc"><del>Wait </del><em><del>2</del></em><del> min</del><ins>Wait * 2 * min</ins></span></td>',
    );
    expect(block).toContain(
      '<td><span class="dc"><del><del>deprecated</del></del><del> flag</del><ins>~~ deprecated ~~ flag</ins></span></td>',
    );
  });

  it("keeps a changed character reference whole and shows the source when syntax would pair across sides", async () => {
    const { changes } = await pair(
      "refs.md",
      "# Refs\n\n| A | B |\n| - | - |\n| a &amp; b | `one |\n",
      "# Refs\n\n| A | B |\n| - | - |\n| a &lt; b | x |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain(
      '<td><span class="dc"><del>a &#x26; b</del><ins>a &#x3C; b</ins></span></td>',
    );
    const crossed = await pair(
      "crossed.md",
      "# Crossed\n\n| A |\n| - |\n| `one |\n",
      "# Crossed\n\n| A |\n| - |\n| `one` |\n",
    );
    const html = await page(crossed.changes);
    expect(html).not.toContain('class="dtwrap"');
    expect(html).toContain(
      '<div class="tx dtsrc"><span class="srcnote">Table · 1 row changed</span>',
    );
  });

  it("keeps a code span's edge spaces, an image's marks and edge emphasis faithful", async () => {
    const { changes } = await pair(
      "edges.md",
      "# Edges\n\n| A | B |\n| - | - |\n| ` a` | ![old](a.png) same |\n",
      "# Edges\n\n| A | B |\n| - | - |\n| ` b ` | ![new](a.png) same |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain(
      '<td><span class="dc"><code><del> a</del></code><code><ins>b</ins></code></span></td>',
    );
    expect(block).toContain(
      '<td><span class="dc"><del>[image: old]</del><del> same</del><ins>[image: new]</ins><ins> same</ins></span></td>',
    );
    const bold = await pair(
      "bold.md",
      "# Bold\n\n| A | B |\n| - | - |\n| a | flag for the run |\n",
      "# Bold\n\n| A | B |\n| - | - |\n| **Required.** | flag for the run |\n",
    );
    const html = await page(bold.changes);
    expect(html).not.toContain('class="dtwrap"');
    expect(html).toContain(
      '<div class="tx dtsrc"><span class="srcnote">Table · 1 row changed</span>',
    );
  });

  it("shows the source rows when a unit isn't one table", async () => {
    const { changes } = await pair("two.md", twoTables("3"), twoTables("4"));
    const html = await page(changes);
    expect(html).not.toContain('class="dtwrap"');
    expect(html).toContain(
      '<div class="blk mod" data-change="table, 1 row changed" tabindex="-1"><span class="mk">',
    );
    expect(html).toContain(
      '<div class="tx dtsrc"><span class="srcnote">Table · 1 row changed</span><span class="row0">| A |</span><span class="row0">| - |</span><span class="lndel">| 3 apples |</span><span class="lnadd">| 4 apples |</span><span class="row0">| B |</span>',
    );
  });

  it("counts a dash-only body row as a row", async () => {
    const { changes } = await pair(
      "dash.md",
      "# Dash\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
      "# Dash\n\n| A | B |\n| - | - |\n| - | - |\n| 1 | 3 |\n",
    );
    const html = await page(changes);
    expect(html).toContain(
      '<div class="blk mod" data-change="table, 1 row changed, 1 added" tabindex="-1">',
    );
    expect(html).toContain('<span class="srcnote">Table · 1 row changed, 1 added</span>');
  });

  it("shows an unchanged table opened in a fold as a plain table", async () => {
    const table = "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
    const { changes } = await pair(
      "fold.md",
      ["# Fold", ...steady(1, 3), table, ...steady(4, 3), "Retry for 72 hours."].join("\n\n"),
      ["# Fold", ...steady(1, 3), table, ...steady(4, 3), "Retry for 24 hours."].join("\n\n"),
    );
    const html = await page(changes);
    const url = unescape(/data-fold="([^"]+)"/.exec(html)?.[1] ?? "");
    expect(url).toContain("format=html");
    const fold = await page(url);
    expect(fold).toContain('<div class="blk ctx"><span class="mk" aria-hidden="true"></span>');
    expect(fold).toContain('<div class="tx rd"><div class="dtwrap"><table class="dt">');
    expect(fold).not.toContain('class="g"');
    expect(fold).not.toContain("<caption");
    expect(fold).not.toContain("ctxnote");
    expect(fold).not.toContain("data-change");
    expect(fold.match(/<span class="dc">/g)).toHaveLength(6);
  });
});

describe("callouts and relative links", () => {
  it("renders a GFM alert as a callout", async () => {
    const { changes } = await pair("alert.md", "# Alert\n", "# Alert\n\n> [!WARNING]\n> x\n");
    const html = await page(changes);
    expect(html).toContain('<div class="markdown-alert markdown-alert-warning">');
    expect(html).toContain('<p class="markdown-alert-title">Warning</p>');
    expect(html).not.toContain("[!WARNING]");
  });

  it("resolves relative links to the head revision, on the page and in folds", async () => {
    const { changes, pinned } = await pair("docs/a.md", linkDoc("72"), linkDoc("24"));
    const href = `href="${pinned}docs/b.md"`;
    expect(pinned).toMatch(/^\/c\/[^/]+\/r\/[^/]+\/$/);
    expect(await page(changes)).toContain(`<a ${href}>next</a>, retry for`);
    expect(await firstFold(changes)).toContain(`Read <a ${href}>next</a> first.`);
  });

  it("points a changed link at the head side's destination, in text and in table cells", async () => {
    const { changes, pinned } = await pair("docs/a.md", linkTable("alpha"), linkTable("beta"));
    const html = await page(changes);
    expect(html).toContain(`<a href="${pinned}docs/beta.md">next</a> for details.`);
    // A cell with a link is diffed whole, so the changed destination shows as a change.
    expect(tableBlock(html)).toContain(
      `<a href="${pinned}docs/alpha.md"><del>next</del></a><a href="${pinned}docs/beta.md"><ins>next</ins></a>`,
    );
    expect(html).not.toMatch(/%EE%80/i);
  });

  it("links a changed bare URL in a table cell to each side's own destination", async () => {
    const { changes } = await pair(
      "urls.md",
      "# Urls\n\n| Service | Endpoint |\n| --- | --- |\n| Primary service endpoint | https://old.example |\n",
      "# Urls\n\n| Service | Endpoint |\n| --- | --- |\n| Primary service endpoint | www.new.example |\n",
    );
    const block = tableBlock(await page(changes));
    expect(block).toContain(
      '<td><span class="dc"><a href="https://old.example" target="_blank" rel="noopener noreferrer"><del>https://old.example</del></a><ins>www.new.example</ins></span></td>',
    );
    // No link mixes the two sides, and the link terminator never shows.
    expect(block).not.toMatch(/href="[^"]*old[^"]*new|<!--|&#x3C;!/);
  });

  it("caches folds per revision, so identical content links into its own revision", async () => {
    const one = await pair("a.md", linkDoc("72"), linkDoc("24"));
    const two = await pair("a.md", linkDoc("72"), linkDoc("24"));
    expect(one.pinned).not.toBe(two.pinned);
    // The first fold fills the cache; the second, same content in another revision, must miss it.
    expect(await firstFold(one.changes)).toContain(`<a href="${one.pinned}b.md">next</a>`);
    expect(await firstFold(two.changes)).toContain(`<a href="${two.pinned}b.md">next</a>`);
  });
});
