// The diff worker thread started by DiffWorkers (compare.ts): one job at a time, a diff or a
// batch of Changes-page Markdown fragments. A bundle entry of its own (dist/compare-worker.js).
import { parentPort } from "node:worker_threads";

import { DIFF_TIME_BUDGET_MS, diffFile, type WorkerJob } from "./compare.ts";

if (!parentPort) throw new Error("The diff worker requires a parent port");
const port = parentPort;
// Loaded only here: the fragment renderer is heavy, and only workers render fragments.
const { renderFragments } = await import("@waypoint/render");
port.on("message", (job: WorkerJob) => {
  const result =
    job.kind === "diff"
      ? diffFile(job.file, job.base, job.head, job.mode)
      : renderFragments(job.sources, DIFF_TIME_BUDGET_MS);
  port.postMessage(result, []);
});
