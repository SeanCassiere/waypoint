/** @jsxImportSource hono/jsx */
import type { Context } from "hono";

import type { HttpServices } from "../../../http.ts";
import { parseSearch } from "../../../search-query.ts";
import { linksEnabled } from "../../../shares.ts";
import { getChrome } from "../../chrome.ts";
import { HomeBar, Layout } from "../../layout.tsx";
import { noStore } from "../../respond.ts";
import { RecentBody, EmptyHome, loadPublicNow } from "./home.tsx";
import { SearchBody, exactTarget } from "./search.tsx";

export async function recentPage(s: HttpServices, c: Context): Promise<Response> {
  const q = (c.req.query("q") ?? "").trim();
  const cursor = c.req.query("cursor");
  const now = Date.now();
  if (q && !cursor) {
    const target = await exactTarget(s, q);
    if (target) return noStore(c.redirect(target, 302));
  }
  const parsed = parseSearch(q);
  const [search, chrome, publicNow] = await Promise.all([
    s.reads.searchCollections({
      query: parsed.text,
      limit: 50,
      cursor,
      ...(parsed.project ? { metadata: { project: parsed.project } } : {}),
      ...(parsed.tags.length ? { tags: parsed.tags } : {}),
      ...(parsed.host ? { host: parsed.host } : {}),
      shared: parsed.shared,
      unsynced: parsed.unsynced,
      pending: parsed.pending,
      only_deleted: parsed.trash,
      projects: !q,
    }),
    getChrome(s, now),
    q || !linksEnabled(s) ? Promise.resolve(null) : loadPublicNow(s),
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
            projects={(search.projects ?? []).slice(0, 12)}
            publicNow={publicNow}
          />
        ) : (
          <EmptyHome />
        )}
      </Layout>,
    ),
  );
}

export { highlight, CollectionRow } from "./rows.tsx";
export { NeedsAttention } from "./attention.tsx";
export { type Facet, type PublicNow, RecentBody, EmptyHome } from "./home.tsx";
export { SearchBody, exactTarget } from "./search.tsx";
