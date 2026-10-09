/** @jsxImportSource hono/jsx */
import type { ManifestFileEntry } from "@waypoint/core";
import { icon, imageTypeLabel } from "@waypoint/ui";
import { raw } from "hono/html";

import { shellPath } from "../../../viewer-paths.ts";
import { galleryDirFor, type Glyph } from "../../components.tsx";
import { bytes } from "../../format.ts";
import type { CollectionContext } from "./shell.tsx";

/**
 * RX-04: an image file on the reader's stage (`stageCss`): fit the width, never grow, scroll when
 * tall. The caption names the file, its size after load (`fillDims` fills `[data-dim]`), bytes and
 * type, the change against the parent revision, and "Open in gallery" only when the image's
 * folder has a gallery. The stage takes Tab focus so keyboard users can scroll it.
 */
export function ImageStage(props: {
  ctx: CollectionContext;
  path: string;
  file: ManifestFileEntry;
  raw: string;
  glyph: Glyph | undefined;
}) {
  const { ctx, path, file } = props;
  const pub = ctx.collection.public_id;
  const rpub = ctx.revision.public_id;
  const changes = `${shellPath(pub, rpub, "", true)}changes?file=${encodeURIComponent(path)}`;
  const chip =
    ctx.revision.parent_revision_id && (props.glyph === "~" || props.glyph === "+")
      ? props.glyph
      : null;
  const n = ctx.revision.display_number ?? "?";
  const gallery = galleryDirFor(path, ctx.files);
  return (
    <div class="wstage" data-dims>
      <figure class="stage" tabindex={0} aria-label={path}>
        <div class="fit">
          <img src={props.raw} alt={path} data-stage-img />
        </div>
      </figure>
      <p class="wcap">
        <b>{path.slice(path.lastIndexOf("/") + 1)}</b>
        <span data-dim></span>
        <span>{bytes(file.size)}</span>
        <span class="ty">{imageTypeLabel(file.mime)}</span>
        {chip === "~" ? (
          <span class="ichg m">
            {`~ Changed in #${n} · `}
            <a href={changes}>See changes</a>
          </span>
        ) : chip === "+" ? (
          <span class="ichg a">
            {`+ Added in #${n} · `}
            <a href={changes}>See changes</a>
          </span>
        ) : null}
        <span class="sp"></span>
        {gallery ? (
          <a
            class="btn"
            href={`${shellPath(pub, rpub, "", true)}gallery/${gallery.dir.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/`}
          >
            {raw(icon("grid"))}Open in gallery
          </a>
        ) : null}
        <a class="btn" href={props.raw} download data-download>
          {raw(icon("download"))}Download
        </a>
      </p>
    </div>
  );
}
