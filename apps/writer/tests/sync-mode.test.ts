import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.ts";
import { checkSyncMode, openDatabases } from "../src/db.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function scratch(...files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-sync-mode-"));
  dirs.push(dir);
  await Promise.all(files.map((file) => writeFile(join(dir, file), "")));
  return dir;
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
async function syncServer(bin: string, db: string, port: number): Promise<ChildProcess> {
  const child = spawn(bin, [db, "--sync-server", `127.0.0.1:${port}`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) });
      return child;
    } catch {
      await delay(50);
    }
  }
  child.kill("SIGTERM");
  throw new Error("Sync server did not start");
}
function synced(dataDir: string, port: number): Config {
  return {
    environment: "dev",
    dataDir,
    baseUrl: "http://127.0.0.1:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024,
    sync: true,
    tursoUrl: `http://127.0.0.1:${port}`,
    tursoAuthToken: "test",
    r2AccountId: "test",
    r2AccessKeyId: "test",
    r2SecretAccessKey: "test",
    r2Bucket: "test",
  };
}

describe("data directory sync mode", () => {
  it("accepts a fresh directory either way", async () => {
    const dir = await scratch();
    await expect(checkSyncMode({ dataDir: dir, sync: false })).resolves.toBeUndefined();
    await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
  });
  it("keeps a cloud-synced replica away from local-only mode", async () => {
    const dir = await scratch("waypoint.db", "waypoint.db-info");
    await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
    await expect(checkSyncMode({ dataDir: dir, sync: false })).rejects.toThrow(
      "WAYPOINT_SYNC=off can't use",
    );
  });
  it("keeps a local-only database away from cloud sync", async () => {
    const dir = await scratch();
    const opened = await openDatabases({
      environment: "prod",
      dataDir: dir,
      baseUrl: "http://127.0.0.1:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    });
    await opened.waypoint.exec("CREATE TABLE IF NOT EXISTS t (x)");
    await opened.waypoint.close();
    await opened.queue.close();
    await expect(checkSyncMode({ dataDir: dir, sync: false })).resolves.toBeUndefined();
    await expect(checkSyncMode({ dataDir: dir, sync: true })).rejects.toThrow(
      "created with WAYPOINT_SYNC=off",
    );
  });
  it("treats the empty waypoint.db a failed first sync leaves as absent", async () => {
    const dir = await scratch("waypoint.db");
    await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
    await expect(checkSyncMode({ dataDir: dir, sync: false })).resolves.toBeUndefined();
  });
  it("counts WAL content as a local-only database", async () => {
    const dir = await scratch("waypoint.db");
    await writeFile(join(dir, "waypoint.db-wal"), "x");
    await expect(checkSyncMode({ dataDir: dir, sync: true })).rejects.toThrow(
      "created with WAYPOINT_SYNC=off",
    );
  });
  it("retries a first sync that couldn't reach the cloud", async () => {
    const dir = await scratch();
    const port = await freePort();
    // Nothing listens on the port: the bootstrap fails after creating waypoint.db.
    await expect(openDatabases(synced(dir, port))).rejects.toThrow("fetch failed");
    expect((await stat(join(dir, "waypoint.db"))).size).toBe(0);
    await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
    const bin = process.env.TURSODB_BIN;
    if (!bin) return;
    // With a sync server up, the next start bootstraps into the same directory.
    const child = await syncServer(bin, join(dir, "cloud.db"), port);
    try {
      const opened = await openDatabases(synced(dir, port));
      await opened.waypoint.exec("CREATE TABLE IF NOT EXISTS t (x)");
      await opened.syncClient.push();
      await opened.waypoint.close();
      await opened.queue.close();
      await expect(stat(join(dir, "waypoint.db-info"))).resolves.toBeDefined();
      await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
    }
  });
});
