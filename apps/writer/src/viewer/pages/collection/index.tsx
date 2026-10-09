/** @jsxImportSource hono/jsx */
import { validatePath } from "@waypoint/core";
import { isStageImage } from "@waypoint/ui";
import type { Context } from "hono";

import type { HttpServices } from "../../../http.ts";
import { isLive, linksEnabled } from "../../../shares.ts";
import { rawPath, shellPath } from "../../../viewer-paths.ts";
import { isEmbeddable } from "../../components.tsx";
import { Layout } from "../../layout.tsx";
import { noStore } from "../../respond.ts";
import { changesPage } from "../changes/index.tsx";
import { galleryPage } from "../gallery.tsx";
import { publicPreview } from "../public-preview.tsx";
import { LinksPanel, previewHref, publicSegment, ShareDialog, shareDisclosure } from "../share.tsx";
import type { ViewerExtras } from "../status.tsx";
import { trashLinks } from "../trash.tsx";
import { CollectionBar, TabBar } from "./bar.tsx";
import { CollectionDialogs } from "./dialogs.tsx";
import { ImageStage } from "./image-stage.tsx";
import { RevisionMenu, CopyMenu, MoreMenu } from "./menus.tsx";
import { type PanelTab, Panel, HistoryPanel, FilesPanel } from "./panel.tsx";
import {
  glyphsAgainst,
  loadCollection,
  DownloadCard,
  ShellRoot,
  documentSearch,
  notFound,
} from "./shell.tsx";
import { StatusLine } from "./status-line.tsx";
import { DeletedPage } from "./trash-page.tsx";

function decodePath(encoded: string, head: string): string | null {
  try {
    if (/%(?:2f|5c)/i.test(encoded)) return null;
    return encoded ? validatePath(encoded.split("/").map(decodeURIComponent).join("/")) : head;
  } catch {
    return null;
  }
}

export async function collectionPage(
  s: HttpServices,
  c: Context,
  extras: ViewerExtras,
): Promise<Response> {
  const pub = (c.req.param("pub") ?? "").toLowerCase();
  const now = Date.now();
  const url = new URL(c.req.raw.url);
  const after = url.pathname.slice(`/c/${pub}/`.length);
  const match = /^r\/([^/]+)(?:\/(.*))?$/.exec(after);
  const rpub = match?.[1]?.toLowerCase();
  const loaded = await loadCollection(s, c, { pub, rpub, now });
  if (loaded.kind === "missing") return notFound(c, loaded.chrome, url.pathname);
  if (loaded.kind === "deleted") {
    const id = loaded.collection.id;
    // Restore… carries the same counts and paused links as the Trash row (OW-07).
    const [rows, details, links] = await Promise.all([
      s.reads.revisions(id),
      s.reads.trashDetails([id]),
      linksEnabled(s) ? trashLinks(s, [id]) : Promise.resolve(undefined),
    ]);
    const last = rows.findLast((row) => row.sync_state !== "failed") ?? rows.at(-1);
    const detail = details.get(id);
    return noStore(
      c.html(
        <DeletedPage
          chrome={loaded.chrome}
          collection={loaded.collection}
          n={last?.display_number ?? null}
          detail={{ revisions: detail?.revisions ?? 0, files: detail?.files ?? 0 }}
          paused={links?.get(id)?.paused ?? []}
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
  const disclosure = ctx.sharing ? await shareDisclosure(ctx, path) : null;
  return noStore(
    c.html(
      <Layout
        title={collection.title}
        chrome={ctx.chrome}
        bar={<CollectionBar ctx={ctx} />}
        page="collection"
        findIn={collection.title}
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
            {isStageImage(file.mime) ? (
              <ImageStage
                ctx={ctx}
                path={path}
                file={{ path, hash: file.hash, mime: file.mime, size: file.size, url: raw }}
                raw={raw}
                glyph={glyphs.get(path)}
              />
            ) : isEmbeddable(file.mime) ? (
              <iframe class="frame" title={path} data-frame src={raw} />
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
        {disclosure ? <ShareDialog ctx={ctx} links={ctx.links} disclosure={disclosure} /> : null}
      </Layout>,
    ),
  );
}

export type { CollectionContext } from "./shell.tsx";
export {
  filesOf,
  glyphsAgainst,
  loadCollection,
  changesHref,
  ShellRoot,
  documentSearch,
  notFound,
} from "./shell.tsx";
export { CollectionBar, TabBar, HomeBarLite } from "./bar.tsx";
export { handoffBlock, RevisionMenu, CopyMenu, MoreMenu } from "./menus.tsx";
export { CollectionDialogs } from "./dialogs.tsx";
export { type PanelTab, Panel, HistoryPanel, FilesPanel } from "./panel.tsx";
export { type Segment, statusSegments, StatusLine } from "./status-line.tsx";
export { DeletedPage } from "./trash-page.tsx";
