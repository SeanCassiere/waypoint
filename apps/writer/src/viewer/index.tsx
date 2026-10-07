/** @jsxImportSource hono/jsx */
import { Hono } from "hono";

import type { HttpServices } from "../http.js";
import { linksEnabled } from "../shares.js";
import { clientAsset, cssAsset, faviconAsset, pagesAsset } from "./assets.js";
import { getChrome } from "./chrome.js";
import { collectionPage, notFound } from "./pages/collection.js";
import { recentPage } from "./pages/recent.js";
import { linksPage } from "./pages/share.js";
import { statusPage, type ViewerExtras } from "./pages/status.js";
import { trashPage, trashLinks } from "./pages/trash.js";

export type { ViewerExtras } from "./pages/status.js";

export function viewerApp(s: HttpServices, extras: ViewerExtras): Hono {
  const app = new Hono();
  for (const asset of [clientAsset, cssAsset, pagesAsset])
    app.get(
      asset.url,
      () =>
        new Response(asset.bytes, {
          headers: {
            "content-type": asset.type,
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
    );
  // Browsers also ask for /favicon.ico on pages without a <link rel="icon"> (raw files).
  for (const path of [faviconAsset.url, "/favicon.ico"])
    app.get(
      path,
      () =>
        new Response(faviconAsset.bytes, {
          headers: { "content-type": faviconAsset.type, "cache-control": "public, max-age=86400" },
        }),
    );
  app.get("/", (c) => recentPage(s, c));
  app.get("/trash", (c) =>
    trashPage(s, c, linksEnabled(s) ? (ids) => trashLinks(s, ids) : undefined),
  );
  app.get("/links", (c) => linksPage(s, c));
  app.get("/status", (c) => statusPage(s, c, extras));
  app.get("/c/:pub", (c) => collectionPage(s, c, extras));
  app.get("/c/:pub/*", (c) => collectionPage(s, c, extras));
  app.get("*", async (c) => notFound(c, await getChrome(s), new URL(c.req.raw.url).pathname));
  return app;
}
