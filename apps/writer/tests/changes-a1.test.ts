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
import { hunkSpans } from "../src/viewer/pages/changes/units.tsx";

// OW-12a: an honest Changes page (folds that say Hide when open, long runs that open, source
// hunks that expand, tallies, removed images, the stepper, spoken change descriptions).

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-changes-a1-"));
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
async function upload(path: string, content: string | Uint8Array) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
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
type Files = Record<string, string | Uint8Array>;
/** Two revisions (#1, then #2 replacing the files); returns #2's Changes URL and both pinned
 *  paths. */
async function pair(before: Files, after: Files) {
  const head = Object.keys(before)[0] ?? Object.keys(after)[0] ?? "index.md";
  const first = await write("/api/collections", {
    title: "A1",
    head_path: head,
    files: await Promise.all(Object.entries(before).map(([path, text]) => upload(path, text))),
  });
  const second = await write(`/api/collections/${first.collection_id}/revisions`, {
    message: "Second",
    mode: "replace",
    head_path: Object.keys(after)[0] ?? head,
    files: await Promise.all(Object.entries(after).map(([path, text]) => upload(path, text))),
  });
  const firstPinned = new URL(first.url ?? "").pathname;
  const secondPinned = new URL(second.url ?? "").pathname;
  return { changes: `${secondPinned}changes`, firstPinned, secondPinned, second };
}
async function page(path: string): Promise<string> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return response.text();
}
const unescape = (href: string) => href.replaceAll("&amp;", "&");
const paragraphs = (count: number, word: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => `Para ${index} ${word(index)}.`);

describe("folds", () => {
  it("carries both labels in the summary, swapped by CSS when open", async () => {
    const run = paragraphs(12, () => "steady");
    const { changes } = await pair(
      { "index.md": [...run, "Retry for 72 hours."].join("\n\n") },
      { "index.md": [...run, "Retry for 24 hours."].join("\n\n") },
    );
    const html = await page(changes);
    expect(html).toContain('<span class="when-closed">Show 11 unchanged blocks above</span>');
    expect(html).toContain('<span class="when-open">Hide 11 unchanged blocks above</span>');
  });

  it("links a run over the load limit to the open view, which shows it inline", async () => {
    const run = paragraphs(250, (index) => (index < 249 ? "ALPHAWORD" : "context"));
    const { changes } = await pair(
      { "big.md": [...run, "Retry for 72 hours."].join("\n\n") },
      { "big.md": [...run, "Retry for 24 hours."].join("\n\n") },
    );
    const html = await page(changes);
    const link =
      /<a class="fold" href="([^"]+)">Show 249 unchanged blocks above \(opens big\.md on its own\)<\/a>/.exec(
        html,
      );
    expect(link?.[1]).toMatch(/\?file=big\.md&amp;folds=open&amp;from=0$/);
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain("ALPHAWORD");
    const open = await page(unescape(link?.[1] ?? ""));
    expect(open).toMatch(/<details class="folded"><summary class="fold">/);
    expect(open).toContain("ALPHAWORD");
    expect(open).not.toContain("data-fold=");
  });

  it("loads a run within the limit lazily, and inlines it on the open view", async () => {
    const run = paragraphs(100, (index) => (index < 99 ? "BETAWORD" : "context"));
    const { changes } = await pair(
      { "mid.md": [...run, "Retry for 72 hours."].join("\n\n") },
      { "mid.md": [...run, "Retry for 24 hours."].join("\n\n") },
    );
    const html = await page(changes);
    expect(html).toMatch(/<details class="folded" data-fold="[^"]+">/);
    expect(html).not.toContain("BETAWORD");
    const open = await page(`${changes}?file=mid.md&folds=open&from=0`);
    const inline = /<details class="folded"><summary[\s\S]*?<\/details>/.exec(open)?.[0] ?? "";
    expect(inline).toContain("BETAWORD");
    expect(open).not.toContain("data-fold=");
  });
});

