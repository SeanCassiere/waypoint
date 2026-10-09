/** @jsxImportSource hono/jsx */
import { isMarkdown } from "@waypoint/core";
import { markWords } from "@waypoint/render";
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import {
  fileKind,
  MAX_BLOCKS,
  MAX_LINES,
  type CompareFile,
  type DiffBlock,
  type FileDiff,
  type LineDiffRow,
  type TruncatedReason,
  type WordOp,
} from "../../../compare.ts";
import { rawPath, shellPath } from "../../../viewer-paths.ts";
import { bytes, plural } from "../../format.ts";
import type { CollectionContext } from "../collection/index.tsx";

export const ADDED_PREVIEW = 20;
export const ADDED_LIMIT = 200;
/** Unchanged runs up to this long load on demand when opened; longer ones link to the
 * no-script `?folds=open` view, which shows every run inline. */
export const FOLD_LOAD_LIMIT = 200;
/** Blocks (or source lines) one file card shows at a time, and the whole page's budget. A
 * file past its window links to the next one, so no Changes page is megabytes of HTML. */
export const FILE_BLOCKS = 300;
export const PAGE_BLOCKS = 600;
export const FILE_LINES = 1500;
export const PAGE_LINES = 3000;
/** Unchanged source lines up to this many load on demand when a hunk is opened; longer ones
 * link to the file. */
export const FOLD_LINE_LIMIT: number = FILE_LINES;
/** Code blocks diff line by line with an LCS table; past this many cells, lines show as removed
 * then added. */
const CODE_LCS_CELLS = 250_000;

export const glyph = (status: CompareFile["status"]) =>
  status === "added" ? "+" : status === "removed" ? "−" : status === "modified" ? "~" : "=";
export const glyphClass = (status: CompareFile["status"]) =>
  status === "added" ? "k a" : status === "removed" ? "k rm" : status === "modified" ? "k m" : "k";
/** The spoken word for a glyph ("~" is "changed", as in the legend). */
const statusWord = (status: CompareFile["status"]) =>
  status === "modified" ? "changed" : status === "unchanged" ? "unchanged" : status;
