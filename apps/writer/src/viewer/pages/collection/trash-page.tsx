/** @jsxImportSource hono/jsx */
import type { JSX } from "hono/jsx/jsx-runtime";

import type { CollectionRow } from "../../../read-model.ts";
import { LogoMark, HealthPill } from "../../components.tsx";
import { plural, projectAndTags } from "../../format.ts";
import { Layout, type Chrome } from "../../layout.tsx";
import type { TrashLinks } from "../trash.tsx";

/** What every Restore… button carries (OW-07): the restore dialog's counts and paused links. */
interface RestoreData {
  detail: { revisions: number; files: number };
  paused: TrashLinks["paused"];
}
function restoreAttrs(collection: CollectionRow, data: RestoreData) {
  return {
    "data-action": "restore",
    "data-id": collection.id,
    "data-title": collection.title,
    "data-revisions": String(data.detail.revisions),
    "data-files": String(data.detail.files),
    "data-links": JSON.stringify(data.paused),
    "data-then": "reload",
  };
}

/** The In Trash page keeps the collection bar (spec §5.3, deleted.html), minus Copy and Share. */
function TrashBar(props: {
  chrome: Chrome;
  collection: CollectionRow;
  n: number | null;
  restore: RestoreData;
}) {
  const { collection } = props;
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(collection.metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      metadata = Object.fromEntries(Object.entries(parsed));
  } catch {
    metadata = {};
  }
  const { project } = projectAndTags(metadata);
  return (
    <header class="bar cbar">
      <a class="iconbtn back" href="/" aria-label="Back to Recent">
        ‹
      </a>
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
      </a>
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
      {props.n !== null ? (
        <span class="revbtn static">
          #{props.n}
          <span class="l">in Trash</span>
        </span>
      ) : null}
      <span class="grow" />
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
      <div id="more-menu" class="menu" popover="auto" role="menu" aria-label="More actions">
        <div class="mbox">
          <button
            type="button"
            class="mi"
            role="menuitem"
            popovertarget="more-menu"
            popovertargetaction="hide"
            {...restoreAttrs(collection, props.restore)}
          >
            <span aria-hidden="true">↺</span>
            <span>Restore…</span>
          </button>
          <a class="mi" role="menuitem" href="/trash">
            <span aria-hidden="true">⌫</span>
            <span>Open Trash</span>
          </a>
          <button type="button" class="mi" role="menuitem" commandfor="keys" command="show-modal">
            <span aria-hidden="true">?</span>
            <span>Keyboard shortcuts</span>
            <kbd>?</kbd>
          </button>
        </div>
      </div>
      <HealthPill health={props.chrome.health} />
    </header>
  );
}

export function DeletedPage(props: {
  chrome: Chrome;
  collection: CollectionRow;
  n?: number | null;
  detail: { revisions: number; files: number };
  paused: TrashLinks["paused"];
}): JSX.Element {
  const restore = { detail: props.detail, paused: props.paused };
  const k = props.paused.length;
  return (
    <Layout
      title={`${props.collection.title} (in Trash)`}
      chrome={props.chrome}
      bar={
        <TrashBar
          chrome={props.chrome}
          collection={props.collection}
          n={props.n ?? null}
          restore={restore}
        />
      }
      page="deleted"
    >
      <main class="wrap narrow" id="main">
        <div class="hero warn">
          <span class="dot" aria-hidden="true" />
          <div>
            <b>“{props.collection.title}” is in Trash.</b>
            <span>
              {k
                ? `It's hidden from lists and search, and its ${plural(k, "public link")} ${k === 1 ? "is" : "are"} paused. Restore asks whether to turn ${k === 1 ? "it" : "them"} back on.`
                : "It's hidden from lists and search. Restore brings it back."}
            </span>
          </div>
        </div>
        <div class="btns">
          <button type="button" class="btn primary" {...restoreAttrs(props.collection, restore)}>
            Restore…
          </button>
          <a class="btn" href="/trash">
            Open Trash
          </a>
        </div>
      </main>
    </Layout>
  );
}
