import { isTextMime, normalizeMime } from "./mime.ts";

export type RendererName = "markdown" | "text" | "csv";

/** Every renderer, in the order `rerender` backfills them. */
export const RENDERER_NAMES: readonly RendererName[] = ["markdown", "text", "csv"];

// Documents and images, not text to read: their raw response is never replaced by a rendition.
const neverSubstituted: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);

/**
 * The renderer whose rendition replaces a file of this MIME type on the raw routes; null for none.
 * Shared by the writer (ingest, rerender, raw route) and the reader (raw route), so they agree.
 * Never throws: an invalid MIME type has no renderer.
 */
export function rendererFor(mime: string): RendererName | null {
  let essence: string;
  try {
    essence = normalizeMime(mime);
  } catch {
    return null;
  }
  if (essence === "text/markdown") return "markdown";
  if (essence === "text/csv" || essence === "text/tab-separated-values") return "csv";
  if (neverSubstituted.has(essence)) return null;
  return isTextMime(essence) ? "text" : null;
}