/** `isMarkdown` throws on an unparseable MIME; an odd manifest MIME is just not Markdown. */
const md = (mime: string): boolean => {
  try {
    return isMarkdown(mime);
  } catch {
    return false;
  }
};
/** `fileKind`, where an unparseable MIME is binary rather than an error. */
const kindOf = (mime: string): ReturnType<typeof fileKind> => {
  try {
    return fileKind(mime);
  } catch {
    return "binary";
  }
};
/** "1,500 unchanged lines": a count with thousands separators and its noun. */
const counted = (count: number, one: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : `${one}s`}`;
/** A fold's summary: both labels in the markup, swapped by CSS on `details[open]`. */
function FoldSummary(props: { label: string }) {
  return (
    <summary class="fold">
      {raw(icon("chevronDown"))}
      <span class="when-closed">Show {props.label}</span>
      <span class="when-open">Hide {props.label}</span>
    </summary>
  );
}

function Words(props: { words: readonly WordOp[] }) {
  return (
    <>
      {props.words.map((word) =>
        word.op === "insert" ? (
          <ins>{word.text}</ins>
        ) : word.op === "delete" ? (
          <del>{word.text}</del>
        ) : (
          word.text
        ),
      )}
    </>
  );
}
/**
 * Markdown blocks on the page, rendered together off the event loop (Markdown parsing is
 * superlinear on some inputs). Components emit placeholders; `fill` swaps in the HTML, or the
 * block's source when it was too long or the time budget ran out.
 */
class Fragments {
  private readonly sources: string[] = [];
  private readonly fallbacks: Child[] = [];
  /** Whether rendering likely ran out of time (see fill). */
  fellBack = false;
  add(markdown: string, fallback: Child): number {
    this.sources.push(markdown);
    this.fallbacks.push(fallback);
    return this.sources.length - 1;
  }
  async fill(
    html: string,
    render: (sources: string[]) => Promise<(string | null)[]>,
  ): Promise<string> {
    const rendered = await render(this.sources);
    // The worker's time budget runs out at the end of the list, so a missing last fragment
    // means this rendering may be incomplete; a single oversized block shows as source anyway.
    this.fellBack = rendered.length > 0 && typeof rendered.at(-1) !== "string";
    const fallbacks = await Promise.all(
      this.fallbacks.map(async (fallback, index) => {
        if (typeof rendered[index] === "string") return "";
        const node = <>{fallback}</>;
        return (await node).toString();
      }),
    );
    // Placeholders are comments, which escaped page text can never contain.
    return html.replace(/<!--wpfrag:(\d+)-->/g, (_, at: string) => {
      const index = Number(at);
      const fragment = rendered[index];
      return typeof fragment === "string"
        ? `<div class="tx rd">${fragment}</div>`
        : (fallbacks[index] ?? "");
    });
  }
}
function Rendered(props: { markdown: string; source: Child; frags: Fragments }) {
  const fallback = (
    <div class="tx code">
      <span class="srcnote">Source · not rendered</span>
      {props.source}
    </div>
  );
  return raw(`<!--wpfrag:${props.frags.add(props.markdown, fallback)}-->`);
}
/** A typographic mark with its word for screen readers (a label on a generic span isn't
 * exposed reliably). */
const mark = (sign: string, word: string) => (
  <>
    <span aria-hidden="true">{sign}</span>
    <span class="vh">{word}</span>
  </>
);
const marker = (op: DiffBlock["op"]) =>
  op === "insert" ? (
    <span class="mk">{mark("+", "added")}</span>
  ) : op === "delete" ? (
    <span class="mk">{mark("−", "removed")}</span>
  ) : op === "replace" ? (
    <span class="mk">{mark("~", "changed")}</span>
  ) : (
    <span class="mk" aria-hidden="true" />
  );
const opWord = (op: DiffBlock["op"]) =>
  op === "insert" ? "added" : op === "delete" ? "removed" : "changed";
const tone = (op: DiffBlock["op"]) =>
  op === "insert" ? "add" : op === "delete" ? "del" : op === "replace" ? "mod" : "ctx";

/** A run of consecutive table rows, or a single other block. */
type Unit = { table: DiffBlock[] } | { block: DiffBlock };
function units(ops: readonly DiffBlock[]): Unit[] {
  const out: Unit[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (op.kind === "table" && last && "table" in last) last.table.push(op);
    else out.push(op.kind === "table" ? { table: [op] } : { block: op });
  }
  return out;
}
const unchanged = (unit: Unit) =>
  "table" in unit ? unit.table.every((op) => op.op === "equal") : unit.block.op === "equal";

function TableUnit(props: { rows: DiffBlock[] }) {
  const changed = props.rows.filter((row) => row.op === "replace").length;
  const added = props.rows.filter((row) => row.op === "insert").length;
  const removed = props.rows.filter((row) => row.op === "delete").length;
  if (!changed && !added && !removed)
    return (
      <div class="blk ctx">
        <span class="mk" aria-hidden="true" />
        <div class="tx">
          <span class="ctxnote">
            ▦ Table, {plural(Math.max(0, props.rows.length - 2), "row")} (unchanged)
          </span>
        </div>
      </div>
    );
  const parts = [
    changed ? `${plural(changed, "row")} changed` : "",
    added ? `${added} added` : "",
    removed ? `${removed} removed` : "",
  ].filter(Boolean);
  return (
    <div class="blk src mod" data-change={`table, ${parts.join(", ")}`} tabindex={-1}>
      {marker("replace")}
      <div class="tx">
        <span class="srcnote">Table · {parts.join(", ")}</span>
        {props.rows.map((row) =>
          row.op === "equal" ? (
            <span class="row0">{row.head_text}</span>
          ) : row.op === "insert" ? (
            <span class="lnadd">{row.head_text}</span>
          ) : row.op === "delete" ? (
            <span class="lndel">{row.base_text}</span>
          ) : (
            <>
              <span class="lndel">{row.base_text}</span>
              <span class="lnadd">{row.head_text}</span>
            </>
          ),
        )}
      </div>
    </div>
  );
}
function codeLanguage(text: string): string {
  return /^ {0,3}(?:`{3,}|~{3,})\s*([\w+-]+)/.exec(text)?.[1] ?? "";
}
function codeBody(text: string): string[] {
  const lines = text.split("\n");
  return lines.slice(1, /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? "") ? -1 : undefined);
}
/** A removed or added code line with its gutter sign (not selected when copying). */
function CodeLine(props: { op: "insert" | "delete"; text: string }) {
  return props.op === "insert" ? (
    <span class="lnadd">
      <span class="sg" aria-hidden="true">
        +
      </span>
      {props.text}
    </span>
  ) : (
    <span class="lndel">
      <span class="sg" aria-hidden="true">
        −
      </span>
      {props.text}
    </span>
  );
}
function CodeBlock(props: { op: DiffBlock }) {
  const { op } = props;
  const text = op.head_text ?? op.base_text ?? "";
  const language = codeLanguage(text);
  if (op.op === "equal")
    return (
      <div class="blk ctx">
        <span class="mk" aria-hidden="true" />
        <div class="tx">
          <span class="ctxnote">
            ▦ Code block{language ? ` (${language})` : ""}, {plural(codeBody(text).length, "line")}{" "}
            (unchanged)
          </span>
        </div>
      </div>
    );
  if (op.op !== "replace")
    return (
      <div class={`blk src ${tone(op.op)}`} data-change={`code ${opWord(op.op)}`} tabindex={-1}>
        {marker(op.op)}
        <div class="tx">
          <span class="srcnote">
            Code{language ? ` · ${language}` : ""} · {op.op === "insert" ? "added" : "removed"}
          </span>
          {codeBody(text).join("\n")}
        </div>
      </div>
    );
  const before = codeBody(op.base_text ?? "");
  const after = codeBody(op.head_text ?? "");
  const rows: Child[] = [];
  let deleted = 0;
  let added = 0;
  if (before.length * after.length > CODE_LCS_CELLS) {
    const lines = plural(Math.max(before.length, after.length), "line");
    return (
      <div class="blk src mod" data-change={`code, ${lines} changed`} tabindex={-1}>
        {marker("replace")}
        <div class="tx">
          <span class="srcnote">
            Code{language ? ` · ${language}` : ""} · {lines} changed
          </span>
          {before.map((line) => (
            <CodeLine op="delete" text={line} />
          ))}
          {after.map((line) => (
            <CodeLine op="insert" text={line} />
          ))}
        </div>
      </div>
    );
  }
  // A simple line LCS is enough for code blocks inside one Markdown block.
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  );
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i]![j] =
        before[i] === after[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push(`${before[i] ?? ""}\n`);
      i++;
      j++;
    } else if (
      i < before.length &&
      (j >= after.length || (table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0))
    ) {
      rows.push(<CodeLine op="delete" text={before[i] ?? ""} />);
      i++;
      deleted++;
    } else {
      rows.push(<CodeLine op="insert" text={after[j] ?? ""} />);
      j++;
      added++;
    }
  }
  const lines = plural(Math.max(deleted, added), "line");
  return (
    <div class="blk src mod" data-change={`code, ${lines} changed`} tabindex={-1}>
      {marker("replace")}
      <div class="tx">
        <span class="srcnote">
          Code{language ? ` · ${language}` : ""} · {lines} changed
        </span>
        {rows}
      </div>
    </div>
  );
}
function BlockView(props: { op: DiffBlock; frags: Fragments }) {
  const { op } = props;
  if (op.kind === "code") return <CodeBlock op={op} />;
  const text = op.op === "delete" ? (op.base_text ?? "") : (op.head_text ?? "");
  const source = op.op === "replace" && op.words ? markWords(op.words) : text;
  const kind =
    op.kind === "list-item"
      ? "list item"
      : op.kind === "heading" || op.kind === "paragraph"
        ? op.kind
        : "block";
  return (
    <div
      class={`blk ${tone(op.op)}`}
      data-change={op.op === "equal" ? undefined : `${kind} ${opWord(op.op)}`}
      tabindex={op.op === "equal" ? undefined : -1}
    >
      {marker(op.op)}
      <Rendered
        markdown={source}
        source={op.op === "replace" && op.words ? <Words words={op.words} /> : text}
        frags={props.frags}
      />
    </div>
  );
}
function UnitView(props: { unit: Unit; frags: Fragments }) {
  return "table" in props.unit ? (
    <TableUnit rows={props.unit.table} />
  ) : (
    <BlockView op={props.unit.block} frags={props.frags} />
  );
}
/** Where a file's folded runs load from (the compare API's HTML format) and its no-script view. */
interface FoldLinks {
  url: (from: number, to: number) => string;
  /** The no-script view of the file with every run inlined, at the window holding `start`. */
  openHref: (start: number) => string;
  /** The file's path, for the link text. */
  path: string;
}
function Fold(props: {
  units: Unit[];
  start: number;
  where: "above" | "below" | "between";
  frags: Fragments;
  fold: FoldLinks | null;
  open: boolean;
}) {
  const count = props.units.length;
  const label = `${counted(count, "unchanged block")}${props.where === "between" ? "" : ` ${props.where}`}`;
  // The no-script view (`?folds=open`) inlines every run, whatever its length (the window and
  // the fragment budget bound it): a lazy fold's fallback link there would be this very page.
  if (props.open)
    return (
      <details class="folded">
        <FoldSummary label={label} />
        {props.units.map((unit) => (
          <UnitView unit={unit} frags={props.frags} />
        ))}
      </details>
    );
  if (!props.fold)
    return (
      <div class="fold" role="note">
        {counted(count, "unchanged block")} {props.where === "between" ? "" : props.where}
      </div>
    );
  // Too long to load into the page: the no-script view of the file shows it.
  if (count > FOLD_LOAD_LIMIT)
    return (
      <a class="fold" href={props.fold.openHref(props.start)}>
        Show {label} (opens {props.fold.path} on its own)
      </a>
    );
  // The text isn't on the page: opening the fold fetches it (client/folds.ts).
  return (
    <details class="folded" data-fold={props.fold.url(props.start, props.start + count)}>
      <FoldSummary label={label} />
      <div class="note" data-fold-body>
        <a href={props.fold.openHref(props.start)}>Show {label}</a>
      </div>
    </details>
  );
}
/**
 * Renders block ops with unchanged runs folded (one block of context kept). `from` and `limit`
 * window the units; fold ranges are unit indices into the whole file.
 */
