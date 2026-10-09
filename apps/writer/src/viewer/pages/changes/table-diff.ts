// Rendered table diffs (OW-12b). A table unit's shown rows become one Markdown fragment, so cells
// get real inline Markdown and the word marks; the rendered <table> then gets a gutter column, row
// classes and a caption. Anything unexpected returns null, and the unit shows its source rows.
import { markWords } from "@waypoint/render";
import { diffWordsWithSpace } from "diff";

import type { DiffBlock, WordOp } from "../../../compare.ts";
import { plural } from "../../format.ts";

/** Cells longer than this (either side) aren't word-diffed. */
const MAX_CELL_WORDS = 1024;
/** Changed cells per table that get word diffs; the rest show old deleted, new inserted. */
const MAX_CELL_DIFFS = 200;

/** One GFM table row's cells: outer pipes dropped, split on unescaped `|`, trimmed. Escaped
 * `\|` stays escaped for the renderer. */
export function parseTableRow(text: string): string[] {
  let row = text.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Whether a row is a GFM delimiter row (`| --- | :-: |`). */
export function isDelimiterRow(text: string): boolean {
  if (!text.includes("-")) return false;
  return parseTableRow(text).every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * A word diff of one cell, capped like every jsdiff call (D47); `undefined` when either side is
 * too long or the diff gives up. Spaces or punctuation shared only between replaced words join
 * them, so "~1 h" to "25 min" and "3.1:1" to "5.2:1" read as one deletion and one insertion
 * rather than piece by piece.
 */
export function cellWords(base: string, head: string): WordOp[] | undefined {
  if (base.length > MAX_CELL_WORDS || head.length > MAX_CELL_WORDS) return undefined;
  const parts = diffWordsWithSpace(base, head, { maxEditLength: 200, timeout: 20 });
  if (!parts) return undefined;
  const out: WordOp[] = [];
  let deleted = "";
  let inserted = "";
  const flush = () => {
    if (deleted) out.push({ op: "delete", text: deleted });
    if (inserted) out.push({ op: "insert", text: inserted });
    deleted = inserted = "";
  };
  parts.forEach((part, index) => {
    if (part.removed) deleted += part.value;
    else if (part.added) inserted += part.value;
    // Between a replacement and the next change (jsdiff merges equal runs, so an equal part
    // that isn't last is followed by a change).
    else if (deleted && inserted && index < parts.length - 1 && !/[\p{L}\p{N}]/u.test(part.value)) {
      deleted += part.value;
      inserted += part.value;
    } else {
      flush();
      out.push({ op: "equal", text: part.value });
    }
  });
  flush();
  return out;
}

export type TableRowKind = "ctx" | "mod" | "add" | "del";
/** What decorateTable needs to know about the fragment's body rows. */
export interface TableMeta {
  /** Body rows in order: each row's change, or (a number) a gap row's count of unchanged rows. */
  readonly rows: readonly (TableRowKind | number)[];
  /** Content columns, which a gap row's cell spans. */
  readonly columns: number;
  /** The caption ("Table · 1 row changed, 1 added") with a gutter column; `null` for an
   * unchanged table, shown plain. */
  readonly caption: string | null;
  /** For each row of the fragment, header first (a gap row has `[]`): the content columns whose
   * cells carry word marks. Decoration fails if one of them renders without a mark: Markdown
   * syntax can swallow a mark, and the change would read as unchanged. (Other cells aren't
   * checked: `~~struck~~` text is a `<del>` too.) */
  readonly marked?: readonly (readonly number[])[];
  /** For each row of the fragment, like `marked`: the content columns diffed whole, old cell
   * deleted then new cell inserted, with one `SPLIT` between the two. Decoration fails unless it
   * renders in the cell itself, outside any element: Markdown syntax pairing across the two sides
   * (an unmatched `` ` `` or `**` in the old cell closed by the new one) would misstate both. */
  readonly whole?: readonly (readonly number[])[];
}

/** Placed between the deleted and inserted halves of a cell diffed whole; removed in decoration. */
const SPLIT = "\uE004";

/** A row's text on the side it shows (the base side only for a removed row). */
const rowText = (block: DiffBlock) =>
  block.op === "delete" ? (block.base_text ?? "") : (block.head_text ?? "");

/** "1 row changed", "1 added", "1 removed": the parts with a count. */
function countWords(counted: readonly DiffBlock[]): string[] {
  const count = (op: DiffBlock["op"]) => counted.filter((row) => row.op === op).length;
  const changed = count("replace");
  const added = count("insert");
  const removed = count("delete");
  return [
    changed ? `${plural(changed, "row")} changed` : "",
    added ? `${added} added` : "",
    removed ? `${removed} removed` : "",
  ].filter(Boolean);
}
/**
 * The unit's delimiter rows, by position: the second row of the base side and of the head side,
 * when it is delimiter-shaped. A later delimiter-shaped row is a body row (`| - | - |`), or an
 * adjacent table's delimiter, which the rows alone can't tell apart; it counts as a row.
 */
function delimiters(rows: readonly DiffBlock[]): Set<DiffBlock> {
  const out = new Set<DiffBlock>();
  const base = rows.filter((row) => row.op !== "insert");
  const head = rows.filter((row) => row.op !== "delete");
  if (base[1] && isDelimiterRow(base[1].base_text ?? "")) out.add(base[1]);
  if (head[1] && isDelimiterRow(head[1].head_text ?? "")) out.add(head[1]);
  return out;
}
/**
 * A table unit's counts in words: "1 row changed", "1 added". The delimiter doesn't count, and the
 * header counts only when it changed (a wholly added table of two rows is "2 added"), unless it
 * is the only row there is. A change to the delimiter alone (column alignment) counts it, so a
 * changed table always says what changed.
 */
export function tableParts(rows: readonly DiffBlock[]): string[] {
  const headed = rows.length > 1 && isDelimiterRow(rowText(rows[1]!));
  const delimiter = delimiters(rows);
  const rowsOnly = rows.filter((row) => !delimiter.has(row));
  const parts = countWords(
    rowsOnly.filter((row) => !(headed && row === rows[0] && row.op !== "replace")),
  );
  if (parts.length) return parts;
  const all = countWords(rowsOnly);
  return all.length ? all : countWords(rows);
}

/** A GFM autolink literal: a bare URL (`https://…`, `www.…`, `mailto:…`) or an email address. */
const AUTOLINK = /https?:\/\/|www\.|mailto:|xmpp:|[\w.+-]@[\w-]/i;
/** Emphasis and strike delimiter runs, in order. */
const delimiterRuns = (side: string) => side.match(/[*_~]+/g)?.join(" ") ?? "";
/** Whether a cell's side holds one of the constructs listed on `diffsWhole`, below. */
const holdsConstruct = (side: string) =>
  /\]\(|!\[/.test(side) ||
  /<[^\s<>]+>/.test(side) ||
  AUTOLINK.test(side) ||
  /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(side) ||
  side.includes("`") ||
  /<[a-z/!?]/i.test(side);
/**
 * Whether a changed cell is diffed whole (old cell deleted, new cell inserted, no word marks
 * inside) rather than word by word. A mark inside some Markdown constructs changes what renders,
 * or points a link at a URL in neither revision, so a cell is diffed whole when either side holds:
 * - a link or image (`[a](u)`, `![alt](u)`, `![alt][ref]`): a mark could land in the destination;
 * - an autolink or bare URL (`<https://…>`, `https://…`, `www.…`, `mailto:…`, an email address):
 *   its extent ignores marks, so a link starting in the deleted words would run into the inserted
 *   ones;
 * - a character reference (`&amp;`, `&#65;`, `&#x41;`): a mark inside breaks it, and its syntax
 *   would show instead of the character;
 * - a code span (a backtick): a mark at its edge stops the parser stripping the edge spaces;
 * - an HTML tag or comment (`<` then a letter, `/`, `!` or `?`): a mark inside breaks it;
 * - emphasis or strike delimiters (`*`, `_`, `~`) that differ between the sides: marks around the
 *   delimiters alone would be swallowed, and a formatting change would show no change at all;
 * - a change touching a delimiter (`Wait *2* min` to `Wait * 2 * min`): the runs read the same,
 *   but the change can decide whether they open or close emphasis, and a mark beside a run
 *   (which Markdown reads as punctuation) can too, so one side's formatting would show for both;
 * - other Markdown syntax among the changed words (an escape, brackets, `!`, `|`, `<`, `>`): a mark
 *   could part a `\|` or an escape from its character.
 * Word marks stay for plain text, the common case.
 */
export function diffsWhole(base: string, head: string, words: readonly WordOp[]): boolean {
  return (
    holdsConstruct(base) ||
    holdsConstruct(head) ||
    delimiterRuns(base) !== delimiterRuns(head) ||
    words.some((word) => word.op !== "equal" && /[*_`~\\[\]()<>!|]/.test(word.text)) ||
    touchesDelimiter(words)
  );
}
/** Whether a changed word sits right beside a `*`, `_` or `~`: the nearest unchanged text before
 * it ends with one, or the nearest after it starts with one. */
function touchesDelimiter(words: readonly WordOp[]): boolean {
  return words.some((word, index) => {
    if (word.op === "equal") return false;
    const before = words.slice(0, index).findLast((other) => other.op === "equal");
    const after = words.slice(index + 1).find((other) => other.op === "equal");
    return /[*_~]$/.test(before?.text ?? "") || /^[*_~]/.test(after?.text ?? "");
  });
}
/** Ends an autolink literal at the end of a cell's half, where it would otherwise run on past the
 * mark and the split (or keep trailing punctuation that GFM leaves out of the link). An HTML
 * comment, which the fragment renderer drops. Not after a `\`, which would escape it. */
const LINK_END = "<!---->";
const halfOf = (side: string) =>
  AUTOLINK.test(side) && !side.endsWith("\\") ? `${side}${LINK_END}` : side;
/** Emphasis at either end of a cell diffed whole sits against a mark, which Markdown reads as a
 * letter: a `_` can't open or close there, nor a `*` or `~` run against punctuation
 * (`**Required.**`, `` *`x`* ``), so the delimiters would show: the table shows its source. */
const EDGE_EMPHASIS = /^_|_$|^[*~]+[^*~\p{L}\p{N}\s]|[^*~\p{L}\p{N}\s][*~]+$/u;

const row = (cells: readonly string[], columns: number) =>
  `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? "").join(" | ")} |`;

/**
 * The fragment source and decoration of a table unit: the header, the delimiter, then (for a
 * changed table) every changed row with one unchanged row either side and a placeholder row for
 * each other unchanged run; an unchanged table shows every row. `null` when the unit isn't one
 * table with a header (two adjacent tables, or rows that aren't a table), or when a changed cell
 * can't be marked faithfully: show its source.
 */
export function tableFragment(
  rows: readonly DiffBlock[],
): { markdown: string; meta: TableMeta } | null {
  const [header, delimiter, ...body] = rows;
  if (!header || !delimiter || !isDelimiterRow(rowText(delimiter))) return null;
  // A delimiter-shaped body row may be the delimiter of an adjacent table (blank lines aren't in
  // the rows), and merging two tables into one would misstate both: show the source instead.
  if (body.some((block) => isDelimiterRow(rowText(block)))) return null;
  const plain = rows.every((block) => block.op === "equal");
  let diffs = MAX_CELL_DIFFS;
  let unsafe = false;
  const marked: number[][] = [];
  const whole: number[][] = [];
  /** A row's cells; a changed row's unequal cells carry word marks. */
  const cells = (block: DiffBlock): string[] => {
    const columns: number[] = [];
    const wholeColumns: number[] = [];
    marked.push(columns);
    whole.push(wholeColumns);
    if (block.op !== "replace") return parseTableRow(rowText(block));
    const before = parseTableRow(block.base_text ?? "");
    const after = parseTableRow(block.head_text ?? "");
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
      const base = before[index] ?? "";
      const head = after[index] ?? "";
      if (base === head) return head;
      columns.push(index);
      const words = diffs-- > 0 ? cellWords(base, head) : undefined;
      if (words && !diffsWhole(base, head, words)) return markWords(words);
      wholeColumns.push(index);
      if (EDGE_EMPHASIS.test(base) || EDGE_EMPHASIS.test(head)) unsafe = true;
      return [
        markWords([{ op: "delete", text: halfOf(base) }]),
        markWords([{ op: "insert", text: halfOf(head) }]),
      ].join(SPLIT);
    });
  };
  const head = cells(header);
  const near = new Set<number>();
  // A changed header or alignment gets the first row as context, like any changed row.
  if (header.op !== "equal" || delimiter.op !== "equal") near.add(0);
  body.forEach((block, index) => {
    if (block.op === "equal") return;
    near.add(index - 1);
    near.add(index + 1);
  });
  const shown: (string[] | number)[] = [];
  const kinds: (TableRowKind | number)[] = [];
  let gap = 0;
  const flush = () => {
    if (!gap) return;
    shown.push(gap);
    kinds.push(gap);
    marked.push([]);
    whole.push([]);
    gap = 0;
  };
  body.forEach((block, index) => {
    if (!plain && block.op === "equal" && !near.has(index)) {
      gap++;
      return;
    }
    flush();
    shown.push(cells(block));
    kinds.push(
      block.op === "insert"
        ? "add"
        : block.op === "delete"
          ? "del"
          : block.op === "replace"
            ? "mod"
            : "ctx",
    );
  });
  flush();
  if (unsafe) return null;
  const allRemoved = rows.every((block) => block.op === "delete");
  const align = parseTableRow(
    allRemoved ? (delimiter.base_text ?? "") : (delimiter.head_text ?? delimiter.base_text ?? ""),
  );
  const columns = Math.max(
    head.length,
    align.length,
    ...shown.map((cellsOrGap) => (typeof cellsOrGap === "number" ? 0 : cellsOrGap.length)),
  );
  const lines = [
    row(head, columns),
    row(
      Array.from({ length: columns }, (_, index) => align[index] ?? "---"),
      columns,
    ),
    // A gap is a row of empty cells here; decorateTable replaces it.
    ...shown.map((cellsOrGap) => row(typeof cellsOrGap === "number" ? [] : cellsOrGap, columns)),
  ];
  const parts = tableParts(rows);
  return {
    markdown: lines.join("\n"),
    meta: {
      rows: kinds,
      columns,
      caption: plain ? null : `Table · ${parts.join(", ")}`,
      marked,
      whole,
    },
  };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escape = (value: string) => value.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
const GUTTER: Record<TableRowKind, string> = {
  ctx: "",
  mod: '<span aria-hidden="true">~</span><span class="vh">changed row</span>',
  add: '<span aria-hidden="true">+</span><span class="vh">added row</span>',
  del: '<span aria-hidden="true">−</span><span class="vh">removed row</span>',
};
/** One tag (attribute values are always double-quoted and may hold `<`) or a run of text (whose
 * `<` is always escaped). */
const TOKEN = /<(\/?)([a-z][a-z0-9]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/gy;
const VOID = new Set(["br", "hr", "img", "input", "wbr"]);
/** Sentinels and the split mark: none may be left in the text. */
const STRAY = /[\uE000-\uE004]/;

/**
 * Turns a rendered table fragment into the diff table: `div.dtwrap > table.dt` with a caption, a
 * gutter column and row classes (or, without a caption, plain), gap rows for unchanged runs, and
 * every content cell's children in `span.dc`. `null` unless the fragment is exactly one table with
 * one header row and the expected body rows: never a half-decorated table.
 */
export function decorateTable(html: string, meta: TableMeta): string | null {
  const gutter = meta.caption !== null;
  const out: string[] = [];
  let tables = 0;
  let depth = 0;
  let section: "thead" | "tbody" | null = null;
  let headRows = 0;
  let bodyRows = 0;
  /** Inside a gap's placeholder row, whose tokens are dropped. */
  let skipping = false;
  /** The current row (header 0) and content cell, and whether that cell shows a word mark. */
  let rowAt = -1;
  let cellAt = -1;
  let mark = false;
  /** In a content cell: elements open inside it, and splits seen at its top level. */
  let cellDepth = -1;
  let splits = 0;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < html.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(html);
    if (!match || match.index !== at) return null;
    const [token, close, tag] = match;
    if (tag === undefined) {
      // Text: only whitespace outside the table; cell text inside it.
      if (!depth && token.trim()) return null;
      if (skipping) continue;
      let text = token;
      if (text.includes(SPLIT)) {
        // A split belongs at a whole-diffed cell's top level, once.
        if (cellDepth !== 0 || !meta.whole?.[rowAt]?.includes(cellAt)) return null;
        splits += text.split(SPLIT).length - 1;
        text = text.replaceAll(SPLIT, "");
      }
      if (STRAY.test(text)) return null;
      out.push(text);
      continue;
    }
    if (tag === "table") {
      if (close) {
        depth--;
        out.push("</table></div>");
      } else {
        if (++tables > 1) return null;
        depth++;
        out.push('<div class="dtwrap"><table class="dt">');
        if (gutter) out.push(`<caption class="srcnote">${escape(meta.caption ?? "")}</caption>`);
      }
      continue;
    }
    if (!depth) return null;
    if (tag === "thead" || tag === "tbody") {
      section = close ? null : tag;
      out.push(token);
      continue;
    }
    if (tag === "tr") {
      if (close) {
        if (skipping) skipping = false;
        else out.push(token);
        continue;
      }
      rowAt++;
      cellAt = -1;
      if (section === "thead") {
        headRows++;
        out.push(token, gutter ? '<th class="g"><span class="vh">Change</span></th>' : "");
        continue;
      }
      if (section !== "tbody") return null;
      const kind = meta.rows[bodyRows++];
      if (kind === undefined) return null;
      if (typeof kind === "number") {
        if (!gutter) return null;
        skipping = true;
        out.push(
          `<tr class="r-gap"><td class="g"></td><td colspan="${meta.columns}">⋯ ${plural(kind, "unchanged row")}</td></tr>`,
        );
        continue;
      }
      out.push(gutter ? `<tr class="r-${kind}"><td class="g">${GUTTER[kind]}</td>` : token);
      continue;
    }
    if (skipping) continue;
    if (tag === "th" || tag === "td") {
      if (close) {
        if (!mark && meta.marked?.[rowAt]?.includes(cellAt)) return null;
        if (cellDepth !== 0 || splits !== (meta.whole?.[rowAt]?.includes(cellAt) ? 1 : 0))
          return null;
        cellDepth = -1;
        out.push(`</span>${token}`);
      } else {
        cellAt++;
        mark = false;
        cellDepth = 0;
        splits = 0;
        out.push(`${token}<span class="dc">`);
      }
      continue;
    }
    if (!close && (tag === "del" || tag === "ins")) mark = true;
    if (cellDepth >= 0 && !VOID.has(tag) && !token.endsWith("/>")) {
      cellDepth += close ? -1 : 1;
      if (cellDepth < 0) return null;
    }
    out.push(token);
  }
  if (tables !== 1 || depth || headRows !== 1 || bodyRows !== meta.rows.length) return null;
  return out.join("");
}