describe("source hunks", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  const before = `${lines.join("\n")}\n`;
  const after = `${[...lines.slice(0, 19), "line twenty", "inserted", ...lines.slice(20)].join("\n")}\n`;

  it("folds unchanged lines into details that load numbered rows", async () => {
    const { changes } = await pair({ "notes.md": before }, { "notes.md": after });
    const html = await page(`${changes}?view=source`);
    const folds = [...html.matchAll(/<details class="folded lnfold" data-fold="([^"]+)">/g)].map(
      ([, url]) => unescape(url ?? ""),
    );
    expect(folds).toHaveLength(2);
    for (const url of folds) expect(url).toMatch(/mode=lines.*from=\d+.*to=\d+.*bfrom=\d+/);
    expect(html).toContain('<span class="when-closed">Show 16 unchanged lines</span>');
    expect(html).toContain('<span class="when-open">Hide 17 unchanged lines</span>');
    // The trailing hunk: base lines 24-40 are head lines 25-41 (one line was inserted).
    const trailing = folds[1] ?? "";
    expect(trailing).toMatch(/&from=25&to=42&bfrom=24$/);
    const loaded = await app.request(trailing);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("content-type")).toContain("text/html");
    const rows = await loaded.text();
    expect(rows.match(/class="ln"/g)).toHaveLength(17);
    expect(rows).toContain(
      '<div class="ln"><span class="n">24</span><span class="n">25</span><span class="s"> </span><span>line 24</span></div>',
    );
    expect(rows).toContain('<span class="n">40</span><span class="n">41</span>');
    expect(folds[0]).toMatch(/&from=1&to=17&bfrom=1$/);
    expect((await app.request(trailing.replace("to=42", "to=43"))).status).toBe(400);
    expect((await app.request(trailing.replace(/from=25&to=42/, "from=1&to=1502"))).status).toBe(
      400,
    );
    expect((await app.request(trailing.replace("bfrom=24", "bfrom=0"))).status).toBe(400);
  });

  it("escapes loaded lines", async () => {
    const { changes } = await pair(
      { "a.txt": `<b>&\n${lines.join("\n")}\nend\n` },
      { "a.txt": `<b>&\n${lines.join("\n")}\nEND\n` },
    );
    const html = await page(changes);
    const url = unescape(/data-fold="([^"]+)"/.exec(html)?.[1] ?? "");
    expect(await (await app.request(url)).text()).toContain("<span>&lt;b&gt;&amp;</span>");
  });

  it("finds where each hunk starts on each side", () => {
    expect(
      hunkSpans([
        { op: "hunk", text: "5 unchanged lines" },
        { op: "equal", base: 6, head: 6, text: "f" },
      ]).get(0),
    ).toEqual({ base: 1, head: 1, count: 5 });
    const spans = hunkSpans([
      { op: "equal", base: 1, head: 1, text: "a" },
      { op: "insert", head: 2, text: "b" },
      { op: "hunk", text: "3 unchanged lines" },
      { op: "equal", base: 5, head: 6, text: "c" },
      { op: "delete", base: 6, text: "d" },
      { op: "hunk", text: "1 unchanged line" },
    ]);
    expect(spans.get(2)).toEqual({ base: 2, head: 3, count: 3 });
    expect(spans.get(5)).toEqual({ base: 7, head: 7, count: 1 });
    expect(spans.size).toBe(2);
  });
});

describe("view switch", () => {
  it("shows Rendered/Source only when a changed file is Markdown", async () => {
    const script = await pair({ "run.sh": "echo 1\n" }, { "run.sh": "echo 2\n" });
    const plain = await page(script.changes);
    expect(plain).toContain('<span class="muted small viewnote">Line diff</span>');
    expect(plain).not.toContain('aria-label="Diff view"');
    const markdown = await pair({ "index.md": "# A\n\nOne.\n" }, { "index.md": "# A\n\nTwo.\n" });
    const rendered = await page(markdown.changes);
    expect(rendered).toContain('aria-label="Diff view"');
    expect(rendered).not.toContain("Line diff");
  });
});

