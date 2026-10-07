/** @jsxImportSource hono/jsx */
import { isTextMime, type ManifestFileEntry, type RevisionChanges } from "@waypoint/core";
import type { Child } from "hono/jsx";

import type { Health } from "../health.js";
import { shellPath } from "../viewer-paths.js";
import { changesTitle, plural } from "./format.js";
import { formatTime, fullDate, type TimeFormat } from "./timefmt.js";

export function LogoMark(props: { size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg class="wmark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" />
      <path d="M14 20l10 26 8-17 8 17 10-26" />
    </svg>
  );
}
export function Globe() {
  return (
    <svg class="globe" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M1.5 8h13M8 1.5c2 2 2.8 4.2 2.8 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.2 5.7 5.2 8S6 12.5 8 14.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
      />
    </svg>
  );
}
export function Spinner() {
  return <span class="spin" aria-hidden="true" />;
}
/** A `<time>` with UTC fallback text; the client rewrites it in the browser's locale. */
export function Time(props: { at: number; fmt?: TimeFormat; now: number }) {
  const fmt = props.fmt ?? "clock";
  return (
    <time
      datetime={new Date(props.at).toISOString()}
      data-fmt={fmt}
      title={`${fullDate(props.at, true)} UTC`}
    >
      {formatTime(props.at, fmt, props.now, true)}
    </time>
  );
}
export function Chg(props: { changes: RevisionChanges | null | undefined; unit?: string }) {
  const changes = props.changes;
  if (!changes) return null;
  const parts: Child[] = [];
  if (changes.modified) parts.push(<span class="m">~{changes.modified}</span>);
  if (changes.added) parts.push(<span class="a">+{changes.added}</span>);
  if (changes.removed) parts.push(<span class="rm">−{changes.removed}</span>);
  if (!parts.length) return null;
  return (
    <span class="chg" title={changesTitle(changes)}>
      {parts.map((part, index) => (
        <>
          {index ? " " : ""}
          {part}
        </>
      ))}
      {props.unit ? ` ${props.unit}` : ""}
    </span>
  );
}

