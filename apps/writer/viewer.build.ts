// Bundles the viewer's browser scripts and stylesheet into dist/viewer/. The writer hashes them at
// startup and serves them from /assets/viewer/<hash>.{js,css} with an immutable cache.
//
// A turbo task of its own (`build:viewer`): the writer's tests serve these files too, so it reads
// workspace packages from source (`@waypoint/source`, also for this script's own import of
// @waypoint/ui) and needs no library build. Run it with `node --conditions=@waypoint/source`.
import {
  controlsCss,
  panelCss,
  sharedTokensCss,
  stageCss,
  treeCss,
  writerComponentsCss,
  writerTokensCss,
} from "@waypoint/ui";
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

// The shared tokens (with the chrome's font faces) come first, then the writer-only roles, so the
// shell and the public reader can't drift apart; only the writer gets writerTokensCss. Then the
// component system (packages/ui/src/components-css.ts): the controls the reader shares, then the
// writer's own. The reader's image stage (RX-04), then the file panel and its tree
// (packages/ui/src/panel-css.ts) come before the viewer's own rules, so the partials only lay
// things out on top of them and the writer's pages use the same ones.
await build({
  stdin: {
    contents:
      sharedTokensCss +
      writerTokensCss +
      controlsCss +
      writerComponentsCss +
      stageCss +
      panelCss +
      treeCss +
      viewerCssSource(),
    loader: "css",
    resolveDir: at("src/viewer"),
    sourcefile: "viewer.css",
  },
  outfile: at("dist/viewer/viewer.css"),
  bundle: true,
  // The chrome's font is served by the writer itself (CHROME_FONT_PATH), not bundled.
  external: ["/assets/*"],
  minify: true,
  logLevel: "info",
});
