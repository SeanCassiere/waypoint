/** @jsxImportSource hono/jsx */
import { MCP_LAUNCHER_API } from "@waypoint/core";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { CompareFile, FileDiff } from "../../compare.js";
import type { HealthItem } from "../../health.js";
import type { HttpServices } from "../../http.js";
import { getStatus } from "../../status-data.js";
import { getChrome } from "../chrome.js";
import { revisionHref, Time } from "../components.js";
import { plural, shortId } from "../format.js";
import { HomeBar, Layout } from "../layout.js";
import { noStore } from "../respond.js";
import { formatTime } from "../timefmt.js";

export interface ViewerExtras {
  /** Short hash of the MCP server bundle the writer serves, if built. */
  serverBundle(): Promise<string | null>;
  /** Cached per-file diff (B1) for the Changes page. */
  fileDiff(file: CompareFile, mode: "blocks" | "lines"): Promise<FileDiff>;
  /** Renders Changes-page Markdown fragments off the event loop; `null` means show source. */
  renderFragments(sources: string[]): Promise<(string | null)[]>;
  /** Agents currently long-polling for a new revision (B5). */
  watchers?(): { collection_id: string; after: string; since: number; client: string | null }[];
}

function describeClient(client: string | null): string {
  if (!client) return "An agent";
  const [agent, host] = client.split("/");
  const name = (agent ?? "agent").replace(/-mcp-client$|-client$/, "");
  return `${name} on ${host ?? "an unknown machine"}`;
}

function Hero(props: { tone: "bad" | "warn" | "ok" | "off"; title: Child; body?: Child }) {
  return (
    <div class={`hero ${props.tone}`} role={props.tone === "bad" ? "alert" : undefined}>
      <span class="dot" aria-hidden="true" />
      <div>
        <b>{props.title}</b>
        {props.body ? <span>{props.body}</span> : null}
      </div>
    </div>
  );
}

/** Rows per Status list; the rest are a link away (and all of them are in /api/status). */
export const STATUS_LIST = 50;
function listWindow(c: Context, key: string, items: readonly HealthItem[]) {
  const asked = Math.floor(Number(c.req.query(key) ?? 0));
  const from = Number.isSafeInteger(asked) && asked > 0 && asked < items.length ? asked : 0;
  return { from, shown: items.slice(from, from + STATUS_LIST), total: items.length };
}
function ListMore(props: { param: string; from: number; shown: number; total: number }) {
  const { from, shown, total } = props;
  const after = total - from - shown;
  if (from === 0 && after <= 0) return null;
  const at = (start: number) =>
    `/status?${new URLSearchParams({ [props.param]: String(start) }).toString()}`;
  return (
    <p class="legend" data-more={props.param}>
      {from > 0 ? `Showing ${from + 1}–${from + shown} of ${total}. ` : null}
      {after > 0 ? `and ${after} more… ` : null}
      {from > 0 ? <a href={at(Math.max(0, from - STATUS_LIST))}>Previous {STATUS_LIST}</a> : null}
      {from > 0 && after > 0 ? " · " : null}
      {after > 0 ? <a href={at(from + shown)}>Next {Math.min(after, STATUS_LIST)}</a> : null}
      {" · "}
      <a href="/api/status">All as JSON</a>
    </p>
  );
}

function revisionLink(item: HealthItem) {
  return (
    <>
      <a href={revisionHref(item)}>{item.collection_title ?? "Untitled collection"}</a>{" "}
      <span class="mono muted">#{item.display_number ?? "?"}</span>
    </>
  );
}

