/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";

import type { HttpServices } from "../../http.ts";
import { rawPath, shellPath } from "../../viewer-paths.ts";
import { bytes, plural } from "../format.ts";
import { Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";
import {
  CollectionBar,
  CollectionDialogs,
  CopyMenu,
  FilesPanel,
  glyphsAgainst,
  HistoryPanel,
  MoreMenu,
  Panel,
  ShellRoot,
  TabBar,
  type CollectionContext,
} from "./collection/index.tsx";

const IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)$/;

/** Image gallery for a folder (spec §5.6): the browser scales originals; no thumbnails. */
export async function galleryPage(
  s: HttpServices,
  c: Context,
  ctx: CollectionContext,
  dir: string,
): Promise<Response | null> {
  const { revision, collection } = ctx;
  const parentRow = revision.parent_revision_id
    ? ctx.rows.find((row) => row.id === revision.parent_revision_id)
    : undefined;
  const parent = parentRow ? await s.reads.manifestOf(parentRow) : undefined;
  const inDir = (path: string) => path.startsWith(dir) && !path.slice(dir.length).includes("/");
  const images = ctx.files.filter((file) => inDir(file.path) && IMAGE.test(file.mime));
  if (!images.length) return null;
  const glyphs = glyphsAgainst(ctx.manifest, parent);
  const removed = parent
    ? Object.entries(parent.files).filter(
        ([path, entry]) => inDir(path) && IMAGE.test(entry.mime) && !ctx.manifest.files[path],
      )
    : [];
  const filter = c.req.query("filter") === "changed" ? "changed" : "all";
  const shown =
    filter === "changed" ? images.filter((file) => glyphs.get(file.path) !== "·") : images;
  const changedCount = images.filter((file) => glyphs.get(file.path) !== "·").length;
  const page = `${shellPath(collection.public_id, revision.public_id, "", true)}gallery/${dir
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")}/`;
  const parentN = parentRow?.display_number ?? null;
  const n = revision.display_number ?? 0;
  const done = shellPath(collection.public_id, revision.public_id, "", true);
  return noStore(
    c.html(
      <Layout
        title={`${dir} · ${collection.title}`}
        chrome={ctx.chrome}
        bar={<CollectionBar ctx={ctx} mode="gallery" pill={`gallery · ${dir}`} doneHref={done} />}
        page="gallery"
        findIn={collection.title}
      >
        <ShellRoot ctx={ctx} path={revision.head_path} mode="gallery">
          <Panel
            ctx={ctx}
            tab="files"
            files={<FilesPanel ctx={ctx} path={null} glyphs={glyphs} />}
            history={<HistoryPanel ctx={ctx} path="" all={false} />}
          />
          <main class="main" id="main" tabindex={-1}>
            <div
              class="gallery"
              data-gallery
              data-done={done}
              data-n={String(n)}
              data-parent-n={parentN === null ? "" : String(parentN)}
            >
              <div class="galhead">
                <h2>{dir}</h2>
                <span class="muted">
                  {plural(images.length, "image")} in #{n}
                  {parentN !== null ? ` · ${changedCount} changed since #${parentN}` : ""}
                </span>
                <span class="grow" />
                <nav class="seg" aria-label="Filter images">
                  <a href={page} aria-current={filter === "all" ? "page" : undefined}>
                    All
                  </a>
                  <a
                    href={`${page}?filter=changed`}
                    aria-current={filter === "changed" ? "page" : undefined}
                  >
                    Changed {changedCount}
                  </a>
                </nav>
              </div>
              {shown.map((file) => {
                const glyph = glyphs.get(file.path) ?? "·";
                const before =
                  parent?.files[file.path] && parentRow
                    ? rawPath(parentRow.public_id, file.path)
                    : "";
                return (
                  <a
                    class={`shot${glyph === "+" ? " add" : glyph === "~" ? " mod" : ""}`}
                    href={shellPath(collection.public_id, revision.public_id, file.path, true)}
                    data-shot
                    data-dims
                    data-name={file.path.slice(dir.length)}
                    data-after={rawPath(revision.public_id, file.path)}
                    data-before={glyph === "~" ? before : undefined}
                    data-status={glyph === "+" ? "added" : glyph === "~" ? "changed" : "unchanged"}
                  >
                    <span class="img">
                      <img
                        src={rawPath(revision.public_id, file.path)}
                        alt={file.path.slice(dir.length)}
                        loading="lazy"
                        decoding="async"
                      />
                    </span>
                    <span class="cap">
                      <span
                        class={glyph === "+" ? "k a" : glyph === "~" ? "k m" : "k"}
                        aria-label={
                          glyph === "+" ? "added" : glyph === "~" ? "changed" : "unchanged"
                        }
                      >
                        {glyph}
                      </span>
                      <span class="nm">{file.path.slice(dir.length)}</span>
                      <span class="dim" data-dim>
                        {bytes(file.size)}
                      </span>
                    </span>
                  </a>
                );
              })}
              {removed.length ? (
                <>
                  <div class="galsec">Removed in #{n}</div>
                  {removed.map(([path, entry]) => (
                    <div class="shot del" aria-label={`${path} removed`}>
                      <span class="img">
                        <span class="muted small">was {bytes(entry.size)}</span>
                      </span>
                      <span class="cap">
                        <span class="k rm">−</span>
                        <span class="nm">{path.slice(dir.length)}</span>
                      </span>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </main>
        </ShellRoot>
        <div class="panel-scrim" data-action="panel-close" />
        <TabBar />
        <CopyMenu ctx={ctx} path={revision.head_path} />
        <MoreMenu ctx={ctx} path={revision.head_path} />
        <CollectionDialogs ctx={ctx} />
        <dialog class="lbx" id="lightbox" aria-labelledby="lbx-title" data-mode="side">
          <header>
            <b id="lbx-title" data-lbx-title />
            <span class="muted small" data-lbx-status />
            <span class="grow" />
            <div class="seg" role="group" aria-label="Compare view" data-lbx-modes>
              <button type="button" data-mode="side" aria-pressed="true">
                Side by side
              </button>
              <button type="button" data-mode="slider" aria-pressed="false">
                Slider
              </button>
              <button type="button" data-mode="only" aria-pressed="false">
                #{n} only
              </button>
            </div>
            <form method="dialog">
              <button class="btn sm" data-lbx-done aria-keyshortcuts="Escape">
                Done <kbd aria-hidden="true">Esc</kbd>
              </button>
            </form>
          </header>
          <div class="pair" data-lbx-pair>
            <figure data-lbx-before>
              <img alt="" />
              <figcaption>Before · #{parentN ?? "–"}</figcaption>
            </figure>
            <figure>
              <img alt="" data-lbx-after />
              <figcaption>After · #{n}</figcaption>
            </figure>
          </div>
          <div class="slider" data-lbx-slider>
            <div class="stack">
              <img alt="" data-lbx-under />
              <img alt="" class="after" data-lbx-over />
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value="50"
              aria-label="Reveal the new image"
              data-lbx-range
            />
          </div>
          <footer>
            <button type="button" class="btn sm" data-lbx-prev aria-keyshortcuts="ArrowLeft">
              {raw(icon("chevronLeft"))} Previous
            </button>
            <span class="muted small" data-lbx-count />
            <button type="button" class="btn sm" data-lbx-next aria-keyshortcuts="ArrowRight">
              Next {raw(icon("chevronRight"))}
            </button>
            <span class="lbx-hint muted small" aria-hidden="true">
              <kbd>←</kbd> <kbd>→</kbd> images
            </span>
            <span class="grow" />
            <a class="btn sm" data-lbx-open href="#">
              Open in collection
            </a>
          </footer>
        </dialog>
      </Layout>,
    ),
  );
}
