/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../http.ts";
import { SHARE_COLUMNS, shareViews, type ShareRow } from "../../shares.ts";
import { getChrome } from "../chrome.ts";
import { Globe, Time } from "../components.tsx";
import { plural, shortId } from "../format.ts";
import { HomeBar, Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";

export interface TrashLinks {
  /** Paused links (not revoked, not expired) that would work again after a restore. */
  paused: { id: string; label: string | null; revision_display_number: number | null }[];
  total: number;
}

export async function trashPage(
  s: HttpServices,
  c: Context,
  linksFor?: (collectionIds: string[]) => Promise<Map<string, TrashLinks>>,
): Promise<Response> {
  const now = Date.now();
  const [items, chrome] = await Promise.all([s.reads.deletedCollections(), getChrome(s, now)]);
  const ids = items.map((item) => item.id);
  const [details, links] = await Promise.all([
    s.reads.trashDetails(ids),
    linksFor ? linksFor(ids) : Promise.resolve(new Map<string, TrashLinks>()),
  ]);
  return noStore(
    c.html(
      <Layout
        title="Trash"
        chrome={chrome}
        bar={<HomeBar chrome={chrome} current="trash" />}
        page="trash"
      >
        <main class="wrap narrow" id="main">
          <div class="ph">
            <div>
              <h1>Trash</h1>
              <p>
                Deleted collections are hidden everywhere, and their public links stop working.
                Restore brings everything back. Purge erases it permanently, everywhere.
              </p>
            </div>
          </div>
          <div class="rows">
            {items.length ? (
              items.map((item) => {
                const detail = details.get(item.id);
                const link = links.get(item.id);
                const linkChip: Child = link?.paused.length ? (
                  <a class="chip xs" href="/links" title="Revoke them from Public links">
                    <Globe />
                    {plural(link.paused.length, "link")}, inactive while in Trash
                  </a>
                ) : null;
                return (
                  <div class="r" data-trash-row={item.id} data-flash-target={item.id}>
                    <span class="t">{item.title}</span>
                    <span class="acts">
                      <button
                        type="button"
                        class="btn sm"
                        data-action="restore"
                        data-id={item.id}
                        data-title={item.title}
                        data-revisions={String(detail?.revisions ?? 0)}
                        data-files={String(detail?.files ?? 0)}
                        data-links={JSON.stringify(link?.paused ?? [])}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        class="btn sm danger"
                        data-action="purge"
                        data-id={item.id}
                        data-title={item.title}
                        data-revisions={String(detail?.revisions ?? 0)}
                        data-files={String(detail?.files ?? 0)}
                        data-link-count={String(link?.total ?? 0)}
                      >
                        Purge…
                      </button>
                    </span>
                    <span class="s">
                      {item.deleted_at != null ? (
                        <span>
                          deleted <Time at={item.deleted_at} fmt="ago" now={now} />
                        </span>
                      ) : null}
                      <span>
                        {plural(detail?.revisions ?? 0, "revision")} ·{" "}
                        {plural(detail?.files ?? 0, "file")}
                      </span>
                      <span class="mono" title={item.id}>
                        {shortId(item.id, 12)}
                      </span>
                      {linkChip}
                    </span>
                  </div>
                );
              })
            ) : (
              <div class="empty">Trash is empty.</div>
            )}
          </div>
        </main>
      </Layout>,
    ),
  );
}

/** Paused links per trashed collection: they work again after a restore (spec §5.9). */
export async function trashLinks(s: HttpServices, ids: string[]): Promise<Map<string, TrashLinks>> {
  const result = new Map<string, TrashLinks>();
  if (!ids.length) return result;
  const rows = await s.waypoint.all<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM share_links WHERE collection_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  for (const view of await shareViews(s, rows, { urls: false })) {
    const entry = result.get(view.collection_id) ?? { paused: [], total: 0 };
    entry.total++;
    if (view.status === "paused")
      entry.paused.push({
        id: view.id,
        label: view.label,
        revision_display_number: view.revision_display_number,
      });
    result.set(view.collection_id, entry);
  }
  return result;
}
