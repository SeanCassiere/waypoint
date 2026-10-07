// Bundles the viewer's browser script and stylesheet. The writer hashes both at startup and
// serves them from /assets/viewer/<hash>.{js,css} with an immutable cache.
import { readFile } from "node:fs/promises";

import { tokensCss } from "@waypoint/ui";
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
  entryPoints: [at("src/viewer-pages.browser.ts")],
  outfile: at("dist/viewer-pages.browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "info",
});

// The shared Folio tokens come first so the shell and the public reader can't drift apart.
await build({
  stdin: {
    contents: tokensCss + (await readFile(at("src/viewer/viewer.css"), "utf8")),
    loader: "css",
    resolveDir: at("src/viewer"),
    sourcefile: "viewer.css",
  },
  outfile: at("dist/viewer.css"),
  bundle: true,
  minify: true,
  logLevel: "info",
});
