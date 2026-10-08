import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
});
