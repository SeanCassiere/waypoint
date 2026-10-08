import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, STATEMENT_CACHE_SIZE, type Db } from "../apps/writer/src/db.ts";

let dir: string;
let queue: Db;
let waypoint: Db;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-statements-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024,
    sync: false,
  };
  ({ queue, waypoint } = await openDatabases(config));
  await queue.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
});
afterEach(async () => {
  await queue.close();
  await waypoint.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Prepared statement cache", () => {
  it("reuses one statement per SQL string, bounded, with correct bindings", async () => {
    for (let index = 0; index < 50; index++)
      await queue.run("INSERT INTO t (id,value) VALUES (?,?)", [index, `v${index}`]);
    expect(queue.cachedStatements).toBe(1);
    for (let index = 0; index < 50; index++)
      expect(await queue.get<{ value: string }>("SELECT value FROM t WHERE id=?", [index])).toEqual(
        { value: `v${index}` },
      );
    expect(queue.cachedStatements).toBe(2);
    for (let index = 0; index < STATEMENT_CACHE_SIZE + 40; index++)
      await queue.get(`SELECT value FROM t WHERE id=? AND ${index}=${index}`, [1]);
    expect(queue.cachedStatements).toBe(STATEMENT_CACHE_SIZE);
  });

  it("keeps bindings apart when a transaction runs the same SQL concurrently", async () => {
    for (let index = 0; index < 20; index++)
      await queue.run("INSERT INTO t (id,value) VALUES (?,?)", [index, `v${index}`]);
    const values = await queue.transaction((tx) =>
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          tx.get<{ value: string }>("SELECT value FROM t WHERE id=?", [index]),
        ),
      ),
    );
    expect(values.map((row) => row?.value)).toEqual(
      Array.from({ length: 20 }, (_, index) => `v${index}`),
    );
  });

  it("drops cached statements on schema changes, so a stale one never runs", async () => {
    await queue.run("INSERT INTO t (id,value) VALUES (1,'a')");
    expect(await queue.all("SELECT * FROM t")).toEqual([{ id: 1, value: "a" }]);
    // Running a statement prepared before this ALTER aborts the process inside the engine.
    await queue.transaction((tx) => tx.exec("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'x'"));
    expect(await queue.all("SELECT * FROM t")).toEqual([{ id: 1, value: "a", extra: "x" }]);
    await queue.run("CREATE TABLE u (k TEXT)");
    await queue.run("DROP TABLE t");
    await queue.run("CREATE TABLE t (other TEXT)");
    await queue.run("INSERT INTO t (other) VALUES ('b')");
    expect(await queue.all("SELECT * FROM t")).toEqual([{ other: "b" }]);
  });

  it("prepares a statement afresh after it fails", async () => {
    await queue.run("INSERT INTO t (id,value) VALUES (1,'a')");
    await expect(queue.run("INSERT INTO t (id,value) VALUES (?,?)", [1, "dup"])).rejects.toThrow(
      /UNIQUE|constraint/i,
    );
    await queue.run("INSERT INTO t (id,value) VALUES (?,?)", [2, "b"]);
    expect(await queue.all("SELECT value FROM t ORDER BY id")).toEqual([
      { value: "a" },
      { value: "b" },
    ]);
  });

  // Each prepared-and-never-closed statement used to leak about 12.5 KB of native memory
  // (50,000 reads: about 600 MB); closing each one still leaks about 2.5 KB (about 125 MB).
  // Reusing statements keeps growth to allocator noise. The bound is generous on purpose.
  it("keeps RSS roughly flat across 50,000 queries", async () => {
    const sql = "SELECT value FROM t WHERE id=?";
    for (let index = 0; index < 2000; index++) await queue.get(sql, [index]);
    const before = process.memoryUsage().rss;
    for (let index = 0; index < 50_000; index++) await queue.get(sql, [index]);
    const grownMb = (process.memoryUsage().rss - before) / 1048576;
    expect(grownMb).toBeLessThan(60);
  }, 60_000);
});
