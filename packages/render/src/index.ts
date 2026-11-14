import { Worker } from "node:worker_threads";

import { isMarkdown, rendererFor } from "@waypoint/core";

import { CSV_LIMITS, CSV_RENDERER_NAME, CSV_RENDERER_VERSION } from "./csv.ts";
import { fallbackDocument, RENDERER_NAME, RENDERER_VERSION } from "./render.ts";
import { TEXT_LIMITS, TEXT_RENDERER_NAME, TEXT_RENDERER_VERSION } from "./text.ts";
import { decodeSource } from "./view.ts";

export { renderMarkdown, RENDERER_NAME, RENDERER_VERSION } from "./render.ts";
export { renderText, TEXT_LIMITS, TEXT_RENDERER_NAME, TEXT_RENDERER_VERSION } from "./text.ts";
export { renderCsv, CSV_LIMITS, CSV_RENDERER_NAME, CSV_RENDERER_VERSION } from "./csv.ts";

type Result = { bytes: Uint8Array; mime: "text/html" };
/** A renderer of this package: its rendition name, version and render function. */
export type HtmlRenderer = {
  readonly name: string;
  readonly version: number;
  render(source: Uint8Array, mime: string): Promise<Result | null>;
};
/** The worker protocol: a missing `kind` means markdown. */
type WorkerMessage = {
  source: string;
  title?: string;
  kind?: "markdown" | "text" | "csv";
  mime?: string;
  byteLength?: number;
};
type Job = { resolve: (html: string | null) => void; reject: (reason: Error) => void };
type Slot = { worker: Worker; jobs: Map<number, Job>; failed: boolean };

// The worker is a sibling module: dist/render-worker.js next to this bundle (in this package and
// in the writer, whose bundle has a render-worker.js entry), or src/render-worker.ts when this
// module runs from source (tests). Node runs that source directly, resolving workspace packages
// to their source as well.
const fromSource = import.meta.url.endsWith(".ts");
const workerUrl = new URL(
  fromSource ? "./render-worker.ts" : "./render-worker.js",
  import.meta.url,
);
const workerExecArgv = fromSource ? ["--conditions=@waypoint/source"] : [];

/**
 * A pool of render workers, each started on first use: up to `size` slots, each job going to the
 * least-loaded one. A worker that fails rejects every job in its slot, and the slot is replaced
 * on the next job, so a failure stays within its pool.
 */
