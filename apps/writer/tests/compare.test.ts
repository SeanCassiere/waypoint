import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markWords, renderFragment } from "@waypoint/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import {
  compareManifests,
  diffBlocks,
  diffFile,
  diffTextLines,
  splitBlocks,
  toHunks,
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

type FixtureManifest = Parameters<typeof compareManifests>[1];
type FixtureEntry = FixtureManifest["files"][string];
const isHash = (value: string): value is FixtureEntry["hash"] =>
  /^sha256:[0-9a-f]{64}$/.test(value);
function fixtureEntry(c: string): FixtureEntry {
  const hash = `sha256:${c.repeat(64)}`;
  if (!isHash(hash)) throw new Error("bad hash");
  return { hash, mime: "text/markdown", size: 3 };
}
function fixtureManifest(headPath: string, files: Record<string, string>): FixtureManifest {
  return {
    headPath,
    files: Object.fromEntries(Object.entries(files).map(([path, c]) => [path, fixtureEntry(c)])),
  };
}

describe("block splitting and diffing (B1)", () => {
  it("splits headings, paragraphs, list items, table rows and whole fences", () => {
    const blocks = splitBlocks(
      "---\ntitle: x\n---\n# Title\n\nPara one\ncontinues.\n\n- a\n  more a\n- b\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n> quote\n> more\n",
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "other",
      "heading",
      "paragraph",
      "list-item",
      "list-item",
      "table",
      "table",
      "table",
      "code",
      "other",
    ]);
    expect(blocks[3]?.text).toBe("- a\n  more a");
    expect(blocks[8]?.text).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
  });
  it("pairs changed blocks into replacements with word diffs and folds context", () => {
    const base = splitBlocks("# T\n\nOne\n\nTwo\n\nThree\n\nFour\n\nRetry for 72 hours.\n");
    const head = splitBlocks(
      "# T\n\nOne\n\nTwo\n\nThree\n\nFour\n\nNew block\n\nRetry for 24 hours.\n",
    );
    const ops = diffBlocks(base, head);
    expect(ops.map((op) => op.op)).toEqual([
      "equal",
      "equal",
      "equal",
      "equal",
      "equal",
      "insert",
      "replace",
    ]);
    const changed = diffBlocks(
      splitBlocks("Retry for 72 hours."),
      splitBlocks("Retry for 24 hours."),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.op).toBe("replace");
    expect(changed[0]?.words?.filter((word) => word.op !== "equal")).toEqual([
      { op: "delete", text: "72" },
      { op: "insert", text: "24" },
    ]);
    const { hunks, folded_after } = toHunks(ops);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.folded_before).toBe(4);
    expect(hunks[0]?.blocks.map((op) => op.op)).toEqual(["equal", "insert", "replace"]);
    expect(folded_after).toBe(0);
  });
  it("renders sentinel-marked Markdown to balanced, sanitized HTML", () => {
    const html = renderFragment(
      markWords([
        { op: "equal", text: "Then " },
        { op: "delete", text: "reopen **the" },
        { op: "insert", text: "resume" },
        {
          op: "equal",
          text: " firewall** and [docs](javascript:alert(1)) <script>x()</script> ![x](./a.png)",
        },
      ]),
    );
    expect(html).toContain("<del>reopen </del>");
    expect(html).toContain("<ins>resume</ins>");
    expect(html).not.toMatch(/<script|javascript:|<img||||/);
    expect(html).toContain("[image: x]");
    expect(renderFragment("## Heading\n")).not.toContain("id=");
    expect(renderFragment("[ok](https://example.com)")).toContain('rel="noopener noreferrer"');
    expect(renderFragment("- [x] done\n- [ ] todo\n")).toMatch(
      /aria-label="Done"[^>]*>.*aria-label="Not done"/s,
    );
  });
  it("compares manifests head-first and diffs text by lines", () => {
    const compare = compareManifests(
      fixtureManifest("a.md", { "a.md": "1", "gone.md": "2", "same.md": "3" }),
      fixtureManifest("z.md", { "z.md": "4", "a.md": "5", "same.md": "3" }),
    );
    expect(compare.files.map((entry) => [entry.path, entry.status])).toEqual([
      ["z.md", "added"],
      ["a.md", "modified"],
      ["gone.md", "removed"],
      ["same.md", "unchanged"],
    ]);
    expect(compare.counts).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 });
    expect(compare.head_path_changed).toBe(true);
    const lines = diffTextLines("a\nb\nc\n", "a\nB\nc\n");
    expect(lines.map((row) => row.op)).toEqual(["equal", "delete", "insert", "equal"]);
    const truncated = diffFile(compare.files[1]!, "x", undefined, "blocks");
    expect(truncated.truncated).toBe(true);
  });
});

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
  return { path, hash };
}
async function write(path: string, body: unknown): Promise<Record<string, string>> {
  const value: unknown = await (await app.request(path, json(body))).json();
  if (!value || typeof value !== "object") throw new Error("bad write");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-compare-"));
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

describe("compare API and Changes page", () => {
  it("serves manifest and per-file diffs and renders the Changes page", async () => {
    const first = await write("/api/collections", {
      title: "Diffs",
      head_path: "index.md",
      files: [
        await upload(
          "index.md",
          "# Plan\n\nRetry for 72 hours.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
        ),
        await upload("old.txt", "x\n"),
      ],
    });
    const second = await write(`/api/collections/${first.collection_id}/revisions`, {
      message: "Shorter retries",
      mode: "replace",
      files: [
        await upload(
          "index.md",
          "# Plan\n\nRetry for 24 hours.\n\n| A | B |\n| - | - |\n| 1 | 3 |\n",
        ),
        await upload("new.md", "# New\n"),
      ],
    });
    const manifest: unknown = await (
      await app.request(`/api/revisions/${second.revision_id}/compare`)
    ).json();
    expect(manifest).toMatchObject({
      base: { id: first.revision_id },
      head: { id: second.revision_id },
      counts: { added: 1, removed: 1, modified: 1, unchanged: 0 },
    });
    const file: unknown = await (
      await app.request(`/api/revisions/${second.revision_id}/compare/index.md`)
    ).json();
    expect(file).toMatchObject({
      path: "index.md",
      status: "modified",
      kind: "text",
      truncated: false,
    });
    expect(JSON.stringify(file)).toContain('"op":"replace"');
    const lines: unknown = await (
      await app.request(`/api/revisions/${second.revision_id}/compare/index.md?mode=lines`)
    ).json();
    expect(JSON.stringify(lines)).toContain('"op":"delete"');
    expect(
      (await app.request(`/api/revisions/${second.revision_id}/compare/missing.md`)).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/revisions/${second.revision_id}/compare?base=rev_missing`)).status,
    ).toBe(404);
    const pinned = new URL(second.url ?? "").pathname;
    const spies = [
      vi.spyOn(queue, "all"),
      vi.spyOn(queue, "get"),
      vi.spyOn(waypoint, "all"),
      vi.spyOn(waypoint, "get"),
    ];
    const page = await app.request(`${pinned}changes`);
    const queries = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    spies.forEach((spy) => spy.mockRestore());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Changes in #2");
    expect(html).toContain("<del>72</del>");
    expect(html).toContain("<ins>24</ins>");
    expect(html).toContain("Table · 1 row changed");
    expect(html).toContain("Removed (was 2 B)");
    expect(queries).toBeLessThan(30);
    const source = await (await app.request(`${pinned}changes?view=source`)).text();
    expect(source).toContain('class="lines"');
    const first1 = new URL(first.url ?? "").pathname;
    expect(await (await app.request(`${first1}changes`)).text()).toContain("first revision");
    // The no-script compare form (NAV-10's /c/<pub>/compare) redirects to the Changes URL.
    const form = `?from=${pinned}&r=${first1.split("/")[4] ?? ""}&r=${pinned.split("/")[4] ?? ""}`;
    const picked = await app.request(`/c/${pinned.split("/")[2] ?? ""}/compare${form}`);
    expect(picked.status).toBe(302);
    expect(picked.headers.get("location")).toBe(`${pinned}changes`);
    // The collection segment is validated too before it goes into the redirect.
    for (const pub of ["%2F%2Fevil.example", "not_a_pub!!", "%5Cevil"]) {
      const bad = await app.request(`/c/${pub}/compare${form}`);
      expect({ pub, status: bad.status, location: bad.headers.get("location") }).toEqual({
        pub,
        status: 404,
        location: null,
      });
    }
  });
});
