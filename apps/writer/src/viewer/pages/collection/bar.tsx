/** @jsxImportSource hono/jsx */
import { isLive } from "../../../shares.ts";
import { Globe, LogoMark, HealthPill } from "../../components.tsx";
import { projectAndTags } from "../../format.ts";
import type { Chrome } from "../../layout.tsx";
import type { CollectionContext } from "./shell.tsx";

function revisionLabel(ctx: Pick<CollectionContext, "revision" | "latest">): {
  text: string;
  tone: string;
} {
  const { revision, latest } = ctx;
  if (revision.sync_state === "failed") return { text: "failed", tone: "failed" };
  if (revision.id === latest?.id)
    return revision.sync_state === "pending"
      ? { text: "latest · uploading", tone: "pending" }
      : { text: "latest", tone: "" };
  if (revision.sync_state === "pending") return { text: "uploading", tone: "pending" };
  return { text: "not latest", tone: "" };
}

export function CollectionBar(props: {
  ctx: CollectionContext;
  mode?: "document" | "changes" | "gallery";
  pill?: string | undefined;
  /** Replaces the revision pill's visible content (no #N, no state word): "#2 → #7 changes". */
  crumb?: string | undefined;
  doneHref?: string | undefined;
}) {
  const { ctx } = props;
  const { collection, revision, chrome } = ctx;
  const { project } = projectAndTags(collection.metadataObject);
  const label = revisionLabel(ctx);
  return (
    <header class="bar cbar">
      <a class="iconbtn back" href="/" aria-label="Back to Recent">
        ‹
      </a>
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
      </a>
      <button
        type="button"
        class="iconbtn hide-sm"
        data-action="panel-toggle"
        aria-controls="panel"
        aria-expanded="true"
        aria-label="Files and history"
        title="Files and history  ."
      >
        ☰
      </button>
      <nav class="crumbs" aria-label="Breadcrumb">
        {project ? (
          <>
            <a
              class="hide-sm"
              href={`/?${new URLSearchParams({ q: `project:${project}` }).toString()}`}
              title={project}
            >
              {project}
            </a>
            <span class="sep hide-sm" aria-hidden="true">
              /
            </span>
          </>
        ) : null}
        <h1 data-title-text>{collection.title}</h1>
      </nav>
      <button
        type="button"
        class="revbtn"
        popovertarget="rev-menu"
        aria-haspopup="dialog"
        title="Revisions  [ ]"
        aria-label={
          props.crumb
            ? `${props.crumb}. Open revisions`
            : `Revision ${revision.display_number ?? "?"}, ${props.pill ?? label.text}. Open revisions`
        }
      >
        {props.crumb ?? (
          <>
            #{revision.display_number ?? "?"}
            <span class={`l ${label.tone}`}>{props.pill ?? label.text}</span>
          </>
        )}
        <span class="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {ctx.links.some(isLive) ? (
        <a class="chip public hide-sm" href="?panel=links" title="Public links">
          <Globe />
          Public
        </a>
      ) : null}
      {props.doneHref ? (
        <a class="btn sm ghost hide-sm" href={props.doneHref} data-done>
          Done <kbd>Esc</kbd>
        </a>
      ) : null}
      <span class="grow" />
      <button
        type="button"
        class="btn ghost hide-sm"
        popovertarget="copy-menu"
        aria-haspopup="menu"
      >
        Copy <span aria-hidden="true">▾</span>
      </button>
      {ctx.sharing ? (
        <button type="button" class="btn public hide-sm" commandfor="share" command="show-modal">
          <Globe />
          Share
        </button>
      ) : null}
      <button
        type="button"
        class="iconbtn"
        popovertarget="more-menu"
        aria-haspopup="menu"
        aria-label="More actions"
        title="More actions"
      >
        ⋯
      </button>
      <HealthPill health={chrome.health} />
    </header>
  );
}

export function TabBar() {
  return (
    <nav class="tabbar" aria-label="Collection">
      <button type="button" data-action="panel-tab" data-tab="files">
        <span class="i" aria-hidden="true">
          ☰
        </span>
        <span>Files</span>
      </button>
      <button type="button" data-action="panel-tab" data-tab="history">
        <span class="i" aria-hidden="true">
          ◷
        </span>
        <span>History</span>
      </button>
      <button type="button" popovertarget="copy-menu" aria-haspopup="menu">
        <span class="i" aria-hidden="true">
          ⧉
        </span>
        <span>Copy</span>
      </button>
      <button type="button" popovertarget="more-menu" aria-haspopup="menu">
        <span class="i" aria-hidden="true">
          ⋯
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

export function HomeBarLite(props: { chrome: Chrome }) {
  return (
    <header class="bar">
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
        <span>Waypoint</span>
      </a>
      <span class="grow" />
      <HealthPill health={props.chrome.health} />
    </header>
  );
}
