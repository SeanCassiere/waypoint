/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import { compareManifests, type FileDiff } from "../../../compare.ts";
import type { HttpServices } from "../../../http.ts";
import { isLive } from "../../../shares.ts";
import { shellPath } from "../../../viewer-paths.ts";
import { excludedLabel, type PairKind } from "../../compare-text.ts";
import { Time, type TimelineRow } from "../../components.tsx";
import { plural } from "../../format.ts";
import { Layout } from "../../layout.tsx";
import { noStore } from "../../respond.ts";
import {
  CollectionBar,
  CopyMenu,
  HistoryPanel,
  MoreMenu,
  Panel,
  ShellRoot,
  TabBar,
  CollectionDialogs,
  StatusLine,
  type CollectionContext,
  type Segment,
} from "../collection/index.tsx";
import { AboutCard } from "../collection/panel.tsx";
import { LinksPanel, previewHref, publicSegment, ShareDialog, shareDisclosure } from "../share.tsx";
import type { ViewerExtras } from "../status.tsx";
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
  textBody,
  treeTally,
  DiffKey,
  FileCard,
  Stepper,
  ViewSwitch,
} from "./units.tsx";

const RENDER_FIRST = 5;

export async function changesPage(
  s: HttpServices,
  c: Context,
  ctx: CollectionContext,
  extras: ViewerExtras,
): Promise<Response> {
  const { revision, collection, rows } = ctx;
  const view = c.req.query("view") === "source" ? "source" : "rendered";
  const parentRow = rows.find((row) => row.id === revision.parent_revision_id);
  // The pair, classified in order (NAV-10): no ?base= is the parent comparison; a ?base= with no
  // row is a 404 and the same row a 400, both showing the parent comparison around the error;
  // otherwise lineage.ts says how the two relate (a reversed pair redirects, ordered).
  const query = c.req.query("base");
  const picked =
    query === undefined ? undefined : rows.find((row) => row.public_id === query.toLowerCase());
  let kind: "first" | PairKind = parentRow ? "parent" : "first";
  let error: "missing" | "same" | null = null;
  let baseRow = parentRow;
  let steps: TimelineRow[] = [];
  let excluded: TimelineRow[] = [];
  let common: TimelineRow | null = null;
  if (query !== undefined && !picked) error = "missing";
  else if (picked) {
    const relation = ctx.lineage.relation(picked.id, revision.id);
    switch (relation.kind) {
      case "same":
        error = "same";
        break;
      case "parent":
        kind = "parent";
        baseRow = picked;
        steps = relation.steps;
        break;
      case "ancestor":
        kind = "ancestor";
        baseRow = picked;
        steps = relation.steps;
        excluded = relation.excluded;
        break;
      case "descendant": {
        // The base is newer, on the head's line: the ordered URL, computed from the two rows.
        const ordered = new URLSearchParams();
        if (picked.parent_revision_id !== revision.id) ordered.set("base", revision.public_id);
        ordered.set("swapped", "1");
        if (view === "source") ordered.set("view", "source");
        return noStore(
          c.redirect(
            `${shellPath(collection.public_id, picked.public_id, "", true)}changes?${ordered.toString()}`,
            302,
          ),
        );
      }
      case "branches":
        kind = "branches";
        baseRow = picked;
        common = relation.common;
        break;
      case "unknown":
        // Both rows are here, so "unknown" means two separate histories.
        kind = "unrelated";
        baseRow = picked;
        break;
      default: {
        const never: never = relation;
        throw new Error(`Unknown relation ${JSON.stringify(never)}`);
      }
    }
  }
  // A parent pair's one step is the head (it carries the range segment's sync state).
  const head = ctx.byId.get(revision.id);
  if (kind === "parent" && !steps.length && head) steps = [head];
  // Error pages merge no base into their links; other pages keep the one they were asked for.
  const basePub = error ? undefined : picked?.public_id;
  // History's Compare… and Cancel keep the page's query, so on error pages without the base.
  const cleanUrl = new URL(ctx.url);
  cleanUrl.searchParams.delete("base");
  const historyCtx = error ? { ...ctx, url: cleanUrl } : ctx;
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
        render: (sources, links) => extras.renderFragments(sources, links),
      }),
    );
  }
  const baseN = baseRow?.display_number ?? null;
  const headN = revision.display_number ?? 0;
  const done =
    revision.id === ctx.latest?.id
      ? `/c/${collection.public_id}/`
      : shellPath(collection.public_id, revision.public_id, "", true);
  const host = ctx.timeline.find((row) => row.id === revision.id)?.host;
  const pill = baseN === null ? "first revision" : `changes from #${baseN}`;
  const [low, high] = [baseN ?? 0, headN].toSorted((a, b) => a - b);
  // VS-03b deleted the branches crumb's compare glyph (no icon for it); NAV-09b words it.
  const crumb = error
    ? undefined
    : kind === "ancestor"
      ? `#${baseN} → #${headN} changes`
      : kind === "branches" || kind === "unrelated"
        ? `#${low} and #${high} branches`
        : undefined;
  const ownChanges = (row: { public_id: string }) =>
    `${shellPath(collection.public_id, row.public_id, "", true)}changes`;
  const legend =
    kind === "first"
      ? `#${headN} is the first revision, so everything is new.`
      : kind === "parent"
        ? `Comparing #${headN} with its parent #${baseN}. To compare other revisions, use Compare… in History.`
        : kind === "ancestor"
          ? `Changes from #${baseN} to #${headN} across ${plural(steps.length, "revision")}: ${steps.map((row) => `#${row.display_number}`).join(", ")}. To change the range, use Compare… in History.`
          : kind === "branches"
            ? `Comparing two branches that split at #${common?.display_number ?? "?"}.`
            : "Comparing two unrelated histories.";
  const unsynced = error ? [] : steps.filter((row) => row.sync_state !== "synced");
  const rangeText = unsynced.length
    ? `These changes are readable here only; public links see ${ctx.publicSees ? `#${ctx.publicSees.display_number}` : "nothing yet"}, so ${
        unsynced.length === 1
          ? `#${unsynced[0]?.display_number}'s part isn't public yet`
          : `the parts from ${listed(unsynced.map((row) => `#${row.display_number}`))} aren't public yet`
      }.`
    : null;
  const rangeSegment: Segment | null = rangeText
    ? { tone: "info", text: rangeText, body: <span class="long">{rangeText}</span> }
    : null;
  const segments = [publicSegment(ctx.links), rangeSegment].filter((item) => item !== null);
  const baseTimeline = baseRow ? ctx.byId.get(baseRow.id) : undefined;
  const filesPanel = (
    <>
      <div class="tree">
        <div class="dir">Changed</div>
        {changed.length ? (
          changed.map((file) => {
            const index = compare.files.indexOf(file);
            const tally = treeTally(file, diffs.get(file.path));
            return (
              <a
                href={rendered.has(file.path) ? `#f-${index}` : href({ file: file.path })}
                aria-current={only === file.path ? "page" : undefined}
              >
                <span class={glyphClass(file.status)} aria-label={file.status}>
                  {glyph(file.status)}
                </span>
                <span class="nm">{file.path}</span>
                {tally ? <span class="sz">{tally}</span> : null}
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
        <DiffKey />
      </p>
      <p class="legend">{legend}</p>
      <AboutCard ctx={ctx} />
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
  const disclosure = ctx.sharing ? await shareDisclosure(ctx, revision.head_path) : null;
  return noStore(
    c.html(
      <Layout
        title={`Changes in #${headN} · ${collection.title}`}
        chrome={ctx.chrome}
        bar={
          <CollectionBar
            ctx={ctx}
            mode="changes"
            pill={pill}
            crumb={crumb}
            doneHref={done}
            menus={
              <>
                <CopyMenu ctx={ctx} path={revision.head_path} />
                <MoreMenu ctx={ctx} path={revision.head_path} />
              </>
            }
          />
        }
        page="changes"
        findIn={collection.title}
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
            history={
              <HistoryPanel
                ctx={historyCtx}
                path=""
                all={c.req.query("history") === "all"}
                preticks={baseRow ? [baseRow.public_id, revision.public_id] : [revision.public_id]}
              />
            }
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
            <h2 class="vh">Sync and sharing status</h2>
            <StatusLine ctx={ctx} extra={segments} />
            <div class="cmp" data-done={done}>
              {error ? (
                <p class="cmphead cmperr">
                  {error === "missing" ? (
                    <>
                      <b>#? isn't in this collection any more.</b>{" "}
                      <a href={href({})}>
                        {baseN === null
                          ? `See what #${headN} added ›`
                          : `Compare with the parent #${baseN} instead ›`}
                      </a>
                    </>
                  ) : (
                    <>
                      <b>Pick two different revisions.</b>{" "}
                      <a href={`?panel=history&compare=1&r=${revision.public_id}`}>
                        Choose revisions to compare ›
                      </a>
                    </>
                  )}
                </p>
              ) : (
                <>
                  {c.req.query("swapped") === "1" && baseN !== null ? (
                    <p class="cmpnote" role="status">
                      Swapped to #{baseN} → #{headN} so additions read as additions.
                    </p>
                  ) : null}
                  <div class="cmphead">
                    {kind === "ancestor" ? (
                      <>
                        <h2>
                          Changes from #{baseN} to #{headN}
                        </h2>
                        <div class="muted">
                          Everything that changed after {baseRow ? message(baseRow) : ""} (#{baseN}
                          ), up to {message(revision)} (#{headN})
                          {host ? (
                            <>
                              {" · "}
                              <span class="mono">{host}</span>
                            </>
                          ) : null}
                          {" · "}
                          <Time at={revision.created_at} fmt="day" now={ctx.chrome.now} />
                        </div>
                        <div class="incl">
                          <span class="lbl">Includes</span>
                          <ol>
                            {steps.map((row, i) => (
                              <li>
                                <a
                                  class={`stepchip${row.sync_state === "pending" ? " pending" : row.sync_state === "failed" ? " failed" : ""}`}
                                  href={ownChanges(row)}
                                >
                                  <b>#{row.display_number}</b> {row.message ?? "No message"}
                                </a>
                                {i < steps.length - 1 ? (
                                  <span class="arr" aria-hidden="true">
                                    →
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ol>
                        </div>
                        {head
                          ? excluded.map((row) => (
                              <p class="excl">
                                {raw(icon("branch", "sm"))} Not included:{" "}
                                {excludedLabel(ctx.lineage, row, head)}.
                                {ctx.lineage.onLine.has(row.id) ? null : (
                                  <>
                                    {" "}
                                    <a href={ownChanges(row)}>
                                      What #{row.display_number} changed ›
                                    </a>
                                  </>
                                )}
                              </p>
                            ))
                          : null}
                      </>
                    ) : kind === "branches" || kind === "unrelated" ? (
                      <>
                        <h2>
                          #{headN} compared with #{baseN}{" "}
                          <span class="chip xs">
                            {kind === "branches" ? "different branches" : "different histories"}
                          </span>
                        </h2>
                        <div class="muted">
                          {kind === "branches"
                            ? `#${low} and #${high} both build on #${common?.display_number ?? "?"}, so this shows how the two versions differ, not what either one changed.`
                            : `#${low} and #${high} share no earlier revision.`}
                        </div>
                        {kind === "branches" && common ? (
                          <ForkCard ctx={ctx} base={baseTimeline ?? common} common={common} />
                        ) : null}
                      </>
                    ) : (
                      <>
                        <h2>Changes in #{headN}</h2>
                        <div class="muted">
                          {revision.message ? `“${revision.message}” · ` : ""}
                          {host ? (
                            <>
                              <span class="mono">{host}</span> ·{" "}
                            </>
                          ) : null}
                          <Time at={revision.created_at} fmt="day" now={ctx.chrome.now} />
                          {baseN !== null ? ` · compared with its parent #${baseN}` : null}
                        </div>
                      </>
                    )}
                    <div class="sumrow">
                      {chips}
                      <span class="grow" />
                      <Stepper />
                      <ViewSwitch view={view} href={href} files={changed} />
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
                </>
              )}
              <a hidden data-changes-link href={href({})}></a>
            </div>
          </main>
        </ShellRoot>
        <div class="panel-scrim" data-action="panel-close" />
        <TabBar />
        <CollectionDialogs ctx={ctx} />
        {disclosure ? <ShareDialog ctx={ctx} links={ctx.links} disclosure={disclosure} /> : null}
      </Layout>,
      error === "missing" ? 404 : error === "same" ? 400 : 200,
    ),
  );
}

/** A revision's message in quotes, for the range header. */
const message = (row: { message: string | null }) =>
  row.message ? `“${row.message}”` : "No message";
/** The fork diagram's class for a failed branch. */
const failed = (row: TimelineRow) => (row.sync_state === "failed" ? " failed" : "");

/** "#3, #4, #5 and #7". */
function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Two branches (NAV-10): where they split, drawn statically, and three ways on. */
function ForkCard(props: { ctx: CollectionContext; base: TimelineRow; common: TimelineRow }) {
  const { ctx, base, common } = props;
  const head = ctx.revision;
  const pub = ctx.collection.public_id;
  const against = (
    row: { public_id: string; parent_revision_id: string | null },
    other: TimelineRow,
  ) =>
    `${shellPath(pub, row.public_id, "", true)}changes${row.parent_revision_id === other.id ? "" : `?base=${other.public_id}`}`;
  const headRow = ctx.byId.get(head.id);
  // The lower number on top, as in the explanation above it.
  const [top, bottom] =
    base.display_number < (head.display_number ?? 0)
      ? [base, headRow ?? base]
      : [headRow ?? base, base];
  return (
    <div class="forkcard">
      <svg class="fork" viewBox="0 0 132 52" width="132" height="52" aria-hidden="true">
        <path class={`ln${failed(top)}`} d="M20 26 C 48 26, 62 10, 96 10" />
        <path class={`ln${failed(bottom)}`} d="M20 26 C 48 26, 62 42, 96 42" />
        <circle class="nd" cx="20" cy="26" r="5" />
        <circle class={`nd${failed(top)}`} cx="96" cy="10" r="5" />
        <circle class={`nd${failed(bottom)}`} cx="96" cy="42" r="5" />
        <text x="20" y="48" text-anchor="middle">
          #{common.display_number}
        </text>
        <text x="106" y="14">
          #{top.display_number}
        </text>
        <text x="106" y="46">
          #{bottom.display_number}
        </text>
      </svg>
      <div class="btns">
        <a class="btn sm" href={against(head, common)}>
          What #{head.display_number} changed (vs #{common.display_number})
        </a>
        <a class="btn sm" href={against(base, common)}>
          What #{base.display_number} changed (vs #{common.display_number})
        </a>
        <a class="btn sm" href={against(base, headRow ?? base)}>
          Swap sides
        </a>
      </div>
    </div>
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
