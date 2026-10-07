import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** @jsxImportSource hono/jsx */
import { isTextMime, validatePath, type ManifestFileEntry } from "@waypoint/core";
import { Hono } from "hono";

import type { HttpServices } from "./http.js";
import { getStatus } from "./status-data.js";
import { rawPath, shellPath } from "./viewer-paths.js";

const clientBytes = readFileSync(new URL("../dist/viewer-client.browser.js", import.meta.url));
const clientHash = createHash("sha256").update(clientBytes).digest("hex").slice(0, 16);
const clientUrl = `/assets/viewer/${clientHash}.js`;
const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2159a4"/><path d="M13 18l11 29 8-18 8 18 11-29" fill="none" stroke="white" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;
const css = `:root{font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f7f8fa;--panel:#fff;--ink:#1d2734;--muted:#64748b;--line:#dce2e9;--accent:#2159a4;--soft:#eaf1fa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}button,.button,select,input{border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);padding:.45rem .65rem}button,.button{cursor:pointer}button:hover,.button:hover{border-color:var(--accent);text-decoration:none}.danger{color:#b33838}header{border-bottom:1px solid var(--line);background:var(--panel);padding:.7rem 1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}.brand{font-weight:750;color:var(--ink);letter-spacing:-.03em}.nav{display:flex;gap:1rem;margin-left:auto}.wrap{max-width:1100px;margin:2rem auto;padding:0 1rem}h1{font-size:1.55rem;line-height:1.2;margin:.3rem 0 1.25rem}h2{font-size:1rem;margin:0 0 .8rem}.muted,small{color:var(--muted)}.bar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}.bar form{display:flex;gap:.5rem}.grow{flex:1}.list{border:1px solid var(--line);border-radius:9px;background:var(--panel);overflow:hidden}.row{display:flex;align-items:center;gap:1rem;padding:.85rem 1rem;border-top:1px solid var(--line)}.row:first-child{border-top:0}.row-title{font-weight:600;flex:1;min-width:0;overflow-wrap:anywhere}.meta{color:var(--muted);white-space:nowrap;font-size:.88rem}.badge{border-radius:99px;background:var(--soft);color:var(--accent);padding:.15rem .55rem;font-size:.75rem;font-weight:650}.badge.failed{background:#fce8e7;color:#a92828}.badge.pending{background:#fff0d0;color:#795500}.error{color:#b33838;min-height:1.3em}[data-frame-notice]{margin:0 1rem}[data-frame-notice]:empty{display:none}.notice{margin:0;flex-basis:100%;color:var(--muted);font-size:.88rem}.shell{height:calc(100vh - 65px);display:flex;flex-direction:column}.shell-head{padding:.65rem 1rem;border-bottom:1px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}.shell-head input{font-size:1.15rem;font-weight:650;min-width:220px;max-width:460px;flex:1}.shell-head select{max-width:260px;text-overflow:ellipsis}.shell-main{display:grid;grid-template-columns:255px minmax(0,1fr);min-height:0;flex:1}.sidebar{background:var(--panel);border-right:1px solid var(--line);overflow:auto;padding:.8rem}.sidebar summary{cursor:pointer;font-weight:600;padding:.2rem}.sidebar details{margin-left:.45rem}.file{display:block;padding:.3rem .5rem;margin:.1rem 0;border-radius:5px;overflow-wrap:anywhere}.file.current{background:var(--soft);font-weight:650}.headmark{font-size:.75rem;color:var(--muted);margin-left:.35rem}.content{min-width:0;background:var(--panel)}iframe{border:0;width:100%;height:100%;display:block}.download{padding:2rem}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.8rem;margin-bottom:1.5rem}.stat{padding:1rem;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.stat strong{display:block;font-size:1.5rem}.fail{align-items:flex-start}.fail .row-title{min-width:180px}@media(max-width:720px){.shell{height:auto;min-height:calc(100vh - 65px)}.shell-main{display:flex;flex-direction:column}.sidebar{max-height:180px;border-right:0;border-bottom:1px solid var(--line)}.content{height:65vh}.row{flex-wrap:wrap}.meta{white-space:normal}}@media(prefers-color-scheme:dark){:root{--bg:#111820;--panel:#1b2530;--ink:#e7edf5;--muted:#a1b0c1;--line:#344354;--accent:#a9cdff;--soft:#293d56}.badge.failed{background:#4a272a;color:#ffb1aa}.badge.pending{background:#4b3d24;color:#f7d993}.danger,.error{color:#ffaaa7}}`;
const fmtDate = (time: number | null): import("hono/jsx").Child =>
  time == null ? (
    "Never"
  ) : (
    <time datetime={new Date(time).toISOString()}>{new Date(time).toISOString()}</time>
  );
