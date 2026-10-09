/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";

import { pausedChipText } from "../../client/trash-rules.ts";
import type { HttpServices } from "../../http.ts";
import { SHARE_COLUMNS, shareViews, type ShareRow } from "../../shares.ts";
import { getChrome } from "../chrome.ts";
import { Time } from "../components.tsx";
import { plural } from "../format.ts";
import { HomeBar, Layout } from "../layout.tsx";
import { purgeLinks, PurgeRow } from "../purge.tsx";
import { noStore } from "../respond.ts";
import { RecentRow, rowTitleId } from "./recent/rows.tsx";

export interface TrashLinks {
  /** Links that work again after a restore (FC1: status "paused"). */
  paused: {
    id: string;
    label: string | null;
    revision_display_number: number | null;
    expires_at: number | null;
  }[];
  total: number;
}

export async function trashPage(
  s: HttpServices,
  c: Context,
  linksFor?: (collectionIds: string[]) => Promise<Map<string, TrashLinks>>,
): Promise<Response> {
  const now = Date.now();
  const [items, chrome, purges] = await Promise.all([
    s.reads.deletedCollections(),
    getChrome(s, now),
    s.reads.purgingCollections(),
  ]);
  const ids = items.map((item) => item.id);
  const [details, links, revoked] = await Promise.all([
    s.reads.trashDetails(ids),
    linksFor ? linksFor(ids) : Promise.resolve(new Map<string, TrashLinks>()),
    purgeLinks(s, purges),
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
                Collections here are hidden everywhere and their public links are paused. Restore
                brings one back; Purge erases it for good. Nothing in Trash is purged automatically.
              </p>
            </div>
          </div>
          {purges.length ? (
            <section aria-labelledby="trash-purging">
              <h2 class="sec" id="trash-purging">
                Being purged<span class="vh"> ·</span> <span class="n">{purges.length}</span>
              </h2>
              <p class="tlegend">
                Their public links were revoked when you confirmed. They can't be restored. Each
                leaves this list when erasing finishes.
              </p>
              <ul class="list">
                {purges.map((row) => (
                  <PurgeRow
                    row={row}
                    page="trash"
                    now={now}
                    links={revoked.get(row.collection_id) ?? []}
                    syncEnabled={chrome.health.syncEnabled}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {items.length ? (
            <section aria-labelledby="trash-in">
              <h2 class="sec" id="trash-in">
                In Trash<span class="vh"> ·</span> <span class="n">{items.length}</span>
              </h2>
              <ul class="list">
                {items.map((item) => {
                  const detail = details.get(item.id);
                  const link = links.get(item.id);
                  const describedBy = rowTitleId(item.public_id);
                  return (
                    <RecentRow
                      variant="trash"
                      pub={item.public_id}
                      title={item.title}
                      at={item.deleted_at ?? 0}
                      flashTarget={item.id}
                      now={now}
                      msg={
                        <>
                          {item.deleted_at != null ? (
                            <>
                              Moved to Trash <Time at={item.deleted_at} fmt="ago" now={now} />{" "}
                              ·{" "}
                            </>
                          ) : null}
                          {plural(detail?.revisions ?? 0, "revision")} ·{" "}
                          {plural(detail?.files ?? 0, "file")}
                        </>
                      }
                      meta={
                        <>
                          <span class="mono">{item.public_id}</span>
                          {/* The space keeps the ID and the chip apart in the row's text (flex ignores it). */}
                          {link?.paused.length ? (
                            <>
                              {" "}
                              <span class="chip xs paused">
                                {raw(icon("globe", "sm"))}
                                <span class="chip-t">{pausedChipText(link.paused)}</span>
                              </span>
                            </>
                          ) : null}
                        </>
                      }
                      actions={
                        <>
                          <button
                            type="button"
                            class="btn sm"
                            aria-describedby={describedBy}
                            data-action="restore"
                            data-id={item.id}
                            data-title={item.title}
                            data-revisions={String(detail?.revisions ?? 0)}
                            data-files={String(detail?.files ?? 0)}
                            data-links={JSON.stringify(link?.paused ?? [])}
                          >
                            Restore…
                          </button>
                          <button
                            type="button"
                            class="btn sm danger"
                            aria-describedby={describedBy}
                            data-action="purge"
                            data-id={item.id}
                            data-title={item.title}
                            data-public-id={item.public_id}
                            data-revisions={String(detail?.revisions ?? 0)}
                            data-files={String(detail?.files ?? 0)}
                            data-links={JSON.stringify(link?.paused ?? [])}
                          >
                            Purge…
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
          {!items.length && !purges.length ? <div class="empty">Trash is empty.</div> : null}
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
        expires_at: view.expires_at,
      });
    result.set(view.collection_id, entry);
  }
  return result;
}
