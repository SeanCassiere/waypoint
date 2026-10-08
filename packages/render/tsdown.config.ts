import { defineConfig } from "tsdown";

// The renderer and its worker thread, a sibling entry (dist/render-worker.js) that index.js starts.
// Dependencies stay external.
export default defineConfig({
  entry: ["src/index.ts", "src/render-worker.ts"],
  platform: "node",
  target: "node24",
  fixedExtension: false,
  // One output module per source module, so consumers' bundlers drop unused modules
  // (`sideEffects: false`) as precisely as they did with tsc's output.
  unbundle: true,
  dts: { generator: "oxc" },
});
