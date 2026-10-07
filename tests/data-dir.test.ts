import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { ownDataDirectory } from "../apps/writer/src/data-dir.js";
describe("writer data directory", () => {
  it("allows one owner and releases the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-"));
    try {
      const release = await ownDataDirectory(dir);
      await expect(ownDataDirectory(dir)).rejects.toThrow("already owned");
      await release();
      const second = await ownDataDirectory(dir);
      await second();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== "linux")("reclaims a lock from a reused process ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-stale-lock-"));
    try {
      await writeFile(join(dir, "writer.lock"), `${process.pid}:old-start-tick`);
      const release = await ownDataDirectory(dir);
      expect(await readFile(join(dir, "writer.lock"), "utf8")).not.toContain("old-start-tick");
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== "linux")(
    "allows only one concurrent stale-lock reclaimer",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "waypoint-stale-race-"));
      try {
        await writeFile(join(dir, "writer.lock"), `${process.pid}:old-start-tick`);
        const results = await Promise.allSettled([ownDataDirectory(dir), ownDataDirectory(dir)]);
        const owners = results.filter((result) => result.status === "fulfilled");
        expect(owners).toHaveLength(1);
        for (const owner of owners) if (owner.status === "fulfilled") await owner.value();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
