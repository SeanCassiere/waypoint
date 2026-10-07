import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isContentHash, WaypointError } from "@waypoint/core";
async function createChild(parentPath: string, segment: string): Promise<string> {
  const child = join(parentPath, segment);
  try {
    await mkdir(child);
    const parent = await open(parentPath, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return child;
}
export class BlobStore {
  private activeWrites = 0;
  private idleWaiters = new Set<() => void>();
  constructor(
    readonly dataDir: string,
    readonly maxBlobBytes: number,
  ) {}
  path(hash: string): string {
    if (!isContentHash(hash)) throw new WaypointError("validation_failed", "Invalid content hash");
    const hex = hash.slice(7);
    return join(this.dataDir, "blobs", "sha256", hex.slice(0, 2), hex);
  }
  async has(hash: string): Promise<boolean> {
    const path = this.path(hash);
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  async size(hash: string): Promise<number> {
    try {
      return (await stat(this.path(hash))).size;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new WaypointError("blob_missing", "Blob not found");
      throw error;
    }
  }
  open(hash: string): Readable {
    return createReadStream(this.path(hash));
  }
  async sweepTemps(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dataDir))
      if (name.startsWith(".blob-")) await unlink(join(this.dataDir, name));
  }
  async delete(hash: string): Promise<void> {
    await unlink(this.path(hash)).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
  waitForIdle(): Promise<void> {
    if (this.activeWrites === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
  async put(source: Readable, claimedHash?: string): Promise<{ hash: string; size: number }> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.activeWrites++;
    const temp = join(this.dataDir, `.blob-${randomUUID()}`);
    const digest = createHash("sha256");
    let size = 0;
    try {
      const maxBlobBytes = this.maxBlobBytes;
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxBlobBytes)
              throw new WaypointError("blob_too_large", "Blob exceeds configured limit");
            digest.update(bytes);
            yield bytes;
          }
        },
        createWriteStream(temp, { flags: "wx" }),
      );
      const hash = `sha256:${digest.digest("hex")}`;
      if (claimedHash !== undefined && hash !== claimedHash)
        throw new WaypointError("blob_hash_mismatch", "Blob hash does not match claim");
      const handle = await open(temp, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const dest = this.path(hash);
      const blobDir = await createChild(this.dataDir, "blobs");
      const shaDir = await createChild(blobDir, "sha256");
      const directory = await createChild(shaDir, hash.slice(7, 9));
      if (!(await this.has(hash))) {
        await rename(temp, dest);
        const folder = await open(directory, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      }
      return { hash, size };
    } finally {
      await unlink(temp).catch(() => undefined);
      this.activeWrites--;
      if (this.activeWrites === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }
}
