import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";
import { galleryDirFor } from "../src/viewer/components.tsx";

// RX-04: image files get the stage instead of the iframe, with a caption, the change chip, and
// "Open in gallery" only when the image's folder has a gallery (galleryDirFor).
const png = (path: string) => ({ path, mime: "image/png" });

describe("galleryDirFor", () => {
  const four = ["a", "b", "c", "d"].map((name) => png(`shots/${name}.png`));
  it.each([
    ["a root-level image", "a.png", [...four, png("a.png")], null],
    ["4 images in shots/", "shots/a.png", four, { dir: "shots/", images: 4 }],
    ["3 images", "shots/a.png", four.slice(1), null],
    [
      "images in shots/sub/ (they don't count)",
      "shots/a.png",
      [...four.slice(1), png("shots/sub/x.png"), png("shots/sub/y.png")],
      null,
    ],
    [
      "non-image files (they don't count)",
      "shots/a.png",
      [...four.slice(1), { path: "shots/notes.txt", mime: "text/plain" }],
      null,
    ],
    ["a folder prefix", "shots/", four, { dir: "shots/", images: 4 }],
  ])("%s", (_, path, files, expected) => expect(galleryDirFor(path, files)).toEqual(expected));
});

let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let reads: ReadModel;
// The ?as=public preview renders only synced revisions, so revisions go through a committer.
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-image-stage-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://reader-dev.example.test",
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
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  worker = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    new MemoryBucket(),
    new SyncLoop(queue, opened.syncClient, Date.now, waypoint),
    ingest,
  );
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey: new Uint8Array(32).fill(42),
  });
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
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
const created = z.object({ collection_id: z.string(), revision_id: z.string(), url: z.string() });
async function post(url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const parsed = created.parse(await res.json());
  await worker.drain();
  await worker.drain();
  expect((await reads.revision(parsed.revision_id))?.sync_state).toBe("synced");
  return { ...parsed, path: new URL(parsed.url).pathname };
}
async function page(path: string): Promise<string> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}
const row = (html: string, path: string) =>
  new RegExp(`<a data-file="${path.replaceAll(".", "\\.")}"[^>]*>`).exec(html)?.[0];

describe("image stage (RX-04)", () => {
  it("puts images on the stage, with Open in gallery only for a gallery folder", async () => {
    const files = await Promise.all([
      ...["a", "b", "c", "d"].map((name) => file(`shots/${name}.png`, `png ${name}`, "image/png")),
      file("cover.png", "png cover", "image/png"),
      file("pics/x.png", "png x", "image/png"),
      file("pics/y.png", "png y", "image/png"),
      file("index.md", "# Audit", "text/markdown"),
      file("notes.txt", "notes", "text/plain"),
      file("build.zip", "PK zip", "application/zip"),
    ]);
    const first = await post("/api/collections", {
      title: "Checkout audit",
      head_path: "index.md",
      files,
    });
    const pub = first.path.split("/")[2]!;

    const a = await page(`/c/${pub}/shots/a.png`);
    expect(a).toContain('class="wstage"');
    expect(a).toContain('<figure class="stage" tabindex="0"');
    expect(a).toContain("data-stage-img");
    expect(a).toContain("data-download");
    expect(a).not.toContain("<iframe");
    const gallery = /<a class="btn" href="([^"]+)">(?:<svg[^]*?<\/svg>)Open in gallery<\/a>/.exec(
      a,
    );
    expect(gallery?.[1]).toBe(`${first.path}gallery/shots/`);
    expect(a).toContain('<span class="ty">PNG image</span>');
    expect(a).not.toContain("ichg");

    for (const path of ["cover.png", "pics/x.png"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two pages, checked in order.
      const html = await page(`/c/${pub}/${path}`);
      expect(html).toContain('class="wstage"');
      expect(html).not.toContain("Open in gallery");
    }

    // The Files tree: a gallery only under shots/; image rows navigate fully.
    const head = await page(`/c/${pub}/`);
    expect(head.match(/View as gallery/g)).toHaveLength(1);
    expect(head).toContain("View as gallery (4)");
    expect(head.indexOf("View as gallery")).toBeGreaterThan(head.indexOf('data-dir="shots/"'));
    for (const path of ["shots/a.png", "cover.png", "pics/x.png"])
      expect(row(head, path)).toContain('data-embed="false"');
    expect(row(head, "index.md")).toBeDefined();
    expect(row(head, "index.md")).not.toContain("data-embed");
    expect(head).toContain('<iframe class="frame"');
    expect(head).not.toContain("frame img");

    // The public preview shows the reader's stage, and the download card for an archive.
    expect(await page(`/c/${pub}/shots/a.png?as=public`)).toContain('class="imgmain"');
    expect(await page(`/c/${pub}/build.zip?as=public`)).toContain('class="dl"');

    const second = await post(`/api/collections/${first.collection_id}/revisions`, {
      files: [
        await file("shots/a.png", "png a, changed", "image/png"),
        await file("shots/e.png", "png e", "image/png"),
      ],
    });
    const changed = await page(`/c/${pub}/shots/a.png`);
    expect(changed).toContain("~ Changed in #2");
    expect(changed).toContain('<span class="ichg m">');
    expect(changed).toContain(`${second.path}changes?file=shots%2Fa.png`);
    const added = await page(`/c/${pub}/shots/e.png`);
    expect(added).toContain("+ Added in #2");
    expect(added).toContain('<span class="ichg a">');
    expect(await page(`/c/${pub}/shots/b.png`)).not.toContain("ichg");
    for (const path of ["shots/a.png", "shots/b.png", "cover.png"])
      // oxlint-disable-next-line eslint/no-await-in-loop -- Three pages, checked in order.
      expect(await page(`${first.path}${path}`)).not.toContain("ichg");
  });
});
