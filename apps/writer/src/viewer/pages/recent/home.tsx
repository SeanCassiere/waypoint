/** @jsxImportSource hono/jsx */
import type { CollectionSearchResult } from "@waypoint/core";

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
      <aside class="side hide-sm" aria-label="Browse">
        {props.projects.length ? (
          <>
            <h2>Projects</h2>
            <ul class="list facets">
              {props.projects.map((facet) => (
                <li>
                  <a
                    class="facet"
                    href={`/?${new URLSearchParams({ q: `project:${facet.value}` }).toString()}`}
                  >
                    {facet.value}
                    <span>{facet.count}</span>
                  </a>
                </li>
              ))}
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
                  {props.publicNow.length
                    ? "All public links →"
                    : "No public links. Manage links →"}
                </a>
              </li>
            </ul>
          </>
        ) : null}
      </aside>
    </div>
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
