/** @jsxImportSource hono/jsx */
import type { CollectionSearchResult } from "@waypoint/core";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import { STUCK_AFTER_MS, type Health } from "../../health.js";
import type { HttpServices } from "../../http.js";
import { getChrome } from "../chrome.js";
import { Chg, Globe, revisionHref, Time } from "../components.js";
import { plural, projectAndTags } from "../format.js";
import { HomeBar, Layout, type Chrome } from "../layout.js";
import { noStore } from "../respond.js";
import { dayLabel } from "../timefmt.js";

/** Splits `text` around case-insensitive matches of `query` and wraps them in <mark>. */
export function highlight(text: string, query: string): Child {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const out: Child[] = [];
  let at = 0;
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, at)) {
    if (index > at) out.push(text.slice(at, index));
    out.push(<mark>{text.slice(index, index + needle.length)}</mark>);
    at = index + needle.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
function metadataMatch(metadata: Record<string, unknown>, query: string): [string, string] | null {
  const needle = query.trim().toLowerCase();
  const walk = (key: string, value: unknown): [string, string] | null => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      return String(value).toLowerCase().includes(needle) ? [key, String(value)] : null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(key, item);
        if (found) return found;
      }
    } else if (value && typeof value === "object")
      for (const [child, item] of Object.entries(value)) {
        const found = walk(`${key}.${child}`, item);
        if (found) return found;
      }
    return null;
  };
  for (const [key, value] of Object.entries(metadata)) {
    const found = walk(key, value);
    if (found) return found;
  }
  return null;
}

export function CollectionRow(props: {
  item: CollectionSearchResult;
  now: number;
  query?: string | undefined;
}) {
  const { item, now } = props;
  const latest = item.latest_revision;
  const { project, tags } = projectAndTags(item.metadata);
  const labels = [project, ...tags].filter((value): value is string => Boolean(value));
  const query = props.query ?? "";
  const metaHit = query && item.match === "metadata" ? metadataMatch(item.metadata, query) : null;
  return (
    <a
      class="item"
      href={`/c/${item.public_id}/`}
      data-updated={String(item.updated_at)}
      data-pub={item.public_id}
      data-n={latest ? String(latest.display_number) : undefined}
    >
      <span class="t">
        <span class="tt" style={`view-transition-name:col-${item.public_id}`}>
          {highlight(item.title, query)}
        </span>
      </span>
      <span class="when">
        <Time at={item.updated_at} now={now} />
      </span>
      <span class="msg">{latest?.message ?? (latest ? "No message" : "No revision yet")}</span>
      <span class="rn">{latest ? `#${latest.display_number}` : ""}</span>
      <span class="meta">
        {latest?.source_host ? <span class="host">{latest.source_host}</span> : null}
        <Chg changes={latest?.changes} />
        {labels.length ? <span>{labels.join(" · ")}</span> : null}
        {item.queue?.failed ? (
          <span class="chip xs failed">
            <span aria-hidden="true">!</span> {item.queue.failed} failed
          </span>
        ) : null}
        {item.queue?.pending ? <span class="chip xs pending">uploading</span> : null}
        {item.share?.active ? (
          <span class="chip xs public">
            <Globe />
            Public
            {item.share.follows_latest
              ? " · follows latest"
              : ` · ${plural(item.share.active, "link")}`}
          </span>
        ) : null}
        {item.match === "id" ? <span class="faint">ID match</span> : null}
        {item.match === "title" && query ? <span class="faint">title match</span> : null}
        {metaHit ? (
          <span class="faint">
            metadata match: {metaHit[0]} = “{highlight(metaHit[1], query)}”
          </span>
        ) : null}
        <span class="more-new" data-new hidden />
      </span>
    </a>
  );
}

