import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import type { BlobStore } from "./blob-store.ts";
import type { Bucket } from "./bucket.ts";
import { blobKey } from "./committer.ts";
import type { Db } from "./db.ts";
import type { Renderer, Rendition } from "./ingest.ts";

/**
 * Rendering one source at a renderer's current version, shared by `waypoint-writer rerender` and
 * the background backfill: fetch the source if it isn't local, render it with a timeout, store
 * the output and queue its `pending_blobs` and `pending_renditions` rows. The committer uploads
 * the output and commits the rows later (blob before row), exactly as for ingest's renditions.
 *
 * `renderSource` runs the steps in order; each step is exported too, so a caller that must hold
 * a lock around some of them (but not the render) can run them itself.
 */

export interface RenderSourceDeps {
  waypoint: Db;
  queue: Db;
  blobs: BlobStore;
  bucket?: Bucket | undefined;
  /** The background backfill's blob writes, which don't count as blob activity (BlobStore). */
  background?: boolean;
}

export type FetchOutcome =
  | { status: "present" }
  /** No local copy and nothing to fetch: no `blobs` row, or no bucket. */
  | { status: "missing" }
  /** The bucket download failed; `error` says why (a `BucketError` is transient or permanent). */
  | { status: "fetch_failed"; error: unknown };

/** Makes the source local: a writer bootstrapped from the cloud fetches blobs lazily, as the viewer does. */
export async function ensureLocalSource(
  deps: RenderSourceDeps,
  hash: string,
): Promise<FetchOutcome> {
  if (await deps.blobs.has(hash)) return { status: "present" };
  const stored = await deps.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [hash]);
  if (!deps.bucket || !stored) return { status: "missing" };
  try {
    await deps.blobs.put(await deps.bucket.get(blobKey(hash)), hash, {
      background: Boolean(deps.background),
    });
    return { status: "present" };
  } catch (error) {
    return { status: "fetch_failed", error };
  }
}

export function readSource(blobs: BlobStore, hash: string): Promise<Uint8Array> {
  return readFile(blobs.path(hash));
}

export type RenderOutcome =
  | { status: "rendered"; rendition: Rendition }
  /** The renderer returned no rendition or threw (ingest skips such sources the same way). */
  | { status: "declined" }
  | { status: "timeout" };

/** Starts a timer and returns its cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export async function renderWithTimeout(
  renderer: Renderer,
  source: Uint8Array,
  mime: string,
  timeoutMs: number,
  setTimer: SetTimer = realTimer,
): Promise<RenderOutcome> {
  const timedOut = Symbol("timeout");
  let cancel: (() => void) | undefined;
  try {
    const result = await Promise.race([
      renderer.render(source, mime),
      new Promise<typeof timedOut>((resolve) => {
        cancel = setTimer(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (result === timedOut) return { status: "timeout" };
    return result ? { status: "rendered", rendition: result } : { status: "declined" };
  } catch {
    return { status: "declined" };
  } finally {
    cancel?.();
  }
}

export type QueueOutcome =
  | { status: "queued"; outputHash: string }
  /** The output is over the blob limit: no rendition, as at ingest. */
  | { status: "output_too_large" };

/**
 * Stores the output and queues its rows in one queue transaction. `onStored` sees the output's
 * hash once it's stored and before its rows are queued (the backfill holds it from GC there).
 */
export async function queueRendition(
  deps: Pick<RenderSourceDeps, "waypoint" | "queue" | "blobs" | "background">,
  renderer: Pick<Renderer, "rendererName" | "rendererVersion">,
  hash: string,
  rendition: Rendition,
  now: number,
  onStored?: (outputHash: string) => void,
): Promise<QueueOutcome> {
  if (rendition.bytes.byteLength > deps.blobs.maxBlobBytes) return { status: "output_too_large" };
  const output = await deps.blobs.put(Readable.from([Buffer.from(rendition.bytes)]), undefined, {
    background: Boolean(deps.background),
  });
  onStored?.(output.hash);
  const stored = await deps.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [output.hash]);
  await deps.queue.transaction(async (tx) => {
    if (!stored)
      await tx.run("INSERT OR IGNORE INTO pending_blobs (hash,size) VALUES (?,?)", [
        output.hash,
        output.size,
      ]);
    await tx.run(
      "INSERT OR IGNORE INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [hash, renderer.rendererName, renderer.rendererVersion, output.hash, rendition.mime, now],
    );
  });
  return { status: "queued", outputHash: output.hash };
}

export type RenderSourceResult =
  | QueueOutcome
  | Exclude<FetchOutcome, { status: "present" }>
  | Exclude<RenderOutcome, { status: "rendered" }>;

/** Fetches if missing, renders with a timeout, stores the output and queues its rows. */
export async function renderSource(
  deps: RenderSourceDeps,
  renderer: Renderer,
  source: { hash: string; mime: string },
  options: { timeoutMs: number; now: () => number },
): Promise<RenderSourceResult> {
  const fetched = await ensureLocalSource(deps, source.hash);
  if (fetched.status !== "present") return fetched;
  const bytes = await readSource(deps.blobs, source.hash);
  const rendered = await renderWithTimeout(renderer, bytes, source.mime, options.timeoutMs);
  if (rendered.status !== "rendered") return rendered;
  return queueRendition(deps, renderer, source.hash, rendered.rendition, options.now());
}