function BlockDiff(props: {
  ops: readonly DiffBlock[];
  from?: number;
  limit?: number;
  frags: Fragments;
  fold: FoldLinks | null;
  foldsOpen: boolean;
}) {
  const { frags } = props;
  const all = units(props.ops);
  const offset = props.from ?? 0;
  const shown = all.slice(offset, props.limit === undefined ? undefined : offset + props.limit);
  const out: Child[] = [];
  const fold = (run: Unit[], start: number, where: "above" | "below" | "between") => (
    <Fold
      units={run}
      start={offset + start}
      where={where}
      frags={frags}
      fold={props.fold}
      open={props.foldsOpen}
    />
  );
  let index = 0;
  while (index < shown.length) {
    if (!unchanged(shown[index]!)) {
      out.push(<UnitView unit={shown[index]!} frags={frags} />);
      index++;
      continue;
    }
    let end = index;
    while (end < shown.length && unchanged(shown[end]!)) end++;
    const run = shown.slice(index, end);
    const atStart = index === 0;
    const atEnd = end === shown.length;
    if (run.length <= 2 && !atStart && !atEnd)
      run.forEach((unit) => out.push(<UnitView unit={unit} frags={frags} />));
    else if (atStart && atEnd) out.push(fold(run, index, "between"));
    else if (atStart) {
      if (run.length > 1) out.push(fold(run.slice(0, -1), index, "above"));
      out.push(<UnitView unit={run.at(-1)!} frags={frags} />);
    } else if (atEnd) {
      out.push(<UnitView unit={run[0]!} frags={frags} />);
      if (run.length > 1) out.push(fold(run.slice(1), index + 1, "below"));
    } else {
      out.push(<UnitView unit={run[0]!} frags={frags} />);
      out.push(fold(run.slice(1, -1), index + 1, "between"));
      out.push(<UnitView unit={run.at(-1)!} frags={frags} />);
    }
    index = end;
  }
  return <>{out}</>;
}
/** Number of display units (table rows grouped) in a block diff. */
export function unitCount(ops: readonly DiffBlock[]): number {
  return units(ops).length;
}

