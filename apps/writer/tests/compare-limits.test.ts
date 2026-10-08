// Diff limits (review pass A): pathological inputs finish in bounded time, large diffs run off
// the event loop, and the writer stays responsive while they run. These measure wall-clock
// time, so they run in the "timing" project (turbo's `test:timing`), alone after every other test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderFragments } from "@waypoint/render";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import {
  DiffCache,
  diffBlocks,
  diffBytes,
  diffFile,
  DiffWorkers,
  MAX_PAIRINGS,
  MAX_WORD_DIFF,
  splitBlocks,
  type CompareFile,
  type FileDiff,
} from "../src/compare.ts";
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

/** Deterministic pseudo-random words, so failures reproduce. */
function words(seed: number) {
  let state = seed;
  return (length: number) => {
    let out = "";
    for (let index = 0; index < length; index++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      out += "abcdefghijklmnopqrstuvwxyz0123456789"[state % 36];
    }
    return out;
  };
}
const fileOf = (mime: string, status: CompareFile["status"] = "modified"): CompareFile => ({
  path: "x",
  status,
  mime,
  base: status === "added" ? null : { hash: "sha256:a", size: 1 },
  head: { hash: "sha256:b", size: 1 },
  text: true,
});
function timed(run: () => FileDiff): { ms: number; result: FileDiff } {
  const start = performance.now();
  const result = run();
  return { ms: performance.now() - start, result };
}

// The reviewer's reproductions (diffbench.mjs, diffscale.mjs, diffadd.mjs).
const rnd = words(7);
const oneLine = Array.from({ length: 150_000 }, () => rnd(5));
const json = (items: string[]) => JSON.stringify(items);
const jsonBase = Array.from({ length: 20_000 }, () => rnd(5));
const cases: {
  name: string;
  base: string | null;
  head: string;
  mime: string;
  mode: "blocks" | "lines";
  status?: CompareFile["status"];
  truncated: false | "lines" | "blocks" | "complex";
}[] = [
  {
    // 64 s before: a 160 KB one-line JSON file.
    name: "160 KB one-line JSON",
    base: json(jsonBase),
    head: json(jsonBase.map((item, index) => (index % 2 ? item : rnd(5)))),
    mime: "application/json",
    mode: "lines",
    truncated: false,
  },
  {
    name: "~900 KB one line of words",
    base: oneLine.join(" "),
    head: oneLine.map((item, index) => (index % 2 ? item : rnd(5))).join(" "),
    mime: "text/plain",
    mode: "lines",
    truncated: false,
  },
  {
    name: "~900 KB one fenced block",
    base: "```\n" + oneLine.join(" ") + "\n```",
    head: "```\n" + oneLine.map((item, index) => (index % 2 ? item : rnd(5))).join(" ") + "\n```",
    mime: "text/markdown",
    mode: "blocks",
    truncated: false,
  },
  {
    name: "120,000 distinct lines per side",
    base: Array.from({ length: 120_000 }, (_, index) => `a${index}x`).join("\n"),
    head: Array.from({ length: 120_000 }, (_, index) => `b${index}y`).join("\n"),
    mime: "text/plain",
    mode: "lines",
    truncated: "lines",
  },
  {
    name: "400,000 short lines per side",
    base: "a\n".repeat(400_000),
    head: "b\n".repeat(400_000),
    mime: "text/plain",
    mode: "lines",
    truncated: "lines",
  },
  {
    name: "16,000 distinct lines per side",
    base: Array.from({ length: 16_000 }, (_, index) => `a${index}x`).join("\n"),
    head: Array.from({ length: 16_000 }, (_, index) => `b${index}y`).join("\n"),
    mime: "text/plain",
    mode: "lines",
    truncated: "complex",
  },
  {
    name: "4,999 similar paragraphs per side, all changed",
    base: Array.from(
      { length: 4999 },
      (_, index) => `common words here alpha beta gamma delta b${index} ${rnd(8)}`,
    ).join("\n\n"),
    head: Array.from(
      { length: 4999 },
      (_, index) => `common words here alpha beta gamma delta h${index} ${rnd(8)}`,
    ).join("\n\n"),
    mime: "text/markdown",
    mode: "blocks",
    truncated: "complex",
  },
  {
    name: "4,000-block Markdown file added",
    base: null,
    head: Array.from({ length: 4000 }, (_, index) => `line ${index}`).join("\n\n"),
    mime: "text/markdown",
    mode: "blocks",
    status: "added",
    truncated: false,
  },
  {
    name: "append to a 15,000-line log",
    base: Array.from({ length: 15_000 }, (_, index) => `line ${index}`).join("\n"),
    head:
      Array.from({ length: 15_000 }, (_, index) => `line ${index}`).join("\n") +
      "\n" +
      Array.from({ length: 2000 }, (_, index) => `new ${index}`).join("\n"),
    mime: "text/plain",
    mode: "lines",
    truncated: false,
  },
  {
    name: "1,000 long lines, each changed",
    base: Array.from({ length: 1000 }, () =>
      Array.from({ length: 150 }, () => rnd(5)).join(" "),
    ).join("\n"),
    head: Array.from({ length: 1000 }, () =>
      Array.from({ length: 150 }, () => rnd(5)).join(" "),
    ).join("\n"),
    mime: "text/plain",
    mode: "lines",
    truncated: false,
  },
];

