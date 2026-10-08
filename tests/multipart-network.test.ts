import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";

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
  it("cleans an active upload on SIGTERM and can restart", async () => {
    const childDir = await mkdtemp(join(tmpdir(), "waypoint-sigterm-upload-"));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("No child port");
    const childPort = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const config: Config = {
      environment: "dev",
      dataDir: childDir,
      baseUrl: `http://127.0.0.1:${childPort}`,
      port: childPort,
      queueGiveUpHours: 72,
      maxBlobBytes: 10 * 1024 * 1024,
      sync: false,
    };
    const start = () =>
      spawn(process.execPath, [join(process.cwd(), "apps/writer/dist/main.js"), "serve"], {
        env: {
          ...process.env,
          WAYPOINT_ENV: "dev",
          WAYPOINT_SYNC: "off",
          WAYPOINT_DATA_DIR: childDir,
          WAYPOINT_PORT: String(childPort),
        },
        stdio: "ignore",
      });
    const waitForHealth = async (): Promise<void> => {
      const ready = await waitUntil(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${childPort}/healthz`)).ok;
          } catch {
            return false;
          }
        },
        80,
        25,
      );
      if (!ready) throw new Error("Child writer did not start");
    };
    let child = start();
    try {
      await waitForHealth();
      const req = httpRequest({
        hostname: "127.0.0.1",
        port: childPort,
        path: "/api/collections",
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      });
      req.on("error", () => undefined);
      req.write(partial);
      req.write(Buffer.alloc(256 * 1024, 65));
      expect(await waitUntil(() => hasTemp(childDir), 40, 10)).toBe(true);
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      child.kill("SIGTERM");
      expect(await Promise.race([exited, delay(6000).then(() => -1)])).toBe(0);
      req.destroy();
      expect((await readdir(childDir)).some((name) => name.startsWith(".blob-"))).toBe(false);
      const opened = await openDatabases(config);
      try {
        await expectNoQueuedWrite(opened.queue);
      } finally {
        await opened.waypoint.close();
        await opened.queue.close();
      }
      child = start();
      await waitForHealth();
      expect((await fetch(`http://127.0.0.1:${childPort}/healthz`)).status).toBe(200);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await exited;
      }
      await rm(childDir, { recursive: true, force: true });
    }
  }, 15000);
});