/**
 * Rendered HTML of diff bodies, keyed by content and view, bounded by size. Rendering a large
 * diff's Markdown fragments takes hundreds of milliseconds, so a repeat view reuses it.
 */
class HtmlCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: string): void {
    if (value.length * 2 > this.maxBytes / 4) return;
    const old = this.entries.get(key);
    if (old !== undefined) this.bytes -= old.length * 2;
    this.entries.delete(key);
    this.entries.set(key, value);
    this.bytes += value.length * 2;
    for (const [oldest, html] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= html.length * 2;
    }
  }
}
const bodies = new HtmlCache(48 * 1024 * 1024);
async function cachedHtml(
  key: string,
  build: (frags: Fragments) => Child,
  render: (sources: string[]) => Promise<(string | null)[]>,
): Promise<string> {
  const cached = bodies.get(key);
  if (cached !== undefined) return cached;
  const frags = new Fragments();
  const node = <>{build(frags)}</>;
  const html = await frags.fill((await node).toString(), render);
  // A rendering cut short by the time budget may complete next time: don't keep it.
  if (!frags.fellBack) bodies.set(key, html);
  return html;
}

/** HTML for units [from, to) of a block diff: what an opened fold loads. */
export function foldFragment(
  diff: FileDiff,
  from: number,
  to: number,
  render: (sources: string[]) => Promise<(string | null)[]>,
  key: string,
): Promise<string> {
  const range = units(diff.ops).slice(from, to);
  return cachedHtml(
    `fold|${key}|${from}|${to}`,
    (frags) => (
      <>
        {range.map((unit) => (
          <UnitView unit={unit} frags={frags} />
        ))}
      </>
    ),
    render,
  );
}
/**
 * Where each hunk (folded unchanged lines) of a full line diff starts on each side, and how many
 * lines it holds, keyed by row index: a hunk starts one past the last numbered row on each side.
 */