describe("tallies and removed files", () => {
  it("shows sizes on image and binary rows, and frames a removed image", async () => {
    const { changes, firstPinned, secondPinned } = await pair(
      {
        "index.md": "# Shots\n",
        "a.png": new Uint8Array(3000).fill(1),
        "c.bin": new Uint8Array([1, 2]),
        "c.png": new Uint8Array([9, 9, 9]),
        "old.txt": "x\n",
      },
      {
        "index.md": "# Shots\n",
        "a.png": new Uint8Array(2900).fill(2),
        "b.png": new Uint8Array([5, 5, 5, 5]),
      },
    );
    const html = await page(changes);
    const tree: Record<string, string | undefined> = {};
    for (const [, name, size] of html.matchAll(
      /<span class="nm">([^<]+)<\/span>(?:<span class="sz">([^<]*)<\/span>)?<\/a>/g,
    ))
      tree[name ?? ""] = size;
    expect(tree).toEqual({
      "a.png": "2.9 → 2.8 KB",
      "b.png": "new",
      "c.bin": "was 2 B",
      "c.png": "was 3 B",
      "old.txt": undefined,
    });
    // The a.png card's header shows the same tally.
    expect(html).toMatch(
      /data-file-diff="a\.png">[\s\S]*?<span class="tally">2\.9 → 2\.8 KB<\/span>[\s\S]*?<\/header>/,
    );
    const basePub = firstPinned.split("/")[4] ?? "";
    const removed =
      /<figure class="rmimg" data-dims="true">[\s\S]*?<\/figure>/.exec(html)?.[0] ?? "";
    expect(removed).toContain(`<img src="/raw/r/${basePub}/c.png"`);
    expect(removed).toContain(
      `<figcaption>Removed in #2<span data-dim-wrap="true" hidden=""> · <span data-dim="true"></span></span> · 3 B · <a href="${firstPinned}c.png">Open in #1</a></figcaption>`,
    );
    expect(html).toContain("Removed (was 2 B).");
    // Image pairs: dimensions fill in after load.
    expect(html).toContain(
      'Before · #1<span data-dim-wrap="true" hidden=""> · <span data-dim="true"></span></span> · 2.9 KB',
    );
    expect(html).toContain(`<img src="/raw/r/${secondPinned.split("/")[4] ?? ""}/a.png"`);
  });

  it("counts text changes in words on the card and compactly in the tree", async () => {
    const changed = await pair(
      { "index.md": "# A\n\nRetry for 72 hours.\n" },
      { "index.md": "# A\n\nRetry for 24 hours.\n" },
    );
    const one = await page(changed.changes);
    expect(one).toContain('<span class="tally">Blocks: <span class="m">1 changed</span></span>');
    expect(one).toContain('<span class="sz">~1 blocks</span>');
    const both = await pair(
      { "index.md": "# A\n\nRetry for 72 hours.\n" },
      { "index.md": "# A\n\nRetry for 24 hours.\n\nNew block.\n" },
    );
    expect(await page(both.changes)).toContain(
      '<span class="tally">Blocks: <span class="m">1 changed</span> · <span class="a">1 added</span></span>',
    );
    const lines = await page(`${both.changes}?view=source`);
    expect(lines).toContain(
      '<span class="tally">Lines: <span class="a">3 added</span> · <span class="rm">1 removed</span></span>',
    );
  });
});

describe("stepper and spoken marks", () => {
  it("renders one hidden stepper with a polite output", async () => {
    const { changes } = await pair(
      {
        "index.md":
          "# Plan\n\nRetry for 72 hours.\n\n```sh\npg_upgrade --check\npg_upgrade --jobs 4\n```\n\nEnd.\n",
        "notes.txt": "a\nb\n",
      },
      {
        "index.md":
          "# Plan\n\nRetry for 24 hours.\n\n```sh\npg_upgrade --check\npg_upgrade --jobs 8\n```\n\nEnd.\n",
        "notes.txt": "a\nb\nc\n",
      },
    );
    const html = await page(changes);
    expect(html.match(/data-stepper/g)).toHaveLength(1);
    expect(html.includes('<div class="stepper" data-stepper="true" hidden="">')).toBe(true);
    expect(html.match(/<output[^>]*>/g)).toEqual([
      '<output class="stepcount" data-step-count="true" aria-live="polite">',
    ]);
    expect(html).toMatch(
      /<button type="button" class="btn sm" data-step="-1" aria-keyshortcuts="k">/,
    );
    expect(html).toMatch(
      /<button type="button" class="btn sm" data-step="1" aria-keyshortcuts="j">/,
    );
    // Marks: the glyph hidden, the word for screen readers; no labels on generic spans.
    expect(html).not.toContain('class="mk" aria-label=');
    expect(html).toContain(
      '<span class="mk"><span aria-hidden="true">~</span><span class="vh">changed</span></span>',
    );
    expect(html).toContain(
      '<span class="k m"><span aria-hidden="true">~</span><span class="vh">changed</span></span>',
    );
    expect(html).toContain('data-change="code, 1 line changed"');
    expect(html).toContain('data-change="paragraph changed"');
    expect(html).toContain('data-change="line added"');
    // Line rows' signs follow the same pattern; unchanged rows keep a blank sign.
    expect(html).not.toContain('class="s" aria-label=');
    expect(html).toContain(
      '<span class="s"><span aria-hidden="true">+</span><span class="vh">added</span></span>',
    );
    expect(html).toContain('<span class="s"> </span>');
    // Code lines keep their gutter signs, out of the copied text.
    expect(html).toContain('<span class="lnadd"><span class="sg" aria-hidden="true">+</span>');
    expect(html).toContain('<span class="lndel"><span class="sg" aria-hidden="true">−</span>');
    // The legend of marks sits above the Files panel's legend.
    expect(html).toContain(
      '<p class="legend"><span class="diffkey"><span class="k a"><span aria-hidden="true">+</span></span> added · <span class="k m"><span aria-hidden="true">~</span></span> changed · <span class="k rm"><span aria-hidden="true">−</span></span> removed</span></p><p class="legend">',
    );
  });
});
