import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { iconUse } from "@waypoint/ui";
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

// RX-03: the writer's ?as=public preview passes each file's type and size to the shell, so it
// shows the same type icons and download marker as the public reader.
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let reads: ReadModel;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-preview-files-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://reader-dev.example.test",
    port: 7410,
    queueGiveUpHours: 72,
    // The archive below is 4,300,000 bytes.
    maxBlobBytes: 8 * 1024 * 1024,
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

const text = (value: string) => new TextEncoder().encode(value);
async function upload(bytes: Uint8Array): Promise<string> {
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  const res = await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
  expect(res.status).toBe(200);
  return hash;
}

describe("public preview files", () => {
  it("shows the reader's type icons and download marker", async () => {
    const files = [
      { path: "index.md", hash: await upload(text("# Field kit")), mime: "text/markdown" },
      {
        path: "archive/build.tar.gz",
        hash: await upload(new Uint8Array(4_300_000).fill(7)),
        mime: "application/gzip",
      },
    ];
    for (let i = 1; i <= 7; i++)
      files.push({
        path: `notes/n${i}.md`,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Seven small uploads, in order.
        hash: await upload(text(`note ${i}`)),
        mime: "text/markdown",
      });
    const created = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Field kit", head_path: "index.md", files }),
    });
    expect(created.status).toBe(200);
    const { collection_id: collectionId, revision_id: revisionId } = z
      .object({ collection_id: z.string(), revision_id: z.string() })
      .parse(await created.json());
    await worker.drain();
    await worker.drain();
    expect((await reads.revision(revisionId))?.sync_state).toBe("synced");
    const collection = await waypoint.get<{ public_id: string }>(
      "SELECT public_id FROM collections WHERE id=?",
      [collectionId],
    );
    const res = await app.request(`/c/${collection?.public_id}/?as=public`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<symbol id="i-binary"');
    expect(html).toContain("build.tar.gz<small> download · 4.1 MB</small></a>");
    expect(html).toContain(`id="files-cur">${iconUse("doc")}<span class="t"`);
    expect(html).toContain(`${iconUse("doc")}index.md</a>`);
  });
});
