import { normalizeMime } from "@waypoint/core";

import { escapeHtml, FRAME_REPORTER, readingCss, type ShikiLanguage } from "./render.ts";

// The text and CSV views (RX-08): the shared parts of the `text` and `csv` renderers. A view's
// output depends only on the bytes, the MIME type and the renderer version. It is shared by every
// file with the same bytes, so it never contains the file name: VIEW_SCRIPT fills that in from the
// frame's own URL. No markup, link, attribute or URL is ever derived from content.

/** A text view's kind chip and Shiki language (null: shown uncoloured). */
export type ViewKind = { readonly label: string; readonly language: ShikiLanguage | null };

const kinds = new Map<string, ViewKind>([
  ["text/x-shellscript", { label: "Shell script", language: "bash" }],
  ["application/json", { label: "JSON", language: "json" }],
  ["application/x-ndjson", { label: "JSON lines", language: "json" }],
  ["application/ndjson", { label: "JSON lines", language: "json" }],
  ["text/javascript", { label: "JavaScript", language: "javascript" }],
  ["application/javascript", { label: "JavaScript", language: "javascript" }],
  ["application/x-javascript", { label: "JavaScript", language: "javascript" }],
  ["text/typescript", { label: "TypeScript", language: "typescript" }],
  ["application/typescript", { label: "TypeScript", language: "typescript" }],
  ["text/x-python", { label: "Python", language: "python" }],
  ["application/yaml", { label: "YAML", language: "yaml" }],
  ["application/x-yaml", { label: "YAML", language: "yaml" }],
  ["text/yaml", { label: "YAML", language: "yaml" }],
  ["text/x-yaml", { label: "YAML", language: "yaml" }],
  ["application/toml", { label: "TOML", language: "toml" }],
  ["application/x-toml", { label: "TOML", language: "toml" }],
  ["text/x-diff", { label: "Diff", language: "diff" }],
  ["text/css", { label: "CSS", language: "css" }],
  ["text/x-go", { label: "Go", language: "go" }],
  ["text/x-rust", { label: "Rust", language: "rust" }],
  ["text/x-sql", { label: "SQL", language: "sql" }],
  ["text/x-dockerfile", { label: "Dockerfile", language: "dockerfile" }],
  ["application/xml", { label: "XML", language: null }],
  ["text/xml", { label: "XML", language: null }],
  ["text/csv", { label: "CSV", language: null }],
  ["text/tab-separated-values", { label: "TSV", language: null }],
  ["text/plain", { label: "Plain text", language: null }],
]);
const json: ViewKind = { label: "JSON", language: "json" };
const yaml: ViewKind = { label: "YAML", language: "yaml" };
const xml: ViewKind = { label: "XML", language: null };
const text: ViewKind = { label: "Text", language: null };

/** The kind chip and language for a MIME type (callers have already checked it's a text type). */
export function viewKind(mime: string): ViewKind {
  const essence = normalizeMime(mime);
  const known = kinds.get(essence);
  if (known) return known;
  if (/^application\/[\w.+-]+\+json$/u.test(essence)) return json;
  if (/^application\/[\w.+-]+\+yaml$/u.test(essence)) return yaml;
  if (/^application\/[\w.+-]+\+xml$/u.test(essence)) return xml;
  return text;
}

/** UTF-8 decoded like markdown: lossy replacement is deterministic; a BOM is kept for the caller. */
export function decodeSource(source: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(source);
}

/** The source without one leading U+FEFF (byte order mark). */
export function withoutBom(source: string): string {
  return source.startsWith("\uFEFF") ? source.slice(1) : source;
}

/** Lines split on `\n`, one trailing `\r` each removed; a final newline doesn't start a line. */
export function splitLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// C0 controls but tab and line feed, DEL, zero-width and direction marks, and bidi embeddings,
// overrides and isolates: each shows as a visible marker so nothing hides or reorders the text.
const controls = new RegExp(
  // oxlint-disable-next-line eslint/no-control-regex -- These controls are what the markers replace.
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "gu",
);

/** Content as HTML text: every character escaped, controls shown as `⟪U+XXXX⟫` markers. */
export function escapeView(value: string): string {
  return escapeHtml(value).replace(
    controls,
    (character) =>
      `<span class="cc">⟪U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟫</span>`,
  );
}

/** A count grouped with commas, by regex rather than locale (`1,204`). */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(?:\d{3})+$)/gu, ",");
}

