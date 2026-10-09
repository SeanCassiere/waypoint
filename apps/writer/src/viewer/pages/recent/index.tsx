/** @jsxImportSource hono/jsx */
import { parseId, publicIdFor } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";

import type { HttpServices } from "../../../http.ts";
import { parseSearch } from "../../../search-query.ts";
import { linksEnabled } from "../../../shares.ts";
import { getChrome } from "../../chrome.ts";
import { HomeBar, Layout } from "../../layout.tsx";
import { noStore } from "../../respond.ts";
import { RecentBody, EmptyHome, loadPublicNow } from "./home.tsx";
import { SearchBody, exactTarget } from "./search.tsx";

/**
 * The empty `/?q=` (NAV-02): a real search page, not Recent. Phones get an in-page field (the
 * bar's is hidden below 761 px); the client focuses the first visible field on load.
 */
function SearchStart() {
  return (
    <main class="wrap narrow searchstart" id="main">
      <h1 class="page">Search</h1>
      <p class="lede">
        Find a collection by its title or metadata, or paste a Waypoint URL or ID to jump straight
        to it.
      </p>
      <form class="search-page show-sm" role="search" action="/" method="get" data-search>
        {raw(icon("search"))}
        <input
          type="search"
          name="q"
          placeholder="Search, or paste a URL or ID"
          aria-label="Search, or paste a URL or ID"
          autocomplete="off"
          autocapitalize="none"
          enterkeyhint="search"
          spellcheck={false}
          autofocus
          role="combobox"
          aria-expanded="false"
          aria-controls="suggest-page"
          aria-autocomplete="list"
        />
        <div class="suggest" id="suggest-page" role="listbox" aria-label="Suggestions" hidden />
        <span class="sr" role="status" data-search-status />
      </form>
    </main>
  );
}

export async function recentPage(s: HttpServices, c: Context): Promise<Response> {
  const given = c.req.query("q");
  const q = (given ?? "").trim();
  const cursor = c.req.query("cursor");
  const now = Date.now();
  if (given !== undefined && !q && !cursor) {
    const chrome = await getChrome(s, now);
    return noStore(
      c.html(
        <Layout
          title="Search"
          chrome={chrome}
          bar={<HomeBar chrome={chrome} current="recent" />}
          page="search"
        >
          <SearchStart />
        </Layout>,
      ),
    );
  }
  if (q && !cursor) {
    const target = await exactTarget(s, q);
    if (target) return noStore(c.redirect(target, 302));
  }
  const parsed = parseSearch(q);
  const [search, chrome, publicNow, browse] = await Promise.all([
    s.reads.searchCollections({
      query: parsed.text,
      limit: 50,
      cursor,
      ...(parsed.project ? { metadata: { project: parsed.project } } : {}),
      ...(parsed.tags.length ? { tags: parsed.tags } : {}),
      ...(parsed.host ? { host: parsed.host } : {}),
      shared: parsed.public,
      failed: parsed.failed,
      pending: parsed.uploading,
      unsynced: parsed.unsynced,
      only_deleted: parsed.trash,
      projects: !q,
    }),
    getChrome(s, now),
    linksEnabled(s) ? loadPublicNow(s) : Promise.resolve(null),
    // Search pages show Recent's sidebar: its projects from the same uncached read Recent's use.
    q ? s.reads.searchCollections({ limit: 1, projects: true }) : Promise.resolve(null),
  ]);
  const items = search.collections;
  if (q)
    return noStore(
      c.html(
        <Layout
          title={`Search: ${q}`}
          chrome={chrome}
          bar={<HomeBar chrome={chrome} current="recent" q={q} />}
          page="search"
        >
          <SearchBody
            chrome={chrome}
            q={q}
            parsed={parsed}
            items={items}
            nextCursor={search.next_cursor}
            freeText={parsed.text}
            trash={parsed.trash}
            projects={browse?.projects ?? []}
            publicNow={publicNow}
          />
        </Layout>,
      ),
    );
  // Revision public IDs are derived, not stored on the search result: the unread link needs the
  // latest one's (OW-08).
  const latestPubs = new Map(
    await Promise.all(
      items.flatMap(({ id, latest_revision: latest }) =>
        latest ? [publicIdFor(parseId(latest.id, "rev")).then((pub) => [id, pub] as const)] : [],
      ),
    ),
  );
  return noStore(
    c.html(
      <Layout
        title="Recent"
        chrome={chrome}
        bar={<HomeBar chrome={chrome} current="recent" />}
        page="recent"
      >
        {items.length || cursor ? (
          <RecentBody
            chrome={chrome}
            items={items}
            nextCursor={search.next_cursor}
            projects={search.projects ?? []}
            publicNow={publicNow}
            latestPubs={latestPubs}
          />
        ) : (
          <EmptyHome />
        )}
      </Layout>,
    ),
  );
}

export { highlight, RecentRow } from "./rows.tsx";
export { NeedsAttention } from "./attention.tsx";
export { type Facet, type PublicNow, RecentBody, EmptyHome } from "./home.tsx";
export { SearchBody, exactTarget } from "./search.tsx";
