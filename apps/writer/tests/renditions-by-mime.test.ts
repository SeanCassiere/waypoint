// RX-08: ingest renders markdown, text and CSV files with their type's renderer, and the raw route
// serves each type's rendition (HTML, images, `?source` and downloads get the original; the API
// file route substitutes only markdown).
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService, NullRenderer, rendererSet, type Renderer } from "../src/ingest.ts";
import {
  migrate,
  waypointMigrations,
  queueMigrations,
  guardEnvironment,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { writerRenderers } from "../src/renderer.ts";

// The RX-08 mockups' files: a 37-line, 1,094-byte script and a 570-byte one-line JSON.
const DRAIN_SCRIPT = `${[
  "#!/usr/bin/env bash",
  "# Pause PgBouncer, wait for in-flight transactions, then hand over to pg_upgrade.",
  "# Run from the bastion as the admin user. Safe to re-run: every step checks state first.",
  "set -euo pipefail",
  "",
  'PGB_HOST="${PGB_HOST:-pgbouncer}"',
  'PGB_PORT="${PGB_PORT:-6432}"',
  'DB="app"',
  "DRAIN_TIMEOUT=120   # seconds to wait for active server connections to finish",
  "",
  'log() { echo "[$(date -u +%H:%M:%S)] $*"; }',
  "",
  "pgb() {",
  '  psql -h "$PGB_HOST" -p "$PGB_PORT" -U admin pgbouncer -tAc "$1"',
  "}",
  "",
  'log "Pausing $DB on $PGB_HOST:$PGB_PORT"',
  'pgb "PAUSE $DB;"',
  "",
  "# PAUSE returns once clients are queued; server connections may still be busy.",
  'for i in $(seq 1 "$DRAIN_TIMEOUT"); do',
  '  active=$(pgb "SHOW SERVERS;" | awk -F\'|\' -v db="$DB" \'$2 == db && $4 == "active"\' | wc -l)',
  '  if [ "$active" -eq 0 ]; then',
  '    log "Drained after ${i}s"',
  "    break",
  "  fi",
  "  sleep 1",
  "done",
  "",
  'if [ "$active" -ne 0 ]; then',
  '  log "Still $active active connections after ${DRAIN_TIMEOUT}s; resuming and aborting"',
  '  pgb "RESUME $DB;"',
  "  exit 1",
  "fi",
  "",
  'log "Paused. Clients are queued, not refused. Run pg_upgrade now, then:"',
  "log \"  pgb 'RESUME $DB;'\"",
].join("\n")}\n`;
const METRICS_JSON =
  '{"run":"2026-10-06T21:14:03Z","model":"rerank-v4","baseline":"bm25+rules","queries":1200,"metrics":{"ndcg@10":{"baseline":0.412,"candidate":0.468,"delta":0.056},"mrr@10":{"baseline":0.377,"candidate":0.431,"delta":0.054},"recall@50":{"baseline":0.781,"candidate":0.804,"delta":0.023},"p95_latency_ms":{"baseline":38,"candidate":61,"delta":23}},"slices":[{"name":"navigational","queries":410,"ndcg_delta":0.012},{"name":"long-tail","queries":520,"ndcg_delta":0.091},{"name":"misspelled","queries":270,"ndcg_delta":0.047}],"regressions":["q-0193","q-0877"],"passed":true}' +
  "\n";

let dir: string;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let waypoint: Db;
let queue: Db;
let blobs: BlobStore;
let reads: ReadModel;
let ingest: IngestService;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-test-"));
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
  const syncClient = opened.syncClient;
  close = async () => {
    await waypoint.close();
    await queue.close();
  };
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  await guardEnvironment(waypoint, syncClient, "dev", false);
  blobs = new BlobStore(dir, config.maxBlobBytes);
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  ingest = new IngestService(waypoint, queue, blobs, reads, syncClient, undefined, writerRenderers);
  app = createApp({ waypoint, queue, blobs, reads, ingest });
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

async function stored(path: string, content: string | Uint8Array, mime: string) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const saved = await blobs.put(Readable.from([bytes]));
  return { path, hash: saved.hash, mime };
}
const csv = "name,count\nalpha,1\nbeta,2\ngamma,3\ndelta,4\nepsilon,5\n";
const html = "<!doctype html><h1>HTML stays HTML</h1>";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
async function files() {
  return [
    await stored("index.md", "# Index\n", "text/markdown"),
    await stored("run.sh", DRAIN_SCRIPT, "text/x-shellscript"),
    await stored("metrics.json", METRICS_JSON, "application/json"),
    await stored("data.csv", csv, "text/csv"),
    await stored("notes.txt", "notes\n", "text/plain"),
    await stored("page.html", html, "text/html"),
    await stored("pic.png", Uint8Array.of(0x89, 0x50, 0x4e, 0x47), "image/png"),
    await stored("icon.svg", svg, "image/svg+xml"),
    await stored("twin.md", "# Twin\n", "text/markdown"),
    await stored("twin.txt", "# Twin\n", "text/plain"),
  ];
}
function publicIdOf(url: string): string {
  const id = url.split("/r/")[1]?.split("/")[0];
  if (!id) throw new Error(`No revision public ID in ${url}`);
  return id;
}

