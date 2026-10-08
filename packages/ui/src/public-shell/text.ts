import { escapeHtml } from "../html.ts";

const special = /[&<>"']/;
/** escapeHtml with a fast path: most paths and URLs need no escaping. */
export const esc = (value: string): string => (special.test(value) ? escapeHtml(value) : value);

const unreserved = /^[A-Za-z0-9._~/-]*$/;
/**
 * Per-segment encodeURIComponent, cheaply: most paths need no encoding, and otherwise `%2F` can
 * only come from `/`, since a literal `%` becomes `%25`.
 */
export const encodePathSegments = (path: string): string =>
  unreserved.test(path) ? path : encodeURIComponent(path).replaceAll("%2F", "/");

// oxlint-disable-next-line eslint/no-control-regex -- Controls and spaces must be percent-encoded in URLs.
const linkUnsafe = /[\u0000- "#%<>?\\^`{|}\u007f]/g;
/**
 * A path for an HTML link, IRI style: only characters that would change how the URL parses
 * (`%`, `?`, `#`, `\`, spaces and controls, and a few that browsers escape anyway) are
 * percent-encoded. Other characters, including non-ASCII, stay as they are; the browser
 * percent-encodes them as UTF-8 when it follows the link, so the server decodes the same path.
 * Much smaller than `encodePathSegments` for non-ASCII names.
 */
export const encodeLinkPath = (path: string): string =>
  unreserved.test(path) ? path : path.replace(linkUnsafe, (char) => encodeURIComponent(char));

// Explicit bidi embeddings, overrides and isolates. In a label they could make a name read
// differently from what it is ("invoice<RLO>fdp.exe"), so labels show them as U+FFFD.
const bidiControls = /[‪-‮⁦-⁩]/g;
export const showBidi = (text: string): string => text.replace(bidiControls, "�");

/** Labels longer than this are shortened in the middle; `data-p` keeps the full path. */
const LABEL_MAX = 80;
export function label(text: string): string {
  let shown = text;
  if (shown.length > LABEL_MAX) {
    let head = 38;
    let tail = shown.length - 38;
    // Don't split a surrogate pair.
    if (/[\ud800-\udbff]/.test(shown.charAt(head - 1))) head--;
    if (/[\udc00-\udfff]/.test(shown.charAt(tail))) tail++;
    shown = `${shown.slice(0, head)}…${shown.slice(tail)}`;
  }
  return esc(showBidi(shown));
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : name.slice(0, 6);
}
