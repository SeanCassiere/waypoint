/** @jsxImportSource hono/jsx */
import { markWords } from "@waypoint/render";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import {
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
/** Unchanged runs up to this long are inlined on the no-script `?folds=open` view. */
const FOLD_RENDER_LIMIT = 30;
/** Unchanged runs up to this long load on demand when opened; longer ones stay a note. */
export const FOLD_LOAD_LIMIT = 200;
/** Blocks (or source lines) one file card shows at a time, and the whole page's budget. A
 * file past its window links to the next one, so no Changes page is megabytes of HTML. */
export const FILE_BLOCKS = 300;
export const PAGE_BLOCKS = 600;
export const FILE_LINES = 1500;
export const PAGE_LINES = 3000;
/** Code blocks diff line by line with an LCS table; past this many cells, lines show as removed
 * then added. */
const CODE_LCS_CELLS = 250_000;

export const glyph = (status: CompareFile["status"]) =>
  status === "added" ? "+" : status === "removed" ? "−" : status === "modified" ? "~" : "=";
export const glyphClass = (status: CompareFile["status"]) =>
  status === "added" ? "k a" : status === "removed" ? "k rm" : status === "modified" ? "k m" : "k";

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
const marker = (op: DiffBlock["op"]) =>
  op === "insert" ? (
    <span class="mk" aria-label="added">
      +
    </span>
  ) : op === "delete" ? (
    <span class="mk" aria-label="removed">
      −
    </span>
  ) : op === "replace" ? (
    <span class="mk" aria-label="changed">
      ~
    </span>
  ) : (
    <span class="mk" aria-hidden="true" />
  );
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
    <div class="blk src mod" data-change="" tabindex={-1}>
      <span class="mk" aria-label="changed">
        ~
      </span>
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
      <div class={`blk src ${tone(op.op)}`} data-change="" tabindex={-1}>
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
  if (before.length * after.length > CODE_LCS_CELLS)
    return (
      <div class="blk src mod" data-change="" tabindex={-1}>
        {marker("replace")}
        <div class="tx">
          <span class="srcnote">
            Code{language ? ` · ${language}` : ""} ·{" "}
            {plural(Math.max(before.length, after.length), "line")} changed
          </span>
          {before.map((line) => (
            <span class="lndel">{line}</span>
          ))}
          {after.map((line) => (
            <span class="lnadd">{line}</span>
          ))}
        </div>
      </div>
    );
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
      rows.push(<span class="lndel">{before[i]}</span>);
      i++;
      deleted++;
    } else {
      rows.push(<span class="lnadd">{after[j]}</span>);
      j++;
      added++;
    }
  }
  return (
    <div class="blk src mod" data-change="" tabindex={-1}>
      {marker("replace")}
      <div class="tx">
        <span class="srcnote">
          Code{language ? ` · ${language}` : ""} · {plural(Math.max(deleted, added), "line")}{" "}
          changed
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
  return (
    <div
      class={`blk ${tone(op.op)}`}
      data-change={op.op === "equal" ? undefined : ""}
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
  /** The no-script view of the file with short runs inlined, at the window holding `start`. */
  openHref: (start: number) => string;
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
  const label = `Show ${plural(count, "unchanged block")}${props.where === "between" ? "" : ` ${props.where}`}`;
  // The no-script full view inlines short runs, as the page always did.
  if (props.open && count <= FOLD_RENDER_LIMIT)
    return (
      <details class="folded">
        <summary class="fold">{label}</summary>
        {props.units.map((unit) => (
          <UnitView unit={unit} frags={props.frags} />
        ))}
      </details>
    );
  if (!props.fold || props.open || count > FOLD_LOAD_LIMIT)
    return (
      <div class="fold" role="note">
        {plural(count, "unchanged block")} {props.where === "between" ? "" : props.where}
      </div>
    );
  // The text isn't on the page: opening the fold fetches it (client/folds.ts).
  return (
    <details class="folded" data-fold={props.fold.url(props.start, props.start + count)}>
      <summary class="fold">{label}</summary>
      <div class="note" data-fold-body>
        <a href={props.fold.openHref(props.start)}>{label}</a>
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
function LineDiff(props: { rows: readonly LineDiffRow[] }) {
  return (
    <div class="lines">
      {props.rows.map((row) =>
        row.op === "hunk" ? (
          <div class="hunk">⋯ {row.text}</div>
        ) : (
          <div
            class={`ln${row.op === "insert" ? " add" : row.op === "delete" ? " del" : ""}`}
            data-change={row.op === "equal" ? undefined : ""}
            tabindex={row.op === "equal" ? undefined : -1}
          >
            <span class="n">{row.base ?? ""}</span>
            <span class="n">{row.head ?? ""}</span>
            <span
              class="s"
              aria-label={
                row.op === "insert" ? "added" : row.op === "delete" ? "removed" : undefined
              }
            >
              {row.op === "insert" ? "+" : row.op === "delete" ? "−" : " "}
            </span>
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
  if (diff.lines) {
    const rows = diff.lines;
    return cachedHtml(
      key,
      () => (
        <>
          <LineDiff rows={rows.slice(window.from, window.from + window.limit)} />
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
    const openHead = shellPath(ctx.collection.public_id, ctx.revision.public_id, file.path, true);
    return cachedHtml(
      key,
      (frags) => (
        <>
          <BlockDiff ops={diff.ops} limit={ADDED_PREVIEW} frags={frags} fold={null} foldsOpen />
          <div class="note">
            Showing the first {ADDED_PREVIEW} of {diff.ops.length} blocks.{" "}
            <a href={openHead}>
              Open #{ctx.revision.display_number ?? 0}/{file.path}
            </a>
          </div>
        </>
      ),
      options.render,
    );
  }
  const encoded = file.path.split("/").map(encodeURIComponent).join("/");
  const fold: FoldLinks | null = options.baseId
    ? {
        url: (from, to) =>
          `/api/revisions/${ctx.revision.id}/compare/${encoded}?${new URLSearchParams({
            base: options.baseId!,
            format: "html",
            from: String(from),
            to: String(to),
          }).toString()}`,
        openHref: (start) =>
          href({
            file: file.path,
            folds: "open",
            from: String(start - (start % FILE_BLOCKS)),
          }),
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
  if (file.status === "removed")
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
          <figure>
            <img
              src={rawBase}
              alt={`${file.path} in #${props.baseNumber}`}
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              Before · #{props.baseNumber} · {bytes(file.base.size)}
            </figcaption>
          </figure>
        ) : null}
        {file.head ? (
          <figure>
            <img src={rawHead} alt={`${file.path} in #${headN}`} loading="lazy" decoding="async" />
            <figcaption>
              After · #{headN} · {bytes(file.head.size)}
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
  return (
    <section class="fd" id={`f-${props.index}`} aria-label={file.path} data-file-diff={file.path}>
      <header>
        <span class={glyphClass(file.status)} aria-label={file.status}>
          {glyph(file.status)}
        </span>
        <span class="p">{file.path}</span>
        {file.path === ctx.revision.head_path ? <span class="chip xs">head</span> : null}
        {file.status === "added" ? (
          <span class="muted small">new · {bytes(file.head?.size ?? 0)}</span>
        ) : null}
        <span class="grow" />
        {diff && !diff.truncated && diff.kind === "text" ? (
          <span class="chg">{summary(diff)}</span>
        ) : null}
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
