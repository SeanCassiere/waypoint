/** @jsxImportSource hono/jsx */
import { MCP_LAUNCHER_API } from "@waypoint/core";
import type { FragmentLinks } from "@waypoint/render";
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import type { CompareFile, FileDiff } from "../../compare.ts";
import {
  STALLED_AFTER_MS,
  type CollectionHealth,
  type Health,
  type HealthItem,
} from "../../health.ts";
import type { HttpServices } from "../../http.ts";
import { getStatus, LOCAL_ONLY_DETAIL, LOCAL_ONLY_TITLE } from "../../status-data.ts";
import { getChrome } from "../chrome.ts";
import { LineStrip, revisionHref, Time } from "../components.tsx";
import { plural, shortId } from "../format.ts";
import { chipText, explainItem, itemWord, stripModel, type ItemWord } from "../health-words.ts";
import { HomeBar, Layout } from "../layout.tsx";
import { purgeLinks, PurgeRow } from "../purge.tsx";
import { noStore } from "../respond.ts";
import { formatTime } from "../timefmt.ts";

export interface ViewerExtras {
  /** Short hash of the MCP server bundle the writer serves, if built. */
  serverBundle(): Promise<string | null>;
  /** Cached per-file diff (B1) for the Changes page. */
  fileDiff(file: CompareFile, mode: "blocks" | "lines"): Promise<FileDiff>;
  /** Renders Changes-page Markdown fragments off the event loop; `null` means show source. */
  renderFragments(sources: string[], links?: FragmentLinks): Promise<(string | null)[]>;
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
/**
 * Where Home's Details lands: the collection's Needs attention group on Status. The groups follow
 * the `?failed=` window, so a group whose first item is past the first page links to that page.
 */
export function attentionHref(health: Health, pub: string): string {
  let before = 0;
  for (const group of health.collections) {
    if (!group.attention) continue;
    if (group.collection_public_id === pub) break;
    before += group.items.length;
  }
  const from = Math.floor(before / STATUS_LIST) * STATUS_LIST;
  return `/status${from > 0 ? `?failed=${from}` : ""}#attn-${pub}`;
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

const STALLED_MINUTES = STALLED_AFTER_MS / 60_000;
const WORD_ORDER: Record<ItemWord, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };
const WORD_CLASS: Record<ItemWord, string> = {
  failed: "f",
  stalled: "p",
  uploading: "p",
  waiting: "w",
};
/** "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  return parts.length < 2
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/** A Status row's state chip: "#6 failed", "#9 waiting for #8". */
function RowState(props: { item: HealthItem; word: ItemWord; waitingFor: number | null }) {
  const { item, word } = props;
  return (
    <span class={`sc ${WORD_CLASS[word]}`}>
      {raw(icon(word === "failed" ? "alert" : "clock", "sm"))}
      {chipText(item.display_number, word, props.waitingFor)}
    </span>
  );
}
function DropButton(props: { item: HealthItem; describedBy?: string }) {
  const { item } = props;
  return (
    <button
      type="button"
      class="btn sm danger"
      data-action="drop"
      data-id={item.id}
      data-n={item.display_number ?? undefined}
      data-title={item.collection_title ?? undefined}
      aria-describedby={props.describedBy}
    >
      Drop #{item.display_number ?? "?"}…
    </button>
  );
}

/** One revision that needs you, with what happened, what to do, and the raw error. */
function AttentionRow(props: { item: HealthItem; parentN: number | null; now: number }) {
  const { item, now } = props;
  const word = itemWord(item);
  const explain = explainItem(item, word, now, props.parentN);
  return (
    <li class="srow" id={item.id}>
      <div class="h">
        <RowState item={item} word={word} waitingFor={word === "waiting" ? props.parentN : null} />{" "}
        {item.message ? <span class="msg">“{item.message}”</span> : null}
      </div>
      <span class="acts">
        {word === "failed" ? (
          <button
            type="button"
            class="btn sm"
            data-action="retry"
            data-ids={item.id}
            data-n={item.display_number ?? undefined}
            data-title={item.collection_title ?? undefined}
            aria-describedby={`sh-${item.id}`}
          >
            Retry #{item.display_number ?? "?"}
          </button>
        ) : null}
        <DropButton item={item} />
      </span>
      <p class="x" id={`sh-${item.id}`}>
        {explain.what}
      </p>
      <p class="nx">{explain.next}</p>
      <p class="raw">
        <code class={item.last_error === null ? "e none" : "e"}>
          {item.last_error ?? "No error detail"}
        </code>{" "}
        <span>{item.error_kind ?? "unknown kind"}</span>{" "}
        {item.source_host ? (
          <>
            <span class="mono">{item.source_host}</span>{" "}
          </>
        ) : null}
        <span>
          written <Time at={item.created_at} now={now} />
        </span>{" "}
        <span class="mono" title={item.id}>
          {shortId(item.id, 12)}
        </span>
      </p>
    </li>
  );
}

/** One collection's group under Needs attention: its lines, then its windowed rows. */
function AttentionGroup(props: { group: CollectionHealth; items: HealthItem[]; now: number }) {
  const { group, now } = props;
  const pub = group.collection_public_id;
  const numbers = new Map(group.rows.map((row) => [row.id, row.display_number]));
  const heading = pub ? `sg-${pub}` : `sg-${group.collection_id}`;
  return (
    <section class="sgrp" id={`attn-${pub ?? group.collection_id}`} aria-labelledby={heading}>
      <header>
        <h3 id={heading}>
          {pub ? (
            <a href={`/c/${pub}/`}>{group.collection_title ?? "Untitled collection"}</a>
          ) : (
            (group.collection_title ?? "Untitled collection")
          )}
        </h3>{" "}
        {group.project ? <span class="proj">{group.project}</span> : null}
        <span class="imp">
          {group.liveLinks
            ? plural(group.liveLinks, "live link")
            : "No public links · nothing public is affected"}
        </span>
      </header>
      <LineStrip model={stripModel(group)} />
      <ul class="srows">
        {props.items.map((item) => (
          <AttentionRow
            item={item}
            parentN={
              item.parent_revision_id ? (numbers.get(item.parent_revision_id) ?? null) : null
            }
            now={now}
          />
        ))}
      </ul>
    </section>
  );
}

/** The Status hero when collections need you (OW-06b), or null. */
function attentionHero(health: Health, groups: CollectionHealth[], also: boolean): Child {
  if (!groups.length) return null;
  const tone = groups.some((group) => group.worst === "failed") ? "bad" : "warn";
  const prefix = also ? "Also: " : "";
  const [only] = groups;
  if (groups.length === 1 && only) {
    const failed = only.items.filter((item) => item.sync === "failed");
    const stalled = only.items.filter((item) => item.sync === "stalled");
    const parts = [
      ...failed.map((item) => `#${item.display_number ?? "?"} failed to sync`),
      ...stalled.map((item) => `#${item.display_number ?? "?"} has stalled`),
    ];
    const sees = stripModel(only).seesN;
    return (
      <Hero
        tone={tone}
        title={`${prefix}${only.collection_title ?? "Untitled collection"} needs you.`}
        body={`${joinAnd(parts)}. ${
          sees === null
            ? "Nothing in it has synced yet."
            : `Other machines and public links still see #${sees}.`
        }${health.collections.length === 1 ? " Everything else is synced." : ""}`}
      />
    );
  }
  const f = health.failed.length;
  const s = health.stalled.length;
  const counts = f
    ? `${plural(f, "revision")} failed${s ? ` and ${s} stalled` : ""}.`
    : `${plural(s, "revision")} stalled.`;
  return (
    <Hero
      tone={tone}
      title={`${prefix}${groups.length} collections need you.`}
      body={`${counts} Each collection is listed under Needs attention.`}
    />
  );
}

/**
 * Parent numbers of the In progress rows, noted by `statusPage` from every revision of their
 * collections: a waiting row's parent may sit on another `?pending=` page, and a HealthItem
 * doesn't carry its parent's number. Keyed by the per-request item, so `InProgressSection` keeps
 * its agreed props; without an entry it looks among its own items.
 */
const progressParents = new WeakMap<HealthItem, number>();

/**
 * Status's In progress section (OW-06b): queued revisions of collections that don't need you,
 * then `extra` (OW-14's purge rows, each an <li>, not windowed), the `?pending=` pager and `after`.
 */
export function InProgressSection(props: {
  items: HealthItem[];
  extra?: Child[];
  extraCount?: number;
  after?: Child;
  now: number;
  syncEnabled: boolean;
  window: { from: number; total: number };
}) {
  const { items, now } = props;
  const extraCount = props.extraCount ?? 0;
  const numbers = new Map(items.map((item) => [item.id, item.display_number]));
  return (
    <section aria-labelledby="sec-progress" data-status-section="progress">
      <h2 class="sec" id="sec-progress">
        In progress{" "}
        <span class="n" data-progress-count>
          {props.window.total + extraCount}
        </span>
      </h2>
      <ul class="srows" data-status-progress>
        {items.map((item) => {
          const word = itemWord(item);
          const parent =
            progressParents.get(item) ??
            (item.parent_revision_id ? numbers.get(item.parent_revision_id) : null);
          return (
            <li class="srow" id={item.id}>
              <div class="h">
                <a class="ct" id={`pt-${item.id}`} href={revisionHref(item)}>
                  {item.collection_title ?? "Untitled collection"}
                </a>{" "}
                <RowState
                  item={item}
                  word={word}
                  waitingFor={word === "waiting" ? (parent ?? null) : null}
                />{" "}
                {item.message ? <span class="msg">“{item.message}”</span> : null}
              </div>
              <span class="acts">
                <DropButton item={item} describedBy={`pt-${item.id}`} />
              </span>
              <p class="raw">
                {item.source_host ? (
                  <>
                    <span class="mono">{item.source_host}</span>{" "}
                  </>
                ) : null}
                <span>
                  started <Time at={item.created_at} now={now} />
                </span>
                {props.syncEnabled ? null : (
                  <>
                    {" "}
                    <span>waits here while sync is off</span>
                  </>
                )}
              </p>
            </li>
          );
        })}
        {props.extra}
      </ul>
      {!items.length && !extraCount ? (
        <div class="rows">
          <div class="empty">Nothing is uploading.</div>
        </div>
      ) : null}
      <ListMore
        param="pending"
        from={props.window.from}
        shown={items.length}
        total={props.window.total}
      />
      {props.after}
    </section>
  );
}

export async function statusPage(
  s: HttpServices,
  c: Context,
  extras: ViewerExtras,
): Promise<Response> {
  const now = Date.now();
  const [status, chrome, bundle, purges] = await Promise.all([
    getStatus(s),
    getChrome(s, now),
    extras.serverBundle(),
    s.reads.purgingCollections(),
  ]);
  const revokedLinks = await purgeLinks(s, purges);
  // Purges are In progress rows; /api/status keeps them in queue_errors (OW-14).
  const queueErrors = status.queue_errors.filter((row) => row.kind !== "purge");
  const health = chrome.health;
  const attention = health.collections.filter((group) => group.attention);
  const attentionIds = new Set(attention.map((group) => group.collection_id));
  // Grouped by collection in group order; within one, failed, stalled, uploading, waiting.
  const attentionItems = attention.flatMap((group) =>
    group.items.toSorted((a, b) => WORD_ORDER[itemWord(a)] - WORD_ORDER[itemWord(b)]),
  );
  const progress = health.pending.filter((item) => !attentionIds.has(item.collection_id));
  const attentionList = listWindow(c, "failed", attentionItems);
  const progressList = listWindow(c, "pending", progress);
  const rowNumbers = new Map(
    health.collections.flatMap((group) => group.rows.map((row) => [row.id, row.display_number])),
  );
  for (const item of progressList.shown) {
    const parent = item.parent_revision_id ? rowNumbers.get(item.parent_revision_id) : undefined;
    if (parent !== undefined) progressParents.set(item, parent);
  }
  const shownGroups = attention.flatMap((group) => {
    const items = attentionList.shown.filter((item) => item.collection_id === group.collection_id);
    return items.length ? [{ group, items }] : [];
  });
  const heroes: Child[] = [];
  // Persistent, whatever else is wrong: local-only mode keeps nothing anywhere but here.
  if (!health.syncEnabled)
    heroes.push(
      <Hero
        tone={status.environment === "prod" ? "warn" : "off"}
        title={LOCAL_ONLY_TITLE}
        body={LOCAL_ONLY_DETAIL}
      />,
    );
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
  if (attention.length) heroes.push(attentionHero(health, attention, heroes.length > 0));
  if (!heroes.length) {
    if (health.pending.length)
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
      <Layout
        title="Status"
        chrome={chrome}
        bar={<HomeBar chrome={chrome} current="status" />}
        page="status"
      >
        <main class="wrap" id="main">
          <div class="ph">
            <div>
              <h1>Status</h1>
              <p>
                Writer <span class="mono">{chrome.host}</span> · environment{" "}
                <span class="mono">{status.environment}</span> · version{" "}
                <span class="mono" data-version>
                  {status.version}
                  {status.sha ? ` (${status.sha.slice(0, 12)})` : ""}
                </span>
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
              <div class="d">stopped trying; needs Retry or Drop</div>
            </div>
            {health.syncEnabled ? (
              <div class={`stat ${health.stalled.length ? "" : "zero"}`}>
                <div class="n">{health.stalled.length}</div>
                <div class="l">
                  stalled · {health.pending.length - health.stalled.length} uploading normally
                </div>
                <div class="d">stalled = no upload progress for {STALLED_MINUTES} min</div>
              </div>
            ) : (
              <div class={`stat ${health.pending.length ? "" : "zero"}`}>
                <div class="n">{health.pending.length}</div>
                <div class="l">waiting here</div>
                <div class="d">sync is off, so nothing uploads</div>
              </div>
            )}
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
                last cloud sync
                {status.last_push_at !== null ? (
                  <span class="sr">
                    Last push{" "}
                    <time datetime={new Date(status.last_push_at).toISOString()}>
                      {new Date(status.last_push_at).toISOString()}
                    </time>
                  </span>
                ) : null}
              </div>
              <div class="d">
                push {pushAgo} · pull {pullAgo}
              </div>
            </div>
          </div>
          <section aria-labelledby="sec-attn" data-status-section="attention">
            <h2 class="sec" id="sec-attn">
              Needs attention <span class="n">{plural(attention.length, "collection")}</span>
            </h2>
            {shownGroups.length ? (
              shownGroups.map(({ group, items }) => (
                <AttentionGroup group={group} items={items} now={now} />
              ))
            ) : (
              <div class="rows">
                <div class="empty">Nothing needs attention.</div>
              </div>
            )}
            <ListMore
              param="failed"
              from={attentionList.from}
              shown={attentionList.shown.length}
              total={attentionList.total}
            />
            <p class="legend">
              Home, the health pill and this page use the same rule: a revision is <b>stalled</b>{" "}
              after {STALLED_MINUTES} minutes without upload progress.
            </p>
          </section>
          <InProgressSection
            items={progressList.shown}
            extra={purges.map((row) => (
              <PurgeRow
                row={row}
                page="status"
                now={now}
                links={revokedLinks.get(row.collection_id) ?? []}
                syncEnabled={health.syncEnabled}
                bucketDeletes={status.queue.pending_r2_deletes}
              />
            ))}
            extraCount={purges.length}
            after={
              purges.length ? (
                <p class="legend">A purge is never marked failed: it retries until it finishes.</p>
              ) : undefined
            }
            now={now}
            syncEnabled={health.syncEnabled}
            window={{ from: progressList.from, total: progressList.total }}
          />
          {extras.watchers ? (
            <>
              <h2 class="sec">
                Agents watching <span class="n">{watchers.length}</span>
              </h2>
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
          <h2 class="sec">
            Background queue errors <span class="n">{queueErrors.length}</span>
          </h2>
          <div class="rows">
            {queueErrors.length ? (
              queueErrors.slice(0, STATUS_LIST).map((row) => (
                <div class="r">
                  <span class="t">
                    {row.kind === "bucket_delete" ? "Bucket delete" : "Snapshot"}{" "}
                    <span class="mono muted">{row.id}</span>
                  </span>
                  <span class="e">{row.last_error}</span>
                </div>
              ))
            ) : (
              <div class="empty">
                No snapshot or bucket-delete errors. Purges are listed under In progress.
              </div>
            )}
          </div>
          {queueErrors.length > STATUS_LIST ? (
            <p class="legend" data-more="queue-errors">
              and {queueErrors.length - STATUS_LIST} more… <a href="/api/status">All as JSON</a>
            </p>
          ) : null}
          <h2 class="sec">Writer</h2>
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
