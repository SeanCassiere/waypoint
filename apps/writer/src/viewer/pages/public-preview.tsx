import { renderPublicShell } from "@waypoint/ui";
import type { Context } from "hono";

import { rawPath, shellPath } from "../../viewer-paths.js";
import { noStore } from "../respond.js";
import type { CollectionContext } from "./collection.js";

/**
 * ?as=public: the public reader's shell on the writer (spec §2, §9), so the preview matches
 * what a stranger sees. A latest URL previews the newest synced revision, like the reader.
 */
export async function publicPreview(
  c: Context,
  ctx: CollectionContext,
  path: string,
): Promise<Response> {
  const served = ctx.pinned ? ctx.revision : (ctx.publicSees ?? ctx.revision);
  const manifest =
    served.id === ctx.revision.id ? ctx.manifest : await ctx.s.reads.manifestOf(served);
  const paths = Object.keys(manifest.files).toSorted((a, b) =>
    a === manifest.headPath ? -1 : b === manifest.headPath ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  const current = manifest.files[path] ? path : manifest.headPath;
  const href = (file: string) =>
    `${shellPath(ctx.collection.public_id, served.public_id, file, ctx.pinned, manifest.headPath)}?as=public`;
  return noStore(
    c.html(
      renderPublicShell({
        title: ctx.collection.title,
        files: paths.map((file) => ({ path: file })),
        head: manifest.headPath,
        current,
        fileHref: href,
        frameBase: rawPath(served.public_id, ""),
        updatedAt: ctx.pinned ? null : served.created_at,
        snapshotAt: ctx.pinned ? served.created_at : null,
      }),
    ),
  );
}
