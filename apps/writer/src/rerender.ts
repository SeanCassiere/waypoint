import type { BlobStore } from "./blob-store.ts";
import type { Bucket } from "./bucket.ts";
import { inSeries, type Db } from "./db.ts";
import type { Renderer } from "./ingest.ts";
import { renderSource } from "./render-source.ts";
import { surveyStale } from "./stale.ts";

/**
 * `waypoint-writer rerender`: give existing files a rendition at one renderer's current version
 * (`--renderer markdown|text|csv`, default markdown). Ingest renders only new content, so after a
 * renderer's version bump older revisions keep showing their old rendition until this runs. The
 * scope is every file whose type picks that renderer (`rendererFor`), one renderer per run.
 *
 * It only enqueues: outputs go into the local blob store with `pending_blobs` and
 * `pending_renditions` rows, and the server's committer uploads each output before inserting its
 * `blobs` and `renditions` rows (blob before row), then pushes. It takes the data-directory lock,
 * so it runs while the server is stopped; the server commits the work on its next start.
 * Idempotent and resumable: sources whose newest rendition (committed or queued) is at or above
 * the current version are skipped, so an interrupted run is finished by running it again. The
 * selection is stale.ts's, shared with the background backfill; the CLI includes collections in
 * Trash and processes sources in source-hash order.
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
  /** Distinct source blobs in scope (files whose type picks this renderer). */
  sources: number;
  /** Sources whose newest rendition, committed or queued, is at or above the current version. */
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
  "Usage: waypoint-writer rerender (--all | --collection <id>) [--dry-run] [--limit <n>] [--renderer markdown|text|csv] [--version <n>]";

/** The renderer a rerender run uses: `--renderer`'s value, or markdown. Throws on an unknown name. */
export function rerenderRendererName(args: readonly string[], names: readonly string[]): string {
  const index = args.indexOf("--renderer");
  const name = index >= 0 ? args[index + 1] : "markdown";
  // A missing value is left to parseRerenderArgs ("--renderer needs a value").
  if (name === undefined || name.startsWith("--")) return "markdown";
  if (!names.includes(name))
    throw new Error(`Unknown renderer ${name}; this writer has ${names.join(", ")}`);
  return name;
}

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
  const survey = await surveyStale(waypoint, queue, {
    renderers: [renderer],
    ...(collectionId === undefined ? {} : { collectionId }),
    includeTrashed: true,
    now: now(),
  });
  const total = survey.sources.get(renderer.rendererName) ?? 0;
  // The CLI keeps its source-hash order (the backfill uses the survey's priority order).
  const needed = survey.stale.toSorted((left, right) =>
    left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
  );
  const limit = options.limit ?? needed.length;
  const summary: RerenderSummary = {
    renderer: renderer.rendererName,
    renderer_version: renderer.rendererVersion,
    collection: collectionId ?? null,
    dry_run: options.dryRun,
    sources: total,
    current: total - needed.length,
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
  await inSeries(needed, async (source) => {
    if (summary.queued >= limit) return;
    attempted++;
    const result = await renderSource({ waypoint, queue, blobs, bucket }, renderer, source, {
      timeoutMs,
      now,
    });
    switch (result.status) {
      case "queued":
        summary.queued++;
        return;
      case "fetch_failed":
        console.error(
          `Rerender could not fetch ${source.hash}: ${result.error instanceof Error ? result.error.message : "unknown error"}`,
        );
        summary.missing.push(source.hash);
        return;
      case "missing":
        summary.missing.push(source.hash);
        return;
      // A rendition the blob store can't hold fails this source only, not the run.
      case "declined":
      case "timeout":
      case "output_too_large":
        summary.failed.push(source.hash);
    }
  });
  summary.remaining = needed.length - attempted;
  return summary;
}
