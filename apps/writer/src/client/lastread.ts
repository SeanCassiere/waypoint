import { icon } from "@waypoint/ui";

import { shellPath } from "../viewer-paths.ts";
import { $, $$, el, shellRoot, storage } from "./dom.ts";
import { refreshStatusLine } from "./status-line.ts";
import { toast } from "./toast.ts";

/** The new-since segment's neutral marker and the Mark-as-read button's icon (VS-03). */
const DOT = icon("dot");
const CLOSE = icon("close");

export interface ReadMark {
  id: string;
  n: number;
  pub: string;
}
export function readMark(collection: string): ReadMark | null {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(`wp:read:${collection}`) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "id" in value &&
      "n" in value &&
      "pub" in value &&
      typeof value.id === "string" &&
      typeof value.n === "number" &&
      typeof value.pub === "string"
    )
      return { id: value.id, n: value.n, pub: value.pub };
  } catch {
    return null;
  }
  return null;
}
function setRead(collection: string, mark: ReadMark): void {
  storage()?.setItem(`wp:read:${collection}`, JSON.stringify(mark));
}

/** Recent (OW-08): a row is unread when its collection has revisions newer than its read mark, or,
 *  without a mark, when it changed after wp:lastVisit (set on the first visit and by Mark all read
 *  only). Unread rows get a dot, a bolder title and, with a mark, one link to the changes since.
 *  Rows stay where the server put them; client/day-groups.ts localises the day groups. */
export function bindRecentMarks(): void {
  const recent = $("[data-recent]");
  if (!recent) return;
  const store = storage();
  const stored = Number(store?.getItem("wp:lastVisit") ?? Number.NaN);
  const lastVisit = Number.isFinite(stored) && stored > 0 ? stored : null;
  if (lastVisit === null) attempt(() => store?.setItem("wp:lastVisit", String(Date.now())));
  /** Puts each unread row back as the server rendered it. */
  const undo: (() => void)[] = [];
  for (const item of $$("li.item[data-pub]", HTMLLIElement, recent)) {
    const reset = markUnread(item, lastVisit);
    if (reset) undo.push(reset);
  }
  const lede = $("[data-lede]", recent);
  if (!undo.length || !lede) return;
  const original = [...lede.childNodes];
  const count = undo.length;
  const markAll = el("button", {
    class: "markall",
    text: "Mark all read",
    attrs: { type: "button", "data-mark-all": "" },
  });
  lede.replaceChildren(
    el("b", { text: `${count} ${count === 1 ? "collection" : "collections"}` }),
    ` ${count === 1 ? "has" : "have"} revisions you haven't read. `,
    markAll,
    el("span", { text: " · ", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "small muted", text: "Read marks live in this browser." }),
  );
  markAll.addEventListener("click", () => {
    // Fresh from the DOM: rows may have moved between day groups since the first paint.
    const unread = $$("li.item.unread", HTMLLIElement, recent);
    for (const item of unread) {
      const { pub, latestId, latestPub, n } = item.dataset;
      if (pub && latestId && latestPub && n)
        attempt(() => setRead(pub, { id: latestId, n: Number(n), pub: latestPub }));
    }
    attempt(() => store?.setItem("wp:lastVisit", String(Date.now())));
    for (const reset of undo) reset();
    lede.replaceChildren(...original);
    const heading = $("#recent-title");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
    toast(`Marked ${unread.length} ${unread.length === 1 ? "collection" : "collections"} read`);
  });
}

/** Recent's storage writes are best effort: a full or blocked localStorage (QuotaExceededError)
 *  must not stop the existing read marks from showing, or the rest of the page from starting. */
function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // Nothing is remembered this time; the page itself still works.
  }
}

