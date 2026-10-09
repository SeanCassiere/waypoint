/** @jsxImportSource hono/jsx */
import { WaypointError, type CollectionSearchResult } from "@waypoint/core";

import type { HttpServices } from "../../../http.ts";
import { CANONICAL_TOKENS } from "../../../search-query.ts";
import { shellPath } from "../../../viewer-paths.ts";
import { Time } from "../../components.tsx";
import type { Chrome } from "../../layout.tsx";
import { highlight, CollectionRow } from "./rows.tsx";

export function SearchBody(props: {
  chrome: Chrome;
  q: string;
  items: CollectionSearchResult[];
  nextCursor: string | null;
  freeText: string;
  trash?: boolean;
}) {
  const { items, q, chrome } = props;
  return (
    <main class="wrap" id="main">
      <div class="ph">
        <div>
          <h1>
            {items.length || props.nextCursor ? (
              <>
                {props.nextCursor ? `${items.length}+` : items.length}{" "}
                {items.length === 1 && !props.nextCursor ? "result" : "results"} for “{q}”
              </>
            ) : (
              <>No collections match “{q}”</>
            )}
          </h1>
          <p>
            Matched in titles and metadata values. Paste a Waypoint URL or ID to jump straight to
            it.
          </p>
        </div>
      </div>
      <p class="muted small" data-token-hint>
        Narrow it down: <span class="mono">project:webhooks</span>{" "}
        <span class="mono">tag:research</span> <span class="mono">host:macbook-air</span>{" "}
        {CANONICAL_TOKENS.map(({ text: token }) => (
          <>
            <a
              class="mono"
              href={`/?${new URLSearchParams({ q: q.includes(token) ? q : `${q} ${token}`.trim() }).toString()}`}
            >
              {token}
            </a>{" "}
          </>
        ))}
      </p>
      {items.length ? (
        items.map((item) =>
          props.trash ? (
            <a class="item" href="/trash">
              <span class="t">
                <span class="tt">{highlight(item.title, props.freeText)}</span>
              </span>
              <span class="when">
                <Time at={item.updated_at} now={chrome.now} />
              </span>
              <span class="msg">In Trash. Restore it from Trash to read it again.</span>
              <span class="rn" />
            </a>
          ) : (
            <CollectionRow item={item} now={chrome.now} query={props.freeText} />
          ),
        )
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

/** An exact collection or revision ID, public ID, or Waypoint URL resolves to a page (B6). */
export async function exactTarget(s: HttpServices, q: string): Promise<string | null> {
  const value = q.trim();
  try {
    if (/^col_[0-9a-z]{26}$/i.test(value)) {
      const collection = await s.reads.collection(value.toLowerCase());
      return collection ? `/c/${collection.public_id}/` : null;
    }
    if (/^rev_[0-9a-z]{26}$/i.test(value)) {
      const revision = await s.reads.revision(value.toLowerCase());
      const collection = revision ? await s.reads.collection(revision.collection_id) : undefined;
      return revision && collection ? `/c/${collection.public_id}/r/${revision.public_id}/` : null;
    }
    if (/^[0-9a-hjkmnp-tv-z]{12}$/i.test(value)) {
      const collection = await s.reads.collectionByPublicId(value);
      if (collection) return `/c/${collection.public_id}/`;
      const resolved = await s.reads.resolve(`/raw/r/${value.toLowerCase()}/x`);
      const owner = await s.reads.collection(resolved.collection_id);
      return owner ? `/c/${owner.public_id}/r/${value.toLowerCase()}/` : null;
    }
    if (/^https?:\/\//i.test(value) || /^\/(?:c|raw)\//.test(value)) {
      const resolved = await s.reads.resolve(value);
      const collection = await s.reads.collection(resolved.collection_id);
      if (!collection) return null;
      const revision = resolved.revision_id
        ? await s.reads.revision(resolved.revision_id)
        : undefined;
      return shellPath(
        collection.public_id,
        revision?.public_id ?? "",
        resolved.path ?? "",
        Boolean(revision),
      );
    }
  } catch (error) {
    if (error instanceof WaypointError) return null;
    throw error;
  }
  return null;
}
