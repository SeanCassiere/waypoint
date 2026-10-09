/** @jsxImportSource hono/jsx */
import type { CollectionSearchResult } from "@waypoint/core";
import type { JSX } from "hono/jsx/jsx-runtime";

import type { HttpServices } from "../../../http.ts";
import { plural } from "../../format.ts";
import type { Chrome } from "../../layout.tsx";
import { NeedsAttention } from "./attention.tsx";
import { DayGroups, RecentRow } from "./rows.tsx";

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
  /** Collection ID → its latest revision's public ID. */
  latestPubs: ReadonlyMap<string, string>;
}) {
  const { chrome, items } = props;
  const now = chrome.now;
  return (
    <div class="home">
      <main id="main" aria-labelledby="recent-title" data-recent>
        <h1 class="page" id="recent-title">
          Recent
        </h1>
        <p class="lede" data-lede>
          Newest first, by latest revision.
        </p>
        <NeedsAttention health={chrome.health} now={now} />
        <BrowseRow projects={props.projects} publicNow={props.publicNow} />
        <DayGroups
          kind="recent"
          items={items}
          at={(item) => item.updated_at}
          now={now}
          render={(item) => (
            <RecentRow
              variant="recent"
              item={item}
              now={now}
              latestPub={props.latestPubs.get(item.id)}
            />
          )}
        />
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
      <BrowseAside projects={props.projects} publicNow={props.publicNow} />
    </div>
  );
}

/** The sidebar's Projects list shows this many; the rest sit behind "Show all N". */
const PROJECTS_SHOWN = 12;
/** `/?q=project:<value>`, quoting a value with whitespace (`project:"api team"`) so FC3's
 *  parser reads the whole name rather than its first word plus free text. */
function projectHref(value: string): string {
  const token = /\s/.test(value) ? `project:"${value}"` : `project:${value}`;
  return `/?${new URLSearchParams({ q: token }).toString()}`;
}
function ProjectFacet(props: { facet: Facet }): JSX.Element {
  return (
    <li>
      <a class="facet" href={projectHref(props.facet.value)}>
        {props.facet.value}
        <span>{props.facet.count}</span>
      </a>
    </li>
  );
}

/** Recent's sidebar, also on search results (NAV-03): Projects (12, then "Show all N", which
 *  works without JS) and Public now. Hidden on phones, where BrowseRow takes its place. */
export function BrowseAside(props: {
  projects: Facet[];
  publicNow: PublicNow[] | null;
}): JSX.Element {
  const rest = props.projects.slice(PROJECTS_SHOWN);
  return (
    <aside class="side hide-sm" aria-label="Browse">
      {props.projects.length ? (
        <>
          <h2>Projects</h2>
          <ul class="list facets">
            {props.projects.slice(0, PROJECTS_SHOWN).map((facet) => (
              <ProjectFacet facet={facet} />
            ))}
            {rest.length ? (
              <li>
                <details class="more">
                  <summary>Show all {props.projects.length}</summary>
                  <ul class="list facets">
                    {rest.map((facet) => (
                      <ProjectFacet facet={facet} />
                    ))}
                  </ul>
                </details>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
      {props.publicNow ? (
        <>
          <h2>Public now</h2>
          <ul class="list facets">
            {props.publicNow.map((item) => (
              <li>
                <a class="facet" href={`/c/${item.public_id}/?panel=links`}>
                  {item.title}
                  <span>{plural(item.links, "link")}</span>
                </a>
              </li>
            ))}
            <li>
              <a class="facet all" href="/links">
                {props.publicNow.length ? "All public links →" : "No public links. Manage links →"}
              </a>
            </li>
          </ul>
        </>
      ) : null}
    </aside>
  );
}

/**
 * The sidebar on phones (NAV-03, A11Y-02): one horizontally scrolling row of 44 px chips, Public
 * now first, then every project. Rendered where it reads (after Needs attention on Recent, after
 * the hint on search), so DOM, focus and visual order agree; hidden above 760 px.
 */
export function BrowseRow(props: {
  projects: Facet[];
  publicNow: PublicNow[] | null;
}): JSX.Element | null {
  // Public now's list length (at most 8, loadPublicNow's cap): collections, not links.
  const publicNow = props.publicNow?.length ?? 0;
  if (!publicNow && !props.projects.length) return null;
  return (
    <nav class="browse" aria-labelledby="browse-h">
      <h2 id="browse-h">Browse</h2>
      <ul class="list">
        {publicNow ? (
          <li>
            <a class="bchip pub" href="/links">
              Public now <span>{publicNow}</span>
            </a>
          </li>
        ) : null}
        {props.projects.map((facet) => (
          <li>
            <a class="bchip" href={projectHref(facet.value)}>
              {facet.value} <span>{facet.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
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

/** "Public now": collections with live links, most links first (four queries). */
export async function loadPublicNow(s: HttpServices): Promise<PublicNow[]> {
  const summary = await s.reads.shareSummary();
  const collections = await s.reads.collectionsById([...summary.keys()]);
  // The summary also carries paused-only collections; live links already exclude Trash.
  return [...summary]
    .flatMap(([id, share]) => {
      const collection = collections.get(id);
      return collection && share.active > 0
        ? [{ public_id: collection.public_id, title: collection.title, links: share.active }]
        : [];
    })
    .toSorted((a, b) => b.links - a.links || a.title.localeCompare(b.title))
    .slice(0, 8);
}
