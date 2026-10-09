// RX-05: the viewer's raw route serves CSV and TSV as plain text, so its frame shows their text;
// the API file route keeps the stored type for API and MCP clients.
// RX-06: `?download` on /raw/r/ serves the stored file, under its stored type, as an attachment.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  migrate,
  waypointMigrations,
  queueMigrations,
  guardEnvironment,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
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
  ingest = new IngestService(waypoint, queue, blobs, reads, syncClient);
  app = createApp({ waypoint, queue, blobs, reads, ingest });
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
async function stored(path: string, text: string, mime: string) {
  const saved = await blobs.put(Readable.from([new TextEncoder().encode(text)]));
  return { path, hash: saved.hash, mime };
}
describe("raw route content types (RX-05)", () => {
  it("serves CSV and TSV as plain text on /raw/r/ and keeps the API's stored type", async () => {
    const csv = "region,requests\neu-west,1200\n";
    const tsv = "region\trequests\neu-west\t1200\n";
    const result = await ingest.create({
      title: "Tables",
      files: [
        await stored("index.md", "# Tables", "text/markdown"),
        await stored("data.csv", csv, "text/csv"),
        await stored("sheet.tsv", tsv, "text/tab-separated-values"),
      ],
    });
    const publicId = result.url.split("/r/")[1]?.split("/")[0];
    expect(publicId).toBeTruthy();
    for (const [path, body] of [
      ["data.csv", csv],
      ["sheet.tsv", tsv],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two files, checked in order.
      const raw = await app.request(`/raw/r/${publicId}/${path}`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two files, checked in order.
      expect(await raw.text()).toBe(body);
    }
    const api = await app.request(`/api/revisions/${result.revision_id}/files/data.csv`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await api.text()).toBe(csv);
    const markdown = await app.request(`/raw/r/${publicId}/index.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });
});
describe("raw route downloads (RX-06)", () => {
  it("serves the stored bytes under the stored type as an attachment", async () => {
    const csv = "region,requests\neu-west,1200\n";
    const markdownSource = "# Field kit\n\nNotes.";
    // A renderer, so index.md has a rendition the download must skip.
    const renderer = {
      rendererName: "markdown",
      rendererVersion: 1,
      render: () =>
        Promise.resolve({
          bytes: new TextEncoder().encode("<h1>Field kit</h1>"),
          mime: "text/html",
        }),
    };
    const rendering = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      renderer,
    );
    const result = await rendering.create({
      title: "Downloads",
      files: [
        await stored("index.md", markdownSource, "text/markdown"),
        await stored("data.csv", csv, "text/csv"),
      ],
    });
    const publicId = result.url.split("/r/")[1]?.split("/")[0];
    expect(publicId).toBeTruthy();
    const framedMarkdown = await app.request(`/raw/r/${publicId}/index.md`);
    expect(framedMarkdown.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const etag = framedMarkdown.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"sha256:/);
    expect(await framedMarkdown.text()).toBe("<h1>Field kit</h1>");
    const markdown = await app.request(`/raw/r/${publicId}/index.md?download`, {
      headers: { "if-none-match": etag },
    });
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdown.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''index.md",
    );
    expect(markdown.headers.get("x-content-type-options")).toBe("nosniff");
    expect(markdown.headers.get("etag")).toBeNull();
    expect(markdown.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await markdown.text()).toBe(markdownSource);
    const table = await app.request(`/raw/r/${publicId}/data.csv?download`);
    expect(table.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(table.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''data.csv");
    expect(await table.text()).toBe(csv);
    const framed = await app.request(`/raw/r/${publicId}/data.csv`);
    expect(framed.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(framed.headers.get("content-disposition")).toBeNull();
    const api = await app.request(`/api/revisions/${result.revision_id}/files/index.md?download`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-disposition")).toBeNull();
  });
  it("keeps the raw route's errors", async () => {
    const plain = await app.request("/raw/r/nope/x.md");
    const download = await app.request("/raw/r/nope/x.md?download");
    expect(plain.status).toBe(404);
    expect(download.status).toBe(plain.status);
    expect([...download.headers]).toEqual([...plain.headers]);
    expect(await download.text()).toBe(await plain.text());
  });
});
