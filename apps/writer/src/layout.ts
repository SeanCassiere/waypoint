// Where the writer's own files are. The writer runs bundled (dist/main.js plus its worker entries
// and chunks, all in one flat directory, also in the image as /app/dist) or from source
// (src/*.ts, in tests). Keep this module directly in src/ so both cases resolve the same way.
import { fileURLToPath } from "node:url";

const fromSource = import.meta.url.endsWith(".ts");

/** The bundle directory: apps/writer/dist/ (/app/dist/ in the image). */
export const distDirectory: URL = new URL(fromSource ? "../dist/" : "./", import.meta.url);

/** A file in the repository checkout (the MCP bundles and skill when not in the image). */
export function checkoutPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, distDirectory));
}

/**
 * A worker-thread entry: the sibling bundle, or its source, which Node runs directly with
 * workspace packages resolved to their source too.
 */
export function workerEntry(name: "compare-worker"): { url: URL; execArgv: string[] } {
  return fromSource
    ? { url: new URL(`./${name}.ts`, import.meta.url), execArgv: ["--conditions=@waypoint/source"] }
    : { url: new URL(`./${name}.js`, import.meta.url), execArgv: [] };
}
