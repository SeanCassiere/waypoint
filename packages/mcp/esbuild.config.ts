import { build } from "esbuild";

// The launcher stays on esbuild, unchanged: npx caches it indefinitely, so it must stay
// backward-compatible. The server bundle is built by tsdown (tsdown.config.ts), which runs first
// and cleans dist/.
await build({
  entryPoints: ["src/launcher.ts"],
  outfile: "dist/launcher.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["node:*"],
  minify: true,
  banner: { js: "// Cached indefinitely by npx. Keep this launcher backward-compatible." },
});
