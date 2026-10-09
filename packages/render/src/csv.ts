import { normalizeMime, rendererFor } from "@waypoint/core";

import { TEXT_LIMITS } from "./text.ts";
import {
  counted,
  escapeView,
  formatCount,
  splitLines,
  textView,
  VIEW_MAX_CHARS,
  viewDocument,
  viewHeader,
  viewKind,
  withoutBom,
} from "./view.ts";

export const CSV_RENDERER_NAME = "csv";
// Bump this version for any change to the CSV view's output, and update CSV_GOLDEN_HASH in
// tests/golden-text.ts in the same change (see TEXT_RENDERER_VERSION).
// v1: the bounded table (first 500 rows, sticky header, row numbers), text view on a parse failure.
export const CSV_RENDERER_VERSION = 1;

export const CSV_LIMITS: {
  readonly maxBytes: 2097152;
  readonly rows: 500;
  readonly cellChars: 65536;
} = { maxBytes: 2_097_152, rows: 500, cellChars: 65_536 };

const numeric = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/u;

/**
 * Records of an RFC 4180 subset: records end at `\n` or `\r\n`; a field starting with `"` is
 * quoted (`""` is a literal quote, newlines and delimiters are data), and anything after its
 * closing quote up to the next delimiter is kept literally. Undefined for an unterminated quote.
 * A trailing newline doesn't create a record, and blank lines are skipped.
 */
function parseCsv(source: string, delimiter: string): string[][] | undefined {
  const records: string[][] = [];
  let record: string[] = [];
  let index = 0;
  const length = source.length;
  const endRecord = (): void => {
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };
  while (index < length) {
    let field = "";
    if (source[index] === '"') {
      index++;
      for (;;) {
        const quote = source.indexOf('"', index);
        if (quote < 0) return undefined;
        field += source.slice(index, quote);
        if (source[quote + 1] === '"') {
          field += '"';
          index = quote + 2;
        } else {
          index = quote + 1;
          break;
        }
      }
    }
    // Unquoted text, or what follows a closing quote, up to the delimiter or the record's end.
    let end = index;
    while (end < length && source[end] !== delimiter && source[end] !== "\n") end++;
    const rest = source.slice(index, end);
    const atNewline = source[end] === "\n";
    field += atNewline && rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    record.push(field);
    if (end >= length) {
      endRecord();
      return records;
    }
    index = end + 1;
    if (atNewline) endRecord();
    else if (index >= length) {
      // A delimiter at the very end: the record has one more, empty, field.
      record.push("");
      endRecord();
    }
  }
  if (record.length > 0) endRecord();
  return records;
}

function cell(value: string): string {
  return escapeView(
    value.length > CSV_LIMITS.cellChars ? `${value.slice(0, CSV_LIMITS.cellChars)}…` : value,
  );
}

/**
 * The CSV/TSV table view: `source` is the decoded file and `byteLength` its size in bytes.
 * Null: over the bounds or not a CSV/TSV type. A parse failure or an empty file returns the
 * text view of the same source (uncoloured, kind CSV or TSV), and so does a table too large to
 * build (each shown row is padded to the widest record, so few bytes can mean many cells).
 */
export function renderCsv(
  source: string,
  options: { mime: string; byteLength: number },
): Promise<string | null> {
  try {
    return Promise.resolve(csvView(source, options));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The text view of a CSV or TSV source, for a parse failure, an empty file or an oversized table. */
function fallbackView(text: string, essence: string, byteLength: number): string | null {
  const lines = splitLines(text);
  if (lines.length > TEXT_LIMITS.maxLines) return null;
  return textView({ label: viewKind(essence).label, lines, byteLength });
}

// The fewest UTF-16 code units an empty header cell and an empty data cell take.
const emptyHeadCell = '<th scope="col" dir="auto"></th>'.length;
const emptyCell = '<td dir="auto"></td>'.length;

function csvView(source: string, options: { mime: string; byteLength: number }): string | null {
  if (rendererFor(options.mime) !== "csv") return null;
  if (options.byteLength > CSV_LIMITS.maxBytes) return null;
  const text = withoutBom(source);
  const essence = normalizeMime(options.mime);
  const records = parseCsv(text, essence === "text/tab-separated-values" ? "\t" : ",");
  const [header, ...data] = records ?? [];
  if (!header) return fallbackView(text, essence, options.byteLength);
  const columns = data.reduce((most, record) => Math.max(most, record.length), header.length);
  const shown = data.slice(0, CSV_LIMITS.rows);
  if (columns * (emptyHeadCell + shown.length * emptyCell) > VIEW_MAX_CHARS)
    return fallbackView(text, essence, options.byteLength);
  const numericColumns = Array.from({ length: columns }, (_, column) => {
    const values = shown.map((row) => row[column] ?? "").filter((value) => value !== "");
    return values.length > 0 && values.every((value) => numeric.test(value) && /\d/u.test(value));
  });
  const numClass = (column: number): string => (numericColumns[column] ? ' class="num"' : "");
  const head = Array.from(
    { length: columns },
    (_, column) =>
      `<th scope="col" dir="auto"${numClass(column)}>${cell(header[column] ?? "")}</th>`,
  ).join("");
  const rows: string[] = [];
  let size = head.length;
  if (size > VIEW_MAX_CHARS) return fallbackView(text, essence, options.byteLength);
  for (const [index, row] of shown.entries()) {
    const html = `<tr><td class="rn">${index + 1}</td>${Array.from(
      { length: columns },
      (_, column) => `<td dir="auto"${numClass(column)}>${cell(row[column] ?? "")}</td>`,
    ).join("")}</tr>`;
    size += html.length;
    if (size > VIEW_MAX_CHARS) return fallbackView(text, essence, options.byteLength);
    rows.push(html);
  }
  const body = rows.join("");
  const more = data.length - shown.length;
  const meta = `${counted(data.length, "row", "rows")} × ${counted(columns, "column", "columns")}${more > 0 ? ` · first ${CSV_LIMITS.rows} shown` : ""}`;
  const parts = [
    viewHeader("Table", meta),
    `<table class="csv"><thead><tr><th class="rn" scope="col">#</th>${head}</tr></thead><tbody>${body}</tbody></table>`,
  ];
  if (more > 0)
    parts.push(
      `<p class="more">${more === 1 ? "1 more row isn't shown" : `${formatCount(more)} more rows aren't shown`}. Download the file to see them all.</p>`,
    );
  return viewDocument("cv", "Table", parts.join("\n"));
}
