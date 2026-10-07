/** @jsxImportSource hono/jsx */
import {
  isPublicId,
  latestCollectionUrl,
  pinnedRevisionUrl,
  rawUrl,
  validatePath,
  type Manifest,
  type ManifestFileEntry,
  type RevisionChanges,
} from "@waypoint/core";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../http.js";
import { sourceHost, type CollectionRow, type RevisionRow } from "../../read-model.js";
import { collectionLinks, sharingEnabled, type ShareView } from "../../shares.js";
import { rawPath, shellPath } from "../../viewer-paths.js";
import { getChrome } from "../chrome.js";
import {
  FileTree,
  Globe,
  isEmbeddable,
  LogoMark,
  HealthPill,
  Timeline,
  type Glyph,
  type TimelineRow,
} from "../components.js";
import { bytes, ext, projectAndTags } from "../format.js";
import { HomeBar, Layout, NotFoundBody, type Chrome } from "../layout.js";
import { noStore } from "../respond.js";
import { changesPage, CompareDialog } from "./changes.js";
import { galleryPage } from "./gallery.js";
import { publicPreview } from "./public-preview.js";
import { isLive, LinksPanel, previewHref, publicSegment, ShareDialog } from "./share.js";
import type { ViewerExtras } from "./status.js";

const HISTORY_PAGE = 50;
const shortUrl = (url: string) => `…${new URL(url).pathname}`;

/** Everything the collection shell (and its sibling pages) needs, loaded with constant queries. */
export interface CollectionContext {
  s: HttpServices;
  chrome: Chrome;
  collection: CollectionRow & { metadataObject: Record<string, unknown> };
  rows: RevisionRow[];
  latest: RevisionRow | undefined;
  revision: RevisionRow;
  pinned: boolean;
  manifest: Manifest;
  files: ManifestFileEntry[];
  changes: Map<string, RevisionChanges>;
  timeline: TimelineRow[];
  byId: Map<string, TimelineRow>;
  publicSees: RevisionRow | undefined;
  url: URL;
  /** Share links (any state); empty when sharing isn't configured. */
  links: ShareView[];
  sharing: boolean;
}

