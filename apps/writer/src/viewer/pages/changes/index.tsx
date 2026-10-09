/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import { compareManifests, type FileDiff } from "../../../compare.ts";
import type { HttpServices } from "../../../http.ts";
import { isLive } from "../../../shares.ts";
import { shellPath } from "../../../viewer-paths.ts";
import { Time } from "../../components.tsx";
import { plural } from "../../format.ts";
import { Layout } from "../../layout.tsx";
import { noStore } from "../../respond.ts";
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
} from "../collection/index.tsx";
import { LinksPanel, previewHref, ShareDialog } from "../share.tsx";
import type { ViewerExtras } from "../status.tsx";
import { CompareDialog } from "./compare-dialog.tsx";
import {
  ADDED_PREVIEW,
  ADDED_LIMIT,
  FILE_BLOCKS,
  PAGE_BLOCKS,
  FILE_LINES,
  PAGE_LINES,
  glyph,
  glyphClass,
  unitCount,
  summary,
  textBody,
  FileCard,
} from "./units.tsx";

const RENDER_FIRST = 5;

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
  const diffs = new Map<string, FileDiff>();
  for (const file of changed)
    if (rendered.has(file.path) && file.status !== "removed")
      diffs.set(file.path, await extras.fileDiff(file, view === "source" ? "lines" : "blocks"));
  // Each card shows a window of its blocks or lines, drawn from a page-wide budget; a file with
  // nothing left in the budget shows a "Show diff" link like the files past RENDER_FIRST.
  const focused = Boolean(only);
  const start = focused ? Math.max(0, Math.floor(Number(c.req.query("from") ?? 0)) || 0) : 0;
  const foldsOpen = focused && c.req.query("folds") === "open";
  const budget = { block: PAGE_BLOCKS, line: PAGE_LINES };
  const texts = new Map<string, string>();
  for (const file of changed) {
    const diff = diffs.get(file.path);
    if (!diff || diff.truncated || diff.kind !== "text") continue;
    const unit = diff.lines ? "line" : "block";
    const limit = Math.min(unit === "line" ? FILE_LINES : FILE_BLOCKS, budget[unit]);
    if (limit <= 0 && !focused) {
      diffs.delete(file.path);
      continue;
    }
    const window = {
      from: start,
      limit: focused ? (unit === "line" ? FILE_LINES : FILE_BLOCKS) : limit,
    };
    budget[unit] -= diff.lines
      ? Math.min(window.limit, diff.lines.length)
      : file.status === "added" && diff.ops.length > ADDED_LIMIT
        ? ADDED_PREVIEW
        : Math.min(window.limit, unitCount(diff.ops));
    texts.set(
      file.path,
      await textBody({
        ctx,
        file,
        diff,
        baseId: baseRow?.id ?? null,
        window,
        focused,
        foldsOpen,
        href,
        render: (sources) => extras.renderFragments(sources),
      }),
    );
  }
  const baseN = baseRow?.display_number ?? null;
  const headN = revision.display_number ?? 0;
  const crossFork = Boolean(baseRow && baseRow.id !== revision.parent_revision_id);
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
  const cardList = (
    <>
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
          text={texts.get(file.path) ?? null}
        />
      ))}
    </>
  );
  const cards = (await cardList).toString();
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
              {raw(cards)}
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

export {
  FOLD_LOAD_LIMIT,
  FILE_BLOCKS,
  PAGE_BLOCKS,
  FILE_LINES,
  PAGE_LINES,
  unitCount,
  foldFragment,
} from "./units.tsx";
export { CompareDialog } from "./compare-dialog.tsx";