function attentionRows(health: Health, now: number): Child[] {
  const rows: Child[] = [];
  if (health.state === "blocked")
    rows.push(
      <div class="ar">
        <span class="t">Sync is blocked</span>
        <span class="acts">
          <a class="btn sm" href="/status">
            Open Status
          </a>
        </span>
        <span class="s mono">{health.blockedReason}</span>
      </div>,
    );
  else if (
    health.syncEnabled &&
    health.cloudError &&
    (health.cloudLastOkAt === null || now - health.cloudLastOkAt > STUCK_AFTER_MS)
  )
    rows.push(
      <div class="ar">
        <span class="t">Can't reach the cloud</span>
        <span class="acts">
          <a class="btn sm" href="/status">
            Open Status
          </a>
        </span>
        <span class="s">
          Writes still work and are queued here.{" "}
          {health.cloudLastOkAt !== null ? (
            <>
              Last success <Time at={health.cloudLastOkAt} fmt="ago" now={now} />.
            </>
          ) : null}
        </span>
      </div>,
    );
  for (const item of health.failed)
    rows.push(
      <div class="ar">
        <span class="t">
          <a href={revisionHref(item)}>{item.collection_title ?? "Untitled"}</a>{" "}
          <span class="mono">#{item.display_number ?? "?"}</span> failed to sync
        </span>
        <span class="acts">
          <button type="button" class="btn sm" data-action="retry" data-ids={item.id}>
            Retry
          </button>
          <button type="button" class="btn sm danger" data-action="drop" data-id={item.id}>
            Drop…
          </button>
        </span>
        <span class="s">
          {item.last_error ?? "No error detail"}
          {item.source_host ? (
            <>
              {" · written by "}
              <span class="mono">{item.source_host}</span>
            </>
          ) : null}{" "}
          <Time at={item.created_at} now={now} /> · readable here only
        </span>
      </div>,
    );
  if (health.syncEnabled)
    for (const item of health.pending.filter((row) => now - row.created_at > STUCK_AFTER_MS))
      rows.push(
        <div class="ar">
          <span class="t">
            <a href={revisionHref(item)}>{item.collection_title ?? "Untitled"}</a>{" "}
            <span class="mono">#{item.display_number ?? "?"}</span> is stuck uploading
          </span>
          <span class="acts">
            <a class="btn sm" href="/status">
              Open Status
            </a>
          </span>
          <span class="s">
            Started <Time at={item.created_at} fmt="ago" now={now} />
            {item.source_host ? (
              <>
                {" · "}
                <span class="mono">{item.source_host}</span>
              </>
            ) : null}
          </span>
        </div>,
      );
  return rows;
}

export function NeedsAttention(props: { health: Health; now: number }) {
  const rows = attentionRows(props.health, props.now);
  if (!rows.length) return null;
  return (
    <section class="attn" aria-labelledby="attn">
      <h3 id="attn">Needs attention</h3>
      {rows.slice(0, 3)}
      {rows.length > 3 ? (
        <div class="more">
          <a href="/status">+{rows.length - 3} more on Status</a>
        </div>
      ) : null}
    </section>
  );
}