class WorkerPool {
  private readonly slots: Slot[] = [];
  private nextId = 0;
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }

  private discardSlot(slot: Slot): void {
    if (slot.failed) return;
    slot.failed = true;
    for (const job of slot.jobs.values()) job.reject(new Error("Renderer worker failed"));
    slot.jobs.clear();
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }

  private createSlot(): Slot {
    const worker = new Worker(workerUrl, {
      execArgv: workerExecArgv,
      resourceLimits: { stackSizeMb: 4 },
    });
    const slot: Slot = { worker, jobs: new Map(), failed: false };
    const fail = (): void => this.discardSlot(slot);
    worker.on("message", (message: { id: number; html: string | null }) => {
      const job = slot.jobs.get(message.id);
      if (!job) return;
      slot.jobs.delete(message.id);
      job.resolve(message.html);
      if (slot.jobs.size === 0) worker.unref();
    });
    worker.on("error", fail);
    worker.on("exit", fail);
    worker.unref();
    this.slots.push(slot);
    return slot;
  }

  render(message: WorkerMessage): Promise<string | null> {
    const slot =
      this.slots.length < this.size
        ? this.createSlot()
        : this.slots.reduce((left, right) => (left.jobs.size <= right.jobs.size ? left : right));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      slot.jobs.set(id, { resolve, reject });
      slot.worker.ref();
      try {
        slot.worker.postMessage({ id, ...message }, []);
      } catch (error) {
        slot.jobs.delete(id);
        if (slot.jobs.size === 0) slot.worker.unref();
        this.discardSlot(slot);
        void slot.worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Terminates every worker; jobs in flight are rejected. The next job starts a new one. */
  async close(): Promise<void> {
    const slots = this.slots.splice(0);
    for (const slot of slots) this.discardSlot(slot);
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }
}

/**
 * What markdown renders when its worker fails (crashes, or its pool is closed mid-job): the
 * "could not be rendered" fallback document, or no rendition at all.
 */
export type WorkerFailure = "fallback" | "decline";

function markdownWith(pool: WorkerPool, workerFailure: WorkerFailure): HtmlRenderer {
  return {
    name: RENDERER_NAME,
    version: RENDERER_VERSION,
    async render(source: Uint8Array, mime: string): Promise<Result | null> {
      try {
        if (!isMarkdown(mime)) return null;
      } catch {
        return null;
      }
      // Lossy UTF-8 replacement characters are stable for the same invalid input bytes.
      // ignoreBOM preserves U+FEFF so exactly one leading BOM can be removed.
      const text = new TextDecoder("utf-8", { ignoreBOM: true })
        .decode(source)
        .replace(/^\uFEFF/u, "");
      let html: string;
      try {
        html =
          (await pool.render({ source: text })) ??
          fallbackDocument(text, undefined, "could not be rendered");
      } catch {
        if (workerFailure === "decline") return null;
        html = fallbackDocument(text, undefined, "could not be rendered");
      }
      return { bytes: new TextEncoder().encode(html), mime: "text/html" };
    },
  };
}

/**
 * A text or CSV renderer: the MIME type and size are checked here, the view is built in the worker
 * pool. Unlike markdown there is no fallback document: a worker failure means no rendition.
 */
function viewRenderer(
  pool: WorkerPool,
  kind: "text" | "csv",
  name: string,
  version: number,
  maxBytes: number,
): HtmlRenderer {
  return {
    name,
    version,
    async render(source: Uint8Array, mime: string): Promise<Result | null> {
      if (rendererFor(mime) !== kind || source.byteLength > maxBytes) return null;
      let html: string | null;
      try {
        // The view removes one leading BOM itself, like renderText/renderCsv called directly.
        html = await pool.render({
          source: decodeSource(source),
          kind,
          mime,
          byteLength: source.byteLength,
        });
      } catch {
        return null;
      }
      return html === null ? null : { bytes: new TextEncoder().encode(html), mime: "text/html" };
    },
  };
}

/** Markdown, text and CSV renderers sharing one worker pool. */
export interface HtmlRenderers {
  readonly markdown: HtmlRenderer;
  readonly text: HtmlRenderer;
  readonly csv: HtmlRenderer;
  readonly all: readonly HtmlRenderer[];
  /** Terminates the pool's workers (jobs in flight fail); the next render starts a new one. */
  close(): Promise<void>;
}

function renderersWith(pool: WorkerPool, workerFailure: WorkerFailure): HtmlRenderers {
  const markdown = markdownWith(pool, workerFailure);
  const text = viewRenderer(
    pool,
    "text",
    TEXT_RENDERER_NAME,
    TEXT_RENDERER_VERSION,
    TEXT_LIMITS.maxBytes,
  );
  const csv = viewRenderer(
    pool,
    "csv",
    CSV_RENDERER_NAME,
    CSV_RENDERER_VERSION,
    CSV_LIMITS.maxBytes,
  );
  return { markdown, text, csv, all: [markdown, text, csv], close: () => pool.close() };
}

/**
 * The same renderers with a worker pool of their own, `slots` workers at most (each started on
 * first use), so a caller's jobs never queue behind other work or fail with another pool's
 * worker. Output is identical to the shared renderers'. `workerFailure: "decline"` makes a
 * worker failure no rendition rather than markdown's fallback document, for a caller that would
 * otherwise replace a good older rendition with it (the shared renderers use `fallback`).
 */
export function createRenderers(options: {
  slots: number;
  workerFailure?: WorkerFailure;
}): HtmlRenderers {
  if (!Number.isSafeInteger(options.slots) || options.slots < 1)
    throw new Error("slots must be a positive integer");
  return renderersWith(new WorkerPool(options.slots), options.workerFailure ?? "fallback");
}

/** The shared renderers: two workers, least-loaded first. */
const shared = renderersWith(new WorkerPool(2), "fallback");
export const markdownRenderer: HtmlRenderer = shared.markdown;
export const textRenderer: HtmlRenderer = shared.text;
export const csvRenderer: HtmlRenderer = shared.csv;
export {
  markWords,
  MAX_FRAGMENT_SOURCE,
  relativeLinkResolver,
  renderFragment,
  renderFragments,
  SENTINELS,
  type FragmentLinkResolver,
  type FragmentLinks,
} from "./fragment.ts";
