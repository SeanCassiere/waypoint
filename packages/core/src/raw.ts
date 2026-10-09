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

// C0 controls, DEL and explicit bidi embeddings, overrides and isolates: in a saved file name they
// could hide or reorder characters ("invoice<RLO>fdp.exe"), so they become U+FFFD, as in the shell's labels.
// oxlint-disable-next-line eslint/no-control-regex -- Controls must not reach a saved file name.
const unsafeNameCharacters = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;
/**
 * Content-Disposition header for a raw-route `?download` (RX-06): an attachment named after the
 * file's base name, as RFC 8187 `filename*` only (every current browser, curl and wget honour it).
 * Everything but unreserved characters is percent-encoded, so no quote, `;` or line break survives.
 */
export function attachmentDisposition(path: string): string {
  const name = path
    .slice(path.lastIndexOf("/") + 1)
    .replace(unsafeNameCharacters, "�")
    .toWellFormed();
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
