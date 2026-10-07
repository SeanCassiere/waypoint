import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { isContentHash } from "@waypoint/core";
import { z } from "zod";

import type { BlobStore } from "./blob-store.js";
import type { Bucket } from "./bucket.js";
import { blobKey } from "./committer.js";
import { inSeries, type Db } from "./db.js";
import type { Renderer } from "./ingest.js";

/**
 * `waypoint-writer rerender`: give existing markdown blobs a rendition at the current renderer
 * version. Ingest renders only new content, so after a RENDERER_VERSION bump older revisions
 * keep showing their old rendition until this runs.
 *
 * It only enqueues: outputs go into the local blob store with `pending_blobs` and
 * `pending_renditions` rows, and the server's committer uploads each output before inserting its
 * `blobs` and `renditions` rows (blob before row), then pushes. It takes the data-directory lock,
 * so it runs while the server is stopped; the server commits the work on its next start.
 * Idempotent and resumable: sources that already have a current-version rendition (committed or
 * queued) are skipped, so an interrupted run is finished by running it again.
 */
export type RerenderOptions = {
  /** A collection ID or public ID; undefined means every collection. */
  collection?: string;
  dryRun: boolean;
  /**
   * Maximum number of renditions to generate in this run. Sources that turn out missing or fail
   * to render don't count, so every run with renderable sources left makes progress.
   */
  limit?: number;
  timeoutMs?: number;
  now?: () => number;
};
export type RerenderSummary = {
  renderer: string;
  renderer_version: number;
  collection: string | null;
  dry_run: boolean;
  /** Distinct markdown source blobs in scope. */
  sources: number;
  /** Sources that already have a current-version rendition, committed or queued. */
  current: number;
  /** Renditions queued by this run (in a dry run: that would be queued). */
  queued: number;
  /**
   * Sources this run didn't reach because of --limit. Excludes `missing` and `failed`, which
   * another run won't fix, so a loop that repeats while this is above 0 ends.
   */
  remaining: number;
  /** Sources whose blob is neither in the local store nor fetchable from the bucket. */
  missing: string[];
  /** Sources the renderer declined or timed out on; ingest skips these the same way. */
  failed: string[];
};

/**
 * The command's output: the JSON summary, then plain `missing: X` and `failed: Y` counts (their
 * hashes are in the JSON), then a last `remaining: N` line, so a loop can stop when it reads
 * `remaining: 0`. In a dry run nothing is fetched or rendered, so missing and failed are 0 and N
 * counts every source past --limit.
 */
export function formatRerenderSummary(summary: RerenderSummary): string {
  return [
    JSON.stringify(summary),
    `missing: ${summary.missing.length}`,
    `failed: ${summary.failed.length}`,
    `remaining: ${summary.remaining}${summary.dry_run ? " (dry run)" : ""}`,
  ].join("\n");
}

export const RERENDER_USAGE =
  "Usage: waypoint-writer rerender (--all | --collection <id>) [--dry-run] [--limit <n>] [--renderer markdown] [--version <n>]";