export interface Facet {
  value: string;
  count: number;
}
export interface PublicNow {
  public_id: string;
  title: string;
  links: number;
}
export function RecentBody(props: {
  chrome: Chrome;
  items: CollectionSearchResult[];
  nextCursor: string | null;
  projects: Facet[];
  publicNow: PublicNow[] | null;
}) {
  const { chrome, items } = props;
  const now = chrome.now;
  const groups: { label: string; items: CollectionSearchResult[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.updated_at, now, true);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return (
    <div class="home">
      <main id="main" aria-labelledby="recent-title" data-recent>
        <h2 class="page" id="recent-title">
          Recent
        </h2>
        <p class="lede" data-lede>
          Newest first, by latest revision.
        </p>
        <NeedsAttention health={chrome.health} now={now} />
        <div data-groups>
          {groups.map((group) => (
            <>
              <div class="day">{group.label}</div>
              {group.items.map((item) => (
                <CollectionRow item={item} now={now} />
              ))}
            </>
          ))}
        </div>
        {props.nextCursor ? (
          <p class="pager">
            <a
              class="btn"
              href={`/?${new URLSearchParams({ cursor: props.nextCursor }).toString()}`}
            >
              Show older
            </a>
          </p>
        ) : null}
      </main>
      <aside class="side hide-sm" aria-label="Browse">
        {props.projects.length ? (
          <>
            <h3>Projects</h3>
            {props.projects.map((facet) => (
              <a
                class="facet"
                href={`/?${new URLSearchParams({ q: `project:${facet.value}` }).toString()}`}
              >
                {facet.value}
                <span>{facet.count}</span>
              </a>
            ))}
          </>
        ) : null}
        {props.publicNow ? (
          <>
            <h3>Public now</h3>
            {props.publicNow.map((item) => (
              <a class="facet" href={`/c/${item.public_id}/?panel=links`}>
                {item.title}
                <span>{plural(item.links, "link")}</span>
              </a>
            ))}
            <a class="facet all" href="/links">
              {props.publicNow.length ? "All public links →" : "No public links. Manage links →"}
            </a>
          </>
        ) : null}
      </aside>
    </div>
  );
}

export function SearchBody(props: {
  chrome: Chrome;
  q: string;
  items: CollectionSearchResult[];
  nextCursor: string | null;
  freeText: string;
}) {
  const { items, q, chrome } = props;
  return (
    <main class="wrap" id="main">
      <div class="ph">
        <div>
          <h2>
            {items.length || props.nextCursor ? (
              <>
                {props.nextCursor ? `${items.length}+` : items.length}{" "}
                {items.length === 1 && !props.nextCursor ? "result" : "results"} for “{q}”
              </>
            ) : (
              <>No collections match “{q}”</>
            )}
          </h2>
          <p>
            Matched in titles and metadata values. Paste a Waypoint URL or ID to jump straight to
            it.
          </p>
        </div>
      </div>
      <p class="muted small" data-token-hint>
        Narrow it down: <span class="mono">project:webhooks</span>{" "}
        <span class="mono">tag:research</span> <span class="mono">host:macbook-air</span>{" "}
        <span class="mono">is:shared</span> <span class="mono">is:unsynced</span>{" "}
        <span class="mono">is:pending</span> <span class="mono">in:trash</span>
      </p>
      {items.length ? (
        items.map((item) => <CollectionRow item={item} now={chrome.now} query={props.freeText} />)
      ) : (
        <p>
          <a class="btn" href="/">
            Clear filter
          </a>
        </p>
      )}
      {props.nextCursor ? (
        <p class="pager">
          <a
            class="btn"
            href={`/?${new URLSearchParams({ q, cursor: props.nextCursor }).toString()}`}
          >
            Show more
          </a>
        </p>
      ) : null}
    </main>
  );
}

export function EmptyHome() {
  return (
    <main class="wrap narrow blank" id="main">
      <b>Nothing here yet</b>
      <p>
        When an agent publishes a plan, report, or screenshots, it shows up here. Connect your first
        agent to start.
      </p>
      <a class="btn primary" href="/mcp">
        Connect an agent
      </a>
    </main>
  );
}

function projectFacets(items: CollectionSearchResult[]): Facet[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const { project } = projectAndTags(item.metadata);
    if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 12);
}

/** "Public now": collections with live links, most links first (three queries). */
async function loadPublicNow(s: HttpServices): Promise<PublicNow[]> {
  const summary = await s.reads.shareSummary();
  const collections = await s.reads.collectionsById([...summary.keys()]);
  return [...summary]
    .flatMap(([id, share]) => {
      const collection = collections.get(id);
      return collection && !collection.deleted
        ? [{ public_id: collection.public_id, title: collection.title, links: share.active }]
        : [];
    })
    .toSorted((a, b) => b.links - a.links || a.title.localeCompare(b.title))
    .slice(0, 8);
}

export async function recentPage(s: HttpServices, c: Context): Promise<Response> {
  const q = (c.req.query("q") ?? "").trim();
  const cursor = c.req.query("cursor");
  const now = Date.now();
  const [search, chrome, publicNow] = await Promise.all([
    s.reads.searchCollections({ query: q, limit: 50, cursor }),
    getChrome(s, now),
    q || !s.publicBaseUrl ? Promise.resolve(null) : loadPublicNow(s),
  ]);
  const items = search.collections;
  if (q)
    return noStore(
      c.html(
        <Layout
          title={`Search: ${q}`}
          chrome={chrome}
          bar={<HomeBar chrome={chrome} q={q} />}
          page="search"
        >
          <SearchBody
            chrome={chrome}
            q={q}
            items={items}
            nextCursor={search.next_cursor}
            freeText={q}
          />
        </Layout>,
      ),
    );
  return noStore(
    c.html(
      <Layout title="Recent" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="recent">
        {items.length || cursor ? (
          <RecentBody
            chrome={chrome}
            items={items}
            nextCursor={search.next_cursor}
            projects={projectFacets(items)}
            publicNow={publicNow}
          />
        ) : (
          <EmptyHome />
        )}
      </Layout>,
    ),
  );
}