/** Marks one Recent row unread when it is; returns how to undo that, or null for a read row. */
function markUnread(item: HTMLLIElement, lastVisit: number | null): (() => void) | null {
  const pub = item.dataset.pub ?? "";
  const title = $("a.tlink", HTMLAnchorElement, item);
  if (!pub || !title) return null;
  const mark = readMark(pub);
  const n = Number(item.dataset.n);
  const latestPub = item.dataset.latestPub;
  const link = $("a.rv-link", HTMLAnchorElement, item);
  let reset: () => void;
  if (mark && n > mark.n && latestPub && link) {
    const name = $(".tt", title)?.textContent ?? "";
    link.setAttribute("href", `${shellPath(pub, latestPub, "", true)}changes?base=${mark.pub}`);
    link.replaceChildren(
      `${n - mark.n} new since you read #${mark.n}`,
      el("span", { class: "vh", text: ` in ${name}` }),
      el("span", { text: " ›", attrs: { "aria-hidden": "true" } }),
    );
    link.hidden = false;
    title.setAttribute("aria-describedby", link.id);
    reset = () => {
      link.hidden = true;
      link.replaceChildren();
      link.removeAttribute("href");
    };
  } else if (!mark && lastVisit !== null && Number(item.dataset.at) > lastVisit) {
    const description = el("span", {
      class: "vh",
      text: "Unread",
      attrs: { id: `unread-${pub}` },
    });
    title.after(description);
    title.setAttribute("aria-describedby", description.id);
    reset = () => description.remove();
  } else return null;
  item.classList.add("unread");
  return () => {
    reset();
    title.removeAttribute("aria-describedby");
    item.classList.remove("unread");
  };
}

/** Collection: "N new revisions since you last read #M" and marking the latest as read. */
export function bindReadMarks(): void {
  const root = shellRoot();
  if (!root || root.dataset.mode !== "document") return;
  const collection = root.dataset.collection ?? "";
  const latestId = root.dataset.latestId;
  const latestPub = root.dataset.latest;
  const latestN = Number(root.dataset.latestN);
  if (!latestId || !latestPub || !Number.isFinite(latestN)) return;
  const latest: ReadMark = { id: latestId, n: latestN, pub: latestPub };
  const mark = readMark(collection);
  const markRead = () => setRead(collection, latest);
  if (mark && mark.id !== latestId && latestN > mark.n) {
    const count = latestN - mark.n;
    const line = $("[data-status]");
    if (line) {
      const segment = el(
        "span",
        { class: "seg1", attrs: { "data-newsince": "" } },
        el("b", { text: `${count} new ${count === 1 ? "revision" : "revisions"}` }),
        el("span", { class: "long", text: `since you last read #${mark.n}` }),
      );
      segment.insertAdjacentHTML("afterbegin", DOT);
      const changes = el("a", {
        class: "btn sm",
        text: "See changes",
        attrs: { href: `${shellPath(collection, latestPub, "", true)}changes?base=${mark.pub}` },
      });
      const dismiss = el("button", {
        class: "btn sm ghost",
        attrs: { type: "button", "aria-label": "Mark as read" },
      });
      dismiss.insertAdjacentHTML("beforeend", CLOSE);
      dismiss.addEventListener("click", () => {
        markRead();
        segment.remove();
        changes.remove();
        dismiss.remove();
        refreshStatusLine();
      });
      const empty = line.hidden || !line.querySelector(".seg1");
      if (empty) {
        const tap = $("[data-status-tap]", line);
        line.replaceChildren(
          ...(tap ? [tap] : []),
          segment,
          el("span", { class: "grow" }),
          changes,
          dismiss,
        );
        line.className = "status1 info";
      } else {
        // Spec order: failed, uploading, public, then new since last read, then older revision.
        const older = $("[data-older-segment]", line)?.closest(".seg1");
        const anchor = older ?? $(".grow", line);
        const separator = el("span", {
          class: "sepdot",
          text: "·",
          attrs: { "aria-hidden": "true" },
        });
        if (older) older.before(segment, separator);
        else anchor?.before(separator, segment);
        // One primary action per line: See changes only when the line has none yet.
        if (!line.querySelector(".btn")) line.append(changes);
        line.append(dismiss);
        dismiss.addEventListener("click", () => {
          separator.remove();
          refreshStatusLine();
        });
      }
      refreshStatusLine();
    }
  }
  if (root.dataset.revisionId === latestId) setTimeout(markRead, 3000);
}
