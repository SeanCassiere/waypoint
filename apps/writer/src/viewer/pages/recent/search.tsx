/** @jsxImportSource hono/jsx */
import { WaypointError, type CollectionSearchResult } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { JSX } from "hono/jsx/jsx-runtime";

import type { HttpServices } from "../../../http.ts";
import {
  CANONICAL_TOKENS,
  withoutToken,
  type ParsedSearch,
  type SearchToken,
} from "../../../search-query.ts";
import { shellPath } from "../../../viewer-paths.ts";
import { Chg } from "../../components.tsx";
import { plural, projectAndTags } from "../../format.ts";
import type { Chrome } from "../../layout.tsx";
import { BrowseAside, BrowseRow, type Facet, type PublicNow } from "./home.tsx";
import { DayGroups, highlight, RecentRow } from "./rows.tsx";

/** One active filter: its visible text (an optional muted lead word) and the query without it. */
interface FilterChip {
  lead?: string;
  text: string;
  /** Classes beside fchip: "pub" for Public, "trash" for In Trash. */
  tone?: "pub" | "trash";
  rest: string;
}

/** A token's chip in canonical words; aliases (is:shared, is:pending) never show. */
function tokenChip(q: string, token: SearchToken): FilterChip {
  const rest = withoutToken(q, token);
  if (token.key === "project") return { lead: "Project", text: token.value, rest };
  if (token.key === "tag") return { lead: "Tag", text: token.value, rest };
  if (token.key === "host") return { lead: "Host", text: token.value, rest };
  const label = CANONICAL_TOKENS.find(({ text }) => text === token.text)?.label ?? token.text;
  return {
    lead: "Only",
    text: label,
    ...(token.text === "is:public" ? { tone: "pub" as const } : {}),
    ...(token.text === "in:trash" ? { tone: "trash" as const } : {}),
    rest,
  };
}

/** The free-text chip first (removing it keeps every filter, as typed), then one chip per token,
 *  in typed order, each removed with withoutToken so the rest keep their typed spelling. */
function filterChips(q: string, parsed: ParsedSearch): FilterChip[] {
  return [
    ...(parsed.text
      ? [{ text: `“${parsed.text}”`, rest: parsed.list.map((token) => token.raw).join(" ") }]
      : []),
    ...parsed.list.map((token) => tokenChip(q, token)),
  ];
}

/** `/?q=<rest>`, or Recent when nothing is left. */
function searchHref(rest: string): string {
  return rest.trim() ? `/?${new URLSearchParams({ q: rest.trim() }).toString()}` : "/";
}

/** "2 collections", "50+ collections", "1 collection in Trash", "No collections match". */
function resultsTitle(count: number, more: boolean, trash: boolean): string {
  if (!count) return "No collections match";
  const noun = count === 1 && !more ? "collection" : "collections";
  return `${more ? `${count}+` : count} ${noun}${trash ? " in Trash" : ""}`;
}

/**
 * Search results for a non-empty `q` (NAV-03; the empty /?q= is SearchStart): the count as H1,
 * one removable chip per active filter, Clear all and one hint line, then the rows and Recent's
 * sidebar. Phones get the query field in the page (the bar's is hidden there) and the Browse row.
 */
export function SearchBody(props: {
  chrome: Chrome;
  q: string;
  parsed: ParsedSearch;
  items: CollectionSearchResult[];
  nextCursor: string | null;
  freeText: string;
  trash?: boolean | undefined;
  projects: Facet[];
  publicNow: PublicNow[] | null;
}): JSX.Element {
  const { items, q, chrome } = props;
  const now = chrome.now;
  return (
    <div class="home">
      <main id="main" aria-labelledby="results-title">
        {/* A [data-search] form like the bar's, with its own ids; shown only below 761 px, so
            "/" focuses the bar's field on wider screens and this one on phones. */}
        <form class="qfield" role="search" action="/" method="get" data-search data-search-inline>
          {raw(icon("search"))}
          <input
            type="search"
            name="q"
            value={q}
            aria-label="Search, or paste a URL or ID"
            role="combobox"
            aria-controls="suggest-inline"
            aria-expanded="false"
            aria-autocomplete="list"
            enterkeyhint="search"
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
          />
          <div class="suggest" id="suggest-inline" role="listbox" aria-label="Suggestions" hidden />
          <span class="sr" role="status" data-search-status />
        </form>
        <h1 class="page" id="results-title">
          {resultsTitle(items.length, Boolean(props.nextCursor), Boolean(props.trash))}
        </h1>
        <div class="fbar">
          <ul class="list fchips" aria-label="Active filters">
            {filterChips(q, props.parsed).map((chip) => {
              const name = chip.lead ? `${chip.lead} ${chip.text}` : chip.text;
              return (
                <li class={chip.tone ? `fchip ${chip.tone}` : "fchip"}>
                  <span title={name}>
                    {chip.lead ? (
                      <>
                        <span class="k">{chip.lead}</span>{" "}
                      </>
                    ) : null}
                    {chip.text}
                  </span>
                  <a href={searchHref(chip.rest)} aria-label={`Remove ${name}`}>
                    {raw(icon("close", "sm"))}
                  </a>
                </li>
              );
            })}
          </ul>
          <a class="clear" href="/">
            Clear all
          </a>
        </div>
        <p class="hint">
          Add a filter by typing <span class="mono">is:</span>, <span class="mono">project:</span>{" "}
          or <span class="mono">in:trash</span>.
        </p>
        <BrowseRow projects={props.projects} publicNow={props.publicNow} />
        {items.length ? (
          <DayGroups
            kind="search"
            items={items}
            at={(item) => item.updated_at}
            now={now}
            render={(item) =>
              props.trash ? (
                <TrashResult item={item} now={now} freeText={props.freeText} />
              ) : (
                <RecentRow
                  variant="search"
                  item={item}
                  now={now}
                  query={props.freeText}
                  health={chrome.health}
                />
              )
            }
          />
        ) : null}
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
      <BrowseAside projects={props.projects} publicNow={props.publicNow} />
    </div>
  );
}

/** An in:trash result on A11Y-04's Trash variant: its title opens the in-Trash collection page;
 *  its links show as paused (amber), never as Public; no actions here. */
function TrashResult(props: {
  item: CollectionSearchResult;
  now: number;
  freeText: string;
}): JSX.Element {
  const { item } = props;
  const latest = item.latest_revision;
  const { project, tags } = projectAndTags(item.metadata);
  const labels = [project, ...tags].filter((value): value is string => Boolean(value));
  const paused = item.share?.paused ?? 0;
  return (
    <RecentRow
      variant="trash"
      pub={item.public_id}
      title={highlight(item.title, props.freeText)}
      at={item.updated_at}
      now={props.now}
      showWhen
      n={latest?.display_number ?? null}
      msg="In Trash. Open it in Trash to restore or purge."
      meta={
        <>
          {latest?.source_host ? <span class="host">{latest.source_host}</span> : null}
          <Chg changes={latest?.changes} />
          {labels.length ? <span>{labels.join(" · ")}</span> : null}
          {paused > 0 ? (
            <span class="chip xs paused">In Trash · {plural(paused, "link")} paused</span>
          ) : null}
        </>
      }
    />
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
