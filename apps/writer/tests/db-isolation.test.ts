import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { Config } from "../src/config.ts";
import { openDatabases } from "../src/db.ts";
function noop(): void {}
describe("Db connection isolation", () => {
  it("holds all outside statements until a transaction exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-isolation-"));
    const config: Config = {
      environment: "dev",
      dataDir: dir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    };
    const { queue, waypoint } = await openDatabases(config);
    try {
      await queue.exec("CREATE TABLE t (value TEXT)");
      let release: () => void = noop;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = noop;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const transaction = queue.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES ('rolled-back')");
        started();
        await gate;
        throw new Error("rollback");
      });
      await began;
      let outsideDone = false;
      const outside = queue.run("INSERT INTO t VALUES ('outside')").then(() => {
        outsideDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(outsideDone).toBe(false);
      release();
      await expect(transaction).rejects.toThrow("rollback");
      await outside;
      expect(await queue.all<{ value: string }>("SELECT value FROM t")).toEqual([
        { value: "outside" },
      ]);
    } finally {
      await queue.close();
      await waypoint.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
