import { mkdir, open, readFile, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

async function processStartTick(pid: number): Promise<string | undefined> {
  try {
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    return processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
export async function ownDataDirectory(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "writer.lock");
  let handle: FileHandle;
  let initialized = false;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    // Only one process may inspect and replace a stale owner at a time.
    const reclaim = join(directory, "writer.lock.reclaim");
    try {
      await mkdir(reclaim);
    } catch (reclaimError) {
      throw new Error("Data directory lock is being reclaimed by another process", {
        cause: reclaimError,
      });
    }
    try {
      const [pidText, startTick] = (await readFile(path, "utf8")).trim().split(":");
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Data directory lock is being initialized", { cause: error });
      let active = false;
      try {
        process.kill(pid, 0);
        active = true;
      } catch (checkError) {
        if (!(checkError instanceof Error && "code" in checkError && checkError.code === "ESRCH"))
          throw checkError;
      }
      const currentStartTick = await processStartTick(pid);
      if (active && (!startTick || !currentStartTick || startTick === currentStartTick))
        throw new Error(`Data directory is already owned by process ${pid}`, { cause: error });
      await unlink(path);
      handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}:${(await processStartTick(process.pid)) ?? ""}`);
      await handle.sync();
      initialized = true;
    } finally {
      await rmdir(reclaim);
    }
  }
  if (!initialized) {
    await handle.writeFile(`${process.pid}:${(await processStartTick(process.pid)) ?? ""}`);
    await handle.sync();
  }
  return async () => {
    const owned = await handle.stat();
    const current = await stat(path);
    await handle.close();
    if (owned.dev === current.dev && owned.ino === current.ino) await unlink(path);
  };
}
