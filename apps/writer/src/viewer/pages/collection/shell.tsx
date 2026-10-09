/** @jsxImportSource hono/jsx */
import type { Manifest, ManifestFileEntry, RevisionChanges } from "@waypoint/core";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../../http.ts";
import { sourceHost, type CollectionRow, type RevisionRow } from "../../../read-model.ts";
import {
  collectionLinks,
  isLive,
  linksEnabled,
  sharingEnabled,
  type ShareView,
} from "../../../shares.ts";
import { shellPath } from "../../../viewer-paths.ts";
import { getChrome } from "../../chrome.ts";
import type { Glyph, TimelineRow } from "../../components.tsx";
import { bytes, ext } from "../../format.ts";
import { HomeBar, Layout, NotFoundBody, type Chrome } from "../../layout.tsx";
import { makeLineage, type Lineage } from "../../lineage.ts";
import { noStore } from "../../respond.ts";

export const HISTORY_PAGE = 50;

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
  /** The timeline's lineage (latest line, [ and ] stepping, History lanes), built once. */
  lineage: Lineage<TimelineRow>;
  publicSees: RevisionRow | undefined;
  url: URL;
  /** Share links (any state); empty without WAYPOINT_PUBLIC_BASE_URL. */
  links: ShareView[];
  /** Whether links can be created and copied (the token key is set too). */
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
    linksEnabled(s) ? collectionLinks(s, collection.id) : Promise.resolve([]),
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
      lineage: makeLineage(timeline),
      publicSees: rows.findLast((row) => row.sync_state === "synced"),
      url: new URL(c.req.raw.url),
      links,
      sharing: sharingEnabled(s),
    },
  };
}

export function changesHref(ctx: CollectionContext) {
  return (row: TimelineRow, base: TimelineRow): string =>
    `${shellPath(ctx.collection.public_id, row.public_id, "", true)}changes${row.parent_revision_id === base.id ? "" : `?base=${base.public_id}`}`;
}

export function DownloadCard(props: { path: string; size: number; mime: string; raw: string }) {
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
  // [ is the parent, ] the child on the same line; at an end, the toast text comes from lineage.ts.
  const older = ctx.lineage.step(ctx.revision.id, -1);
  const newer = ctx.lineage.step(ctx.revision.id, 1);
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
      data-older={"to" in older ? older.to.public_id : undefined}
      data-newer={"to" in newer ? newer.to.public_id : undefined}
      data-older-end={"end" in older ? older.end : undefined}
      data-newer-end={"end" in newer ? newer.end : undefined}
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
