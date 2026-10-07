/** @jsxImportSource hono/jsx */
import { Hono } from "hono";

import type { HttpServices } from "../http.js";
import { clientAsset, cssAsset } from "./assets.js";
import { ErrorPage } from "./layout.js";
import { collectionPage } from "./pages/collection.js";
import { recentPage } from "./pages/recent.js";
import { statusPage } from "./pages/status.js";
import { trashPage } from "./pages/trash.js";
import { noStore } from "./respond.js";

export function viewerApp(s: HttpServices): Hono {
  const app = new Hono();
  for (const asset of [clientAsset, cssAsset])
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
  app.get("/", (c) => recentPage(s, c));
  app.get("/trash", (c) => trashPage(s, c));
  app.get("/status", (c) => statusPage(s, c));
  app.get("/c/:pub", (c) => collectionPage(s, c));
  app.get("/c/:pub/*", (c) => collectionPage(s, c));
  app.get("*", (c) => noStore(c.html(<ErrorPage />, 404)));
  return app;
}
