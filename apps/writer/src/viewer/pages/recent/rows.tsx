/** @jsxImportSource hono/jsx */
import type { CollectionSearchResult, RevisionChanges } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";

import type { Health } from "../../../health.ts";
import { Chg, Time } from "../../components.tsx";
import { placeText, plural, projectAndTags } from "../../format.ts";
import { dayHeading, dayLabel, trashDayLabel, type DayHeading } from "../../timefmt.ts";
import { RowSyncChips } from "./attention.tsx";

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

export type RowVariant = "recent" | "search" | "trash";
export interface ListRowProps {
  variant: "recent" | "search";
  item: CollectionSearchResult;
  now: number;
  /** Search: highlights the title and adds the match notes. */
  query?: string | undefined;
  /** Recent: the latest revision's public ID, for the "N new since you read" link (OW-08). */
  latestPub?: string | undefined;
  /** The writer's sync health, for the row's sync chips (OW-06b). */
  health?: Health | undefined;
}
export interface TrashRowProps {
  variant: "trash";
  /** The collection's public ID. */
  pub: string;
  /** Plain or highlighted title. */
  title: Child;
  /** data-at: deleted_at on /trash, updated_at in search. */
  at: number;
  /** The collection ID, as data-flash-target (FD3); /trash passes it, in:trash doesn't. */
  flashTarget?: string | undefined;
  now: number;
  /** Search shows the time and #n; /trash doesn't. */
  showWhen?: boolean | undefined;
  n?: number | null | undefined;
  msg: Child;
  meta?: Child | undefined;
  /** Buttons already carrying aria-describedby={rowTitleId(pub)}. */
  actions?: Child | undefined;
}

/** The id of a row's title link, which describes the row's action buttons. */
export function rowTitleId(pub: string): string {
  return `it-${pub}`;
}

/** The row's only link: its title, named by its visible text, stretched over the row in CSS. */
function TitleLink(props: { pub: string; title: Child }): JSX.Element {
  return (
    <span class="t">
      <a class="tlink" id={rowTitleId(props.pub)} href={`/c/${props.pub}/`}>
        <span class="tt">{props.title}</span>
      </a>
    </span>
  );
}

/** Who wrote the latest revision and what it touched, as one phrase: "devbox, +1 file". The
 *  change glyphs carry their own hidden words, so the unit is for the eye only. */
export function Who(props: {
  host: string | null | undefined;
  changes: RevisionChanges | null | undefined;
}): JSX.Element | null {
  const { host, changes } = props;
  const files = changes ? changes.added + changes.modified + changes.removed : 0;
  if (!host && !files) return null;
  return (
    <span class="who">
      {host ? <span class="host">{host}</span> : null}
      {host && files ? ", " : null}
      {files ? (
        <>
          <Chg changes={changes} />
          <span aria-hidden="true">{files === 1 ? " file" : " files"}</span>
        </>
      ) : null}
    </span>
  );
}

/** Where a collection lives: "in infra, tagged runbook". */
export function Place(props: { metadata: Record<string, unknown> }): JSX.Element | null {
  const { project, tags } = projectAndTags(props.metadata);
  const text = placeText(project, tags);
  return text ? <span class="place">{text}</span> : null;
}

/** One row for Recent, search and Trash (A11Y-04): an <li> whose only link is its title; anything
 *  else interactive sits in .meta or .acts, raised above the stretched link. */