export function parseRerenderArgs(
  args: readonly string[],
  renderer: Pick<Renderer, "rendererName" | "rendererVersion">,
): RerenderOptions {
  let all = false;
  let collection: string | undefined;
  let dryRun = false;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--collection") collection = value();
    else if (arg === "--limit") {
      const text = value();
      limit = Number(text);
      if (!/^\d+$/u.test(text) || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error("--limit must be a positive integer");
    } else if (arg === "--renderer") {
      const name = value();
      if (name !== renderer.rendererName)
        throw new Error(`This writer has only the ${renderer.rendererName} renderer`);
    } else if (arg === "--version") {
      const version = value();
      if (version !== String(renderer.rendererVersion))
        throw new Error(
          `This writer renders version ${renderer.rendererVersion}; deploy the matching writer to render version ${version}`,
        );
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (all === (collection !== undefined))
    throw new Error("Pass exactly one of --all or --collection");
  return {
    dryRun,
    ...(collection === undefined ? {} : { collection }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function resolveCollection(waypoint: Db, queue: Db, value: string): Promise<string> {
  const row =
    (await waypoint.get<{ id: string }>("SELECT id FROM collections WHERE id=? OR public_id=?", [
      value,
      value,
    ])) ??
    (await queue.get<{ id: string }>(
      "SELECT id FROM pending_collections WHERE id=? OR public_id=?",
      [value, value],
    ));
  if (!row) throw new Error(`Collection not found: ${value}`);
  return row.id;
}

const manifestFiles = z.object({
  files: z.record(z.string(), z.object({ hash: z.string(), mime: z.string() })),
});
function markdownHashes(manifestJson: string): string[] {
  const parsed = manifestFiles.safeParse(JSON.parse(manifestJson));
  if (!parsed.success) return [];
  return Object.values(parsed.data.files)
    .filter((entry) => entry.mime === "text/markdown" && isContentHash(entry.hash))
    .map((entry) => entry.hash);
}

/** Markdown source hashes in scope: committed files plus files of pending (not failed) revisions. */
async function sources(
  waypoint: Db,
  queue: Db,
  collectionId: string | undefined,
): Promise<string[]> {
  const purging = new Set(
    (await queue.all<{ collection_id: string }>("SELECT collection_id FROM pending_purges")).map(
      (row) => row.collection_id,
    ),
  );
  const hashes = new Set<string>();
  const committed = await waypoint.all<{ collection_id: string; blob_hash: string }>(
    `SELECT DISTINCT r.collection_id, f.blob_hash FROM revision_files f JOIN revisions r ON r.id=f.revision_id WHERE f.mime='text/markdown'${collectionId ? " AND r.collection_id=?" : ""}`,
    collectionId ? [collectionId] : [],
  );
  for (const row of committed) if (!purging.has(row.collection_id)) hashes.add(row.blob_hash);
  const pending = await queue.all<{ collection_id: string; manifest_json: string }>(
    `SELECT collection_id, manifest_json FROM pending_revisions WHERE state='pending'${collectionId ? " AND collection_id=?" : ""}`,
    collectionId ? [collectionId] : [],
  );
  for (const row of pending)
    if (!purging.has(row.collection_id))
      for (const hash of markdownHashes(row.manifest_json)) hashes.add(hash);
  return [...hashes].toSorted();
}

export async function rerender(
  waypoint: Db,
  queue: Db,
  blobs: BlobStore,
  renderer: Renderer,
  options: RerenderOptions,
  bucket?: Bucket,
): Promise<RerenderSummary> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const collectionId =
    options.collection === undefined
      ? undefined
      : await resolveCollection(waypoint, queue, options.collection);
  const all = await sources(waypoint, queue, collectionId);
  const needed: string[] = [];
  await inSeries(all, async (hash) => {
    const existing =
      (await queue.get(
        "SELECT 1 FROM pending_renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
        [hash, renderer.rendererName, renderer.rendererVersion],
      )) ??
      (await waypoint.get(
        "SELECT 1 FROM renditions WHERE source_hash=? AND renderer=? AND renderer_version=?",
        [hash, renderer.rendererName, renderer.rendererVersion],
      ));
    if (!existing) needed.push(hash);
  });
  const limit = options.limit ?? needed.length;
  const summary: RerenderSummary = {
    renderer: renderer.rendererName,
    renderer_version: renderer.rendererVersion,
    collection: collectionId ?? null,
    dry_run: options.dryRun,
    sources: all.length,
    current: all.length - needed.length,
    queued: 0,
    remaining: needed.length,
    missing: [],
    failed: [],
  };
  if (options.dryRun) {
    summary.queued = Math.min(limit, needed.length);
    summary.remaining = needed.length - summary.queued;
    return summary;
  }
  // Attempt sources in order until `limit` are queued; missing and failed ones don't use up the
  // limit, so a run never stalls on sources that can't be rendered.
  let attempted = 0;
  await inSeries(needed, async (hash) => {
    if (summary.queued >= limit) return;
    attempted++;
    if (!(await blobs.has(hash))) {
      // A writer bootstrapped from the cloud fetches blobs lazily; get the source like the viewer would.
      const stored = await waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [hash]);
      if (!bucket || !stored) {
        summary.missing.push(hash);
        return;
      }
      try {
        await blobs.put(await bucket.get(blobKey(hash)), hash);
      } catch (error) {
        console.error(
          `Rerender could not fetch ${hash}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        summary.missing.push(hash);
        return;
      }
    }
    const source = await readFile(blobs.path(hash));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rendered: Awaited<ReturnType<Renderer["render"]>>;
    try {
      rendered = await Promise.race([
        renderer.render(source, "text/markdown"),
        new Promise<null>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Renderer timeout")), timeoutMs);
        }),
      ]);
    } catch {
      rendered = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!rendered) {
      summary.failed.push(hash);
      return;
    }
    const output = await blobs.put(Readable.from([Buffer.from(rendered.bytes)]));
    const stored = await waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [output.hash]);
    await queue.transaction(async (tx) => {
      if (!stored)
        await tx.run("INSERT OR IGNORE INTO pending_blobs (hash,size) VALUES (?,?)", [
          output.hash,
          output.size,
        ]);
      await tx.run(
        "INSERT OR IGNORE INTO pending_renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
        [hash, renderer.rendererName, renderer.rendererVersion, output.hash, rendered.mime, now()],
      );
    });
    summary.queued++;
  });
  summary.remaining = needed.length - attempted;
  return summary;
}