export function filesOf(manifest: Manifest): ManifestFileEntry[] {
  return Object.entries(manifest.files)
    .map(([path, entry]) => ({
      path,
      hash: entry.hash,
      mime: entry.mime,
      size: entry.size,
      url: "",
    }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function glyphsAgainst(
  manifest: Manifest,
  parent: Manifest | undefined,
): Map<string, Glyph> {
  const glyphs = new Map<string, Glyph>();
  for (const [path, entry] of Object.entries(manifest.files)) {
    const before = parent?.files[path];
    glyphs.set(path, !before ? "+" : before.hash !== entry.hash ? "~" : "·");
  }
  return glyphs;
}

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

export function handoffBlock(ctx: CollectionContext): string {
  const { collection, revision, files, latest, s } = ctx;
  const base = s.reads.baseUrl;
  const paths = files.map((file) => file.path);
  const shown = paths.slice(0, 8).join(", ");
  const { project, tags } = projectAndTags(collection.metadataObject);
  const meta = [project ? `project: ${project}` : "", tags.length ? `tags: ${tags.join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return [
    `Waypoint collection "${collection.title}"`,
    `collection_id: ${collection.id}`,
    `revision: #${revision.display_number ?? "?"} ${revision.id} (${revision.id === latest?.id ? "latest" : "not latest"}, ${revision.sync_state ?? "synced"})`,
    `head: ${revision.head_path} · files: ${shown}${paths.length > 8 ? `, … +${paths.length - 8} more` : ""}`,
    `url: ${ctx.pinned ? pinnedRevisionUrl(base, collection.public_id, revision.public_id) : latestCollectionUrl(base, collection.public_id)}`,
    `raw head: ${rawUrl(base, revision.public_id, revision.head_path)}`,
    ...(meta ? [meta] : []),
    `Read: get_collection("${collection.id}", include_head: true)`,
    `Watch: wait_for_revision(after_revision_id: "${revision.id}")`,
  ].join("\n");
}

export async function loadCollection(
  s: HttpServices,
  c: Context,
  options: { pub: string; rpub?: string | undefined; now: number },
): Promise<
  | { kind: "missing"; chrome: Chrome }
  | { kind: "deleted"; chrome: Chrome; collection: CollectionRow }
  | { kind: "no-revision"; chrome: Chrome; collection: CollectionRow }
  | { kind: "ok"; ctx: CollectionContext }
> {
  const [collection, chrome] = await Promise.all([
    s.reads.collectionByPublicId(options.pub),
    getChrome(s, options.now),
  ]);
  if (!collection) return { kind: "missing", chrome };
  if (collection.deleted_at != null) return { kind: "deleted", chrome, collection };
  const rows = await s.reads.revisions(collection.id);
  const latest = rows.findLast((row) => row.sync_state !== "failed") ?? rows.at(-1);
  const revision = options.rpub ? rows.find((row) => row.public_id === options.rpub) : latest;
  if (!revision) return { kind: "no-revision", chrome, collection };
  // Change counts only for the revisions this page shows: the History panel's page, the
  // revision menu's newest eight, and the revision being viewed.
  const historyAll = c.req.query("history") === "all";
  const shown = historyAll ? rows : [...rows.slice(-HISTORY_PAGE), revision];
  const [manifest, changes, links] = await Promise.all([
    s.reads.manifestOf(revision),
    s.reads.changesFor([...new Set(shown)]),
    sharingEnabled(s) ? collectionLinks(s, collection.id) : Promise.resolve([]),
  ]);
  const timeline: TimelineRow[] = rows.map((row) => ({
    id: row.id,
    public_id: row.public_id,
    parent_revision_id: row.parent_revision_id,
    display_number: row.display_number ?? 0,
    message: row.message,
    created_at: row.created_at,
    sync_state: row.sync_state ?? "synced",
    host: sourceHost(row.metadata),
    changes: changes.get(row.id),
    last_error: row.last_error ?? null,
  }));
  let metadataObject: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(collection.metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      metadataObject = Object.fromEntries(Object.entries(parsed));
  } catch {
    metadataObject = {};
  }
  return {
    kind: "ok",
    ctx: {
      s,
      chrome,
      collection: { ...collection, metadataObject },
      rows,
      latest,
      revision,
      pinned: Boolean(options.rpub),
      manifest,
      files: filesOf(manifest),
      changes,
      timeline,
      byId: new Map(timeline.map((row) => [row.id, row])),
      publicSees: rows.findLast((row) => row.sync_state === "synced"),
      url: new URL(c.req.raw.url),
      links,
      sharing: sharingEnabled(s),
    },
  };
}

export function CollectionBar(props: {
  ctx: CollectionContext;
  mode?: "document" | "changes" | "gallery";
  pill?: string | undefined;
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
        aria-label={`Revision ${revision.display_number ?? "?"}, ${props.pill ?? label.text}. Open revisions`}
      >
        #{revision.display_number ?? "?"}
        <span class={`l ${label.tone}`}>{props.pill ?? label.text}</span>
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

export function RevisionMenu(props: { ctx: CollectionContext; path: string }) {
  const { ctx } = props;
  const recent = ctx.timeline.toReversed().slice(0, 8);
  return (
    <div id="rev-menu" class="menu rmenu" popover="auto" role="dialog" aria-label="Revisions">
      <div class="mbox">
        <div class="lbl">Revisions · newest first</div>
        <Timeline
          rows={recent}
          pub={ctx.collection.public_id}
          currentId={ctx.revision.id}
          latestId={ctx.latest?.id ?? null}
          now={ctx.chrome.now}
          path={props.path}
          compact
          byId={ctx.byId}
          changesHref={changesHref(ctx)}
        />
        <hr />
        <button type="button" class="mi" commandfor="compare" command="show-modal">
          <span aria-hidden="true">⇄</span>
          <span>Compare…</span>
          <small>Choose any two revisions</small>
        </button>
        <button
          type="button"
          class="mi"
          data-action="panel-tab"
          data-tab="history"
          popovertarget="rev-menu"
          popovertargetaction="hide"
        >
          <span aria-hidden="true">◷</span>
          <span>Open History panel</span>
          <kbd>h</kbd>
        </button>
      </div>
    </div>
  );
}

export function changesHref(ctx: CollectionContext) {
  return (row: TimelineRow, base: TimelineRow): string =>
    `${shellPath(ctx.collection.public_id, row.public_id, "", true)}changes${row.parent_revision_id === base.id ? "" : `?base=${base.public_id}`}`;
}

export function CopyMenu(props: { ctx: CollectionContext; path: string }) {
  const { ctx, path } = props;
  const base = ctx.s.reads.baseUrl;
  const latestUrl = latestCollectionUrl(
    base,
    ctx.collection.public_id,
    path === ctx.revision.head_path ? undefined : path,
  );
  const pinnedUrl = pinnedRevisionUrl(base, ctx.collection.public_id, ctx.revision.public_id, path);
  return (
    <div id="copy-menu" class="menu" popover="auto" role="menu" aria-label="Copy">
      <div class="mbox">
        <div class="lbl">Links</div>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="copy-menu"
          popovertargetaction="hide"
          data-action="copy-link"
          data-kind="latest"
        >
          <span aria-hidden="true">⧉</span>
          <span>Link to latest</span>
          <kbd>c</kbd>
          <small class="mono" data-copy-preview="latest">
            {shortUrl(latestUrl)}
          </small>
        </button>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="copy-menu"
          popovertargetaction="hide"
          data-action="copy-link"
          data-kind="pinned"
        >
          <span aria-hidden="true">⧉</span>
          <span>Link to this revision (#{ctx.revision.display_number ?? "?"})</span>
          <kbd>⇧C</kbd>
          <small class="mono" data-copy-preview="pinned">
            {shortUrl(pinnedUrl)}
          </small>
        </button>
        <hr />
        <div class="lbl">For another agent</div>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="copy-menu"
          popovertargetaction="hide"
          data-action="copy-handoff"
        >
          <span aria-hidden="true">⧉</span>
          <span>Handoff block</span>
          <kbd>a</kbd>
          <small>Paste into an agent prompt. It has everything needed to read and watch.</small>
        </button>
        <pre class="handoff" data-handoff>
          {handoffBlock(ctx)}
        </pre>
        <hr />
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="copy-menu"
          popovertargetaction="hide"
          data-action="copy-text"
          data-text={ctx.collection.id}
          data-label="collection ID"
        >
          <span aria-hidden="true">#</span>
          <span>Collection ID</span>
          <small class="mono">{ctx.collection.id}</small>
        </button>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="copy-menu"
          popovertargetaction="hide"
          data-action="copy-text"
          data-text={ctx.revision.id}
          data-label="revision ID"
        >
          <span aria-hidden="true">#</span>
          <span>Revision ID</span>
          <small class="mono">{ctx.revision.id}</small>
        </button>
      </div>
    </div>
  );
}

export function MoreMenu(props: { ctx: CollectionContext; path: string; previewPublic?: boolean }) {
  const { ctx, path } = props;
  const raw = rawPath(ctx.revision.public_id, path);
  return (
    <div id="more-menu" class="menu" popover="auto" role="menu" aria-label="More actions">
      <div class="mbox">
        {ctx.sharing ? (
          <button
            type="button"
            class="mi pubitem show-sm"
            role="menuitem"
            commandfor="share"
            command="show-modal"
          >
            <Globe />
            <span>Share…</span>
            <kbd>s</kbd>
          </button>
        ) : null}
        <button type="button" class="mi" role="menuitem" commandfor="rename" command="show-modal">
          <span aria-hidden="true">✎</span>
          <span>Rename…</span>
        </button>
        <button type="button" class="mi" role="menuitem" commandfor="metadata" command="show-modal">
          <span aria-hidden="true">{"{}"}</span>
          <span>Edit metadata…</span>
        </button>
        <hr />
        <a class="mi" role="menuitem" href={raw} target="_blank" rel="noopener" data-open-raw>
          <span aria-hidden="true">↗</span>
          <span>Open raw</span>
        </a>
        <a class="mi" role="menuitem" href={raw} download data-download-raw>
          <span aria-hidden="true">↓</span>
          <span>Download file</span>
        </a>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="print"
        >
          <span aria-hidden="true">⎙</span>
          <span>Print</span>
        </button>
        {props.previewPublic ? (
          <a
            class="mi"
            role="menuitem"
            href={`${shellPath(ctx.collection.public_id, ctx.revision.public_id, path, ctx.pinned, ctx.revision.head_path)}?as=public`}
            target="_blank"
            rel="noopener"
          >
            <Globe />
            <span>Preview as public ↗</span>
          </a>
        ) : null}
        <button type="button" class="mi" role="menuitem" commandfor="keys" command="show-modal">
          <span aria-hidden="true">?</span>
          <span>Keyboard shortcuts</span>
          <kbd>?</kbd>
        </button>
        <hr />
        <button
          type="button"
          class="mi dangeritem"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="trash"
        >
          <span aria-hidden="true">⌫</span>
          <span>Move to Trash…</span>
        </button>
      </div>
    </div>
  );
}

export function CollectionDialogs(props: { ctx: CollectionContext }) {
  const { ctx } = props;
  return (
    <>
      <dialog class="dlg narrow" id="rename" aria-labelledby="rename-title">
        <form data-form="rename">
          <div class="bd">
            <h2 id="rename-title">Rename collection</h2>
            <label class="fl">
              Title
              <input name="title" value={ctx.collection.title} required maxLength={300} autofocus />
            </label>
          </div>
          <p class="alert" role="alert" data-form-error />
          <div class="ft">
            <button class="btn" formmethod="dialog" formnovalidate value="cancel">
              Cancel
            </button>
            <button class="btn primary">Save</button>
          </div>
        </form>
      </dialog>
      <dialog class="dlg" id="metadata" aria-labelledby="metadata-title">
        <form data-form="metadata">
          <div class="bd">
            <h2 id="metadata-title">Edit metadata</h2>
            <label class="fl">
              Collection metadata (JSON object)
              <textarea name="metadata" spellcheck={false}>
                {JSON.stringify(ctx.collection.metadataObject, null, 2)}
              </textarea>
              <small>
                Used for search and the Projects list. Revision metadata isn't affected.
              </small>
            </label>
          </div>
          <p class="alert" role="alert" data-form-error />
          <div class="ft">
            <button class="btn" formmethod="dialog" formnovalidate value="cancel">
              Cancel
            </button>
            <button class="btn primary">Save</button>
          </div>
        </form>
      </dialog>
    </>
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
      <button type="button" popovertarget="copy-menu">
        <span class="i" aria-hidden="true">
          ⧉
        </span>
        <span>Copy</span>
      </button>
      <button type="button" popovertarget="more-menu">
        <span class="i" aria-hidden="true">
          ⋯
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

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

export interface Segment {
  tone: "failed" | "pending" | "public" | "info";
  body: Child;
  /** Plain text of the segment: the phone line's one tap target speaks it (spec §4.12). */
  text: string;
  /** The segment without its long explanation: what the phone line shows. */
  brief?: string;
  /** The "older revision" segment, which goes last (spec order). */
  older?: boolean;
}
export function statusSegments(ctx: CollectionContext): {
  segments: Segment[];
  action: Child | null;
} {
  const { rows, revision, latest, publicSees, collection } = ctx;
  const segments: Segment[] = [];
  let action: Child | null = null;
  const failed = rows.filter((row) => row.sync_state === "failed");
  const pending = rows.filter((row) => row.sync_state === "pending");
  const sees = publicSees ? `#${publicSees.display_number}` : "nothing yet";
  if (rows.length && failed.length === rows.length) {
    segments.push({
      tone: "failed",
      text: "! Nothing in this collection has synced. It exists only on this writer.",
      brief: "! Nothing in this collection has synced.",
      body: (
        <span>
          <span class="f">! Nothing in this collection has synced.</span>{" "}
          <span class="long">It exists only on this writer.</span>
        </span>
      ),
    });
    action = (
      <button
        type="button"
        class="btn sm"
        data-action="retry"
        data-ids={failed.map((row) => row.id).join(",")}
      >
        Retry all
      </button>
    );
    return { segments, action };
  }
  if (revision.sync_state === "failed") {
    // The raw error lives in the History row and on Status; the line stays short (§4.12).
    segments.push({
      tone: "failed",
      text: `! #${revision.display_number} failed to sync. Readable on this writer only.`,
      brief: `! #${revision.display_number} failed to sync.`,
      body: (
        <span>
          <span class="f">! #{revision.display_number} failed to sync.</span>{" "}
          <span class="long">Readable on this writer only.</span>{" "}
          <a href={`/status#${revision.id}`}>Details</a>
        </span>
      ),
    });
    action = (
      <>
        <button type="button" class="btn sm" data-action="retry" data-ids={revision.id}>
          Retry
        </button>
        <button type="button" class="btn sm danger" data-action="drop" data-id={revision.id}>
          Drop…
        </button>
      </>
    );
  } else if (failed.length) {
    const first = failed.at(-1)!;
    const list = failed.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "failed",
      text: `! ${list} failed to sync`,
      body: <span class="f">! {list} failed to sync</span>,
    });
    action = (
      <button type="button" class="btn sm" data-action="retry" data-ids={first.id}>
        Retry #{first.display_number}
      </button>
    );
  }
  if (revision.sync_state === "pending")
    segments.push({
      tone: "pending",
      text: `◌ #${revision.display_number} is uploading. Readable here; other machines and public links see ${sees}.`,
      brief: `◌ #${revision.display_number} is uploading.`,
      body: (
        <span>
          <span class="p">◌ #{revision.display_number} is uploading.</span>{" "}
          <span class="long">Readable here; other machines and public links see {sees}.</span>
        </span>
      ),
    });
  else if (pending.length) {
    const list = pending.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "pending",
      text: `◌ ${list} uploading`,
      body: <span class="p">◌ {list} uploading</span>,
    });
  }
  if ((failed.length || pending.length) && revision.sync_state !== "pending")
    segments.push({
      tone: "info",
      text: `Other machines and public links see ${sees}.`,
      body: <span class="long">Other machines and public links see {sees}.</span>,
    });
  if (ctx.pinned && latest && revision.id !== latest.id && revision.sync_state !== "failed") {
    const viewing = revision.display_number ?? 0;
    const later = (latest.display_number ?? 0) > viewing;
    segments.push({
      tone: "info",
      older: true,
      text: `You're viewing #${viewing}, not the latest. Latest is #${latest.display_number}.`,
      brief: `You're viewing #${viewing}, not the latest. Latest is #${latest.display_number} →`,
      body: (
        <span>
          <span data-older-segment hidden />
          You're viewing #{viewing}, not the latest.{" "}
          <a href={`/c/${collection.public_id}/`}>Latest is #{latest.display_number} →</a>
          {later ? (
            <span class="long">
              {" · "}
              <a
                href={`${shellPath(collection.public_id, latest.public_id, "", true)}changes?base=${revision.public_id}`}
              >
                See changes since #{viewing}
              </a>
            </span>
          ) : null}
        </span>
      ),
    });
  }
  return { segments, action };
}

export function StatusLine(props: { ctx: CollectionContext; extra?: Segment[] }) {
  const { segments, action } = statusSegments(props.ctx);
  // Spec order: failed, uploading, public, new since last read, then the older revision.
  const older = segments.findIndex((segment) => segment.older);
  const extra = props.extra ?? [];
  const all =
    older < 0
      ? [...segments, ...extra]
      : [...segments.slice(0, older), ...extra, ...segments.slice(older)];
  const tone = all.find((segment) => segment.tone === "failed")
    ? "failed"
    : all.find((segment) => segment.tone === "pending")
      ? "pending"
      : all.find((segment) => segment.tone === "public")
        ? "public"
        : "info";
  const text = all.map((segment) => segment.text).join(" · ");
  const brief = all.map((segment) => segment.brief ?? segment.text).join(" · ");
  // The visible glyphs (! ◌) are markers, not words; the tap target's name drops them.
  const spoken = text.replace(/(^|· )[!◌●] /g, "$1").replace(/\.?$/, ".");
  const tab = all.every((segment) => segment.tone === "public") ? "links" : "history";
  return (
    <div class={`status1 ${tone}`} data-status role="status" hidden={!all.length}>
      <a
        class="stap"
        href={`?panel=${tab}`}
        data-action="panel-tab"
        data-tab={tab}
        data-status-tap
        aria-label={`${spoken} Open ${tab === "links" ? "Links" : "History"}.`}
      >
        {brief}
      </a>
      {all.map((segment, index) => (
        <>
          {index ? (
            <span class="sepdot" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span class="seg1">{segment.body}</span>
        </>
      ))}
      <span class="grow" />
      {action}
    </div>
  );
}

function DownloadCard(props: { path: string; size: number; mime: string; raw: string }) {
  return (
    <div class="scroll">
      <div class="dl">
        <div class={`ic${ext(props.path).length > 5 ? " long" : ""}`} aria-hidden="true">
          {ext(props.path)}
        </div>
        <h2>{props.path}</h2>
        <p class="muted">
          {bytes(props.size)} · {props.mime} · can't be previewed in the browser
        </p>
        <div class="btns center">
          <a class="btn primary" href={props.raw} download data-download>
            Download
          </a>
          <button type="button" class="btn" data-action="copy-raw">
            Copy raw URL
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShellRoot(props: {
  ctx: CollectionContext;
  path: string;
  children: Child;
  mode: string;
}) {
  const { ctx } = props;
  const index = ctx.rows.findIndex((row) => row.id === ctx.revision.id);
  return (
    <div
      class="shell"
      id="shell"
      data-viewer
      data-mode={props.mode}
      data-collection={ctx.collection.public_id}
      data-collection-id={ctx.collection.id}
      data-title={ctx.collection.title}
      data-revision={ctx.revision.public_id}
      data-revision-id={ctx.revision.id}
      data-n={String(ctx.revision.display_number ?? 0)}
      data-latest={ctx.latest?.public_id}
      data-latest-id={ctx.latest?.id}
      data-latest-n={ctx.latest ? String(ctx.latest.display_number ?? 0) : undefined}
      data-latest-synced={ctx.latest?.sync_state === "synced" ? "true" : "false"}
      data-path={props.path}
      data-head={ctx.revision.head_path}
      data-pinned={String(ctx.pinned)}
      data-base={ctx.s.reads.baseUrl}
      data-older={index > 0 ? ctx.rows[index - 1]?.public_id : undefined}
      data-newer={
        index >= 0 && index < ctx.rows.length - 1 ? ctx.rows[index + 1]?.public_id : undefined
      }
      data-parent={
        ctx.revision.parent_revision_id
          ? ctx.byId.get(ctx.revision.parent_revision_id)?.public_id
          : undefined
      }
      data-revisions={JSON.stringify(
        ctx.timeline.map((row) => [row.public_id, row.display_number, row.id]),
      )}
      data-files={String(ctx.files.length)}
      data-links={String(ctx.links.filter(isLive).length)}
    >
      {props.children}
    </div>
  );
}

/** The document's own query string: shell-only keys (panel, history) are dropped verbatim. */
export function documentSearch(search: string): string {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part && !/^(?:panel|history)(?:=|$)/.test(part));
  return kept.length ? `?${kept.join("&")}` : "";
}

function decodePath(encoded: string, head: string): string | null {
  try {
    if (/%(?:2f|5c)/i.test(encoded)) return null;
    return encoded ? validatePath(encoded.split("/").map(decodeURIComponent).join("/")) : head;
  } catch {
    return null;
  }
}

export function notFound(
  c: Context,
  chrome: Chrome,
  path: string,
  latestHref?: string,
  message?: Child,
) {
  return noStore(
    c.html(
      <Layout title="Not found" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="not-found">
        <NotFoundBody path={path} latestHref={latestHref} message={message} />
      </Layout>,
      404,
    ),
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

/** The In Trash page keeps the collection bar (spec §5.3, deleted.html), minus Copy and Share. */
function TrashBar(props: { chrome: Chrome; collection: CollectionRow; n: number | null }) {
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
            data-action="restore"
            data-id={collection.id}
            data-title={collection.title}
            data-then="reload"
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
}) {
  return (
    <Layout
      title={`${props.collection.title} (in Trash)`}
      chrome={props.chrome}
      bar={<TrashBar chrome={props.chrome} collection={props.collection} n={props.n ?? null} />}
      page="deleted"
    >
      <main class="wrap narrow" id="main">
        <div class="hero warn">
          <span class="dot" aria-hidden="true" />
          <div>
            <b>“{props.collection.title}” is in Trash.</b>
            <span>
              It's hidden from lists and search, and its public links return “not found”. Restoring
              it brings everything back, links included.
            </span>
          </div>
        </div>
        <div class="btns">
          <button
            type="button"
            class="btn primary"
            data-action="restore"
            data-id={props.collection.id}
            data-title={props.collection.title}
            data-then="reload"
          >
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

export async function collectionPage(
  s: HttpServices,
  c: Context,
  extras: ViewerExtras,
): Promise<Response> {
  const pub = (c.req.param("pub") ?? "").toLowerCase();
  const now = Date.now();
  const url = new URL(c.req.raw.url);
  // The Compare… picker submits ?base=&head= here when JavaScript is off.
  const pickHead = url.searchParams.get("head");
  const pickBase = url.searchParams.get("base");
  if (pickHead && pickBase && isPublicId(pub) && isPublicId(pickHead) && isPublicId(pickBase))
    return noStore(
      c.redirect(
        `/c/${pub}/r/${pickHead.toLowerCase()}/changes?base=${pickBase.toLowerCase()}`,
        302,
      ),
    );
  const after = url.pathname.slice(`/c/${pub}/`.length);
  const match = /^r\/([^/]+)(?:\/(.*))?$/.exec(after);
  const rpub = match?.[1]?.toLowerCase();
  const loaded = await loadCollection(s, c, { pub, rpub, now });
  if (loaded.kind === "missing") return notFound(c, loaded.chrome, url.pathname);
  if (loaded.kind === "deleted") {
    const rows = await s.reads.revisions(loaded.collection.id);
    const last = rows.findLast((row) => row.sync_state !== "failed") ?? rows.at(-1);
    return noStore(
      c.html(
        <DeletedPage
          chrome={loaded.chrome}
          collection={loaded.collection}
          n={last?.display_number ?? null}
        />,
        410,
      ),
    );
  }
  if (loaded.kind === "no-revision")
    return notFound(c, loaded.chrome, url.pathname, `/c/${loaded.collection.public_id}/`);
  const { ctx } = loaded;
  const { collection, revision } = ctx;
  // "changes" names the Changes page unless the revision has a root file called "changes".
  if (match && (match[2] === "changes" || match[2] === "changes/") && !ctx.manifest.files.changes)
    return changesPage(s, c, ctx, extras);
  if (match?.[2]?.startsWith("gallery/") && match[2].endsWith("/")) {
    const dir = decodePath(match[2].slice("gallery/".length, -1), "");
    const page = dir ? await galleryPage(s, c, ctx, `${dir}/`) : null;
    if (page) return page;
    return notFound(c, ctx.chrome, url.pathname, `/c/${collection.public_id}/`);
  }
  const encoded = match ? (match[2] ?? "") : after;
  const path = decodePath(encoded, revision.head_path);
  if (path === null) return notFound(c, ctx.chrome, url.pathname, `/c/${collection.public_id}/`);
  // Before the file check: the public may see a file that the newest revision no longer has.
  if (url.searchParams.get("as") === "public") return publicPreview(c, ctx, path);
  const file = ctx.manifest.files[path];
  if (url.searchParams.get("fallback") === "head") {
    url.searchParams.delete("fallback");
    return noStore(
      c.redirect(
        shellPath(
          collection.public_id,
          revision.public_id,
          file ? path : "",
          ctx.pinned,
          revision.head_path,
          url.search,
        ),
        302,
      ),
    );
  }
  if (!file)
    return notFound(
      c,
      ctx.chrome,
      url.pathname,
      `/c/${collection.public_id}/`,
      <>
        This file isn't in #{revision.display_number}: <span class="mono">{path}</span>.{" "}
        <a
          href={shellPath(
            collection.public_id,
            revision.public_id,
            "",
            ctx.pinned,
            revision.head_path,
          )}
        >
          Open its head file
        </a>
        .
      </>,
    );
  const parentRow = revision.parent_revision_id
    ? ctx.rows.find((row) => row.id === revision.parent_revision_id)
    : undefined;
  const parentManifest = parentRow ? await s.reads.manifestOf(parentRow) : undefined;
  const glyphs = glyphsAgainst(ctx.manifest, parentManifest);
  const panel = c.req.query("panel");
  const tab: PanelTab =
    panel === "history" ? "history" : panel === "links" && ctx.links.length ? "links" : "files";
  const raw = rawPath(revision.public_id, path) + documentSearch(url.search);
  return noStore(
    c.html(
      <Layout
        title={collection.title}
        chrome={ctx.chrome}
        bar={<CollectionBar ctx={ctx} />}
        page="collection"
      >
        <ShellRoot ctx={ctx} path={path} mode="document">
          <Panel
            ctx={ctx}
            tab={tab}
            files={<FilesPanel ctx={ctx} path={path} glyphs={glyphs} />}
            history={<HistoryPanel ctx={ctx} path={path} all={c.req.query("history") === "all"} />}
            links={
              ctx.links.length ? (
                <LinksPanel ctx={ctx} links={ctx.links} previewHref={previewHref(ctx, path)} />
              ) : undefined
            }
            linkCount={ctx.links.filter(isLive).length}
          />
          <main class="main" id="main" tabindex={-1}>
            <StatusLine
              ctx={ctx}
              extra={[publicSegment(ctx.links)].filter((item) => item !== null)}
            />
            {isEmbeddable(file.mime) ? (
              <iframe
                class={`frame${file.mime.startsWith("image/") ? " img" : ""}`}
                title={path}
                data-frame
                src={raw}
              />
            ) : (
              <DownloadCard path={path} size={file.size} mime={file.mime} raw={raw} />
            )}
          </main>
        </ShellRoot>
        <div class="panel-scrim" data-action="panel-close" />
        <TabBar />
        <RevisionMenu ctx={ctx} path={path} />
        <CopyMenu ctx={ctx} path={path} />
        <MoreMenu ctx={ctx} path={path} previewPublic={ctx.links.length > 0} />
        <CollectionDialogs ctx={ctx} />
        <CompareDialog ctx={ctx} basePub={null} />
        {ctx.sharing ? (
          <ShareDialog ctx={ctx} links={ctx.links} previewHref={previewHref(ctx, path)} />
        ) : null}
      </Layout>,
    ),
  );
}
