// The built writer as a process: SIGTERM during an upload cleans its temporary file, and the
// writer restarts cleanly on the same data directory. Uses apps/writer/dist (turbo builds it first).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";

const writerMain = fileURLToPath(new URL("../apps/writer/dist/main.js", import.meta.url));
if (!existsSync(writerMain)) throw new Error(`${writerMain} is missing: run pnpm build first`);
const boundary = "waypoint-abort-test";
const partial = `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{"title":"Incomplete"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file:plan.md"; filename="plan.md"\r\nContent-Type: text/markdown\r\n\r\n`;

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
describe("writer process", () => {
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
      spawn(process.execPath, [writerMain, "serve"], {
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
