// What a mutation says once it's done (OW-02). DOM-free, so the tests import it: the flash a
// page leaves for the next one, and the names actions use in their flash and error toasts.
import { plural } from "../viewer/format.ts";

/** A success toast left for the next page load (sessionStorage "wp:flash"). */
export interface FlashInput {
  text: string;
  /** Second line. */
  detail?: string;
  /** Highlights every [data-flash-target="<id>"] on the next page. */
  id?: string;
}

export function encodeFlash(input: FlashInput): string {
  return JSON.stringify({ text: input.text, detail: input.detail, id: input.id });
}
/** The stored flash, or null for anything that isn't one (missing, unparseable, wrong shape). */
export function decodeFlash(raw: string | null): FlashInput | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const text: unknown = Reflect.get(value, "text");
  const detail: unknown = Reflect.get(value, "detail");
  const id: unknown = Reflect.get(value, "id");
  if (typeof text !== "string" || !text) return null;
  return {
    text,
    ...(typeof detail === "string" && detail ? { detail } : {}),
    ...(typeof id === "string" && id ? { id } : {}),
  };
}

/** `#6 of “Title”`, `#6`, or `the revision`. */
export function revisionName(n: number | null, title: string | null): string {
  if (n === null) return "the revision";
  return title ? `#${n} of “${title}”` : `#${n}`;
}
/** One revision by name, or a count of them. */
export function revisionsName(count: number, n: number | null, title: string | null): string {
  return count > 1 ? plural(count, "revision") : revisionName(n, title);
}
/** `“Title”`, or `this collection`. */
export function collectionName(title: string | null): string {
  return title ? `“${title}”` : "this collection";
}
/** The error toast's title line. */
export function actionTitle(what: string): string {
  return `Couldn't ${what}`;
}

export function retryFlash(count: number, n: number | null, title: string | null): string {
  return `Retrying ${revisionsName(count, n, title)}`;
}
export function dropFlash(numbers: readonly number[], title: string | null): string {
  const list = numbers.length ? numbers.map((n) => `#${n}`).join(", ") : "the revision";
  return title ? `Dropped ${list} from “${title}”` : `Dropped ${list}`;
}
/** Moving to Trash pauses live links; the flash says so, and that Restore asks (D44). */
export function trashFlash(title: string, links: number): FlashInput {
  const text = `Moved “${title}” to Trash`;
  if (links < 1) return { text };
  return {
    text,
    detail:
      links === 1
        ? "Its 1 public link is paused, not revoked. Restore asks whether to turn it back on."
        : `Its ${links} public links are paused, not revoked. Restore asks whether to turn them back on.`,
  };
}
export function restoreFlash(title: string | null, revokedLinks: number): string {
  const name = collectionName(title);
  return revokedLinks
    ? `Restored ${name} and revoked its ${plural(revokedLinks, "public link")}`
    : `Restored ${name}`;
}
