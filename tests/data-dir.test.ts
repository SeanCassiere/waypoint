import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { LOCK_FILE, OWNER_FILE, ownDataDirectory } from "../apps/writer/src/data-dir.js";

const dataDirModule = fileURLToPath(new URL("../apps/writer/src/data-dir.ts", import.meta.url));
// The child takes the lock, reports, and holds it until stdin closes or the test kills it.
const holderSource = `
const { ownDataDirectory } = await import(${JSON.stringify(dataDirModule)});
try {
  const release = await ownDataDirectory(process.argv[1], "test-holder");
  process.stdout.write("locked\\n");
  process.stdin.resume();
  process.stdin.on("end", () => void release().then(() => process.exit(0)));
} catch (error) {
  process.stdout.write("refused: " + error.message + "\\n");
  process.exit(3);
}
`;

/** Starts a process that takes the lock; resolves with its first line of output. */
function holder(dir: string): { child: ChildProcess; line: Promise<string> } {
  const args = ["--experimental-strip-types", "--input-type=module", "-e", holderSource, dir];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const line = new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(output.split("\n")[0] ?? "");
    });
    child.once("exit", (code) => resolve(output.split("\n")[0] || `exit ${code}`));
    child.once("error", reject);
  });
  return { child, line };
}
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));

describe("writer data directory", () => {
  it("allows one owner per process and releases the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-"));
    try {
      const release = await ownDataDirectory(dir, "first");
      await expect(ownDataDirectory(dir)).rejects.toThrow("already owned");
      const owner: unknown = JSON.parse(await readFile(join(dir, OWNER_FILE), "utf8"));
      expect(owner).toMatchObject({ pid: process.pid, hostname: hostname(), command: "first" });
      await release();
      await expect(stat(join(dir, OWNER_FILE))).rejects.toThrow("ENOENT");
      // The lock file itself is never deleted.
      expect((await stat(join(dir, LOCK_FILE))).isFile()).toBe(true);
      const second = await ownDataDirectory(dir);
      await second();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second process while the owner lives, without touching its files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-procs-"));
    const first = holder(dir);
    try {
      expect(await first.line).toBe("locked");
      const ownerBefore = await readFile(join(dir, OWNER_FILE), "utf8");
      const lockBefore = await stat(join(dir, LOCK_FILE));
      const second = holder(dir);
      const refused = await second.line;
      expect(refused).toContain("refused: Data directory is already owned by process");
      expect(refused).toContain(`process ${first.child.pid} on host ${hostname()}`);
      expect(refused).toContain("test-holder");
      await exited(second.child);
      expect(second.child.exitCode).toBe(3);
      // In-process too: this test process doesn't hold the lock, so it's refused the same way.
      await expect(ownDataDirectory(dir)).rejects.toThrow(
        `already owned by process ${first.child.pid}`,
      );
      expect(await readFile(join(dir, OWNER_FILE), "utf8")).toBe(ownerBefore);
      expect((await stat(join(dir, LOCK_FILE))).ino).toBe(lockBefore.ino);
    } finally {
      first.child.kill("SIGKILL");
      await exited(first.child);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is free again as soon as a crashed owner is gone, and only then", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-crash-"));
    try {
      const first = holder(dir);
      expect(await first.line).toBe("locked");
      await expect(ownDataDirectory(dir)).rejects.toThrow("already owned");
      first.child.kill("SIGKILL");
      await exited(first.child);
      // The crashed owner's description is left behind; the lock itself is gone with it.
      expect(await readFile(join(dir, OWNER_FILE), "utf8")).toContain("test-holder");
      const release = await ownDataDirectory(dir, "after-crash");
      expect(await readFile(join(dir, OWNER_FILE), "utf8")).toContain("after-crash");
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores and keeps a writer.lock left by an older version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-legacy-"));
    try {
      await writeFile(join(dir, "writer.lock"), "1:12345");
      const release = await ownDataDirectory(dir);
      await release();
      expect(await readFile(join(dir, "writer.lock"), "utf8")).toBe("1:12345");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets only one of several concurrent processes take the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-lock-race-"));
    const racers = Array.from({ length: 4 }, () => holder(dir));
    try {
      const lines = await Promise.all(racers.map((racer) => racer.line));
      expect(lines.filter((line) => line === "locked")).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("refused:"))).toHaveLength(3);
    } finally {
      for (const racer of racers) racer.child.kill("SIGKILL");
      await Promise.all(racers.map((racer) => exited(racer.child)));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
