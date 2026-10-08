import { defineConfig } from "tsdown";

// Runtime-agnostic: the reader (Workers) and the writer and its viewer bundle it.
export default defineConfig({
  entry: ["src/index.ts"],
  platform: "neutral",
  target: "es2023",
  fixedExtension: false,
  // One output module per source module, so consumers' bundlers drop unused modules
  // (`sideEffects: false`) as precisely as they did with tsc's output.
  unbundle: true,
  dts: { generator: "oxc" },
});
