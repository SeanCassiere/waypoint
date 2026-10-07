// Bundles the viewer's browser script and stylesheet. The writer hashes both at startup and
// serves them from /assets/viewer/<hash>.{js,css} with an immutable cache.
import { build } from "esbuild";

const at = (path: string): string => new URL(path, import.meta.url).pathname;

await build({
  entryPoints: [at("src/viewer-client.browser.ts")],
  outfile: at("dist/viewer-client.browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "info",
});

await build({
  entryPoints: [at("src/viewer/viewer.css")],
  outfile: at("dist/viewer.css"),
  bundle: true,
  minify: true,
  logLevel: "info",
});
