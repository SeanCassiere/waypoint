/** @jsxImportSource hono/jsx */
import type { CollectionSearchResult } from "@waypoint/core";
import type { Child } from "hono/jsx";

import { Chg, Globe, Time } from "../../components.tsx";
import { plural, projectAndTags } from "../../format.ts";

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
      aria-labelledby={`it-${item.public_id}`}
      aria-describedby={`iw-${item.public_id} im-${item.public_id} ix-${item.public_id}`}
      data-updated={String(item.updated_at)}
      data-pub={item.public_id}
      data-n={latest ? String(latest.display_number) : undefined}
    >
      <span class="t">
        <span class="tt" id={`it-${item.public_id}`}>
          {highlight(item.title, query)}
        </span>
      </span>
      <span class="when" id={`iw-${item.public_id}`}>
        <Time at={item.updated_at} now={now} />
      </span>
      <span class="msg" id={`im-${item.public_id}`}>
        {latest?.message ?? (latest ? "No message" : "No revision yet")}
      </span>
      <span class="rn">{latest ? `#${latest.display_number}` : ""}</span>
      <span class="meta" id={`ix-${item.public_id}`}>
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
