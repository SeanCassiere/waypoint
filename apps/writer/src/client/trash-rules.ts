// What Restore does and says (OW-07). DOM-free, so the tests import it: the requests a restore
// makes for a choice about its paused links, its flash, and the Trash row's paused-link chip.
import { plural } from "../viewer/format.ts";

/** What happens to a trashed collection's paused links when it's restored. */
export type RestoreChoice = "revoke" | "keep";
/** A link that works again after a restore (FC1: status "paused"), as data-links carries it. */
export interface PausedLink {
  id: string;
  label: string | null;
  revision_display_number: number | null;
  expires_at: number | null;
}

/** The requests a restore makes, in order; null while a choice is still required (k ≥ 1, no choice). */
export function restoreRequests(
  collectionId: string,
  linkCount: number,
  choice: RestoreChoice | null,
): { method: "POST"; url: string }[] | null {
  if (linkCount > 0 && choice === null) return null;
  const base = `/api/collections/${encodeURIComponent(collectionId)}`;
  const undelete = { method: "POST" as const, url: `${base}/undelete` };
  // Revoke-all is the per-collection call: it revokes every open link, as the choice says.
  if (linkCount > 0 && choice === "revoke")
    return [{ method: "POST", url: `${base}/share-links/revoke-all` }, undelete];
  return [undelete];
}

export function restoreFlashText(
  title: string,
  linkCount: number,
  choice: RestoreChoice | null,
): string {
  const text = `Restored “${title}”.`;
  if (linkCount < 1 || choice === null) return text;
  const one = linkCount === 1;
  if (choice === "revoke")
    return `${text} ${one ? "Its public link was revoked." : `Its ${linkCount} public links were revoked.`}`;
  return `${text} ${one ? "Its public link works again." : `Its ${linkCount} public links work again.`}`;
}

/** "1 link paused · “Vendor debug”"; "" when the list is empty. */
export function pausedChipText(links: readonly PausedLink[]): string {
  if (!links.length) return "";
  // Unlabelled links are counted but not quoted; two labels at most, then "+n".
  const labels = links.flatMap((link) => (link.label ? [`“${link.label}”`] : []));
  const shown = labels.slice(0, 2).join(", ");
  const more = labels.length > 2 ? ` +${labels.length - 2}` : "";
  return `${plural(links.length, "link")} paused${shown ? ` · ${shown}${more}` : ""}`;
}
