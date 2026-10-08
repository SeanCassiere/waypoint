import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

const writerMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const writerTsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const tsxCli = join(
  dirname(
    createRequire(new URL("../../../package.json", import.meta.url)).resolve("tsx/package.json"),
  ),
  "dist/cli.mjs",
);
/** Runs the real writer CLI from source with only the given environment. */
async function runWriter(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [tsxCli, "--tsconfig", writerTsconfig, "--conditions=@waypoint/source", writerMain, ...args],
    { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { code, stderr };
}

describe("data directory sync mode", () => {
  it("refuses restore under WAYPOINT_SYNC=off before touching the data directory", async () => {
    // A cloud-synced replica: opening it with sync off would fail with a different error, so the
    // restore refusal has to come first. A missing directory must not get created either.
    const replica = await scratch("waypoint.db", "waypoint.db-info");
    const missing = join(await scratch(), "never-created");
    for (const dataDir of [replica, missing])
      for (const mode of ["--from-bucket", "--merge"]) {
        const { code, stderr } = await runWriter(["restore", mode], {
          WAYPOINT_ENV: "prod",
          WAYPOINT_SYNC: "off",
          WAYPOINT_DATA_DIR: dataDir,
        });
        expect(code).toBe(1);
        expect(stderr).toContain("restore needs cloud sync");
      }
    expect((await readdir(replica)).toSorted()).toEqual(["waypoint.db", "waypoint.db-info"]);
    await expect(stat(missing)).rejects.toThrow("ENOENT");
  }, 30_000);

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
  it("names an interrupted first sync instead of blaming local-only mode", async () => {
    const dir = await scratch("waypoint.db-bootstrap");
    await writeFile(join(dir, "waypoint.db"), "x");
    for (const sync of [true, false])
      await expect(checkSyncMode({ dataDir: dir, sync })).rejects.toThrow(
        "a first cloud sync into it was interrupted",
      );
  });
  it("drops a failed first sync's marker when the directory goes local-only", async () => {
    const dir = await scratch("waypoint.db", "waypoint.db-bootstrap");
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
    await expect(stat(join(dir, "waypoint.db-bootstrap"))).rejects.toThrow("ENOENT");
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
    await expect(stat(join(dir, "waypoint.db-bootstrap"))).resolves.toBeDefined();
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
      await expect(stat(join(dir, "waypoint.db-bootstrap"))).rejects.toThrow("ENOENT");
      await expect(checkSyncMode({ dataDir: dir, sync: true })).resolves.toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
    }
  });
});
