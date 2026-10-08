// Bundles the viewer's browser scripts and stylesheet into dist/viewer/. The writer hashes them at
// startup and serves them from /assets/viewer/<hash>.{js,css} with an immutable cache.
//
// A turbo task of its own (`build:viewer`): the writer's tests serve these files too, so it reads
// workspace packages from source (`@waypoint/source`, also for this script's own import of
// @waypoint/ui) and needs no library build. Run it with `node --conditions=@waypoint/source`.
import { sharedTokensCss, writerTokensCss } from "@waypoint/ui";
import { build } from "esbuild";

import { viewerCssSource } from "./src/viewer/css.ts";

const at = (path: string): string => new URL(path, import.meta.url).pathname;
const conditions = ["@waypoint/source"];

await build({
  entryPoints: [at("src/client/viewer-client.browser.ts")],
  outfile: at("dist/viewer/viewer-client.browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  conditions,
  minify: true,
  logLevel: "info",
});

await build({
  entryPoints: [at("src/client/viewer-pages.browser.ts")],
  outfile: at("dist/viewer/viewer-pages.browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  conditions,
  minify: true,
  logLevel: "info",
});

// The shared Folio tokens come first, then the writer-only roles, so the shell and the public
// reader can't drift apart; only the writer gets writerTokensCss.
await build({
  stdin: {
    contents: sharedTokensCss + writerTokensCss + viewerCssSource(),
    loader: "css",
    resolveDir: at("src/viewer"),
    sourcefile: "viewer.css",
  },
  outfile: at("dist/viewer/viewer.css"),
  bundle: true,
  minify: true,
  logLevel: "info",
});
