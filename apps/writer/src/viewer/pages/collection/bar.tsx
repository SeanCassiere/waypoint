/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import { shellPath } from "../../../viewer-paths.ts";
import { LogoMark, HealthPill } from "../../components.tsx";
import { projectAndTags } from "../../format.ts";
import { bindingFor, keyTitle } from "../../keymap.ts";
import { FindButton, type Chrome } from "../../layout.tsx";
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
  return { text: "older", tone: "" };
}

/**
 * The collection bar (NAV-04): Recent / project / title › revision pill › file crumb as one
 * breadcrumb list, then Find, Copy link, Share, health and More. The pills open the panel on
 * History and Files (`client/panel.ts` showTab); CSS sets the three widths (40-collection).
 * `missing` is the 404 for a file that isn't in the revision: the pill is a plain link there,
 * and nothing that needs the panel or the menus is rendered.
 */
export function CollectionBar(props: {
  ctx: CollectionContext;
  mode?: "document" | "changes" | "gallery" | "missing";
  /** The file crumb's path (document mode). */
  path?: string | undefined;
  /** Replaces the revision's state word in the pill: "changes from #5", "gallery · shots/". */
  pill?: string | undefined;
  /** Replaces the revision pill's visible content (no #N, no state word): "#2 → #7 changes". */
  crumb?: string | undefined;
  doneHref?: string | undefined;
  /** The Copy and More menus: popovers drawn in the top layer, but kept in the banner, as their
   *  triggers are, so no page content sits outside a landmark (axe region). */
  menus?: Child;
}) {
  const { ctx } = props;
  const { collection, revision, chrome } = ctx;
  const mode = props.mode ?? "document";
  const missing = mode === "missing";
  const { project } = projectAndTags(collection.metadataObject);
  const label = revisionLabel(ctx);
  const n = revision.display_number ?? "?";
  const word = props.pill ?? label.text;
  const pillText = props.crumb ?? `#${n} ${word}`;
  const file = mode === "document" && props.path ? props.path : null;
  // The tab the request opens (Panel's own rule); the client corrects aria-expanded on load.
  const asked = ctx.url.searchParams.get("panel");
  const tab =
    mode === "gallery"
      ? "files"
      : asked === "history"
        ? "history"
        : asked === "links" && ctx.links.length
          ? "links"
          : "files";
  const pillBody = (
    <>
      {raw(icon("history", "sm"))}
      {props.crumb ?? (
        <>
          <b>#{n}</b> <span class={label.tone ? `l ${label.tone}` : "l"}>{word}</span>
        </>
      )}
    </>
  );
  return (
    <header class="bar cbar">
      <a
        class="iconbtn back"
        href="/"
        aria-label="Back to Recent"
        title={project ? `Recent / ${project}` : "Recent"}
      >
        {raw(icon("chevronLeft", "lg"))}
      </a>
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
      </a>
      {missing ? null : (
        <button
          type="button"
          class="iconbtn ptog"
          data-action="panel-toggle"
          aria-controls="panel"
          aria-expanded="true"
          aria-label={bindingFor("panel").title}
          title={keyTitle("panel")}
        >
          {raw(icon("panel", "lg"))}
        </button>
      )}
      <nav class="bc" aria-label="Breadcrumb">
        <ol>
          <li class="anc">
            <a href="/">Recent</a>
          </li>
          {project ? (
            <li class="anc">
              <a
                href={`/?${new URLSearchParams({ q: `project:${project}` }).toString()}`}
                title={project}
              >
                {project}
              </a>
            </li>
          ) : null}
          <li class="ttl">
            <h1 data-title-text>{collection.title}</h1>
            <span class="idsub" aria-hidden="true">
              {pillText}
              {file ? (
                <>
                  {" · "}
                  <span class="mono">{file}</span>
                </>
              ) : null}
            </span>
          </li>
          <li class="crumb rev">
            {missing ? (
              <a
                class="pill rev"
                href={shellPath(
                  collection.public_id,
                  revision.public_id,
                  "",
                  ctx.pinned,
                  revision.head_path,
                  "?panel=history",
                )}
              >
                {pillBody}
              </a>
            ) : (
              <a
                class="pill rev"
                href="?panel=history"
                data-action="panel-tab"
                data-tab="history"
                aria-controls="panel"
                aria-expanded={tab === "history" ? "true" : "false"}
                title={keyTitle("history")}
              >
                {pillBody}
              </a>
            )}
          </li>
          {file ? (
            <li class="crumb file">
              <a
                class="pill file"
                href="?panel=files"
                data-action="panel-tab"
                data-tab="files"
                aria-controls="panel"
                aria-expanded={tab === "files" ? "true" : "false"}
                title={keyTitle("files")}
              >
                {raw(icon("doc", "sm"))}
                <span class="mono">{file}</span>
              </a>
            </li>
          ) : null}
        </ol>
      </nav>
      {props.doneHref && !missing ? (
        <a class="btn sm ghost done" href={props.doneHref} data-done>
          Done <kbd>Esc</kbd>
        </a>
      ) : null}
      <span class="grow" />
      <FindButton class="find" />
      {missing ? null : (
        <button
          type="button"
          class="btn ghost copyl"
          popovertarget="copy-menu"
          aria-haspopup="menu"
        >
          Copy link {raw(icon("chevronDown", "sm"))}
        </button>
      )}
      {ctx.sharing && !missing ? (
        <button type="button" class="btn public share" commandfor="share" command="show-modal">
          {raw(icon("globe"))}
          Share
        </button>
      ) : null}
      <HealthPill health={chrome.health} />
      {missing ? null : (
        <button
          type="button"
          class="iconbtn more"
          popovertarget="more-menu"
          aria-haspopup="menu"
          aria-label="More actions"
          title="More actions"
        >
          {raw(icon("more", "lg"))}
        </button>
      )}
      {props.menus}
    </header>
  );
}

/** The phone tab bar. Files and History follow the pill contract (aria-controls, aria-expanded). */
export function TabBar() {
  return (
    <nav class="tabbar" aria-label="Collection">
      <button
        type="button"
        data-action="panel-tab"
        data-tab="files"
        aria-controls="panel"
        aria-expanded="false"
      >
        <span class="i" aria-hidden="true">
          {raw(icon("folder", "xl"))}
        </span>
        <span>Files</span>
      </button>
      <button
        type="button"
        data-action="panel-tab"
        data-tab="history"
        aria-controls="panel"
        aria-expanded="false"
      >
        <span class="i" aria-hidden="true">
          {raw(icon("history", "xl"))}
        </span>
        <span>History</span>
      </button>
      <button type="button" popovertarget="copy-menu" aria-haspopup="menu">
        <span class="i" aria-hidden="true">
          {raw(icon("copy", "xl"))}
        </span>
        <span>Copy</span>
      </button>
      <button type="button" popovertarget="more-menu" aria-haspopup="menu">
        <span class="i" aria-hidden="true">
          {raw(icon("more", "xl"))}
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
