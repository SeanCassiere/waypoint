import { isPublicId } from "@waypoint/core";
import type { Context } from "hono";

import type { HttpServices } from "../../../http.ts";
import { getChrome } from "../../chrome.ts";
import { orderPair } from "../../compare-text.ts";
import { makeLineage } from "../../lineage.ts";
import { noStore } from "../../respond.ts";
import type { ViewerExtras } from "../status.tsx";
import { collectionPage } from "./index.tsx";
import { notFound } from "./shell.tsx";

/** A pathname inside this collection that is safe to put in Location, or null. Already-encoded
 *  paths only: no `\`, `?`, `#`, whitespace or control characters, no `//`, no dot segments. */
function backPath(from: string | null, pub: string): string | null {
  if (from === null) return null;
  const escaped = pub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^/c/${escaped}/[A-Za-z0-9._~%/-]*$`).test(from)) return null;
  if (from.includes("//")) return null;
  const dots = from.split("/").some((part) => /^\.{1,2}$/.test(part.replace(/%2e/gi, ".")));
  return dots ? null : from;
}

/** GET /c/:pub/compare: History's compare form without script (NAV-10). Two ticked revisions
 *  redirect to their ordered Changes URL; anything else goes back to the form with err=pick2.
 *  Without `from` it's an ordinary collection path (a root file named "compare"). */
export async function compareRoute(
  s: HttpServices,
  c: Context,
  extras: ViewerExtras,
): Promise<Response> {
  const url = new URL(c.req.raw.url);
  if (!url.searchParams.has("from")) return collectionPage(s, c, extras);
  const pub = (c.req.param("pub") ?? "").toLowerCase();
  const collection = isPublicId(pub) ? await s.reads.collectionByPublicId(pub) : undefined;
  if (!collection) return notFound(c, await getChrome(s), url.pathname);
  const home = `/c/${collection.public_id}/`;
  if (collection.deleted_at != null) return noStore(c.redirect(home, 302));
  const back = backPath(url.searchParams.get("from"), collection.public_id) ?? home;
  const rows = (await s.reads.revisions(collection.id)).map((row) => ({
    id: row.id,
    public_id: row.public_id,
    parent_revision_id: row.parent_revision_id,
    display_number: row.display_number ?? 0,
    sync_state: row.sync_state ?? "synced",
  }));
  const byPub = new Map(rows.map((row) => [row.public_id, row]));
  const picks = [...new Set(url.searchParams.getAll("r").map((r) => r.toLowerCase()))].flatMap(
    (r) => {
      const row = byPub.get(r);
      return row ? [row] : [];
    },
  );
  const [a, b] = picks;
  if (picks.length === 2 && a && b) {
    const { from, to } = orderPair(makeLineage(rows), a, b);
    const base = to.parent_revision_id === from.id ? "" : `?base=${from.public_id}`;
    return noStore(c.redirect(`${home}r/${to.public_id}/changes${base}`, 302));
  }
  const again = new URLSearchParams({ panel: "history", compare: "1", err: "pick2" });
  for (const row of picks) again.append("r", row.public_id);
  return noStore(c.redirect(`${back}?${again.toString()}`, 302));
}
