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
