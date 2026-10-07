/** @jsxImportSource hono/jsx */
import type { Context } from "hono";

import type { HttpServices } from "../../http.js";
import { badge } from "../components.js";
import { ago } from "../format.js";
import { Layout } from "../layout.js";
import { noStore } from "../respond.js";

export async function recentPage(s: HttpServices, c: Context): Promise<Response> {
  const q = c.req.query("q") ?? "";
  const { collections: items, next_cursor: nextCursor } = await s.reads.searchCollections({
    query: q,
    limit: 100,
    cursor: c.req.query("cursor"),
  });
  return noStore(
    c.html(
      <Layout title="Collections">
        <main class="wrap">
          <h1>Collections</h1>
          <div class="bar">
            <form method="get">
              <input
                type="search"
                name="q"
                aria-label="Search collections"
                value={q}
                placeholder="Search titles, tags, IDs or URLs"
              />
              <button type="submit">Search</button>
            </form>
            <a href="/trash">Show deleted</a>
          </div>
          <div class="list">
            {items.length ? (
              items.map((item) => (
                <div class="row">
                  <a class="row-title" href={`/c/${item.public_id}/`}>
                    {item.title}
                  </a>
                  <span class="meta">
                    {item.latest_revision
                      ? `#${item.latest_revision.display_number}`
                      : "No revision"}
                  </span>
                  <span class="meta">
                    <time
                      datetime={new Date(
                        item.latest_revision?.created_at ?? item.created_at,
                      ).toISOString()}
                    >
                      {ago(item.latest_revision?.created_at ?? item.created_at)}
                    </time>
                  </span>
                  {item.latest_revision && badge(item.latest_revision.sync_state)}
                  <span class="meta">
                    {item.latest_revision?.file_count ?? 0}{" "}
                    {(item.latest_revision?.file_count ?? 0) === 1 ? "file" : "files"}
                  </span>
                  {(item.metadata.tags !== undefined || item.metadata.project !== undefined) && (
                    <span class="meta">
                      {[item.metadata.project, item.metadata.tags]
                        .flat()
                        .filter((value) => typeof value === "string")
                        .join(" · ")}
                    </span>
                  )}
                </div>
              ))
            ) : (
              <div class="row muted">No collections found.</div>
            )}
          </div>
          {nextCursor && (
            <a href={`/?${new URLSearchParams({ q, cursor: nextCursor }).toString()}`}>More</a>
          )}
        </main>
      </Layout>,
    ),
  );
}