function ago(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function Layout(props: { title: string; children: import("hono/jsx").Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Waypoint</title>
        <link rel="icon" href={favicon} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            Waypoint
          </a>
          <nav class="nav">
            <a href="/">Collections</a>
            <a href="/trash">Trash</a>
            <a href="/status">Status</a>
          </nav>
        </header>
        {props.children}
        <script src={clientUrl} defer />
      </body>
    </html>
  );
}
function ErrorPage() {
  return (
    <Layout title="Not found">
      <main class="wrap">
        <h1>Page not found</h1>
        <p>This collection, revision, or file could not be found.</p>
        <a href="/">Back to collections</a>
      </main>
    </Layout>
  );
}
function shortMessage(message: string | null): string {
  const value = message ?? "No message";
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}
function badge(state: string) {
  return <span class={`badge ${state}`}>{state}</span>;
}
function fileTree(
  files: ManifestFileEntry[],
  head: string,
  pub: string,
  rpub: string,
  pinned: boolean,
  current: string,
) {
  type Node = { folders: Map<string, Node>; files: ManifestFileEntry[] };
  const root: Node = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const render = (node: Node, prefix: string): import("hono/jsx").Child => (
    <>
      {[...node.folders]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <details open>
            <summary>{name}</summary>
            {render(child, `${prefix}${name}/`)}
          </details>
        ))}
      {node.files.map((file) => (
        <a
          class={`file ${file.path === current ? "current" : ""}`}
          data-file={file.path}
          aria-current={file.path === current ? "page" : undefined}
          data-embed={String(isEmbeddable(file.mime))}
          href={shellPath(pub, rpub, file.path, pinned, head)}
        >
          {file.path.slice(prefix.length)}
          {file.path === head && <span class="headmark">head</span>}
        </a>
      ))}
    </>
  );
  return render(root, "");
}
function isEmbeddable(mime: string): boolean {
  return isTextMime(mime) || mime.startsWith("image/") || mime === "application/pdf";
}
async function noStore(pending: Response | Promise<Response>): Promise<Response> {
  const response = await pending;
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export function viewerApp(s: HttpServices): Hono {
  const app = new Hono();
  app.get(
    clientUrl,
    () =>
      new Response(clientBytes, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
  );

  app.get("/", async (c) => {
    const q = c.req.query("q") ?? "";
    const { collections: items, next_cursor: nextCursor } = await s.reads.searchCollections({
      query: q,
      limit: 100,
      cursor: c.req.query("cursor"),
    });
    return noStore(
      c.html(
        <Layout title="Collections">
          <main class="wrap">
            <h1>Collections</h1>
            <div class="bar">
              <form method="get">
                <input
                  type="search"
                  name="q"
                  aria-label="Search collections"
                  value={q}
                  placeholder="Search titles, tags, IDs or URLs"
                />
                <button type="submit">Search</button>
              </form>
              <a href="/trash">Show deleted</a>
            </div>
            <div class="list">
              {items.length ? (
                items.map((item) => (
                  <div class="row">
                    <a class="row-title" href={`/c/${item.public_id}/`}>
                      {item.title}
                    </a>
                    <span class="meta">
                      {item.latest_revision
                        ? `#${item.latest_revision.display_number}`
                        : "No revision"}
                    </span>
                    <span class="meta">
                      <time
                        datetime={new Date(
                          item.latest_revision?.created_at ?? item.created_at,
                        ).toISOString()}
                      >
                        {ago(item.latest_revision?.created_at ?? item.created_at)}
                      </time>
                    </span>
                    {item.latest_revision && badge(item.latest_revision.sync_state)}
                    <span class="meta">
                      {item.latest_revision?.file_count ?? 0}{" "}
                      {(item.latest_revision?.file_count ?? 0) === 1 ? "file" : "files"}
                    </span>
                    {(item.metadata.tags !== undefined || item.metadata.project !== undefined) && (
                      <span class="meta">
                        {[item.metadata.project, item.metadata.tags]
                          .flat()
                          .filter((value) => typeof value === "string")
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div class="row muted">No collections found.</div>
              )}
            </div>
            {nextCursor && (
              <a href={`/?${new URLSearchParams({ q, cursor: nextCursor }).toString()}`}>More</a>
            )}
          </main>
        </Layout>,
      ),
    );
  });
  app.get("/trash", async (c) => {
    const items = await s.reads.deletedCollections();
    return noStore(
      c.html(
        <Layout title="Trash">
          <main class="wrap">
            <h1>Trash</h1>
            <p class="muted">Deleted collections can be restored or permanently purged.</p>
            <p class="error" data-error role="alert"></p>
            <div class="list">
              {items.length ? (
                items.map((item) => (
                  <div class="row">
                    <span class="row-title">
                      {item.title}
                      <small> · {item.id}</small>
                    </span>
                    <button data-action="undelete" data-id={item.id}>
                      Undelete {item.title}
                    </button>
                    <button class="danger" data-action="purge" data-id={item.id}>
                      Purge {item.title}
                    </button>
                  </div>
                ))
              ) : (
                <div class="row muted">Trash is empty.</div>
              )}
            </div>
          </main>
        </Layout>,
      ),
    );
  });
  app.get("/status", async (c) => {
    const status = await getStatus(s);
    const syncState = !status.sync_enabled
      ? "off"
      : status.account_paused
        ? "paused"
        : status.sync_blocked
          ? "blocked"
          : status.sync_verified
            ? "verified"
            : "unverified";
    return noStore(
      c.html(
        <Layout title="Status">
          <main class="wrap">
            <h1>Status</h1>
            <p>
              {badge(syncState)}{" "}
              <span class="muted">
                Sync {syncState} · {status.environment}
              </span>
            </p>
            {status.account_paused ? (
              <p class="error">Bucket account paused: {status.account_error}</p>
            ) : null}
            <div class="stats">
              {Object.entries(status.queue).map(([name, value]) => (
                <div class="stat">
                  <strong>{value}</strong>
                  {name.replaceAll("_", " ")}
                </div>
              ))}
            </div>
            <p>
              Oldest pending:{" "}
              {status.oldest_pending_age_ms === null
                ? "None"
                : ago(Date.now() - status.oldest_pending_age_ms)}
            </p>
            <p>
              Last upload: {fmtDate(status.last_upload_at)} · Last push:{" "}
              {fmtDate(status.last_push_at)} · Last pull: {fmtDate(status.last_pull_at)}
            </p>
            <p>Last error: {status.last_error ?? "None"}</p>
            <h2>Queue errors</h2>
            <div class="list">
              {status.queue_errors.length ? (
                status.queue_errors.map((row) => (
                  <div class="row fail">
                    <strong>{row.kind}</strong>
                    <span class="row-title">{row.id}</span>
                    <span class="error">{row.last_error}</span>
                  </div>
                ))
              ) : (
                <div class="row muted">No queue errors.</div>
              )}
            </div>
            <h2>Pending revisions</h2>
            <div class="list">
              {status.pending_items.length ? (
                status.pending_items.map((row) => (
                  <div class="row">
                    <span class="row-title">
                      {row.collection_public_id ? (
                        <a href={`/c/${row.collection_public_id}/`}>{row.id}</a>
                      ) : (
                        row.id
                      )}
                    </span>
                    <button
                      class="danger"
                      data-action="drop"
                      data-id={row.id}
                      aria-label={`Drop ${row.id}`}
                    >
                      Drop
                    </button>
                  </div>
                ))
              ) : (
                <div class="row muted">No pending revisions.</div>
              )}
            </div>
            <h2>Failed revisions</h2>
            <p class="error" data-error role="alert"></p>
            <div class="list">
              {status.failed_items.length ? (
                status.failed_items.map((row) => (
                  <div class="row fail">
                    <div class="row-title">
                      <strong>
                        {row.collection_public_id ? (
                          <a href={`/c/${row.collection_public_id}/`}>{row.id}</a>
                        ) : (
                          row.id
                        )}
                      </strong>
                      <br />
                      <small>
                        {fmtDate(row.created_at)} · {row.error_kind ?? "Unknown kind"}
                      </small>
                      <br />
                      {row.last_error ?? "No error detail"}
                    </div>
                    <button data-action="retry" data-id={row.id} aria-label={`Retry ${row.id}`}>
                      Retry
                    </button>
                    <button
                      class="danger"
                      data-action="drop"
                      data-id={row.id}
                      aria-label={`Drop ${row.id}`}
                    >
                      Drop
                    </button>
                  </div>
                ))
              ) : (
                <div class="row muted">No failed revisions.</div>
              )}
            </div>
          </main>
        </Layout>,
      ),
    );
  });
  const shell = async (c: import("hono").Context): Promise<Response> => {
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
              <a class="button" data-open-raw href={raw} target="_blank" rel="noopener">
                Open raw
              </a>
              <button class="danger" data-action="delete" data-id={collection.id}>
                Delete
              </button>
              <span class="error" data-error role="alert"></span>
            </div>
            {allRevisionsFailed && (
              <p class="notice" role="status">
                Every revision of this collection failed to sync. They are still viewable here;
                retry them from <a href="/status">Status</a>.
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
  };
  app.get("/c/:pub", shell);
  app.get("/c/:pub/*", shell);
  app.get("*", (c) => noStore(c.html(<ErrorPage />, 404)));
  return app;
}
