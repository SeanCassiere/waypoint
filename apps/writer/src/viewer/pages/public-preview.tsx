/** @jsxImportSource hono/jsx */
import { renderPublicShell } from "@waypoint/ui";
import type { Context } from "hono";

import type { RevisionRow } from "../../read-model.ts";
import { shellPath } from "../../viewer-paths.ts";
import { Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";
import { HomeBarLite, type CollectionContext } from "./collection/index.tsx";

/**
 * ?as=public: the public reader's shell on the writer (spec §2, §9), so the preview matches
 * what a stranger sees. A latest URL previews the newest synced revision, like the reader; a
 * pinned URL previews that revision. Content that hasn't synced is never shown as public.
 */
export async function publicPreview(
  c: Context,
  ctx: CollectionContext,
  path: string,
): Promise<Response> {
  const served = ctx.pinned ? ctx.revision : ctx.publicSees;
  if (!served || served.sync_state !== "synced") return notPublicYet(c, ctx, served);
  const manifest =
    served.id === ctx.revision.id ? ctx.manifest : await ctx.s.reads.manifestOf(served);
  const paths = Object.keys(manifest.files).toSorted((a, b) =>
    a === manifest.headPath ? -1 : b === manifest.headPath ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  const current = manifest.files[path] ? path : manifest.headPath;
  const href = (file: string) =>
    `${shellPath(ctx.collection.public_id, served.public_id, file, ctx.pinned, manifest.headPath)}?as=public`;
  const shell = renderPublicShell({
    title: ctx.collection.title,
    files: paths.map((file) => ({
      path: file,
      mime: manifest.files[file]?.mime,
      size: manifest.files[file]?.size,
    })),
    head: manifest.headPath,
    current,
    fileHref: href,
    frameBase: `/raw/r/${served.public_id}/`,
    updatedAt: ctx.pinned ? null : served.created_at,
    snapshotAt: ctx.pinned ? served.created_at : null,
  });
  // Owner-only hint, injected on the writer; the reader's own output never contains it.
  const back = shellPath(
    ctx.collection.public_id,
    served.public_id,
    current,
    ctx.pinned,
    manifest.headPath,
  );
  // The writer's CSP is only `frame-ancestors 'self'`, so an inline <style> is allowed here
  // (unlike on the reader, whose shell this otherwise is).
  const banner = `<style>${BANNER_CSS}</style><div role="note" class="wp-preview-banner" data-preview-banner>Preview: this is what the public sees through a share link. <a href="${escapeAttr(back)}">Back to the collection</a></div>`;
  return noStore(c.html(shell.replace(/<body([^>]*)>/, (m) => `${m}${banner}`)));
}

const BANNER_CSS =
  ".wp-preview-banner{position:sticky;top:0;z-index:10;padding:.5rem 1rem;font:500 .875rem/1.4 system-ui,sans-serif;background:#fff4d6;color:#5c4300;border-bottom:1px solid #e8d49a;text-align:center}" +
  ".wp-preview-banner a{color:inherit}" +
  "@media (prefers-color-scheme:dark){.wp-preview-banner{background:#3a2e0e;color:#f5dc9a;border-bottom-color:#5e4a17}}";

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The owner's explanation in place of a preview: the public sees only synced revisions, and a
 * link to an unsynced one shows the reader's "This link isn't available" page.
 */
function notPublicYet(
  c: Context,
  ctx: CollectionContext,
  pinned: RevisionRow | undefined,
): Promise<Response> {
  const back = shellPath(
    ctx.collection.public_id,
    ctx.revision.public_id,
    "",
    ctx.pinned,
    ctx.revision.head_path,
  );
  const number = pinned?.display_number ?? 0;
  return noStore(
    c.html(
      <Layout
        title={`Not public yet · ${ctx.collection.title}`}
        chrome={ctx.chrome}
        bar={<HomeBarLite chrome={ctx.chrome} />}
        page="not-public"
      >
        <main class="wrap narrow" id="main" tabindex={-1}>
          <div class="hero warn" data-preview="not-public">
            <span class="dot" aria-hidden="true" />
            <div>
              <b>{pinned ? `#${number} isn't public yet.` : "Nothing is public yet."}</b>
              <span>
                {pinned
                  ? `The public sees a revision only once it has synced to the cloud, and #${number} hasn't. An "Only #${number}" link shows “This link isn't available” until it syncs.`
                  : `The public sees a revision only once it has synced to the cloud, and no revision of “${ctx.collection.title}” has yet. Its public links show “This link isn't available” until one does.`}
              </span>
            </div>
          </div>
          <div class="btns">
            <a class="btn primary" href={back}>
              Back to the collection
            </a>
            <a class="btn" href="/status">
              Open Status
            </a>
          </div>
        </main>
      </Layout>,
    ),
  );
}
