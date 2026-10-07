/** @jsxImportSource hono/jsx */
import { markWords, renderFragment } from "@waypoint/render";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import {
  compareManifests,
  type CompareFile,
  type DiffBlock,
  type FileDiff,
  type LineDiffRow,
  type WordOp,
} from "../../compare.js";
import type { HttpServices } from "../../http.js";
import { rawPath, shellPath } from "../../viewer-paths.js";
import { Time } from "../components.js";
import { bytes, plural } from "../format.js";
import { Layout } from "../layout.js";
import { noStore } from "../respond.js";
import {
  CollectionBar,
  CopyMenu,
  HistoryPanel,
  MoreMenu,
  Panel,
  RevisionMenu,
  ShellRoot,
  TabBar,
  CollectionDialogs,
  type CollectionContext,
} from "./collection.js";
import { isLive, LinksPanel, previewHref, ShareDialog } from "./share.js";
import type { ViewerExtras } from "./status.js";

const RENDER_FIRST = 5;
const ADDED_PREVIEW = 20;
const ADDED_LIMIT = 200;
const FOLD_RENDER_LIMIT = 30;

const glyph = (status: CompareFile["status"]) =>
  status === "added" ? "+" : status === "removed" ? "−" : status === "modified" ? "~" : "=";
const glyphClass = (status: CompareFile["status"]) =>
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
function Rendered(props: { markdown: string }) {
  return <div class="tx rd" dangerouslySetInnerHTML={{ __html: renderFragment(props.markdown) }} />;
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
    <div class="blk src mod">
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
      <div class={`blk src ${tone(op.op)}`}>
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
    <div class="blk src mod">
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
function BlockView(props: { op: DiffBlock }) {
  const { op } = props;
  if (op.kind === "code") return <CodeBlock op={op} />;
  const source =
    op.op === "replace" && op.words
      ? markWords(op.words)
      : op.op === "delete"
        ? (op.base_text ?? "")
        : (op.head_text ?? "");
  return (
    <div
      class={`blk ${tone(op.op)}`}
      data-change={op.op === "equal" ? undefined : ""}
      tabindex={op.op === "equal" ? undefined : -1}
    >
      {marker(op.op)}
      <Rendered markdown={source} />
    </div>
  );
}
function UnitView(props: { unit: Unit }) {
  return "table" in props.unit ? (
    <TableUnit rows={props.unit.table} />
  ) : (
    <BlockView op={props.unit.block} />
  );
}
function Fold(props: { units: Unit[]; where: "above" | "below" | "between" }) {
  const count = props.units.reduce((sum, unit) => sum + ("table" in unit ? 1 : 1), 0);
  const label = `Show ${plural(count, "unchanged block")}${props.where === "between" ? "" : ` ${props.where}`}`;
  if (count > FOLD_RENDER_LIMIT)
    return (
      <div class="fold" role="note">
        {plural(count, "unchanged block")} {props.where === "between" ? "" : props.where}
      </div>
    );
  return (
    <details class="folded">
      <summary class="fold">{label}</summary>
      {props.units.map((unit) => (
        <UnitView unit={unit} />
      ))}
    </details>
  );
}
/** Renders block ops with unchanged runs folded behind <details> (one block of context kept). */
function BlockDiff(props: { ops: readonly DiffBlock[]; limit?: number }) {
  const all = units(props.ops);
  const shown = props.limit ? all.slice(0, props.limit) : all;
  const out: Child[] = [];
  let index = 0;
  while (index < shown.length) {
    if (!unchanged(shown[index]!)) {
      out.push(<UnitView unit={shown[index]!} />);
      index++;
      continue;
    }
    let end = index;
    while (end < shown.length && unchanged(shown[end]!)) end++;
    const run = shown.slice(index, end);
    const atStart = index === 0;
    const atEnd = end === shown.length;
    if (run.length <= 2 && !atStart && !atEnd)
      run.forEach((unit) => out.push(<UnitView unit={unit} />));
    else if (atStart && atEnd) out.push(<Fold units={run} where="between" />);
    else if (atStart) {
      if (run.length > 1) out.push(<Fold units={run.slice(0, -1)} where="above" />);
      out.push(<UnitView unit={run.at(-1)!} />);
    } else if (atEnd) {
      out.push(<UnitView unit={run[0]!} />);
      if (run.length > 1) out.push(<Fold units={run.slice(1)} where="below" />);
    } else {
      out.push(<UnitView unit={run[0]!} />);
      out.push(<Fold units={run.slice(1, -1)} where="between" />);
      out.push(<UnitView unit={run.at(-1)!} />);
    }
    index = end;
  }
  return <>{out}</>;
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
function summary(diff: FileDiff): string {
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

function FileCard(props: {
  ctx: CollectionContext;
  file: CompareFile;
  index: number;
  diff: FileDiff | null;
  baseNumber: number | null;
  basePub: string | null;
  view: "rendered" | "source";
  href: (params: Record<string, string>) => string;
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
      <div class="note">
        This change is too large to show (&gt; 1 MB). Open both versions:{" "}
        {openBase ? <a href={openBase}>#{props.baseNumber}</a> : null}
        {openBase ? " · " : ""}
        <a href={openHead}>#{headN}</a>.
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
  else if (diff.lines) body = <LineDiff rows={diff.lines} />;
  else if (file.status === "added" && diff.ops.length > ADDED_LIMIT)
    body = (
      <>
        <BlockDiff ops={diff.ops} limit={ADDED_PREVIEW} />
        <div class="note">
          Showing the first {ADDED_PREVIEW} of {diff.ops.length} blocks.{" "}
          <a href={openHead}>
            Open #{headN}/{file.path}
          </a>
        </div>
      </>
    );
  else body = <BlockDiff ops={diff.ops} />;
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

export async function changesPage(
  s: HttpServices,
  c: Context,
  ctx: CollectionContext,
  extras: ViewerExtras,
): Promise<Response> {
  const { revision, collection, rows } = ctx;
  const basePub = c.req.query("base")?.toLowerCase();
  const baseRow = basePub
    ? rows.find((row) => row.public_id === basePub)
    : rows.find((row) => row.id === revision.parent_revision_id);
  const view = c.req.query("view") === "source" ? "source" : "rendered";
  const only = c.req.query("file");
  const baseManifest = baseRow ? await s.reads.manifestOf(baseRow) : null;
  const compare = compareManifests(baseManifest, ctx.manifest);
  const changed = compare.files.filter((file) => file.status !== "unchanged");
  const unchangedFiles = compare.files.filter((file) => file.status === "unchanged");
  const rendered = new Set(
    (only ? changed.filter((file) => file.path === only) : changed.slice(0, RENDER_FIRST)).map(
      (file) => file.path,
    ),
  );
  const diffs = new Map<string, FileDiff>();
  for (const file of changed)
    if (rendered.has(file.path) && file.status !== "removed")
      diffs.set(file.path, await extras.fileDiff(file, view === "source" ? "lines" : "blocks"));
  const baseN = baseRow?.display_number ?? null;
  const headN = revision.display_number ?? 0;
  const crossFork = Boolean(baseRow && baseRow.id !== revision.parent_revision_id);
  const page = `${shellPath(collection.public_id, revision.public_id, "", true)}changes`;
  const href = (params: Record<string, string>) => {
    const merged: Record<string, string> = {
      ...(basePub ? { base: basePub } : {}),
      ...(view === "source" ? { view } : {}),
      ...params,
    };
    const text = new URLSearchParams(
      Object.entries(merged).filter(([, value]) => value !== ""),
    ).toString();
    return `${page}${text ? `?${text}` : ""}`;
  };
  const done =
    revision.id === ctx.latest?.id
      ? `/c/${collection.public_id}/`
      : shellPath(collection.public_id, revision.public_id, "", true);
  const host = ctx.timeline.find((row) => row.id === revision.id)?.host;
  const pill = baseN === null ? "first revision" : `changes from #${baseN}`;
  const filesPanel = (
    <>
      <div class="tree">
        <div class="dir">Changed</div>
        {changed.length ? (
          changed.map((file) => {
            const index = compare.files.indexOf(file);
            const diff = diffs.get(file.path);
            return (
              <a
                href={rendered.has(file.path) ? `#f-${index}` : href({ file: file.path })}
                aria-current={only === file.path ? "page" : undefined}
              >
                <span class={glyphClass(file.status)} aria-label={file.status}>
                  {glyph(file.status)}
                </span>
                <span class="nm">{file.path}</span>
                {diff && !diff.truncated && diff.kind === "text" ? (
                  <span class="sz">{summary(diff)}</span>
                ) : null}
              </a>
            );
          })
        ) : (
          <p class="legend">No file changes.</p>
        )}
        {unchangedFiles.length ? (
          <details>
            <summary>{plural(unchangedFiles.length, "unchanged file")}</summary>
            <div>
              {unchangedFiles.map((file) => (
                <a href={shellPath(collection.public_id, revision.public_id, file.path, true)}>
                  <span class="k">=</span>
                  <span class="nm muted">{file.path}</span>
                </a>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <p class="legend">
        {baseN === null
          ? `#${headN} is the first revision, so everything is new.`
          : `Comparing #${headN} with ${crossFork ? `#${baseN} (not its parent)` : `its parent #${baseN}`}. Pick another base from the revision menu.`}
      </p>
    </>
  );
  const chips: Child[] = [];
  if (compare.counts.modified)
    chips.push(
      <span class="chip">
        <span class="k m">~</span>
        {compare.counts.modified} changed
      </span>,
    );
  if (compare.counts.added)
    chips.push(
      <span class="chip">
        <span class="k a">+</span>
        {compare.counts.added} added
      </span>,
    );
  if (compare.counts.removed)
    chips.push(
      <span class="chip">
        <span class="k rm">−</span>
        {compare.counts.removed} removed
      </span>,
    );
  if (compare.counts.unchanged)
    chips.push(<span class="chip">{compare.counts.unchanged} unchanged</span>);
  return noStore(
    c.html(
      <Layout
        title={`Changes in #${headN} · ${collection.title}`}
        chrome={ctx.chrome}
        bar={<CollectionBar ctx={ctx} pill={pill} doneHref={done} />}
        page="changes"
      >
        <ShellRoot ctx={ctx} path={revision.head_path} mode="changes">
          <Panel
            ctx={ctx}
            tab={
              c.req.query("panel") === "history"
                ? "history"
                : c.req.query("panel") === "links" && ctx.links.length
                  ? "links"
                  : "files"
            }
            files={filesPanel}
            history={<HistoryPanel ctx={ctx} path="" all={c.req.query("history") === "all"} />}
            links={
              ctx.links.length ? (
                <LinksPanel
                  ctx={ctx}
                  links={ctx.links}
                  previewHref={previewHref(ctx, revision.head_path)}
                />
              ) : undefined
            }
            linkCount={ctx.links.filter(isLive).length}
          />
          <main class="main" id="main" tabindex={-1}>
            <div class="cmp" data-done={done}>
              <div class="cmphead">
                <h2>Changes in #{headN}</h2>
                <div class="muted">
                  {revision.message ? `“${revision.message}” · ` : ""}
                  {host ? (
                    <>
                      <span class="mono">{host}</span> ·{" "}
                    </>
                  ) : null}
                  <Time at={revision.created_at} fmt="day" now={ctx.chrome.now} />
                  {baseN !== null
                    ? ` · compared with #${baseN}${crossFork ? " (not its parent)" : ""}`
                    : null}
                </div>
                <div class="sumrow">
                  {chips}
                  <span class="grow" />
                  <div class="seg" role="group" aria-label="Diff view">
                    <a
                      href={href({ view: "" })}
                      aria-current={view === "rendered" ? "true" : undefined}
                    >
                      Rendered
                    </a>
                    <a
                      href={href({ view: "source" })}
                      aria-current={view === "source" ? "true" : undefined}
                    >
                      Source lines
                    </a>
                  </div>
                </div>
              </div>
              {baseN === null ? (
                <p class="cmphead muted">#{headN} is the first revision. Everything is new.</p>
              ) : null}
              {changed.length ? null : (
                <p class="cmphead muted">
                  No file changed between #{baseN} and #{headN}
                  {compare.head_path_changed ? "; only the head file changed" : ""}.
                </p>
              )}
              {(only ? changed.filter((file) => file.path === only) : changed).map((file) => (
                <FileCard
                  ctx={ctx}
                  file={file}
                  index={compare.files.indexOf(file)}
                  diff={diffs.get(file.path) ?? null}
                  baseNumber={baseN}
                  basePub={baseRow?.public_id ?? null}
                  view={view}
                  href={href}
                />
              ))}
              {only ? (
                <p class="cmphead">
                  <a href={href({ file: "" })}>Show all changed files</a>
                </p>
              ) : null}
            </div>
          </main>
        </ShellRoot>
        <div class="panel-scrim" data-action="panel-close" />
        <TabBar />
        <RevisionMenu ctx={ctx} path="" />
        <CopyMenu ctx={ctx} path={revision.head_path} />
        <MoreMenu ctx={ctx} path={revision.head_path} />
        <CollectionDialogs ctx={ctx} />
        <CompareDialog ctx={ctx} basePub={baseRow?.public_id ?? null} />
        {ctx.sharing ? (
          <ShareDialog
            ctx={ctx}
            links={ctx.links}
            previewHref={previewHref(ctx, revision.head_path)}
          />
        ) : null}
      </Layout>,
    ),
  );
}

/** Shortens an option label at a word boundary, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The revision menu's Compare… picker: choose any two revisions. */
export function CompareDialog(props: { ctx: CollectionContext; basePub: string | null }) {
  const { ctx } = props;
  const options = ctx.timeline.toReversed();
  return (
    <dialog class="dlg narrow" id="compare" aria-labelledby="compare-title">
      <form data-form="compare" method="get" action={`/c/${ctx.collection.public_id}/`}>
        <div class="bd">
          <h2 id="compare-title">Compare revisions</h2>
          <div class="fields">
            <label class="fl">
              From (older)
              <select name="base">
                {options.map((row) => (
                  <option
                    value={row.public_id}
                    selected={
                      row.public_id ===
                      (props.basePub ??
                        ctx.byId.get(ctx.revision.parent_revision_id ?? "")?.public_id)
                    }
                  >
                    #{row.display_number} · {clip(row.message ?? "No message", 60)}
                  </option>
                ))}
              </select>
            </label>
            <label class="fl">
              To (newer)
              <select name="head">
                {options.map((row) => (
                  <option value={row.public_id} selected={row.id === ctx.revision.id}>
                    #{row.display_number} · {clip(row.message ?? "No message", 60)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <p class="alert" role="alert" data-form-error />
        <div class="ft">
          <button class="btn" formmethod="dialog" formnovalidate value="cancel">
            Cancel
          </button>
          <button class="btn primary">Compare</button>
        </div>
      </form>
    </dialog>
  );
}
