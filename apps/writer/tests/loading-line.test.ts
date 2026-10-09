import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { viewerCssSource } from "../src/viewer/css.ts";

// A11Y-08: the collection page's document frame sits in a wrap with an empty role=status line
// behind it (the client fills it after 300 ms; the viewer browser test covers that). Image and
// download pages have no wrap.
let directory: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-loading-line-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
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
  const blobs = new BlobStore(directory, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  app = createApp({ waypoint, queue, blobs, reads, ingest });
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

async function file(path: string, body: string, mime: string) {
  const bytes = new TextEncoder().encode(body);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  const res = await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
  expect(res.status).toBe(200);
  return { path, hash, mime };
}
async function page(path: string): Promise<string> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}
const squash = (css: string) => css.replace(/\s+/g, "");

describe("loading line (A11Y-08)", () => {
  it("wraps the document frame with an empty status line; images and downloads have none", async () => {
    const files = await Promise.all([
      file("index.md", "# Plan\n", "text/markdown"),
      file("shots/a.png", "png a", "image/png"),
      file("build.zip", "PK zip", "application/zip"),
    ]);
    const res = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Plan", head_path: "index.md", files }),
    });
    expect(res.status).toBe(200);
    const { url } = z.object({ url: z.string() }).parse(await res.json());
    const shell = new URL(url).pathname;

    const doc = await page(shell);
    // Hono renders a bare JSX attribute as ="true" (as for data-frame).
    expect(doc).toContain(
      '<div class="docwrap" data-docwrap="true"><div class="loading"><p role="status" data-loading="true"></p></div><iframe class="frame"',
    );
    expect(doc).not.toContain("data-opening");
    expect(doc).not.toContain("aria-busy");
    for (const path of ["shots/a.png", "build.zip"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two pages, checked in order.
      const html = await page(`${shell}${path}`);
      expect(html).not.toContain("data-docwrap");
      expect(html).not.toContain("data-loading");
    }
  });

  it("hides the frame while opening, with no motion", () => {
    const css = squash(viewerCssSource());
    expect(css).toContain(".docwrap[data-opening]>.frame{visibility:hidden;}");
    expect(css).toContain(".docwrap[data-loaded]>.loading{display:none;}");
    expect(css).toMatch(/\.loading\{[^}]*pointer-events:none/);
    expect(css).toMatch(/\.loadingp\{[^}]*overflow-wrap:anywhere/);
    const partial = readFileSync(
      new URL("../src/viewer/css/40-collection.css", import.meta.url),
      "utf8",
    );
    expect(partial).not.toMatch(/transition|animation/);
  });
});
