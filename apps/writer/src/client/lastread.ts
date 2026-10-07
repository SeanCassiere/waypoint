import { shellPath } from "../viewer-paths.js";
import { dayLabel, sinceText } from "../viewer/timefmt.js";
import { $, $$, el, shellRoot, storage } from "./dom.js";
import { refreshStatusLine } from "./status-line.js";

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

/** Recent: "New since" divider, new dots, local day groups and the lede (spec §5.1). */
export function bindRecentMarks(): void {
  const recent = $("[data-recent]");
  const store = storage();
  if (!recent) return;
  const now = Date.now();
  const lastVisit = Number(store?.getItem("wp:lastVisit") ?? Number.NaN);
  const known = Number.isFinite(lastVisit) && lastVisit > 0;
  const items = $$(".item[data-updated]", HTMLAnchorElement, recent);
  const since = known ? sinceText(lastVisit, now, false) : "";
  for (const item of items) {
    const mark = item.dataset.pub ? readMark(item.dataset.pub) : null;
    const n = Number(item.dataset.n);
    const slot = $("[data-new]", item);
    if (mark && slot && n > mark.n) {
      slot.hidden = false;
      slot.textContent = `${n - mark.n} new since you read #${mark.n}`;
    }
  }
  const groups = $("[data-groups]", recent);
  let fresh = 0;
  if (groups) {
    groups.replaceChildren();
    let current = "";
    for (const item of items) {
      const updated = Number(item.dataset.updated);
      const isNew = known && updated > lastVisit;
      if (isNew) fresh++;
      item.classList.toggle("new", isNew);
      const label = isNew ? `New since ${since}` : dayLabel(updated, now, false);
      if (label !== current) {
        groups.append(el("div", { class: isNew ? "day since" : "day", text: label }));
        current = label;
      }
      groups.append(item);
    }
  }
  const lede = $("[data-lede]", recent);
  if (lede && known)
    lede.textContent = fresh
      ? `${fresh} ${fresh === 1 ? "collection" : "collections"} changed since you were last here${/^\d\d:/.test(since) ? " at" : ","} ${since}.`
      : `Nothing new since ${since}.`;
  window.addEventListener("pagehide", () => store?.setItem("wp:lastVisit", String(Date.now())));
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
        el("span", { text: "●", attrs: { "aria-hidden": "true" } }),
        el("b", { text: `${count} new ${count === 1 ? "revision" : "revisions"}` }),
        el("span", { class: "long", text: `since you last read #${mark.n}` }),
      );
      const changes = el("a", {
        class: "btn sm",
        text: "See changes",
        attrs: { href: `${shellPath(collection, latestPub, "", true)}changes?base=${mark.pub}` },
      });
      const dismiss = el("button", {
        class: "btn sm ghost",
        text: "✕",
        attrs: { type: "button", "aria-label": "Mark as read" },
      });
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
