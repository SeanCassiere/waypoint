import { validatePath } from "@waypoint/core";
/** @jsxImportSource hono/jsx */
import type { Context } from "hono";

import type { HttpServices } from "../../http.js";
import { rawPath, shellPath } from "../../viewer-paths.js";
import { fileTree, isEmbeddable } from "../components.js";
import { shortMessage } from "../format.js";
import { ErrorPage, Layout } from "../layout.js";
import { noStore } from "../respond.js";

export async function collectionPage(s: HttpServices, c: Context): Promise<Response> {
  const pub = c.req.param("pub") ?? "";
  const collection = await s.reads.collectionByPublicId(pub);
  if (!collection) return noStore(c.html(<ErrorPage />, 404));
  if (collection.deleted_at !== null)
    return noStore(
      c.html(
        <Layout title="In Trash">
          <main class="wrap">
            <h1>In Trash</h1>
            <p>{collection.title} is deleted.</p>
            <p class="error" data-error role="alert"></p>
            <button data-action="undelete" data-id={collection.id}>
              Undelete {collection.title}
            </button>
          </main>
        </Layout>,
        410,
      ),
    );
  const url = new URL(c.req.raw.url);
  const after = url.pathname.slice(`/c/${pub}/`.length);
  const match = /^r\/([^/]+)(?:\/(.*))?$/.exec(after);
  const pinned = Boolean(match);
  const rpub = match?.[1]?.toLowerCase();
  const revisions = (await s.reads.listRevisions(collection.id)).revisions;
  const revision = pinned
    ? revisions.find((item) => item.public_id === rpub)
    : (revisions.findLast((item) => item.sync_state !== "failed") ?? revisions.at(-1));
  if (!revision) return noStore(c.html(<ErrorPage />, 404));
  const encoded = pinned ? (match?.[2] ?? "") : after;
  let path: string;
  try {
    if (/%(?:2f|5c)/i.test(encoded)) throw new Error("Encoded separator");
    path = encoded
      ? validatePath(encoded.split("/").map(decodeURIComponent).join("/"))
      : revision.head_path;
  } catch {
    return noStore(c.html(<ErrorPage />, 404));
  }
  const detail = await s.reads.getRevision(revision.id);
  const file = detail.files.find((entry) => entry.path === path);
  if (!file) {
    if (url.searchParams.get("fallback") === "head") {
      url.searchParams.delete("fallback");
      return noStore(
        c.redirect(
          shellPath(
            collection.public_id,
            revision.public_id,
            "",
            pinned,
            revision.head_path,
            url.search,
          ),
          302,
        ),
      );
    }
    return noStore(c.html(<ErrorPage />, 404));
  }
  if (url.searchParams.get("fallback") === "head") {
    url.searchParams.delete("fallback");
    return noStore(
      c.redirect(
        shellPath(
          collection.public_id,
          revision.public_id,
          path,
          pinned,
          revision.head_path,
          url.search,
        ),
        302,
      ),
    );
  }
  const raw = rawPath(revision.public_id, path) + url.search;
  const selected = pinned ? revision.public_id : "";
  const latestRevision = revisions.findLast((item) => item.sync_state !== "failed");
  // Pending is the normal state before a commit, so only flag collections whose every revision failed.
  const allRevisionsFailed =
    revisions.length > 0 && revisions.every((item) => item.sync_state === "failed");
  return noStore(
    c.html(
      <Layout title={collection.title}>
        <div
          class="shell"
          data-viewer
          data-collection={collection.public_id}
          data-revision={revision.public_id}
          data-path={path}
          data-head={revision.head_path}
          data-pinned={String(pinned)}
        >
          <div class="shell-head">
            <input aria-label="Collection title" data-title value={collection.title} />
            <button data-action="rename" data-id={collection.id}>
              Save title
            </button>
            <select aria-label="Revision" data-picker>
              <option value="" selected={!pinned}>
                Latest · #{latestRevision?.display_number ?? revision.display_number}
              </option>
              {revisions.toReversed().map((item, index, reversed) => {
                const previous = reversed[index + 1];
                const fork =
                  item.parent_revision_id && previous && item.parent_revision_id !== previous.id;
                return (
                  <option
                    value={item.public_id}
                    selected={selected === item.public_id}
                  >{`#${item.display_number} · ${shortMessage(item.message)} · ${new Date(item.created_at).toISOString()} · ${item.sync_state}${fork ? " · fork" : ""}`}</option>
                );
              })}
            </select>
            <button data-action="go-revision">Go</button>
            <button data-action="copy-latest">Copy latest link</button>
            <button data-action="copy-pinned">Copy this revision link</button>
            <button data-action="share">Share</button>
            <a class="button" data-open-raw href={raw} target="_blank" rel="noopener">
              Open raw
            </a>
            <button class="danger" data-action="delete" data-id={collection.id}>
              Delete
            </button>
            <span class="error" data-error role="alert"></span>
          </div>
          <dialog data-share-dialog>
            <h2>Share collection</h2>
            <p class="muted">
              Anyone with a share URL can view this{" "}
              {pinned ? "snapshot" : "collection's latest revision"}.
            </p>
            <form data-share-form>
              <label>
                Label <input name="label" maxLength={200} placeholder="Optional" />
              </label>
              <label>
                Expires <input name="expires" type="datetime-local" />
              </label>
              <button type="submit">Create link</button>
              <button type="button" data-share-close>
                Close
              </button>
            </form>
            <p data-share-availability role="status"></p>
            <div data-share-created hidden>
              <p>Copy this URL now. You won't see it again.</p>
              <input data-share-url readonly aria-label="New share URL" />
              <button data-share-copy>Copy URL</button>
            </div>
            <h3>Existing links</h3>
            <div data-share-list></div>
          </dialog>
          {allRevisionsFailed && (
            <p class="notice" role="status">
              Every revision of this collection failed to sync. They are still viewable here; retry
              them from <a href="/status">Status</a>.
            </p>
          )}
          <p data-frame-notice class="error" role="status"></p>
          <div class="shell-main">
            <aside class="sidebar">
              <details data-tree open>
                <summary>
                  Files <span class="muted">({detail.files.length})</span>
                </summary>
                {fileTree(
                  detail.files,
                  revision.head_path,
                  collection.public_id,
                  revision.public_id,
                  pinned,
                  path,
                )}
              </details>
            </aside>
            <main class="content">
              {isEmbeddable(file.mime) ? (
                <iframe title={path} data-frame src={raw} />
              ) : (
                <div class="download">
                  <h2>{path}</h2>
                  <p>This file is available as a download.</p>
                  <a class="button" data-download href={raw} download>
                    Download file
                  </a>
                </div>
              )}
            </main>
          </div>
        </div>
      </Layout>,
    ),
  );
}