export function HealthPill(props: { health: Health }) {
  const { health } = props;
  const tone =
    health.state === "failed" || health.state === "blocked"
      ? "failed"
      : health.state === "uploading" || health.state === "offline"
        ? "pending"
        : health.state === "off"
          ? "off"
          : "";
  return (
    <button
      type="button"
      class={`health ${tone}`}
      popovertarget="health-pop"
      aria-label={health.aria}
      data-health={health.state}
    >
      <span class="d" aria-hidden="true" />
      <span class="lbl">{health.label}</span>
      {health.short !== health.label ? <span class="short">{health.short}</span> : null}
    </button>
  );
}
function healthSummary(health: Health): string {
  const summaries: Record<Health["state"], string> = {
    blocked: "Sync is blocked",
    failed: `${plural(health.failed.length, "revision")} failed to sync`,
    offline: "Can't reach the cloud. Writes are queued here.",
    off: "Cloud sync is off on this writer",
    uploading: `${plural(health.pending.length, "revision")} uploading`,
    synced: "Everything is synced",
  };
  return summaries[health.state];
}
export function revisionHref(item: { collection_public_id: string | null; public_id: string }) {
  return item.collection_public_id
    ? shellPath(item.collection_public_id, item.public_id, "", true)
    : "/status";
}
export function HealthPopover(props: { health: Health; now: number; host: string }) {
  const { health, now } = props;
  const dot =
    health.state === "failed" || health.state === "blocked"
      ? "failed"
      : health.state === "uploading" || health.state === "offline"
        ? "pending"
        : health.state === "off"
          ? "off"
          : "";
  return (
    <div id="health-pop" class="pop2" popover="auto" role="dialog" aria-label="Writer status">
      <div class="big">
        <span class={`d ${dot}`} aria-hidden="true" />
        {healthSummary(health)}
      </div>
      <dl class="kv">
        {health.blockedReason ? (
          <>
            <dt>Reason</dt>
            <dd class="mono">{health.blockedReason}</dd>
          </>
        ) : null}
        {health.failed.length ? (
          <>
            <dt>Failed</dt>
            <dd>
              {health.failed.slice(0, 3).map((item, index) => (
                <>
                  {index ? ", " : ""}
                  <a href={revisionHref(item)}>
                    {item.collection_title ?? "Untitled"} #{item.display_number ?? "?"}
                  </a>
                </>
              ))}
              {health.failed.length > 3 ? ` +${health.failed.length - 3} more` : ""}
            </dd>
          </>
        ) : null}
        {health.pending.length ? (
          <>
            <dt>Uploading</dt>
            <dd>
              {plural(health.pending.length, "revision")}
              {health.oldestPendingAt !== null ? (
                <>
                  {" · oldest "}
                  <Time at={health.oldestPendingAt} fmt="ago" now={now} />
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Last cloud sync</dt>
        <dd>
          {!health.syncEnabled ? (
            "off"
          ) : health.cloudLastOkAt === null ? (
            "not yet"
          ) : (
            <Time at={health.cloudLastOkAt} fmt="ago" now={now} />
          )}
        </dd>
        {health.cloudError ? (
          <>
            <dt>Last error</dt>
            <dd class="mono">{health.cloudError}</dd>
          </>
        ) : null}
        <dt>Writer</dt>
        <dd class="mono">
          {props.host} · {health.environment}
        </dd>
      </dl>
      <div class="acts">
        <a class="btn sm" href="/status">
          Open Status
        </a>
        {health.failed.length ? (
          <button
            type="button"
            class="btn sm"
            data-action="retry"
            data-ids={health.failed.map((item) => item.id).join(",")}
          >
            Retry failed
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function isEmbeddable(mime: string): boolean {
  return isTextMime(mime) || mime.startsWith("image/") || mime === "application/pdf";
}
export type Glyph = "+" | "~" | "·";
export const glyphClass = (glyph: Glyph): string =>
  glyph === "+" ? "k a" : glyph === "~" ? "k m" : "k";
const glyphLabel = (glyph: Glyph): string =>
  glyph === "+" ? "added" : glyph === "~" ? "modified" : "unchanged";

export interface TreeOptions {
  files: readonly ManifestFileEntry[];
  head: string;
  pub: string;
  rpub: string;
  pinned: boolean;
  current: string | null;
  glyphs: ReadonlyMap<string, Glyph> | null;
  galleryHref?: ((dir: string) => string) | undefined;
}
const IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)$/;
/** File tree (spec §4.9). Folders are <details>; large manifests start collapsed. */
export function FileTree(props: TreeOptions) {
  type Node = { folders: Map<string, Node>; files: ManifestFileEntry[] };
  const root: Node = { folders: new Map(), files: [] };
  for (const file of props.files) {
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
  const large = props.files.length > 200;
  const current = props.current ?? "";
  const render = (node: Node, prefix: string): Child => {
    const images = node.files.filter((file) => IMAGE.test(file.mime)).length;
    return (
      <>
        {props.galleryHref && prefix && images >= 4 ? (
          <a class="gal" href={props.galleryHref(prefix)}>
            <span class="k" aria-hidden="true">
              ▦
            </span>
            <span class="nm">View as gallery ({images})</span>
          </a>
        ) : null}
        {[...node.folders]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([name, child]) => {
            const path = `${prefix}${name}/`;
            return (
              <details open={!large || current.startsWith(path)} data-dir={path}>
                <summary>{name}</summary>
                <div>{render(child, path)}</div>
              </details>
            );
          })}
        {node.files.map((file) => {
          const glyph = props.glyphs?.get(file.path) ?? "·";
          return (
            <a
              data-file={file.path}
              aria-current={file.path === current ? "page" : undefined}
              data-embed={isEmbeddable(file.mime) ? undefined : "false"}
              href={shellPath(props.pub, props.rpub, file.path, props.pinned, props.head)}
            >
              <span
                class={glyphClass(glyph)}
                aria-label={props.glyphs ? glyphLabel(glyph) : undefined}
              >
                {props.glyphs ? glyph : "·"}
              </span>
              <span class="nm">{file.path.slice(prefix.length)}</span>
              {file.path === props.head ? <span class="hd">head</span> : null}
            </a>
          );
        })}
      </>
    );
  };
  return (
    <>
      {large ? (
        <input
          class="filter"
          type="search"
          placeholder={`Filter ${props.files.length} files`}
          aria-label="Filter files"
          data-filter
        />
      ) : null}
      <div class="tree" aria-label="Files">
        {render(root, "")}
      </div>
    </>
  );
}

export interface TimelineRow {
  id: string;
  public_id: string;
  parent_revision_id: string | null;
  display_number: number;
  message: string | null;
  created_at: number;
  sync_state: "pending" | "committed" | "synced" | "failed";
  host: string | null;
  changes: RevisionChanges | undefined;
  last_error?: string | null | undefined;
  progress?: string | undefined;
}
/** Timeline (spec §4.10): newest first, divs not nested links, "on #K" as the fork signal. */
export function Timeline(props: {
  rows: readonly TimelineRow[];
  pub: string;
  currentId: string | null;
  latestId: string | null;
  now: number;
  path: string;
  compact?: boolean;
  changesHref?: ((row: TimelineRow, base: TimelineRow) => string) | undefined;
  byId: ReadonlyMap<string, TimelineRow>;
}) {
  return (
    <div class="tl">
      {props.rows.map((row, index) => {
        const below = props.rows[index + 1];
        const parent = row.parent_revision_id ? props.byId.get(row.parent_revision_id) : undefined;
        const fork = parent && below && parent.id !== below.id;
        const current = row.id === props.currentId;
        const href = `${shellPath(props.pub, row.public_id, props.path, true)}${props.path ? "?fallback=head" : ""}`;
        const state = row.sync_state;
        return (
          <div
            class={`rv${state === "pending" ? " pending" : state === "failed" ? " failed" : ""}${row.parent_revision_id ? "" : " root"}`}
            aria-current={current ? "true" : undefined}
            data-rev={row.public_id}
          >
            <span class="g" aria-hidden="true">
              <i />
            </span>
            <span>
              <span class="h">
                <a href={href} aria-label={`Revision ${row.display_number}`}>
                  <b>#{row.display_number}</b>
                </a>
                {state === "failed" ? (
                  <span class="chip xs failed">failed</span>
                ) : state === "pending" ? (
                  <span class="chip xs pending">
                    uploading{row.progress ? ` ${row.progress}` : ""}
                  </span>
                ) : current ? (
                  <span class="chip xs ink">
                    {row.id === props.latestId ? "latest" : "viewing"}
                  </span>
                ) : row.id === props.latestId ? (
                  <span class="chip xs">latest</span>
                ) : null}
                <span class="w">
                  <Time at={row.created_at} now={props.now} />
                </span>
              </span>
              <a class="msg" href={href}>
                {row.message ?? "No message"}
              </a>
              <span class="f">
                {row.host ? <span class="host">{row.host}</span> : null}
                {fork && parent ? <span class="fork">on #{parent.display_number}</span> : null}
                <Chg changes={row.changes} />
              </span>
              {!props.compact && state === "failed" && row.last_error ? (
                <span class="err">{row.last_error}</span>
              ) : null}
              {props.compact ? (
                current && parent && props.changesHref ? (
                  <span class="acts">
                    <a class="btn sm" href={props.changesHref(row, parent)}>
                      Changes
                    </a>
                  </span>
                ) : null
              ) : state === "failed" ? (
                <span class="acts">
                  <button type="button" class="btn sm" data-action="retry" data-ids={row.id}>
                    Retry
                  </button>
                  <button type="button" class="btn sm ghost" data-action="drop" data-id={row.id}>
                    Drop…
                  </button>
                  <a class="btn sm ghost" href={`/status#${row.id}`}>
                    Details
                  </a>
                </span>
              ) : state === "pending" ? (
                <span class="acts">
                  <button type="button" class="btn sm ghost" data-action="drop" data-id={row.id}>
                    Drop…
                  </button>
                </span>
              ) : current && parent && props.changesHref ? (
                <span class="acts">
                  <a class="btn sm" href={props.changesHref(row, parent)}>
                    Changes from #{parent.display_number}
                  </a>
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function EmptyState(props: { title: string; children: Child }) {
  return (
    <div class="empty">
      <b>{props.title}</b>
      {props.children}
    </div>
  );
}