describe("renditions by MIME type (RX-08)", () => {
  it("queues each file's rendition under its type's renderer", async () => {
    const written = await files();
    await ingest.create({ title: "Kinds", files: written });
    const rows = await queue.all<{
      source_hash: string;
      renderer: string;
      renderer_version: number;
    }>("SELECT source_hash,renderer,renderer_version FROM pending_renditions");
    const hash = (path: string): string => written.find((file) => file.path === path)!.hash;
    const expected = [
      [hash("index.md"), "markdown", 3],
      [hash("twin.md"), "markdown", 3],
      [hash("run.sh"), "text", 1],
      [hash("metrics.json"), "text", 1],
      [hash("notes.txt"), "text", 1],
      [hash("twin.txt"), "text", 1],
      [hash("data.csv"), "csv", 1],
    ].map(([source, renderer, version]) => `${source} ${renderer} ${version}`);
    expect(
      rows.map((row) => `${row.source_hash} ${row.renderer} ${row.renderer_version}`).toSorted(),
    ).toEqual(expected.toSorted());
    const rendered = new Set(rows.map((row) => row.source_hash));
    expect(["page.html", "pic.png", "icon.svg"].filter((path) => rendered.has(hash(path)))).toEqual(
      [],
    );
    // Same bytes as .md and .txt: one rendition per renderer.
    expect(hash("twin.md")).toBe(hash("twin.txt"));
  });

  it("serves text and CSV renditions on the raw route, and originals elsewhere", async () => {
    const written = await files();
    const result = await ingest.create({ title: "Kinds", files: written });
    const pub = publicIdOf(result.url);
    const script = await app.request(`/raw/r/${pub}/run.sh`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("no-cache");
    const etag = script.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    expect(await script.text()).toContain('<body class="tv">');
    const again = await app.request(`/raw/r/${pub}/run.sh`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);

    expect(await (await app.request(`/raw/r/${pub}/data.csv`)).text()).toContain(
      '<table class="csv">',
    );
    expect(await (await app.request(`/raw/r/${pub}/metrics.json`)).text()).toContain(
      '<p class="fmt">',
    );
    expect(await (await app.request(`/raw/r/${pub}/twin.txt`)).text()).toContain('class="tv"');
    const twinMd = await (await app.request(`/raw/r/${pub}/twin.md`)).text();
    expect(twinMd).not.toContain('class="tv"');
    expect(twinMd).toContain("<h1");

    const source = await app.request(`/raw/r/${pub}/run.sh?source`);
    expect(await source.text()).toBe(DRAIN_SCRIPT);
    expect(source.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(source.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(source.headers.get("etag")).toBeNull();

    const download = await app.request(`/raw/r/${pub}/run.sh?download`);
    expect(await download.text()).toBe(DRAIN_SCRIPT);
    expect(download.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(download.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(download.headers.get("etag")).toBeNull();

    const api = await app.request(`/api/revisions/${result.revision_id}/files/run.sh`);
    expect(await api.text()).toBe(DRAIN_SCRIPT);
    expect(api.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    const apiMarkdown = await app.request(`/api/revisions/${result.revision_id}/files/index.md`);
    expect(apiMarkdown.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const page = await app.request(`/raw/r/${pub}/page.html`);
    expect(await page.text()).toBe(html);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("etag")).toBeNull();
    const icon = await app.request(`/raw/r/${pub}/icon.svg`);
    expect(await icon.text()).toBe(svg);

    const runHash = written.find((file) => file.path === "run.sh")!.hash;
    expect(await reads.rendition(runHash, "text")).toBeDefined();
    expect(await reads.rendition(runHash)).toBeUndefined();
    expect(await reads.rendition(runHash, "markdown")).toBeUndefined();
  });

  it("reuses renditions in a later revision", async () => {
    const calls: string[] = [];
    const counting = rendererSet(
      writerRenderers.all.map((renderer): Renderer => ({
        rendererName: renderer.rendererName,
        rendererVersion: renderer.rendererVersion,
        render: (source, mime) => {
          calls.push(mime);
          return renderer.render(source, mime);
        },
      })),
    );
    const counted = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      counting,
    );
    const written = await files();
    const first = await counted.create({ title: "Kinds", files: written });
    expect(calls.toSorted()).toEqual(
      [
        "application/json",
        "text/csv",
        "text/markdown",
        "text/markdown",
        "text/plain",
        "text/plain",
        "text/x-shellscript",
      ].toSorted(),
    );
    const before = await queue.all("SELECT * FROM pending_renditions");
    calls.length = 0;
    await counted.add(first.collection_id, {
      files: [...written, await stored("extra.png", Uint8Array.of(1, 2, 3), "image/png")],
    });
    expect(calls).toEqual([]);
    expect(await queue.all("SELECT * FROM pending_renditions")).toHaveLength(before.length);
  });

  it("serves the original when the text renderer fails", async () => {
    const broken = rendererSet([
      ...writerRenderers.all.filter((renderer) => renderer.rendererName !== "text"),
      {
        rendererName: "text",
        rendererVersion: 1,
        render: () => Promise.reject(new Error("broken")),
      },
    ]);
    const failing = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      broken,
    );
    const result = await failing.create({
      title: "Broken",
      head_path: "run.sh",
      files: [
        await stored("run.sh", DRAIN_SCRIPT, "text/x-shellscript"),
        await stored("data.csv", csv, "text/csv"),
      ],
    });
    expect(
      (await queue.all<{ renderer: string }>("SELECT renderer FROM pending_renditions")).map(
        (row) => row.renderer,
      ),
    ).toEqual(["csv"]);
    const pub = publicIdOf(result.url);
    const script = await app.request(`/raw/r/${pub}/run.sh`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(await script.text()).toBe(DRAIN_SCRIPT);
    expect(await (await app.request(`/raw/r/${pub}/data.csv`)).text()).toContain(
      '<table class="csv">',
    );
  });

  it("keeps the write when a rendition is over the blob limit, and bounds deep JSON", async () => {
    const oversized = rendererSet([
      ...writerRenderers.all.filter((renderer) => renderer.rendererName !== "text"),
      {
        rendererName: "text",
        rendererVersion: 1,
        render: () =>
          Promise.resolve({ bytes: new Uint8Array(blobs.maxBlobBytes + 1), mime: "text/html" }),
      },
    ]);
    const large = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      oversized,
    );
    const result = await large.create({
      title: "Oversized",
      head_path: "run.sh",
      files: [
        await stored("run.sh", DRAIN_SCRIPT, "text/x-shellscript"),
        await stored("data.csv", csv, "text/csv"),
      ],
    });
    expect(
      (await queue.all<{ renderer: string }>("SELECT renderer FROM pending_renditions")).map(
        (row) => row.renderer,
      ),
    ).toEqual(["csv"]);
    const pub = publicIdOf(result.url);
    expect(await (await app.request(`/raw/r/${pub}/run.sh`)).text()).toBe(DRAIN_SCRIPT);

    // 16 KB of valid, deeply nested JSON: formatting it would take far more than the blob limit
    // in indentation, so it is shown as authored, and the write and its rendition succeed.
    const nested = `${"[".repeat(8000)}0${"]".repeat(8000)}`;
    const deep = await ingest.create({
      title: "Deep",
      files: [await stored("nested.json", nested, "application/json")],
    });
    const view = await (await app.request(`/raw/r/${publicIdOf(deep.url)}/nested.json`)).text();
    expect(view).toContain('<body class="tv">');
    expect(view).toContain('<span class="m">1 line · 16 KB</span>');
    expect(view).not.toContain('class="fmt"');
  });
  it("keeps a merge write when an inherited file's blob isn't local", async () => {
    // Written before text renditions existed, then the local blob store lost the bytes (a writer
    // recovered on a new machine refills it lazily from the bucket).
    const before = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      new NullRenderer(),
    );
    const other = await stored("other.txt", "inherited\n", "text/plain");
    const first = await before.create({ title: "Inherited", files: [other] });
    await unlink(blobs.path(other.hash));
    const added = await stored("c.md", "# C\n", "text/markdown");
    await ingest.add(first.collection_id, { files: [added] });
    expect(
      await queue.all<{ source_hash: string; renderer: string }>(
        "SELECT source_hash,renderer FROM pending_renditions",
      ),
    ).toEqual([{ source_hash: added.hash, renderer: "markdown" }]);
  });
});