/** `1 line`, `2 lines`: the count grouped with commas. */
export function counted(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** A byte size by the reader shell's rules (`packages/ui` public-shell `bytes()`). */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The header: the file name (filled in by VIEW_SCRIPT), the kind chip and the meta line. */
export function viewHeader(label: string, meta: string): string {
  return `<header class="fh"><b class="fn" dir="auto"></b><span class="k">${escapeHtml(label)}</span><span class="m">${escapeHtml(meta)}</span></header>`;
}

/**
 * The views' rules, after the reading template. Colours come only from its reading variables.
 * Long lines wrap inside the code column, so continuation rows stay under the code, never under
 * the number; the numbers aren't selectable, so copying lines yields just the source.
 */
export const VIEW_CSS: string = `.fh{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0 0 12px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.fh .fn{font:650 14px ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg);unicode-bidi:plaintext;overflow-wrap:anywhere}
.fh .k{padding:1px 7px;border:1px solid var(--line-2);border-radius:99px;font-size:12px;font-weight:600;color:var(--fg-2)}
.fmt{margin:0 0 12px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--subtle);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--fg-2)}
body.tv{max-width:min(110ch + 120px,1180px);padding:28px 32px 80px;font-size:15px}
.tv pre.lines{margin:0;padding:12px 0;line-height:1.6;tab-size:4;white-space:normal}
.tv pre.lines code{display:block;font-size:13.5px}
.gw1{--gw:1ch}.gw2{--gw:2ch}.gw3{--gw:3ch}.gw4{--gw:4ch}.gw5{--gw:5ch}
.tv .l{display:grid;grid-template-columns:calc(var(--gw) + 12px) 1fr;column-gap:18px;padding:0 16px 0 0;min-height:1.6em}
.tv .l:target{background:var(--mark)}
.tv .n{padding-left:12px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none}
.tv .c{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.tv .cc,.cv .cc{padding:0 2px;border:1px solid var(--line-2);border-radius:4px;color:var(--fg-2);font-size:.85em}
@media(min-width:900px){.tv pre{margin-inline:0}}
body.cv{max-width:none;padding:24px 24px 64px}
.cv table.csv{width:auto;border-collapse:separate;border-spacing:0;margin:0;font-size:13.5px;font-variant-numeric:tabular-nums}
.cv th,.cv td{padding:6px 14px;border-bottom:1px solid var(--line);min-width:0;max-width:40ch;white-space:pre-wrap;overflow-wrap:break-word;text-align:left;vertical-align:top}
.cv td+td,.cv th+th{border-left:0}
.cv thead th{position:sticky;top:0;z-index:1;background:var(--subtle);border-top:1px solid var(--line);white-space:nowrap}
.cv .num{text-align:right}
.cv .rn{color:var(--muted);text-align:right;padding-right:10px;border-right:1px solid var(--line)}
.cv tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--subtle) 55%,transparent)}
.cv .more{margin:14px 0 0;font-size:13px;color:var(--muted)}
@media(max-width:600px){body.tv{padding:16px 12px 60px}.tv .l{column-gap:12px;padding-right:10px;grid-template-columns:calc(var(--gw) + 6px) 1fr}.tv .n{padding-left:6px}.tv pre.lines code{font-size:12.5px}body.cv{padding:16px 10px 48px}}
@media(forced-colors:active){.tv .l:target{outline:2px solid Highlight;outline-offset:-2px}}`;

/**
 * Fills the header's file name from the frame's own URL (the view is shared by content hash, so
 * the name can't be in it), with bidi controls shown as U+FFFD as in the shell's labels. The
 * escapes stay backslash text (written `\\u…` here, which the formatter leaves alone), so the
 * document never holds a raw control character.
 */
export const VIEW_SCRIPT: string = `(()=>{const b=document.querySelector(".fh .fn");if(!b)return;let n=location.pathname.slice(location.pathname.lastIndexOf("/")+1);try{n=decodeURIComponent(n)}catch{}n=n.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g,"\\ufffd");b.textContent=n;if(n)document.title=n})();`;

/** The view document: the reading template plus VIEW_CSS, and one script (VIEW_SCRIPT, then the frame reporter). */
export function viewDocument(view: "tv" | "cv", label: string, body: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(label)}</title>\n<style>${readingCss}\n${VIEW_CSS}</style>\n</head>\n<body class="${view}">\n${body}\n<script>${VIEW_SCRIPT}${FRAME_REPORTER}</script>\n</body>\n</html>\n`;
}

/**
 * The most UTF-16 code units a view's body may hold. The source bounds don't bound the output:
 * markers, escapes, JSON indentation and padded CSV rows can multiply it. Even if every unit took
 * 3 UTF-8 bytes, a view under this bound stays below the writer's default 50 MB blob limit, and
 * readers never get a document of tens of megabytes. Over it, a view isn't built (null).
 */
export const VIEW_MAX_CHARS = 16_777_216;

/**
 * The text view: a header, an optional note, and numbered lines with `id="L<n>"` anchors.
 * `contents` holds each line's highlighted HTML; without it the lines are escaped uncoloured.
 * The CSV renderer's parse-failure fallback uses this too, uncoloured, with the CSV/TSV kind.
 * Null when the numbered lines would exceed VIEW_MAX_CHARS.
 */
export function textView(options: {
  label: string;
  lines: readonly string[];
  byteLength: number;
  contents?: readonly string[];
  meta?: string;
  note?: string;
}): string | null {
  const { lines, contents } = options;
  const meta =
    options.meta ??
    `${counted(lines.length, "line", "lines")} · ${formatBytes(options.byteLength)}`;
  const digits = Math.min(5, Math.max(1, String(lines.length).length));
  const rows: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    const row = `<span class="l" id="L${index + 1}"><span class="n" aria-hidden="true">${index + 1}</span><span class="c">${contents?.[index] ?? escapeView(line)}</span></span>`;
    size += row.length;
    if (size > VIEW_MAX_CHARS) return null;
    rows.push(row);
  }
  const parts = [viewHeader(options.label, meta)];
  if (options.note !== undefined) parts.push(`<p class="fmt">${escapeHtml(options.note)}</p>`);
  parts.push(
    `<pre class="lines${contents ? " shiki" : ""}"><code class="gw${digits}">${rows.join("")}</code></pre>`,
  );
  return viewDocument("tv", options.label, parts.join("\n"));
}