const sized = (size: number): FileDiff =>
  diffFile(fileOf("text/plain"), "a", "b".repeat(size), "lines");
const distinct = (prefix: string, suffix = "") =>
  Array.from({ length: 16_000 }, (_, index) => `${prefix}${index}${suffix}`).join("\n");
const bracketBomb = (tail: string) =>
  Array.from(
    { length: 40 },
    (_, index) => `${"[".repeat(1200)}p${index}${"](x)".repeat(1200)} ${tail}`,
  ).join("\n\n");

describe("diff limits", () => {
  for (const item of cases)
    it(`finishes in under 2 s: ${item.name}`, () => {
      const { ms, result } = timed(() =>
        diffFile(fileOf(item.mime, item.status), item.base, item.head, item.mode),
      );
      expect(ms).toBeLessThan(2000);
      expect(result.truncated).toBe(item.truncated !== false);
      expect(result.truncated_reason).toBe(item.truncated === false ? undefined : item.truncated);
    });

  it("skips word diffs for pairs over 16 KB", () => {
    const long = "word ".repeat(MAX_WORD_DIFF / 5 + 10);
    const [op] = diffBlocks(splitBlocks(`${long}a`), splitBlocks(`${long}b`));
    expect(op?.op).toBe("replace");
    expect(op?.words).toBeUndefined();
    const [short] = diffBlocks(splitBlocks("one two a"), splitBlocks("one two b"));
    expect(short?.words).toBeDefined();
  });

  it("caps similarity pairing and falls back to plain deletes and inserts", () => {
    const count = Math.ceil(Math.sqrt(MAX_PAIRINGS)) + 1;
    const base = splitBlocks(
      Array.from({ length: count }, (_, index) => `shared words b${index}`).join("\n\n"),
    );
    const head = splitBlocks(
      Array.from({ length: count }, (_, index) => `shared words h${index}`).join("\n\n"),
    );
    const ops = diffBlocks(base, head);
    expect(ops.filter((op) => op.op === "replace")).toHaveLength(0);
    expect(ops.filter((op) => op.op === "delete")).toHaveLength(count);
    expect(ops.filter((op) => op.op === "insert")).toHaveLength(count);
    // Under the cap, the same blocks pair up.
    const few = diffBlocks(base.slice(0, 10), head.slice(0, 10));
    expect(few.filter((op) => op.op === "replace")).toHaveLength(10);
  });

  it("bounds Markdown fragment rendering by size and time", () => {
    const bomb = "[".repeat(1500) + "a" + "](x)".repeat(1500);
    const start = performance.now();
    const out = renderFragments(
      ["**ok**", "x".repeat(9000), ...Array.from({ length: 50 }, () => bomb)],
      300,
    );
    expect(performance.now() - start).toBeLessThan(2000);
    expect(out[0]).toContain("<strong>ok</strong>");
    expect(out[1]).toBeNull();
    expect(out.filter((item) => item === null).length).toBeGreaterThan(40);
  });

  it("bounds the diff cache by bytes, not entries", () => {
    const cache = new DiffCache(1024 * 1024);
    const small = sized(10_000);
    expect(diffBytes(small)).toBeGreaterThan(20_000);
    for (let index = 0; index < 200; index++) cache.set(`k${index}`, small);
    expect(cache.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(cache.size).toBeLessThan(60);
    expect(cache.get("k199")).toBe(small);
    expect(cache.get("k0")).toBeUndefined();
    // An entry over a quarter of the budget isn't cached at all.
    cache.set("huge", sized(200_000));
    expect(cache.get("huge")).toBeUndefined();
  });
});

describe("diff workers", () => {
  const workers = new DiffWorkers();
  afterEach(async () => {
    await workers.close();
  });
  it("diffs large inputs in a worker with the same result as inline", async () => {
    const base = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join("\n");
    const head = base.replace("line 2000", "line two thousand");
    const file = fileOf("text/plain");
    const inline = diffFile(file, base, head, "lines");
    expect(await workers.diff({ file, base, head, mode: "lines" })).toEqual(inline);
    expect(inline.lines?.some((row) => row.op === "insert")).toBe(true);
  });
  it("stops a worker that overruns its wall-clock limit", async () => {
    const strict = new DiffWorkers({ wallMs: 1 });
    const base = Array.from({ length: 16_000 }, (_, index) => `a${index}`).join("\n");
    const head = Array.from({ length: 16_000 }, (_, index) => `b${index}`).join("\n");
    const result = await strict.diff({ file: fileOf("text/plain"), base, head, mode: "lines" });
    expect(result).toMatchObject({ truncated: true, truncated_reason: "complex" });
    expect(await strict.fragments(["**a**"])).toEqual([null]);
    await strict.close();
  });
});

describe("the writer stays responsive during large compares", () => {
  let dir: string;
  let waypoint: Db;
  let queue: Db;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "waypoint-compare-limits-"));
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

  async function upload(path: string, content: string) {
    const bytes = new TextEncoder().encode(content);
    const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
    await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
    return { path, hash };
  }
  async function write(path: string, body: unknown): Promise<Record<string, string>> {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("bad write");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  }
  async function revisions(files: Record<string, [string, string]>) {
    const first = await write("/api/collections", {
      title: "Big diffs",
      head_path: "index.md",
      files: [
        await upload("index.md", "# Big\n"),
        ...(await Promise.all(Object.entries(files).map(([path, [base]]) => upload(path, base)))),
      ],
    });
    const second = await write(`/api/collections/${first.collection_id}/revisions`, {
      files: await Promise.all(Object.entries(files).map(([path, [, head]]) => upload(path, head))),
    });
    return second;
  }
  /** Runs `work` while probing /healthz every 20 ms; returns the slowest probe. */
  async function probeDuring<T>(work: Promise<T>): Promise<{ value: T; worst: number }> {
    let worst = 0;
    const state = { done: false };
    const probes = (async () => {
      while (!state.done) {
        const start = performance.now();
        const response = await app.request("/healthz");
        expect(response.status).toBe(200);
        worst = Math.max(worst, performance.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    // Also catch a blocked event loop between probes.
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last - 10);
      last = now;
    }, 10);
    try {
      const value = await work;
      return { value, worst };
    } finally {
      state.done = true;
      clearInterval(timer);
      await probes;
    }
  }

  it("answers /healthz while a pathological line diff runs", async () => {
    const suffix = ` ${"z".repeat(20)}`;
    const revision = await revisions({ "big.txt": [distinct("a", suffix), distinct("b", suffix)] });
    const start = performance.now();
    const { value, worst } = await probeDuring(
      Promise.resolve(
        app.request(`/api/revisions/${revision.revision_id}/compare/big.txt?mode=lines`),
      ),
    );
    expect(performance.now() - start).toBeLessThan(6000);
    expect(await value.json()).toMatchObject({ truncated: true, truncated_reason: "complex" });
    expect(worst).toBeLessThan(250);
  });

  it("renders the Changes page for slow-to-parse Markdown without blocking", async () => {
    const revision = await revisions({
      "slow.md": [bracketBomb("before"), bracketBomb("after")],
    });
    const page = new URL(revision.url ?? "").pathname;
    const start = performance.now();
    const { value, worst } = await probeDuring(
      Promise.resolve(app.request(`${page}changes?file=slow.md`)),
    );
    expect(performance.now() - start).toBeLessThan(8000);
    expect(value.status).toBe(200);
    const html = await value.text();
    // Blocks the worker couldn't render in its budget show their source instead.
    expect(html).toContain("Source · not rendered");
    expect(html).not.toContain("<!--wpfrag:");
    expect(worst).toBeLessThan(250);
  });

  it("shows a designed truncated state with links to both versions", async () => {
    const revision = await revisions({ "big.txt": [distinct("a"), distinct("b")] });
    const page = new URL(revision.url ?? "").pathname;
    const html = await (await app.request(`${page}changes?file=big.txt`)).text();
    expect(html).toContain('data-truncated="complex"');
    expect(html).toContain("This change is too complex to show as a diff.");
    expect(html).toMatch(/both versions: <a href="[^"]+big\.txt">#1<\/a>/);
  });
});
