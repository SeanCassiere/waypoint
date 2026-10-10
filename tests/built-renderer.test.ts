// The renderer as built: the @waypoint/render package (tsdown) and the writer's bundle, which
// inlines it and starts dist/render-worker.js, render the golden fixture byte for byte like the
// source does (packages/render/tests). Turbo builds both before this suite.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

import { GOLDEN_HASH, goldenInputs } from "../packages/render/tests/golden.ts";

function built(path: string): URL {
  const url = new URL(path, import.meta.url);
  if (!existsSync(url)) throw new Error(`${fileURLToPath(url)} is missing: run pnpm build`);
  return url;
}

it("renders the golden output from the built package in a fresh process", async () => {
  const module = built("../packages/render/dist/render.js").href;
  const script = `import { createHash } from "node:crypto";
import { text } from "node:stream/consumers";
const { renderMarkdown } = await import(${JSON.stringify(module)});
const hash = createHash("sha256");
for (const [source, title] of JSON.parse(await text(process.stdin)))
  hash.update(await renderMarkdown(source, title === null ? undefined : { title }));
process.stdout.write(hash.digest("hex"));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(JSON.stringify(goldenInputs()));
  const [stdout, code] = await Promise.all([
    text(child.stdout),
    new Promise<number | null>((resolve) => child.on("exit", resolve)),
  ]);
  expect(code).toBe(0);
  expect(stdout).toBe(GOLDEN_HASH);
});

it("renders the golden output in the writer bundle's render worker", async () => {
  const worker = new Worker(built("../apps/writer/dist/render-worker.js"), { execArgv: [] });
  try {
    const inputs = goldenInputs();
    const outputs = await new Promise<string[]>((resolve, reject) => {
      const html: string[] = [];
      let pending = inputs.length;
      worker.on("error", reject);
      worker.on("message", (message: { id: number; html: string }) => {
        html[message.id] = message.html;
        if (--pending === 0) resolve(html);
      });
      for (const [id, [source, title]] of inputs.entries())
        worker.postMessage(title === null ? { id, source } : { id, source, title }, []);
    });
    const hash = createHash("sha256");
    for (const output of outputs) hash.update(output);
    expect(hash.digest("hex")).toBe(GOLDEN_HASH);
  } finally {
    await worker.terminate();
  }
});
