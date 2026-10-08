/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { shellPath } from "../../../viewer-paths.ts";
import { FileTree, Timeline, type Glyph } from "../../components.tsx";
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
          ✕
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

export function HistoryPanel(props: { ctx: CollectionContext; path: string; all: boolean }) {
  const { ctx } = props;
  const newest = ctx.timeline.toReversed();
  const shown = props.all ? newest : newest.slice(0, HISTORY_PAGE);
  return (
    <>
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
      />
      {shown.length < newest.length ? (
        <p class="legend">
          <a href="?panel=history&history=all">Show all {newest.length}</a>
        </p>
      ) : null}
      <p class="legend">
        Latest = newest revision that hasn't failed. Numbers are positions and can shift if a fork
        arrives late.
      </p>
    </>
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
    </>
  );
}
