import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

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
import { writerRenderer } from "../src/renderer.ts";
import { cssAsset } from "../src/viewer/assets.ts";

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
let rpub: string;

async function upload(bytes: Uint8Array): Promise<string> {
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return hash;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-compression-"));
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
  const ingest = new IngestService(
    waypoint,
    queue,
    blobs,
    reads,
    opened.syncClient,
    undefined,
    writerRenderer,
  );
  app = createApp({ waypoint, queue, blobs, reads, ingest });
  const markdown = new TextEncoder().encode(
    `# Notes\n\n${"Compressible text repeats itself. ".repeat(200)}`,
  );
  // A PNG signature plus noise: already compressed as far as the writer is concerned.
  const png = new Uint8Array(4096).map((_, index) => (index * 7919) % 251);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const created: unknown = await (
    await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Compression",
        head_path: "notes.md",
        files: [
          { path: "notes.md", hash: await upload(markdown) },
          { path: "plot.png", hash: await upload(png) },
        ],
      }),
    })
  ).json();
  const url =
    created && typeof created === "object" && "url" in created && typeof created.url === "string"
      ? created.url
      : "";
  rpub = new URL(url).pathname.split("/")[4] ?? "";
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("response compression", () => {
  it("compresses viewer HTML with Brotli or gzip and decodes to the same page", async () => {
    const plain = await app.request("/trash");
    const plainText = await plain.text();
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toContain("Accept-Encoding");
    const br = await app.request("/trash", { headers: { "accept-encoding": "gzip, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    const brBytes = Buffer.from(await br.arrayBuffer());
    expect(Number(br.headers.get("content-length"))).toBe(brBytes.byteLength);
    expect(brotliDecompressSync(brBytes).toString()).toBe(plainText);
    expect(brBytes.byteLength).toBeLessThan(plainText.length / 2);
    const gz = await app.request("/trash", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(plainText);
    // The security headers survive.
    expect(br.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("compresses text renditions with a weak ETag that still revalidates", async () => {
    const raw = await app.request(`/raw/r/${rpub}/notes.md`, {
      headers: { "accept-encoding": "br" },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-encoding")).toBe("br");
    const etag = raw.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    expect(brotliDecompressSync(Buffer.from(await raw.arrayBuffer())).toString()).toContain(
      "Compressible text",
    );
    const again = await app.request(`/raw/r/${rpub}/notes.md`, {
      headers: { "accept-encoding": "br", "if-none-match": etag ?? "" },
    });
    expect(again.status).toBe(304);
  });

  it("leaves images, small bodies and the MCP downloads uncompressed", async () => {
    const image = await app.request(`/raw/r/${rpub}/plot.png`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-encoding")).toBeNull();
    expect((await image.arrayBuffer()).byteLength).toBe(4096);
    const health = await app.request("/healthz", { headers: { "accept-encoding": "br" } });
    expect(health.headers.get("content-encoding")).toBeNull();
    const mcp = await app.request("/mcp/skill/SKILL.md", { headers: { "accept-encoding": "br" } });
    expect(mcp.headers.get("content-encoding")).toBeNull();
  });

  it("compresses the immutable viewer assets", async () => {
    const css = await app.request(cssAsset.url, { headers: { "accept-encoding": "br" } });
    expect(css.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await css.arrayBuffer())).byteLength).toBe(
      cssAsset.bytes.byteLength,
    );
  });
});
