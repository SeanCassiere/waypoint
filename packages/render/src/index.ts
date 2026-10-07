import { Worker } from "node:worker_threads";

import { isMarkdown } from "@waypoint/core";

import { fallbackDocument, RENDERER_NAME, RENDERER_VERSION } from "./render.js";

export { renderMarkdown, RENDERER_NAME, RENDERER_VERSION } from "./render.js";

type Result = { bytes: Uint8Array; mime: "text/html" };
type Renderer = {
  readonly name: typeof RENDERER_NAME;
  readonly version: typeof RENDERER_VERSION;
  render(source: Uint8Array, mime: string): Promise<Result | null>;
};
type Job = { resolve: (html: string) => void; reject: (reason: Error) => void };
type Slot = { worker: Worker; jobs: Map<number, Job>; failed: boolean };

const slots: Slot[] = [];
let nextId = 0;
const workerUrl = new URL("./worker.js", import.meta.resolve("@waypoint/render"));

function discardSlot(slot: Slot): void {
  if (slot.failed) return;
  slot.failed = true;
  for (const job of slot.jobs.values()) job.reject(new Error("Renderer worker failed"));
  slot.jobs.clear();
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
}

function createSlot(): Slot {
  const worker = new Worker(workerUrl, { execArgv: [], resourceLimits: { stackSizeMb: 4 } });
  const slot: Slot = { worker, jobs: new Map(), failed: false };
  function fail(): void {
    discardSlot(slot);
  }
  worker.on("message", (message: { id: number; html: string }) => {
    const job = slot.jobs.get(message.id);
    if (!job) return;
    slot.jobs.delete(message.id);
    job.resolve(message.html);
    if (slot.jobs.size === 0) worker.unref();
  });
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.unref();
  slots.push(slot);
  return slot;
}

function renderInWorker(source: string): Promise<string> {
  const slot =
    slots.length < 2
      ? createSlot()
      : slots.reduce((left, right) => (left.jobs.size <= right.jobs.size ? left : right));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    slot.jobs.set(id, { resolve, reject });
    slot.worker.ref();
    try {
      slot.worker.postMessage({ id, source }, []);
    } catch (error) {
      slot.jobs.delete(id);
      if (slot.jobs.size === 0) slot.worker.unref();
      discardSlot(slot);
      void slot.worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const markdownRenderer = {
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
      html = await renderInWorker(text);
    } catch {
      html = fallbackDocument(text, undefined, "could not be rendered");
    }
    return { bytes: new TextEncoder().encode(html), mime: "text/html" };
  },
} as const satisfies Renderer;
export {
  markWords,
  MAX_FRAGMENT_SOURCE,
  renderFragment,
  renderFragments,
  SENTINELS,
} from "./fragment.js";
