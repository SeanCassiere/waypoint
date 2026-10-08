import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { serve } from "@hono/node-server";
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

const boundary = "waypoint-abort-test";
const partial = `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{"title":"Incomplete"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file:plan.md"; filename="plan.md"\r\nContent-Type: text/markdown\r\n\r\n`;
let dir: string;
let port: number;
let server: ReturnType<typeof serve>;
let waypoint: Db;
let queue: Db;

async function waitUntil(
  predicate: () => Promise<boolean>,
  attempts: number,
  intervalMs: number,
): Promise<boolean> {
  if (await predicate()) return true;
  if (attempts <= 1) return false;
  await delay(intervalMs);
  return waitUntil(predicate, attempts - 1, intervalMs);
}
async function hasTemp(path: string): Promise<boolean> {
  return (await readdir(path)).some((name) => name.startsWith(".blob-"));
}
async function clean(): Promise<void> {
  // Up to 5 s: on a busy CI runner the abort can take longer than a second to reach cleanup.
  if (!(await waitUntil(async () => !(await hasTemp(dir)), 200, 25)))
    throw new Error("Multipart temporary file was not cleaned up");
}
async function expectNoQueuedWrite(db: Db): Promise<void> {
  const tables = [
    "pending_collections",
    "pending_revisions",
    "pending_blobs",
    "pending_renditions",
  ] as const;
  const counts = await Promise.all(
    tables.map((table) => db.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)),
  );
  expect(counts.map((row) => row?.count)).toEqual([0, 0, 0, 0]);
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-abort-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 10 * 1024 * 1024,
    sync: false,
  };
  const opened = await openDatabases(config);
  waypoint = opened.waypoint;
  queue = opened.queue;
  await guardEnvironment(waypoint, opened.syncClient, "dev", false);
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  const blobs = new BlobStore(dir, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  server = serve({
    fetch: createApp({ waypoint, queue, blobs, reads, ingest }).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  port = address.port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});
describe("multipart transport failures", () => {
  it("survives a socket destroyed mid-file and cleans the partial put", async () => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/collections",
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    req.on("error", () => undefined);
    req.write(partial);
    req.write(Buffer.alloc(256 * 1024, 65));
    expect(await waitUntil(() => hasTemp(dir), 40, 10)).toBe(true);
    req.destroy();
    await new Promise<void>((resolve) => req.once("close", () => resolve()));
    await clean();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await expectNoQueuedWrite(queue);
  });
  it("returns validation_failed for a body without its closing boundary", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/collections`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: partial + "# incomplete",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
    await clean();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await expectNoQueuedWrite(queue);
  });
});