export function hunkSpans(
  rows: readonly LineDiffRow[],
): Map<number, { base: number; head: number; count: number }> {
  const spans = new Map<number, { base: number; head: number; count: number }>();
  let base = 0;
  let head = 0;
  rows.forEach((row, index) => {
    if (row.op === "hunk") {
      const count = Number(/^(\d+) unchanged/.exec(row.text)?.[1] ?? 0);
      spans.set(index, { base: base + 1, head: head + 1, count });
      return;
    }
    if (row.base !== undefined) base = row.base;
    if (row.head !== undefined) head = row.head;
  });
  return spans;
}
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** Unchanged source lines as the Changes page's line rows, numbered from `baseStart` and
 * `headStart`: what an opened source-view hunk loads. */
export function foldLinesFragment(
  lines: readonly string[],
  baseStart: number,
  headStart: number,
): string {
  return lines
    .map(
      (text, at) =>
        `<div class="ln"><span class="n">${baseStart + at}</span><span class="n">${headStart + at}</span><span class="s"> </span><span>${text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char)}</span></div>`,
    )
    .join("");
}
/** Where a line diff's hunks load from, and the file they otherwise link to. */
interface LineFoldLinks {
  /** The compare API's URL for head lines [from, to) numbered from base line `bfrom`. */
  url: ((from: number, to: number, bfrom: number) => string) | null;
  openHead: string;
  path: string;
  headN: number;
}
function LineDiff(props: {
  rows: readonly LineDiffRow[];
  /** Index of the first row in the full diff (spans are keyed by full indices). */
  offset: number;
  spans: Map<number, { base: number; head: number; count: number }>;
  fold: LineFoldLinks;
}) {
  const { fold } = props;
  const hunk = (index: number) => {
    const span = props.spans.get(props.offset + index);
    const count = span?.count ?? 0;
    const label = counted(count, "unchanged line");
    if (!span || !fold.url || count > FOLD_LINE_LIMIT)
      return (
        <a class="fold" href={fold.openHead}>
          Show {label} (opens {fold.path} in #{fold.headN})
        </a>
      );
    return (
      <details class="folded lnfold" data-fold={fold.url(span.head, span.head + count, span.base)}>
        <FoldSummary label={label} />
        <div class="note" data-fold-body>
          <a href={fold.openHead}>
            Open {fold.path} in #{fold.headN}
          </a>
        </div>
      </details>
    );
  };
  return (
    <div class="lines">
      {props.rows.map((row, index) =>
        row.op === "hunk" ? (
          hunk(index)
        ) : (
          <div
            class={`ln${row.op === "insert" ? " add" : row.op === "delete" ? " del" : ""}`}
            data-change={
              row.op === "insert" ? "line added" : row.op === "delete" ? "line removed" : undefined
            }
            tabindex={row.op === "equal" ? undefined : -1}
          >
            <span class="n">{row.base ?? ""}</span>
            <span class="n">{row.head ?? ""}</span>
            {row.op === "equal" ? (
              <span class="s"> </span>
            ) : (
              <span class="s">
                <span aria-hidden="true">{row.op === "insert" ? "+" : "−"}</span>
                <span class="vh">{row.op === "insert" ? "added" : "removed"}</span>
              </span>
            )}
            <span>{row.words ? <Words words={row.words} /> : row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}
export function summary(diff: FileDiff): string {
  if (diff.lines) {
    const added = diff.lines.filter((row) => row.op === "insert").length;
    const removed = diff.lines.filter((row) => row.op === "delete").length;
    return (
      [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ") + " lines"
    );
  }
  const added = diff.ops.filter((op) => op.op === "insert").length;
  const removed = diff.ops.filter((op) => op.op === "delete").length;
  const changed = diff.ops.filter((op) => op.op === "replace").length;
  return (
    [changed ? `~${changed}` : "", added ? `+${added}` : "", removed ? `−${removed}` : ""]
      .filter(Boolean)
      .join(" ") + " blocks"
  );
}
/** The card header's counts in words, unit once: "Blocks: 2 changed · 5 added". */
export function summaryWords(diff: FileDiff): Child {
  const count = (op: string) =>
    diff.lines
      ? diff.lines.filter((row) => row.op === op).length
      : diff.ops.filter((block) => block.op === op).length;
  const parts = [
    { cls: "m", n: diff.lines ? 0 : count("replace"), word: "changed" },
    { cls: "a", n: count("insert"), word: "added" },
    { cls: "rm", n: count("delete"), word: "removed" },
  ].filter((part) => part.n > 0);
  if (!parts.length) return null;
  return (
    <>
      {diff.lines ? "Lines: " : "Blocks: "}
      {parts.map((part, index) => (
        <>
          {index ? " · " : ""}
          <span class={part.cls}>
            {part.n} {part.word}
          </span>
        </>
      ))}
    </>
  );
}
/** The unit of a `bytes()` size, with its space: " KB". */
const sizeUnit = (size: string) => size.slice(size.lastIndexOf(" "));
/** Sizes of an image or binary file: "2.8 → 2.8 KB" (the unit once when both sides share it),
 * "new" or "was 2.8 KB". Text files have none (their diffs are counted). */
export function fileTally(file: CompareFile, diff: FileDiff | null | undefined): string | null {
  const kind = diff?.kind ?? kindOf(file.mime);
  if (kind === "text") return null;
  if (file.status === "added") return "new";
  if (file.status === "removed") return `was ${bytes(file.base?.size ?? 0)}`;
  if (file.status !== "modified" || !file.base || !file.head) return null;
  const before = bytes(file.base.size);
  const after = bytes(file.head.size);
  return sizeUnit(before) === sizeUnit(after)
    ? `${before.slice(0, -sizeUnit(before).length)} → ${after}`
    : `${before} → ${after}`;
}
/** The Files tree's tally: a text diff's compact counts, else the file's sizes. */
export function treeTally(file: CompareFile, diff: FileDiff | null | undefined): string | null {
  return diff && !diff.truncated && diff.kind === "text" ? summary(diff) : fileTally(file, diff);
}

const TRUNCATED: Record<TruncatedReason, string> = {
  size: "This change is too large to show (over 1 MB).",
  lines: `This file has more than ${MAX_LINES.toLocaleString("en-US")} lines, too many to diff here.`,
  blocks: `This file has more than ${MAX_BLOCKS.toLocaleString("en-US")} blocks, too many to diff here.`,
  complex: "This change is too complex to show as a diff.",
};
const truncatedReason = (diff: FileDiff): string => TRUNCATED[diff.truncated_reason ?? "size"];

/** One file card's window of blocks or lines, and the page budget it draws from. */
interface Window {
  from: number;
  limit: number;
}
function WindowNote(props: {
  unit: "block" | "line";
  total: number;
  window: Window;
  focused: boolean;
  href: (from: number) => string;
}) {
  const { total, window, unit } = props;
  const step = unit === "line" ? FILE_LINES : FILE_BLOCKS;
  const end = Math.min(total, window.from + window.limit);
  if (window.from === 0 && end >= total) return null;
  const noun = `${unit}s`;
  return (
    <div class="note" data-window={`${window.from}-${end}`}>
      Showing {noun} {window.from + 1}–{end} of {total.toLocaleString("en-US")}.{" "}
      {window.from > 0 && props.focused ? (
        <a href={props.href(Math.max(0, window.from - step))}>Previous {noun}</a>
      ) : null}
      {window.from > 0 && props.focused && end < total ? " · " : null}
      {end < total ? (
        <a href={props.href(end)}>
          {props.focused
            ? `Next ${noun}`
            : `Show the other ${(total - end).toLocaleString("en-US")}`}
        </a>
      ) : null}
    </div>
  );
}
/**
 * The rendered body of a text diff: a window of its blocks (folded runs load on demand) or
 * lines, cached as HTML.
 */
export function textBody(options: {
  ctx: CollectionContext;
  file: CompareFile;
  diff: FileDiff;
  baseId: string | null;
  window: Window;
  focused: boolean;
  foldsOpen: boolean;
  href: (params: Record<string, string>) => string;
  render: (sources: string[]) => Promise<(string | null)[]>;
}): Promise<string> {
  const { ctx, file, diff, window, href } = options;
  const at = (from: number) => href({ file: file.path, from: String(from) });
  const key = [
    // The page's own links (base and view parameters) are part of the HTML.
    href({ file: file.path }),
    ctx.revision.id,
    options.baseId ?? "-",
    file.path,
    file.base?.hash ?? "-",
    file.head?.hash ?? "-",
    diff.lines ? "lines" : "blocks",
    window.from,
    window.limit,
    options.focused ? 1 : 0,
    options.foldsOpen ? 1 : 0,
  ].join("|");
  const encoded = file.path.split("/").map(encodeURIComponent).join("/");
  const api = (params: Record<string, string>) =>
    `/api/revisions/${ctx.revision.id}/compare/${encoded}?${new URLSearchParams(params).toString()}`;
  const headN = ctx.revision.display_number ?? 0;
  const openHead = shellPath(ctx.collection.public_id, ctx.revision.public_id, file.path, true);
  if (diff.lines) {
    const rows = diff.lines;
    const baseId = options.baseId;
    const lineFold: LineFoldLinks = {
      url: baseId
        ? (from, to, bfrom) =>
            api({
              base: baseId,
              mode: "lines",
              format: "html",
              from: String(from),
              to: String(to),
              bfrom: String(bfrom),
            })
        : null,
      openHead,
      path: file.path,
      headN,
    };
    return cachedHtml(
      key,
      () => (
        <>
          <LineDiff
            rows={rows.slice(window.from, window.from + window.limit)}
            offset={window.from}
            spans={hunkSpans(rows)}
            fold={lineFold}
          />
          <WindowNote
            unit="line"
            total={rows.length}
            window={window}
            focused={options.focused}
            href={at}
          />
        </>
      ),
      options.render,
    );
  }
  if (file.status === "added" && diff.ops.length > ADDED_LIMIT) {
    return cachedHtml(
      key,
      (frags) => (
        <>
          <BlockDiff ops={diff.ops} limit={ADDED_PREVIEW} frags={frags} fold={null} foldsOpen />
          <div class="note">
            Showing the first {ADDED_PREVIEW} of {diff.ops.length} blocks.{" "}
            <a href={openHead}>
              Open #{headN}/{file.path}
            </a>
          </div>
        </>
      ),
      options.render,
    );
  }
  const baseId = options.baseId;
  const fold: FoldLinks | null = baseId
    ? {
        url: (from, to) =>
          api({ base: baseId, format: "html", from: String(from), to: String(to) }),
        openHref: (start) =>
          href({
            file: file.path,
            folds: "open",
            from: String(start - (start % FILE_BLOCKS)),
          }),
        path: file.path,
      }
    : null;
  return cachedHtml(
    key,
    (frags) => (
      <>
        <BlockDiff
          ops={diff.ops}
          from={window.from}
          limit={window.limit}
          frags={frags}
          fold={fold}
          foldsOpen={options.foldsOpen}
        />
        <WindowNote
          unit="block"
          total={unitCount(diff.ops)}
          window={window}
          focused={options.focused}
          href={at}
        />
      </>
    ),
    options.render,
  );
}

export function FileCard(props: {
  ctx: CollectionContext;
  file: CompareFile;
  index: number;
  diff: FileDiff | null;
  baseNumber: number | null;
  basePub: string | null;
  view: "rendered" | "source";
  href: (params: Record<string, string>) => string;
  /** The text diff's rendered body (see textBody). */
  text: string | null;
}) {
  const { ctx, file, diff } = props;
  const headN = ctx.revision.display_number ?? 0;
  const openHead = shellPath(ctx.collection.public_id, ctx.revision.public_id, file.path, true);
  const openBase = props.basePub
    ? shellPath(ctx.collection.public_id, props.basePub, file.path, true)
    : null;
  const rawHead = rawPath(ctx.revision.public_id, file.path);
  const rawBase = props.basePub ? rawPath(props.basePub, file.path) : null;
  let body: Child = null;
  // Dimensions fill in after the image loads (client/dims.ts).
  const dims = (
    <span data-dim-wrap hidden>
      {" · "}
      <span data-dim />
    </span>
  );
  if (file.status === "removed" && kindOf(file.mime) === "image" && rawBase && openBase)
    body = (
      <figure class="rmimg" data-dims>
        <span class="img">
          <img
            src={rawBase}
            alt={`${file.path} in #${props.baseNumber}`}
            loading="lazy"
            decoding="async"
          />
        </span>
        <figcaption>
          Removed in #{headN}
          {dims} · {bytes(file.base?.size ?? 0)} ·{" "}
          <a href={openBase}>Open in #{props.baseNumber}</a>
        </figcaption>
      </figure>
    );
  else if (file.status === "removed")
    body = <div class="note">Removed (was {bytes(file.base?.size ?? 0)}).</div>;
  else if (!diff)
    body = (
      <div class="note">
        <a class="btn sm" href={props.href({ file: file.path })}>
          Show diff
        </a>
      </div>
    );
  else if (diff.truncated)
    body = (
      <div class="note" data-truncated={diff.truncated_reason ?? "size"}>
        {truncatedReason(diff)}{" "}
        {diff.truncated_reason === "blocks" && props.view === "rendered" ? (
          <>
            <a href={props.href({ view: "source", file: file.path })}>Try Source lines</a>, or open
          </>
        ) : (
          "Open"
        )}{" "}
        {openBase && file.base ? "both versions: " : ""}
        {openBase && file.base ? (
          <>
            <a href={openBase}>#{props.baseNumber}</a> ({bytes(file.base.size)}) ·{" "}
          </>
        ) : null}
        <a href={openHead}>#{headN}</a>
        {file.head ? ` (${bytes(file.head.size)})` : ""}.
      </div>
    );
  else if (diff.kind === "image")
    body = (
      <div class="imgpair">
        {rawBase && file.base ? (
          <figure data-dims>
            <img
              src={rawBase}
              alt={`${file.path} in #${props.baseNumber}`}
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              Before · #{props.baseNumber}
              {dims} · {bytes(file.base.size)}
            </figcaption>
          </figure>
        ) : null}
        {file.head ? (
          <figure data-dims>
            <img src={rawHead} alt={`${file.path} in #${headN}`} loading="lazy" decoding="async" />
            <figcaption>
              After · #{headN}
              {dims} · {bytes(file.head.size)}
            </figcaption>
          </figure>
        ) : null}
      </div>
    );
  else if (diff.kind === "binary")
    body = (
      <div class="note">
        Binary file {file.status === "added" ? "added" : "changed"}
        {file.base ? ` · ${bytes(file.base.size)} → ` : " · "}
        {bytes(file.head?.size ?? 0)}.{" "}
        {rawBase && file.base ? (
          <a href={rawBase} download>
            Download before
          </a>
        ) : null}
        {rawBase && file.base ? " · " : ""}
        <a href={rawHead} download>
          Download {file.base ? "after" : "it"}
        </a>
      </div>
    );
  else body = raw(props.text ?? "");
  // Counts in words for text diffs; sizes for a changed image or binary file.
  const words =
    diff && !diff.truncated && diff.kind === "text"
      ? summaryWords(diff)
      : file.status === "modified"
        ? fileTally(file, diff)
        : null;
  return (
    <section class="fd" id={`f-${props.index}`} aria-label={file.path} data-file-diff={file.path}>
      <header>
        <span class={glyphClass(file.status)}>
          {mark(glyph(file.status), statusWord(file.status))}
        </span>
        <span class="p">{file.path}</span>
        {file.path === ctx.revision.head_path ? <span class="chip xs">head</span> : null}
        {file.status === "added" ? (
          <span class="muted small">new · {bytes(file.head?.size ?? 0)}</span>
        ) : null}
        <span class="grow" />
        {words ? <span class="tally">{words}</span> : null}
        {file.status === "removed" && openBase ? (
          <a class="btn sm ghost" href={openBase}>
            Open in #{props.baseNumber}
          </a>
        ) : file.status !== "removed" ? (
          <a class="btn sm ghost" href={openHead}>
            Open in #{headN}
          </a>
        ) : null}
      </header>
      {body}
    </section>
  );
}

/** Previous and Next change (client/changes-nav.ts unhides it when the page has a change). One
 * element serves the summary row and the phone dock, so there is one live output. */
export function Stepper() {
  return (
    <div class="stepper" data-stepper hidden>
      <button type="button" class="btn sm" data-step="-1" aria-keyshortcuts="k">
        {raw(icon("chevronLeft"))} Previous <kbd aria-hidden="true">k</kbd>
      </button>
      <output class="stepcount" data-step-count aria-live="polite" />
      <button type="button" class="btn sm" data-step="1" aria-keyshortcuts="j">
        Next <kbd aria-hidden="true">j</kbd> {raw(icon("chevronRight"))}
      </button>
    </div>
  );
}

/** The Rendered/Source switch, only when a changed file is Markdown; other pages are line
 * diffs either way. */
export function ViewSwitch(props: {
  view: "rendered" | "source";
  href: (params: Record<string, string>) => string;
  files: readonly CompareFile[];
}) {
  if (!props.files.some((file) => md(file.mime)))
    return <span class="muted small viewnote">Line diff</span>;
  return (
    <div class="seg" role="group" aria-label="Diff view">
      <a
        href={props.href({ view: "" })}
        aria-current={props.view === "rendered" ? "true" : undefined}
      >
        Rendered
      </a>
      <a
        href={props.href({ view: "source" })}
        aria-current={props.view === "source" ? "true" : undefined}
      >
        Source lines
      </a>
    </div>
  );
}

/** The marks' legend: "+ added · ~ changed · − removed" (the words follow, so the glyphs are
 * hidden from assistive technology). */
export function DiffKey() {
  return (
    <span class="diffkey">
      <span class="k a">
        <span aria-hidden="true">+</span>
      </span>{" "}
      added ·{" "}
      <span class="k m">
        <span aria-hidden="true">~</span>
      </span>{" "}
      changed ·{" "}
      <span class="k rm">
        <span aria-hidden="true">−</span>
      </span>{" "}
      removed
    </span>
  );
}