export function RecentRow(props: ListRowProps | TrashRowProps): JSX.Element {
  if (props.variant === "trash")
    return (
      <li
        class="item trash"
        data-pub={props.pub}
        data-at={String(props.at)}
        data-flash-target={props.flashTarget}
      >
        <TitleLink pub={props.pub} title={props.title} />
        {props.showWhen ? (
          <span class="when">
            <Time at={props.at} fmt="time" now={props.now} />
          </span>
        ) : null}
        <p class="msg">{props.msg}</p>
        {props.showWhen && props.n != null ? <span class="rn">#{props.n}</span> : null}
        {props.meta === undefined ? null : <p class="meta">{props.meta}</p>}
        {props.actions === undefined ? null : <span class="acts">{props.actions}</span>}
      </li>
    );
  const { item, now } = props;
  const latest = item.latest_revision;
  const query = props.query ?? "";
  const metaHit = query && item.match === "metadata" ? metadataMatch(item.metadata, query) : null;
  return (
    <li
      class="item"
      data-pub={item.public_id}
      data-n={latest ? String(latest.display_number) : undefined}
      data-at={String(item.updated_at)}
      data-latest-id={latest && props.latestPub ? latest.id : undefined}
      data-latest-pub={latest && props.latestPub ? props.latestPub : undefined}
    >
      <TitleLink pub={item.public_id} title={highlight(item.title, query)} />
      <span class="when">
        <Time at={item.updated_at} fmt="time" now={now} />
      </span>
      <p class="msg">{latest?.message ?? (latest ? "No message" : "No revision yet")}</p>
      <span class="rn">{latest ? `#${latest.display_number}` : ""}</span>
      {/* States first, then who wrote it, then where it lives. */}
      <p class="meta">
        <RowSyncChips collectionId={item.id} health={props.health} />
        {item.share?.active ? (
          <span class="chip xs public">
            {raw(icon("globe", "sm"))}
            {item.share.follows_latest
              ? "Public, follows latest"
              : `Public, ${plural(item.share.active, "link")}`}
          </span>
        ) : null}
        <Who host={latest?.source_host} changes={latest?.changes} />
        <Place metadata={item.metadata} />
        {item.match === "id" ? <span class="faint">ID match</span> : null}
        {item.match === "title" && query ? <span class="faint">title match</span> : null}
        {metaHit ? (
          <span class="faint">
            metadata match: {metaHit[0]} = “{highlight(metaHit[1], query)}”
          </span>
        ) : null}
        {props.variant === "recent" ? (
          // client/lastread.ts fills it in and gives it an href when the collection is unread.
          <a class="rv-link" id={`new-${item.public_id}`} data-new hidden />
        ) : null}
      </p>
    </li>
  );
}

/** A day group's heading row: the label, the date beside it where the label doesn't say it, and
 *  the count at the end. The count is for the eye: a screen reader already counts the list's
 *  items. client/day-groups.ts builds the same markup. */
export function DayHeadingRow(props: { id: string; heading: DayHeading }): JSX.Element {
  const { label, date, count } = props.heading;
  return (
    <h2 class="day" id={props.id}>
      <span class="dlab">{label}</span>
      {date ? (
        <>
          {" "}
          <span class="ddate">{date}</span>
        </>
      ) : null}
      <span class="dcount" aria-hidden="true">
        {count}
      </span>
    </h2>
  );
}

/** One section per consecutive run of equal day labels (UTC on the server; client/day-groups.ts
 *  relabels them for the browser's zone). Rows keep their input order. */
export function DayGroups<T>(props: {
  kind: "recent" | "search" | "trash";
  items: readonly T[];
  at: (item: T) => number;
  now: number;
  render: (item: T) => Child;
}): JSX.Element {
  const label = props.kind === "trash" ? trashDayLabel : dayLabel;
  const groups: { label: string; items: T[] }[] = [];
  for (const item of props.items) {
    const text = label(props.at(item), props.now, true);
    const last = groups.at(-1);
    if (last?.label === text) last.items.push(item);
    else groups.push({ label: text, items: [item] });
  }
  return (
    <div class="groups" data-groups={props.kind}>
      {groups.map((group, index) => {
        const id = `${props.kind}-day-${index}`;
        const first = group.items[0];
        const at = first === undefined ? props.now : props.at(first);
        return (
          <section aria-labelledby={id}>
            <DayHeadingRow
              id={id}
              heading={dayHeading(props.kind, at, props.now, true, group.items.length)}
            />
            <ul class="list">{group.items.map((item) => props.render(item))}</ul>
          </section>
        );
      })}
    </div>
  );
}
