import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Both files are produced by apps/writer/viewer.build.ts. They're hashed once at startup and
// served immutably, so a deploy changes their URLs.
function asset(file: string, extension: "js" | "css", type: string) {
  const bytes = readFileSync(new URL(`../../dist/${file}`, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { bytes, url: `/assets/viewer/${hash}.${extension}`, type };
}

export const clientAsset = asset(
  "viewer-client.browser.js",
  "js",
  "text/javascript; charset=utf-8",
);
export const cssAsset = asset("viewer.css", "css", "text/css; charset=utf-8");
export const pagesAsset = asset("viewer-pages.browser.js", "js", "text/javascript; charset=utf-8");

/** The writer's favicon: the Waypoint mark, self-hosted (no data: URL, no external request). */
export const faviconAsset = {
  bytes: new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#1b1a17"/><path d="M14 20l10 26 8-17 8 17 10-26" fill="none" stroke="#fcfbf9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  url: "/favicon.svg",
  type: "image/svg+xml",
};
