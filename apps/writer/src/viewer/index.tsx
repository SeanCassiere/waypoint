/** @jsxImportSource hono/jsx */
import { Hono } from "hono";

import type { HttpServices } from "../http.ts";
import { linksEnabled } from "../shares.ts";
import { clientAsset, cssAsset, faviconAsset, pagesAsset } from "./assets.ts";
import { getChrome } from "./chrome.ts";
import { compareRoute } from "./pages/collection/compare-route.ts";
import { collectionPage, notFound } from "./pages/collection/index.tsx";
import { recentPage } from "./pages/recent/index.tsx";
import { linksPage } from "./pages/share.tsx";
import { statusPage, type ViewerExtras } from "./pages/status.tsx";
import { trashPage, trashLinks } from "./pages/trash.tsx";

export type { ViewerExtras } from "./pages/status.tsx";

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
  app.get("/c/:pub/compare", (c) => compareRoute(s, c, extras));
  app.get("/c/:pub/*", (c) => collectionPage(s, c, extras));
  app.get("*", async (c) => notFound(c, await getChrome(s), new URL(c.req.raw.url).pathname));
  return app;
}
