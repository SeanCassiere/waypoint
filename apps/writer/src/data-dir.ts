import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { connect } from "@tursodatabase/database";

/** Who holds the data directory, for the error a second process reports. Diagnostics only. */
export interface LockOwner {
  pid: number;
  hostname: string;
  command: string;
  started_at: string;
}

export const LOCK_FILE = "writer-lock.db";
export const OWNER_FILE = "writer-lock.json";

/** Directories this process holds. POSIX record locks don't exclude the process that holds them. */
const held = new Set<string>();

function describeOwner(owner: LockOwner | undefined): string {
  if (!owner) return "another process (owner unknown)";
  return `process ${owner.pid} on host ${owner.hostname} (${owner.command}, since ${owner.started_at})`;
}
async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      "hostname" in parsed &&
      typeof parsed.hostname === "string" &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      "started_at" in parsed &&
      typeof parsed.started_at === "string"
    )
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        command: parsed.command,
        started_at: parsed.started_at,
      };
  } catch {
    // Missing or half-written: the owner is between taking the lock and describing itself.
  }
  return undefined;
}

/**
 * Takes the data directory for this process until the returned release function runs.
 *
 * The lock is the OS-level POSIX record lock Turso holds on `writer-lock.db` while the file is
 * open. The kernel releases it when the process exits, however it exits, and it works across
 * containers sharing the directory (PID checks don't: each container has its own PID namespace).
 * So there is no stale lock to reclaim and nothing ever deletes the lock file. The owner writes
 * `writer-lock.json` (PID, hostname, command) for diagnostics and removes it only while it still
 * holds the lock.
 */
export async function ownDataDirectory(
  directory: string,
  command = process.argv.slice(2).join(" ") || "writer",
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await realpath(directory);
  if (held.has(key))
    throw new Error(`Data directory is already owned by this process (${process.pid})`);
  held.add(key);
  let lock: Awaited<ReturnType<typeof connect>>;
  try {
    lock = await connect(join(directory, LOCK_FILE));
  } catch (error) {
    held.delete(key);
    if (error instanceof Error && /lock/i.test(error.message))
      throw new Error(
        `Data directory is already owned by ${describeOwner(await readOwner(directory))}`,
        { cause: error },
      );
    throw error;
  }
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    command,
    started_at: new Date().toISOString(),
  };
  const ownerPath = join(directory, OWNER_FILE);
  try {
    await writeFile(`${ownerPath}.tmp`, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await rename(`${ownerPath}.tmp`, ownerPath);
  } catch (error) {
    await lock.close();
    held.delete(key);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await unlink(ownerPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    } finally {
      await lock.close();
      held.delete(key);
    }
  };
}
