/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import { shellPath } from "../../../viewer-paths.ts";
import { belowText, lineageBelow, pickSummary } from "../../compare-text.ts";
import { FileTree, Time, Timeline, type Glyph } from "../../components.tsx";
import { plural, projectAndTags } from "../../format.ts";
import { gutterFor } from "../../gutter.ts";
import { writtenOn } from "./dialogs.tsx";
import { HISTORY_PAGE, type CollectionContext, changesHref } from "./shell.tsx";

export type PanelTab = "files" | "history" | "links";
export function Panel(props: {
  ctx: CollectionContext;
  tab: PanelTab;
  files: Child;
  history: Child;
  links?: Child;
  linkCount?: number | undefined;
}) {
  const { ctx } = props;
  const tabs: { id: PanelTab; label: string; count: number; body: Child }[] = [
    { id: "files", label: "Files", count: ctx.files.length, body: props.files },
    { id: "history", label: "History", count: ctx.rows.length, body: props.history },
  ];
  if (props.links !== undefined)
    tabs.push({ id: "links", label: "Links", count: props.linkCount ?? 0, body: props.links });
  return (
    <aside class="panel" id="panel" aria-label="Collection panel">
      <h2 class="vh">Files and history</h2>
      <nav class="ptabs" role="tablist" aria-label="Panel">
        {tabs.map((tab) => (
          <a
            href={`?panel=${tab.id}`}
            role="tab"
            id={`tab-${tab.id}`}
            class={tab.id === "links" ? "pub" : undefined}
            aria-selected={tab.id === props.tab ? "true" : "false"}
            aria-controls={`tp-${tab.id}`}
            tabindex={tab.id === props.tab ? 0 : -1}
            data-tab={tab.id}
          >
            {tab.label}
            <span class="n">{tab.count}</span>
          </a>
        ))}
        <button type="button" class="iconbtn x" data-action="panel-close" aria-label="Close panel">
          {raw(icon("close", "lg"))}
        </button>
      </nav>
      {tabs.map((tab) => (
        <div
          class="pbody"
          role="tabpanel"
          id={`tp-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== props.tab}
          data-tabpanel={tab.id}
        >
          {tab.body}
        </div>
      ))}
      <div class="pfoot">
        <span>
          Panel <kbd>.</kbd>
        </span>
        <span>
          Revisions <kbd>[</kbd>
          <kbd>]</kbd>
        </span>
        <span>
          Shortcuts <kbd>?</kbd>
        </span>
      </div>
    </aside>
  );
}

/** Compare's entry pre-ticks: the revision's parent, then the revision (just it for a root). */
function defaultPreticks(ctx: CollectionContext): string[] {
  const parent = ctx.revision.parent_revision_id
    ? ctx.byId.get(ctx.revision.parent_revision_id)
    : undefined;
  return parent ? [parent.public_id, ctx.revision.public_id] : [ctx.revision.public_id];
}
/** The page's own query without History's compare state (so Changes keeps base and view). */
function keptQuery(ctx: CollectionContext): URLSearchParams {
  const kept = new URLSearchParams(ctx.url.searchParams);
  for (const key of ["panel", "compare", "r", "err", "swapped", "history"]) kept.delete(key);
  return kept;
}
/** Compare…'s href: History in compare mode with the pre-ticks as r= (in tick order). */
function compareOpenHref(ctx: CollectionContext, preticks: readonly string[]): string {
  const query = keptQuery(ctx);
  query.append("panel", "history");
  query.append("compare", "1");
  for (const pub of preticks) query.append("r", pub);
  return `?${query.toString()}`;
}
/** The revision menu's Compare… (until NAV-04): the same pre-ticks and query as History's on
 *  this page. A `base=` naming another revision of this collection is the Changes page's base
 *  (a reversed pair has already redirected), so it is kept and pre-ticked before the revision;
 *  any other `base=` (unknown, or the revision itself: the 404/400 pages) is dropped, as History
 *  drops it there, and the pre-ticks are the parent then the revision. */
export function menuCompareHref(ctx: CollectionContext): string {
  const asked = ctx.url.searchParams.get("base")?.toLowerCase();
  const base = asked ? ctx.rows.find((row) => row.public_id === asked) : undefined;
  if (base && base.id !== ctx.revision.id)
    return compareOpenHref(ctx, [base.public_id, ctx.revision.public_id]);
  const url = new URL(ctx.url);
  url.searchParams.delete("base");
  return compareOpenHref({ ...ctx, url }, defaultPreticks(ctx));
}

/** History: the revision list, and its compare mode (NAV-10), one GET form that works without
 *  script. `preticks` are public IDs in tick order; absent, the revision's parent then itself. */
export function HistoryPanel(props: {
  ctx: CollectionContext;
  path: string;
  all: boolean;
  preticks?: readonly string[];
}) {
  const { ctx } = props;
  const newest = ctx.timeline.toReversed();
  const params = ctx.url.searchParams;
  const on = params.get("compare") === "1";
  const byPub = new Map(ctx.timeline.map((row) => [row.public_id, row]));
  const ticked = on
    ? [...new Set(params.getAll("r").map((pub) => pub.toLowerCase()))].flatMap((pub) => {
        const row = byPub.get(pub);
        return row ? [row] : [];
      })
    : [];
  // The page runs down to the oldest ticked revision, so every tick is a rendered, checked box
  // (an older revision's own page pre-ticks rows below the first page).
  const position = new Map(newest.map((row, index) => [row.id, index]));
  const reach = Math.max(HISTORY_PAGE, ...ticked.map((row) => (position.get(row.id) ?? 0) + 1));
  const shown = props.all ? newest : newest.slice(0, reach);
  // Lanes come from the whole lineage; one "joins at" line per lane running off this page.
  const { joinsBelow } = gutterFor(ctx.lineage, shown);
  // Show all (and "joins at") keep the mode and its ticks, and the page's own query, as Compare…
  // does; outside the mode they stay NAV-05b's plain link.
  const allQuery = keptQuery(ctx);
  allQuery.append("panel", "history");
  allQuery.append("history", "all");
  allQuery.append("compare", "1");
  for (const row of ticked) allQuery.append("r", row.public_id);
  const allHref = on ? `?${allQuery.toString()}` : "?panel=history&history=all";
  const summary = pickSummary(ctx.lineage, ticked);
  const pubs = (ids: Iterable<string>): string[] =>
    [...ids].flatMap((id) => {
      const row = ctx.byId.get(id);
      return row ? [row.public_id] : [];
    });
  const notes = new Map(
    [...summary.notes].flatMap(([id, note]) => pubs([id]).map((pub) => [pub, note] as const)),
  );
  const status = on && params.get("err") === "pick2" ? "Pick two revisions." : summary.status;
  const cancel = keptQuery(ctx);
  cancel.append("panel", "history");
  // What the client's lineage needs from below the page (where two shown rows' histories meet).
  const pubOf = (id: string | null): string | null =>
    id ? (ctx.byId.get(id)?.public_id ?? null) : null;
  const below = belowText(
    lineageBelow(ctx.lineage, shown).flatMap((row) => {
      const id = pubOf(row.id);
      return id ? [{ ...row, id, parent_revision_id: pubOf(row.parent_revision_id) }] : [];
    }),
  );
  return (
    <form
      class="hist"
      method="get"
      action={`/c/${ctx.collection.public_id}/compare`}
      data-compare-form
    >
      <input type="hidden" name="from" value={ctx.url.pathname} />
      <input type="checkbox" id="cmp-on" class="cmp-on" hidden data-compare-on checked={on} />
      <div class="hhead">
        <h3 id="hist-h" class="hl">
          Latest line <span>newest first</span>
        </h3>
        {ctx.rows.length >= 2 ? (
          <a
            class="btn sm cmpbtn"
            href={compareOpenHref(ctx, props.preticks ?? defaultPreticks(ctx))}
            data-compare-open
          >
            Compare…
          </a>
        ) : null}
      </div>
      <div class="hhead cmphd">
        <span class="hl-on">Tick two revisions</span>
        <a class="btn sm" href={`?${cancel.toString()}`} data-compare-cancel>
          Cancel
        </a>
      </div>
      <fieldset class="cmpset" data-below={below || undefined}>
        <legend class="cmpleg">Tick two revisions to compare</legend>
        <Timeline
          rows={shown}
          pub={ctx.collection.public_id}
          currentId={ctx.revision.id}
          latestId={ctx.latest?.id ?? null}
          now={ctx.chrome.now}
          path={props.path}
          byId={ctx.byId}
          changesHref={changesHref(ctx)}
          query={props.all ? "panel=history&history=all" : "panel=history"}
          lineage={ctx.lineage}
          labelledBy="hist-h"
          compare={{
            on,
            picked: new Set(ticked.map((row) => row.public_id)),
            notes,
            inRange: new Set(pubs(summary.inRange)),
          }}
        />
      </fieldset>
      {joinsBelow.map((join) => (
        <p class="legend lgjoin">
          <a href={allHref}>joins at #{join.at} below ›</a>
        </p>
      ))}
      {shown.length < newest.length ? (
        <p class="legend">
          <a href={allHref}>Show all {newest.length}</a>
        </p>
      ) : null}
      {shown.some((row) => !ctx.lineage.onLine.has(row.id)) ? (
        <p class="legend lgd">
          <span class="lgk">
            <i class="k0" aria-hidden="true" />
            Latest line: the newest revision that hasn't failed, and the revisions it builds on
          </span>
          <span class="lgk">
            <i class="k1" aria-hidden="true" />
            Branch: built on an older revision, off the latest line
          </span>
        </p>
      ) : null}
      <div class="cmpfoot">
        <p class="cmpscope" role="status" data-compare-status>
          {on ? status : ""}
        </p>
        <button class="btn primary cmpgo" data-compare-go>
          {summary.button}
        </button>
      </div>
    </form>
  );
}

export function FilesPanel(props: {
  ctx: CollectionContext;
  path: string | null;
  glyphs: Map<string, Glyph> | null;
}) {
  const { ctx } = props;
  const parent = ctx.revision.parent_revision_id
    ? ctx.byId.get(ctx.revision.parent_revision_id)
    : undefined;
  const used = new Set(props.glyphs?.values() ?? []);
  return (
    <>
      <FileTree
        files={ctx.files}
        head={ctx.revision.head_path}
        pub={ctx.collection.public_id}
        rpub={ctx.revision.public_id}
        pinned={ctx.pinned}
        current={props.path}
        glyphs={props.glyphs}
        galleryHref={(dir) =>
          `${shellPath(ctx.collection.public_id, ctx.revision.public_id, "", true)}gallery/${dir.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/`
        }
      />
      <p class="legend">
        {parent
          ? [used.has("+") ? "+ added" : "", used.has("~") ? "~ changed" : ""]
              .filter(Boolean)
              .join(" · ") || "No file changes"
          : "Everything is new"}{" "}
        in #{ctx.revision.display_number ?? "?"}
        {parent ? `, compared with its parent #${parent.display_number}` : " (first revision)"}
      </p>
      <AboutCard ctx={ctx} />
    </>
  );
}

/** Recent's search for one token (`project:webhooks`), as the bar's project crumb links it. */
const searchHref = (token: string): string => `/?${new URLSearchParams({ q: token }).toString()}`;

/** About this collection (NAV-11): the foot of every Files tab, after the legend. Project, tags
 *  and host link to Recent's search; Edit opens the Collection details dialog. */
export function AboutCard(props: { ctx: CollectionContext }) {
  const { ctx } = props;
  // A blank project or tag would be an empty token searching for nothing, so it isn't shown.
  const shown = projectAndTags(ctx.collection.metadataObject);
  const project = shown.project?.trim() ? shown.project : null;
  const tags = shown.tags.filter((tag) => tag.trim());
  const host = writtenOn(ctx.collection.metadataObject);
  const id = ctx.collection.public_id;
  return (
    <section class="about" aria-labelledby="about-h">
      <div class="ah">
        <h3 id="about-h">About this collection</h3>
        <button
          type="button"
          class="txtbtn"
          commandfor="details"
          command="show-modal"
          data-focus="project"
        >
          Edit
        </button>
      </div>
      <dl>
        {project ? (
          <>
            <dt>Project</dt>
            <dd>
              <a class="tok" href={searchHref(`project:${project}`)}>
                {project}
              </a>
            </dd>
          </>
        ) : null}
        {tags.length ? (
          <>
            <dt>Tags</dt>
            <dd>
              {tags.map((tag) => (
                <a class="tok" href={searchHref(`tag:${tag}`)}>
                  {tag}
                </a>
              ))}
            </dd>
          </>
        ) : null}
        {host ? (
          <>
            <dt>Written on</dt>
            <dd>
              <a class="tok mono" href={searchHref(`host:${host}`)}>
                {host}
              </a>
            </dd>
          </>
        ) : null}
        <dt>Started</dt>
        <dd>
          <span>
            <Time at={ctx.collection.created_at} fmt="date" now={ctx.chrome.now} /> ·{" "}
            {plural(ctx.timeline.length, "revision")}
          </span>
        </dd>
        <dt>ID</dt>
        <dd>
          <code class="idv">{id}</code>
          <button
            type="button"
            class="idcopy"
            data-action="copy-text"
            data-text={id}
            data-label="collection public ID"
            aria-label="Copy ID"
            hidden
            data-needs-js
          >
            {raw(icon("copy", "sm"))}
          </button>
        </dd>
      </dl>
      <p class="ahint">
        Project, tags and host are what Recent's filters and <code>project:</code> <code>tag:</code>{" "}
        <code>host:</code> search use.
      </p>
    </section>
  );
}