export async function statusPage(
  s: HttpServices,
  c: Context,
  extras: ViewerExtras,
): Promise<Response> {
  const now = Date.now();
  const [status, chrome, bundle] = await Promise.all([
    getStatus(s),
    getChrome(s, now),
    extras.serverBundle(),
  ]);
  const health = chrome.health;
  const failedList = listWindow(c, "failed", health.failed);
  const pendingList = listWindow(c, "pending", health.pending);
  const heroes: Child[] = [];
  if (health.blockedReason)
    heroes.push(
      <Hero
        tone="bad"
        title={
          status.account_paused
            ? `Bucket account paused: ${status.account_error ?? ""}`
            : "Sync is blocked."
        }
        body={
          <>
            {status.account_paused ? null : (
              <>
                <span class="mono">{health.blockedReason}</span>.{" "}
              </>
            )}
            Writes still work and are queued; nothing reaches the cloud until this is fixed.
          </>
        }
      />,
    );
  if (health.state === "offline")
    heroes.push(
      <Hero
        tone="warn"
        title={
          <>
            Can't reach the cloud database.
            {health.cloudLastOkAt !== null ? (
              <>
                {" "}
                Last success <Time at={health.cloudLastOkAt} fmt="ago" now={now} />.
              </>
            ) : null}
          </>
        }
        body={
          <>
            Writes still work and are queued here. Nothing reaches other machines or public links
            until the connection is back.
            {health.cloudError ? (
              <>
                {" "}
                Last error: <span class="mono">{health.cloudError}</span>
              </>
            ) : null}
          </>
        }
      />,
    );
  if (health.failed.length)
    heroes.push(
      <Hero
        tone="bad"
        title={`${heroes.length ? "Also: " : ""}${plural(health.failed.length, "revision")} failed to sync.`}
        body={
          <>
            {health.failed.length === 1 ? "It's" : "They're"} still readable on this writer, but
            other machines and public links can't see {health.failed.length === 1 ? "it" : "them"}{" "}
            until {health.failed.length === 1 ? "it's" : "they're"} retried.
            {health.pending.length
              ? ` ${plural(health.pending.length, "other revision")} ${health.pending.length === 1 ? "is" : "are"} uploading normally.`
              : ""}
          </>
        }
      />,
    );
  if (!heroes.length) {
    if (!health.syncEnabled)
      heroes.push(
        <Hero
          tone="off"
          title="Sync off."
          body="This writer runs with WAYPOINT_SYNC=off: revisions stay here and nothing reaches the cloud."
        />,
      );
    else if (health.pending.length)
      heroes.push(
        <Hero
          tone="warn"
          title={`${plural(health.pending.length, "revision")} ${health.pending.length === 1 ? "is" : "are"} uploading.`}
          body={
            health.oldestPendingAt !== null ? (
              <>
                The oldest started <Time at={health.oldestPendingAt} fmt="ago" now={now} />.
              </>
            ) : undefined
          }
        />,
      );
    else
      heroes.push(
        <Hero
          tone="ok"
          title={
            <>
              Everything is synced.
              {status.last_push_at !== null ? (
                <>
                  {" "}
                  Last push <Time at={status.last_push_at} fmt="ago" now={now} />.
                </>
              ) : null}
            </>
          }
        />,
      );
  }
  const watchers = extras.watchers?.() ?? [];
  const watchedIds = [...new Set(watchers.map((watcher) => watcher.collection_id))];
  const [watchedCollections, watchedRevisions] = await Promise.all([
    s.reads.collectionsById(watchedIds),
    s.reads.revisionIndex(watchedIds),
  ]);
  const pushAgo =
    status.last_push_at === null ? "never" : formatTime(status.last_push_at, "ago", now, true);
  const pullAgo =
    status.last_pull_at === null ? "never" : formatTime(status.last_pull_at, "ago", now, true);
  return noStore(
    c.html(
      <Layout title="Status" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="status">
        <main class="wrap" id="main">
          <div class="ph">
            <div>
              <h2>Status</h2>
              <p>
                Writer <span class="mono">{chrome.host}</span> · environment{" "}
                <span class="mono">{status.environment}</span>
                {bundle ? (
                  <>
                    {" "}
                    · server bundle <span class="mono">{bundle}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>
          {heroes}
          <div class="grid3">
            <div class={`stat ${health.failed.length ? "bad" : "zero"}`}>
              <div class="n">{health.failed.length}</div>
              <div class="l">failed {health.failed.length === 1 ? "revision" : "revisions"}</div>
            </div>
            <div class={`stat ${health.pending.length ? "" : "zero"}`}>
              <div class="n">{health.pending.length}</div>
              <div class="l">
                {health.pending.length === 1 ? "revision" : "revisions"} uploading
                {health.oldestPendingAt !== null ? (
                  <>
                    {" · oldest "}
                    <Time at={health.oldestPendingAt} fmt="ago" now={now} />
                  </>
                ) : null}
              </div>
            </div>
            <div class={`stat ${health.cloudLastOkAt === null ? "zero" : ""}`}>
              <div class="n">
                {!health.syncEnabled ? (
                  "Off"
                ) : health.cloudLastOkAt === null ? (
                  "Never"
                ) : (
                  <Time at={health.cloudLastOkAt} fmt="ago" now={now} />
                )}
              </div>
              <div class="l">
                last cloud sync (push {pushAgo} · pull {pullAgo})
                {status.last_push_at !== null ? (
                  <span class="sr">
                    Last push{" "}
                    <time datetime={new Date(status.last_push_at).toISOString()}>
                      {new Date(status.last_push_at).toISOString()}
                    </time>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <h3 class="sec">
            Failed revisions <span class="n">{health.failed.length}</span>
          </h3>
          <div class="rows">
            {health.failed.length ? (
              failedList.shown.map((item) => (
                <div class="r" id={item.id}>
                  <span class="t">{revisionLink(item)}</span>
                  <span class="acts">
                    <button type="button" class="btn sm" data-action="retry" data-ids={item.id}>
                      Retry
                    </button>
                    <button
                      type="button"
                      class="btn sm danger"
                      data-action="drop"
                      data-id={item.id}
                    >
                      Drop…
                    </button>
                  </span>
                  <span class="s">
                    {item.message ? <span>“{item.message}”</span> : null}
                    {item.source_host ? <span class="mono">{item.source_host}</span> : null}
                    <Time at={item.created_at} now={now} />
                    <span class="mono" title={item.id}>
                      {shortId(item.id, 12)}
                    </span>
                    <span>error: {item.error_kind ?? "unknown kind"}</span>
                  </span>
                  <span class="e">{item.last_error ?? "No error detail"}</span>
                </div>
              ))
            ) : (
              <div class="empty">No failed revisions.</div>
            )}
          </div>
          <ListMore
            param="failed"
            from={failedList.from}
            shown={failedList.shown.length}
            total={failedList.total}
          />
          <h3 class="sec">
            Uploading <span class="n">{plural(health.pending.length, "revision")}</span>
          </h3>
          <div class="rows">
            {health.pending.length ? (
              pendingList.shown.map((item) => (
                <div class="r" id={item.id}>
                  <span class="t">{revisionLink(item)}</span>
                  <span class="acts">
                    <button type="button" class="btn sm ghost" data-action="drop" data-id={item.id}>
                      Drop…
                    </button>
                  </span>
                  <span class="s">
                    {item.message ? <span>“{item.message}”</span> : null}
                    {item.source_host ? <span class="mono">{item.source_host}</span> : null}
                    <span>
                      started <Time at={item.created_at} now={now} />
                    </span>
                    {!health.syncEnabled ? <span>waits here while sync is off</span> : null}
                  </span>
                </div>
              ))
            ) : (
              <div class="empty">Nothing is uploading.</div>
            )}
          </div>
          <ListMore
            param="pending"
            from={pendingList.from}
            shown={pendingList.shown.length}
            total={pendingList.total}
          />
          {extras.watchers ? (
            <>
              <h3 class="sec">
                Agents watching <span class="n">{watchers.length}</span>
              </h3>
              <div class="rows" data-watchers>
                {watchers.length ? (
                  watchers.map((watcher) => {
                    const collection = watchedCollections.get(watcher.collection_id);
                    const after = watchedRevisions
                      .get(watcher.collection_id)
                      ?.find((row) => row.id === watcher.after)?.display_number;
                    return (
                      <div class="r">
                        <span class="watch">
                          <span class="pulse" aria-hidden="true" />
                          <span>
                            <b>{describeClient(watcher.client)}</b> is waiting for a new revision of{" "}
                            {collection ? (
                              <a href={`/c/${collection.public_id}/`}>{collection.title}</a>
                            ) : (
                              <span class="mono">{watcher.collection_id}</span>
                            )}
                            {after ? ` after #${after}` : ""}
                          </span>
                        </span>
                        <span class="aside">
                          since <Time at={watcher.since} now={now} />
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div class="empty">No agent is waiting for a revision right now.</div>
                )}
              </div>
            </>
          ) : null}
          <h3 class="sec">
            Background queue errors <span class="n">{status.queue_errors.length}</span>
          </h3>
          <div class="rows">
            {status.queue_errors.length ? (
              status.queue_errors.slice(0, STATUS_LIST).map((row) => (
                <div class="r">
                  <span class="t">
                    {row.kind === "bucket_delete"
                      ? "Bucket delete"
                      : row.kind === "purge"
                        ? "Purge"
                        : "Snapshot"}{" "}
                    <span class="mono muted">{row.id}</span>
                  </span>
                  <span class="e">{row.last_error}</span>
                </div>
              ))
            ) : (
              <div class="empty">No snapshot, delete, or purge errors.</div>
            )}
          </div>
          {status.queue_errors.length > STATUS_LIST ? (
            <p class="legend" data-more="queue-errors">
              and {status.queue_errors.length - STATUS_LIST} more…{" "}
              <a href="/api/status">All as JSON</a>
            </p>
          ) : null}
          <h3 class="sec">Writer</h3>
          <div class="rows">
            <div class="r">
              <span class="t mono">{chrome.host}</span>
              <span class="s">
                <span>environment {status.environment}</span>
                <span>
                  Sync{" "}
                  {health.syncEnabled ? (status.sync_verified ? "verified" : "unverified") : "off"}
                </span>
                {bundle ? <span>server bundle {bundle}</span> : null}
                <span>launcher API {MCP_LAUNCHER_API}</span>
                <span>
                  last upload{" "}
                  {status.last_upload_at === null ? (
                    "never"
                  ) : (
                    <Time at={status.last_upload_at} fmt="ago" now={now} />
                  )}
                </span>
              </span>
            </div>
          </div>
        </main>
      </Layout>,
    ),
  );
}
