import { isTextMime, normalizeMime } from "./mime.ts";

/** Essences a sandboxed frame would treat as a download; the raw routes serve them as plain text (RX-05). */
export const PLAIN_TEXT_RAW_TYPES: ReadonlySet<string> = new Set([
  "text/csv",
  "text/tab-separated-values",
]);

/** Content-Type header for a raw-route response (reader /x/, writer /raw/r/). Throws like isTextMime on an invalid type. */
export function rawContentType(mime: string): string {
  if (PLAIN_TEXT_RAW_TYPES.has(normalizeMime(mime))) return "text/plain; charset=utf-8";
  return isTextMime(mime) ? `${mime}; charset=utf-8` : mime;
}
