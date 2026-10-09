import { icon } from "@waypoint/ui";

import { plural } from "../viewer/format.ts";
import { fullDate } from "../viewer/timefmt.ts";
import { registerAction } from "./actions.ts";
import { api, field } from "./api.ts";
import { copyText, showCopied } from "./copy.ts";
import { confirmDialog } from "./dialogs.ts";
import { $, $$, el, run, shellRoot } from "./dom.ts";
import { onCommand } from "./keys.ts";
import { refreshStatusLine } from "./status-line.ts";
import { flash, toast } from "./toast.ts";

const DAY = 86_400_000;
/** Keep in step with STOPS_SOON and NOT_PUSHED in viewer/pages/share.tsx. */
const STOPS_SOON = "Public access stops within seconds.";
const NOT_PUSHED = "Revoked, not yet pushed. Public access continues until it syncs.";
/** A revoked card's note once the reader no longer serves the link. */
const STOPPED = "Its URL no longer works.";

function linkState(value: unknown): string {
  const state = field(field(value, "share_link"), "state");
  return typeof state === "string" ? state : "";
}

/**
 * The revocation note on a card (Links tab) or row (/links): pushed yet, or not. Once the link
 * reads revoked (null), a card's confirmation row says its URL no longer works; a row drops it.
 */
function setRevokeNote(holder: HTMLElement, pushed: boolean | null): void {
  let note = $("[data-stops]", holder);
  if (pushed === null) {
    if (note && holder.classList.contains("gone")) {
      note.dataset.stops = "done";
      note.textContent = STOPPED;
    } else note?.remove();
    return;
  }
  if (!note) {
    const meta = $(":scope > .s", holder);
    note = el(meta ? "span" : "p", { class: meta ? "stops" : "note stops" });
    if (meta) meta.append(note);
    else holder.append(note);
  }
  note.dataset.stops = String(pushed);
  note.textContent = pushed ? STOPS_SOON : NOT_PUSHED;
}

function bump(node: HTMLElement | null, by: number): void {
  if (node) node.textContent = String(Math.max(0, Number(node.textContent ?? "0") + by));
}
/**
 * One fewer link of this status (the holder's data-link-status before the revoke): the Links
 * tab count (live links only), the /links segment counts and Revoke all (on /links, only for
 * a live link). Only when the page couldn't be re-fetched (refreshAfterRevoke).
 */
function countRevoked(status: string): void {
  if (status === "active") bump($("#tab-links .n"), -1);
  if (status) bump($(`[data-count-of="${status}"]`), -1);
  bump($('[data-count-of="revoked"]'), 1);
  const all = $("[data-action=revoke-all]");
  // The /links button (no collection: global revoke-all) counts live links only; the Links
  // tab's counts every open card, as its per-collection revoke-all revokes them all.
  if (!all || (!all.dataset.collectionId && status !== "active")) return;
  const left = Number(all.dataset.count ?? "0") - 1;
  if (left < 2) {
    (all.closest(".lnk-foot") ?? all).remove();
    return;
  }
  all.dataset.count = String(left);
  all.textContent = `Revoke all ${left} ${all.dataset.noun ?? "links"}…`;
}

/**
 * A revoked card (Links tab) collapses into a confirmation row: "Revoked “label”", Dismiss, the
 * push note, and where the link went. The fresh inactive list shows the link itself.
 */
function collapseCard(holder: HTMLElement, pushed: boolean): void {
  const label = $("[data-link-label]", holder);
  // An unlabelled card's label is <i>No label</i>.
  const name = label?.tagName === "B" ? label.textContent : null;
  const dismiss = el("button", {
    class: "iconbtn sm",
    attrs: { type: "button", "data-action": "dismiss-revoked", "aria-label": "Dismiss" },
  });
  dismiss.insertAdjacentHTML("beforeend", icon("close", "sm"));
  holder.replaceChildren(
    el(
      "div",
      { class: "h" },
      el("b", { text: name ? `Revoked “${name}”` : "Revoked link" }),
      dismiss,
    ),
    el("p", { class: "note stops", attrs: { "data-stops": String(pushed) } }),
    el("p", { class: "note", text: "Listed under expired or revoked." }),
  );
  holder.classList.add("dead", "gone");
  holder.dataset.revoked = "";
  setRevokeNote(holder, pushed);
}

/**
 * Shows a link as revoked the moment the writer has recorded it: a card (Links tab) collapses
 * into a confirmation row; a row (/links) loses its actions and its chip reads Revoked (a live
 * /links row has no state chip: one is added after its target chip). The note says whether the
 * revocation has reached the cloud yet (until then the public reader still serves the link),
 * and follows it until it has. Counts are the refresh's job.
 */
function markRevoked(holder: HTMLElement, id: string, pushed: boolean): void {
  if (holder.classList.contains("lnk")) collapseCard(holder, pushed);
  else {
    holder.classList.add("dead");
    const row = holder.classList.contains("r") || holder.classList.contains("lrow");
    let chip = $("[data-link-state]", holder);
    if (!chip && holder.classList.contains("lrow")) {
      chip = el("span");
      $(":scope > .s > [data-shows]", holder)?.after(chip);
    }
    if (chip) {
      chip.className = row ? "chip xs" : "chip";
      chip.dataset.linkState = "revoking";
      chip.replaceChildren("Revoked");
    }
    for (const node of $$(".row, .acts, [data-url-missing]", holder))
      if (node.parentElement === holder) node.remove();
    // Expiry, and a paused row's restore note, no longer apply (/links rows).
    for (const node of $$("[data-live]", holder)) node.remove();
    setRevokeNote(holder, pushed);
  }
  holder.dataset.linkStatus = "revoked";
  holder.tabIndex = -1;
  holder.focus();
  const started = Date.now();
  const check = () => {
    // A dismissed confirmation row has nothing left to follow.
    if (!holder.isConnected) return;
    api(`/api/share-links/${encodeURIComponent(id)}`)
      .then((value) => {
        const link = field(value, "share_link");
        const state = field(link, "state");
        if (state === "revoked") {
          setRevokeNote(holder, null);
          return;
        }
        setRevokeNote(holder, field(link, "revocation_pushed") === true);
        if (Date.now() - started < 120_000) setTimeout(check, 2000);
      })
      .catch(() => {
        if (Date.now() - started < 120_000) setTimeout(check, 2000);
      });
  };
  setTimeout(check, 1000);
}

/**
 * Counter selectors the refresh copies from the fresh page (outside keyed nodes): what
 * countRevoked() bumps. Appendable, so a later page can add a counter without a new pass.
 */
export const REFRESH_SELECTORS: string[] = ["#tab-links .n", "[data-count-of]"];

/** Refreshes started so far: each one's sequence number. */
let refreshes = 0;
/** The newest refresh whose page came back: that page shows every earlier revoke too. */
let arrived = 0;
/** The end of the newest refresh's turn: refreshes decide in the order they started. */
let turns: Promise<void> = Promise.resolve();
/** Each pending refresh's outcome, so an overtaken one can wait for the refresh that swaps. */
const outcomes = new Map<number, Promise<boolean>>();
/** A refresh that hangs mustn't hold up the ones after it. */
const REFRESH_TIMEOUT_MS = 15_000;

const outsideKeyed = (node: Element) => !node.parentElement?.closest("[data-refresh]");
const adopt = (node: Element) => document.importNode(node, true);
const isPublic = (segment: Element) => segment.querySelector(".pubseg") !== null;
/** Pairs a counter with its fresh copy: by data-count-of where it has one. */
const countKey = (node: Element) => node.getAttribute("data-count-of") ?? "";
const keyOf = (node: Element) => node.getAttribute("data-refresh") ?? "";
/** The outermost keyed nodes (an inner one comes with its outer one). */
const keyed = (root: ParentNode) =>
  [...root.querySelectorAll("[data-refresh]")].filter(outsideKeyed);
const present = (key: string) => $(`[data-refresh="${CSS.escape(key)}"]`);

const FOCUSABLE = "button, summary, a[href], input, select, textarea, [tabindex]";
/** The node itself when it takes focus, else its first control. */
function control(node: Element): HTMLElement | null {
  const found = node.matches(FOCUSABLE) ? node : node.querySelector(FOCUSABLE);
  return found instanceof HTMLElement ? found : null;
}
/** Where focus was when a swap took its node away: it goes to the next control after it. */
let lostFocus: Comment | null = null;
/** Child indexes from `root` down to `node`. */
function pathTo(root: Element, node: Element): number[] {
  const path: number[] = [];
  for (let at: Element = node; at !== root && at.parentElement; at = at.parentElement)
    path.unshift([...at.parentElement.children].indexOf(at));
  return path;
}

/** Removes a swapped-out node; if it held focus, marks the spot for restoreFocus(). */
function removeNode(node: Element): void {
  if (lostFocus || !node.contains(document.activeElement)) {
    node.remove();
    return;
  }
  lostFocus = document.createComment("");
  node.replaceWith(lostFocus);
}

/**
 * Replaces a node with its fresh copy. Focus inside it moves to the same control in the copy
 * (same place, same element), else to the copy's first control, else to the next one after it.
 */
function replaceNode(node: Element, added: Element): void {
  const active = document.activeElement;
  const path = active && node.contains(active) ? pathTo(node, active) : null;
  node.replaceWith(added);
  if (!path || !active) return;
  let same: Element | undefined = added;
  for (const index of path) same = same?.children[index];
  const target =
    same instanceof HTMLElement && same.tagName === active.tagName ? same : control(added);
  if (target) target.focus({ preventScroll: true });
  else if (!lostFocus) {
    lostFocus = document.createComment("");
    added.after(lostFocus);
  }
}

/** Focus a swap took away goes to the next control after its spot, else its container's first. */
function restoreFocus(): void {
  const marker = lostFocus;
  lostFocus = null;
  if (!marker) return;
  const parent = marker.parentElement;
  let target: HTMLElement | null = null;
  for (let next = marker.nextElementSibling; next && !target; next = next.nextElementSibling)
    target = control(next);
  marker.remove();
  target ??= parent ? control(parent) : null;
  target?.focus({ preventScroll: true });
}

function parsePage(html: string): Document | null {
  const fresh = new DOMParser().parseFromString(html, "text/html");
  return fresh.body?.firstElementChild ? fresh : null;
}

const shown = (node: HTMLElement) => node.getClientRects().length > 0;
/**
 * Focus the status line had when the refresh hid it or took its control away: the line's first
 * visible control, else, as when a sheet's opener is gone (panel.ts), the visible panel toggle,
 * else the main area.
 */
function keepStatusFocus(line: HTMLElement): void {
  const active = document.activeElement;
  // A control in a hidden line can still be document.activeElement until the browser blurs it.
  if (!line.hidden && active instanceof HTMLElement && line.contains(active) && shown(active))
    return;
  const target =
    (line.hidden ? undefined : $$("a[href], button", line).find(shown)) ??
    $$("[data-action=panel-toggle]").find(shown) ??
    $("#main");
  target?.focus({ preventScroll: true });
}

/** Watches the open phone sheet while the refresh has hidden the status line. */
let sheetWatch: MutationObserver | null = null;
/**
 * The refresh hid the status line while the Links sheet is open: closing the sheet returns focus
 * to its opener (panel.ts), which may be a control in the line, hidden now, so focus would stay
 * in the closed sheet or drop to the body. When the sheet closes and focus has nowhere to be,
 * it goes where keepStatusFocus() sends it.
 */
function watchSheetClose(line: HTMLElement): void {
  const root = $("#shell");
  if (sheetWatch || !root?.classList.contains("open")) return;
  const watch = new MutationObserver(() => {
    if (root.classList.contains("open")) return;
    watch.disconnect();
    sheetWatch = null;
    const active = document.activeElement;
    // A control in the closed (visibility: hidden) sheet stays document.activeElement until
    // the browser blurs it.
    const lost =
      !(active instanceof HTMLElement) ||
      active === document.body ||
      active.closest("[hidden]") !== null ||
      !shown(active) ||
      getComputedStyle(active).visibility === "hidden";
    if (lost) keepStatusFocus(line);
  });
  sheetWatch = watch;
  watch.observe(root, { attributes: true, attributeFilter: ["class"] });
}

const separator = () =>
  el("span", { class: "sepdot", text: "·", attrs: { "aria-hidden": "true" } });
/**
 * A public segment the current line lacks (a link went live meanwhile): in spec order, after
 * failed and uploading, before "new since you last read" and the older revision.
 */
function insertPublic(line: HTMLElement, added: Element): void {
  const segments = $$(":scope > .seg1", line);
  const anchor =
    $(":scope > .seg1[data-newsince]", line) ??
    $("[data-older-segment]", line)?.closest(".seg1") ??
    $(":scope > .grow", line);
  if (anchor?.classList.contains("seg1")) anchor.before(added, separator());
  else {
    const parts = segments.length > 0 ? [separator(), added] : [added];
    if (anchor) anchor.before(...parts);
    else line.append(...parts);
  }
}

/** The status line's public segment (and its tone), then the phone tap text. */
function swapStatus(fresh: Document): void {
  const line = $("[data-status]");
  if (!line) return;
  const active = document.activeElement;
  const hadFocus = active !== null && line.contains(active);
  const freshLine = fresh.querySelector("[data-status]");
  const current = $$(".seg1", line).find(isPublic);
  const next = freshLine ? [...freshLine.querySelectorAll(".seg1")].find(isPublic) : undefined;
  if (current && next) current.replaceWith(adopt(next));
  else if (next) insertPublic(line, adopt(next));
  else if (current) {
    const before = current.previousElementSibling;
    const after = current.nextElementSibling;
    if (before?.classList.contains("sepdot")) before.remove();
    else if (after?.classList.contains("sepdot")) after.remove();
    current.remove();
  }
  // Script-added segments (new since you last read, the frame notice) set no tone of their own.
  if (freshLine && !$("[data-newsince], [data-frame-notice]", line))
    line.className = freshLine.className;
  refreshStatusLine();
  if (hadFocus) keepStatusFocus(line);
  else if (line.hidden) watchSheetClose(line);
}

/** REFRESH_SELECTORS: each count takes the fresh page's value, goes, or appears. */
function swapCounters(fresh: Document): void {
  for (const selector of REFRESH_SELECTORS) {
    const current = $$(selector).filter(outsideKeyed);
    const next = [...fresh.querySelectorAll(selector)].filter(outsideKeyed);
    for (const node of current) {
      const match = next.find((candidate) => countKey(candidate) === countKey(node));
      if (match) node.textContent = match.textContent;
      else node.remove();
    }
    for (const node of next) {
      if (current.some((candidate) => countKey(candidate) === countKey(node))) continue;
      // Into the same container (by id), before its button if it has one (#tab-links .n).
      const id = node.parentElement?.id;
      const container = id ? document.getElementById(id) : null;
      if (container) container.insertBefore(adopt(node), $(":scope > button", container));
    }
  }
}

/** Revoke all buttons outside keyed nodes (/links): the fresh count and text, or gone. */
function swapRevokeAll(fresh: Document): void {
  const next = [...fresh.querySelectorAll("[data-action=revoke-all]")].filter(outsideKeyed);
  for (const button of $$("[data-action=revoke-all]").filter(outsideKeyed)) {
    const collection = button.getAttribute("data-collection-id");
    const match = next.find(
      (candidate) => candidate.getAttribute("data-collection-id") === collection,
    );
    if (!match) {
      removeNode(button.closest(".lnk-foot") ?? button);
      continue;
    }
    for (const name of ["data-count", "data-noun"]) {
      const value = match.getAttribute(name);
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
    button.textContent = match.textContent;
  }
}

/**
 * data-refresh="<key>" nodes: replaced, removed, or inserted after the node holding the previous
 * key in fresh order (before the next one's, else at the end of the fresh node's container).
 * Focus inside a replaced or removed node stays on its control (replaceNode, restoreFocus).
 */
function swapKeyed(fresh: Document): void {
  const nextNodes = keyed(fresh);
  const next = new Map(nextNodes.map((node) => [keyOf(node), node]));
  for (const node of keyed(document)) {
    const match = next.get(keyOf(node));
    if (!match) {
      removeNode(node);
      continue;
    }
    const added = adopt(match);
    // An expanded "Show N expired or revoked" stays expanded.
    if (node instanceof HTMLDetailsElement && added instanceof HTMLDetailsElement)
      added.open = node.open;
    replaceNode(node, added);
  }
  for (const [index, node] of nextNodes.entries()) {
    if (present(keyOf(node))) continue;
    const added = adopt(node);
    const before = nextNodes
      .slice(0, index)
      .toReversed()
      .map((other) => present(keyOf(other)));
    const after = nextNodes.slice(index + 1).map((other) => present(keyOf(other)));
    const previous = before.find((other) => other !== null);
    const following = after.find((other) => other !== null);
    const id = node.parentElement?.closest("[id]")?.id;
    const container = id ? document.getElementById(id) : null;
    if (previous) previous.after(added);
    else if (following) following.before(added);
    else container?.append(added);
  }
}

/**
 * Brings what a revoke changed up to date from a fresh copy of the page: the status line's
 * public segment, the counts, Revoke all, the bar's Public chip and every keyed node. Unkeyed
 * nodes (cards, rows, the confirmation row) stay as they are; nothing reloads or scrolls, and
 * keyboard focus in a swapped node moves to the same control in its fresh copy.
 */
export function refreshFrom(html: string): void {
  const fresh = parsePage(html);
  if (fresh) swapPage(fresh);
}

function swapPage(fresh: Document): void {
  swapStatus(fresh);
  swapCounters(fresh);
  swapRevokeAll(fresh);
  if (!fresh.querySelector("header .chip.public")) $("header .chip.public")?.remove();
  swapKeyed(fresh);
  restoreFocus();
}

/**
 * Re-fetches this page and swaps in what a revoke changed. False when it couldn't (then the
 * caller adjusts the counts itself with countRevoked(), a best-effort estimate: the next
 * successful refresh or page load shows the true counts); true when it did, or a later revoke's
 * refresh did.
 *
 * Overlapping revokes: the pages are fetched in parallel, but each refresh decides in the order
 * they started, after the one before it has settled (including its caller's countRevoked()
 * fallback), so an older page never undoes a newer one. A refresh overtaken by a later one whose
 * page has come back doesn't swap (that page shows this revoke too, and it swaps); it settles
 * only once that one has, so data-refreshed still marks final counts.
 */
export function refreshAfterRevoke(): Promise<boolean> {
  const mine = ++refreshes;
  const previous = turns;
  let release!: () => void;
  turns = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = decide(mine, previous, release);
  outcomes.set(mine, outcome);
  const forget = () => {
    outcomes.delete(mine);
  };
  void outcome.then(forget, forget);
  return outcome;
}

/** Fetches this page; null when that fails. */
async function fetchPage(): Promise<Document | null> {
  try {
    const response = await fetch(location.href, {
      headers: { accept: "text/html" },
      credentials: "same-origin",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    return response.ok ? parsePage(await response.text()) : null;
  } catch {
    return null;
  }
}

async function decide(
  mine: number,
  previous: Promise<void>,
  release: () => void,
): Promise<boolean> {
  const fresh = await fetchPage();
  if (fresh) arrived = Math.max(arrived, mine);
  await previous;
  try {
    const later = arrived > mine ? outcomes.get(arrived) : undefined;
    if (later) {
      release();
      await later;
      return true;
    }
    if (fresh) swapPage(fresh);
    return fresh !== null;
  } finally {
    // After the caller's fallback (its await resumes in a microtask), the next refresh decides.
    setTimeout(release, 0);
  }
}

/** A control that can take focus: shown and not disabled. */
const usable = (node: HTMLElement) =>
  shown(node) && !(node instanceof HTMLButtonElement && node.disabled);
/** Dismiss on a confirmation row: focus goes to the next open card, else to New public link. */
function dismissRevoked(row: HTMLElement): void {
  let next = row.nextElementSibling;
  while (next && !next.matches(".lnk:not(.dead)")) next = next.nextElementSibling;
  // The first control shown: an open Extend… or Revoke… hides its summary; a writer without
  // sharing has no Copy URL.
  const target =
    (next ? $$("button, summary", next).find(usable) : undefined) ??
    $$('#tp-links button[commandfor="share"]').find(usable) ??
    $("#tab-links");
  row.remove();
  target?.focus();
}

/**
 * The share flow (spec §4.15–4.16). The dialog opens natively (commandfor); script submits
 * the JSON request, shows the link (copyable again later from the Links tab), and polls
 * activation every 5 s for up to 3 minutes.
 */
export function bindShare(): void {
  const dialog = $("#share", HTMLDialogElement);
  const root = shellRoot();
  if (dialog && root) bindDialog(dialog, root);
  registerAction("close-details", (element) => {
    const details = element.closest("details");
    if (details) details.open = false;
  });
  bindInlineConfirms();
  registerAction(
    "revoke-link",
    async (element) => {
      const id = element.dataset.id ?? "";
      let pushed = false;
      const revoke = async () => {
        const result = await api(`/api/share-links/${encodeURIComponent(id)}/revoke`, "POST");
        pushed = field(result, "revocation_pushed") === true;
      };
      if (element.dataset.confirm === "true") {
        const ok = await confirmDialog({
          title: "Revoke this link?",
          body: "People using it lose access within seconds. You can't undo this.",
          ok: "Revoke link",
          run: revoke,
        });
        if (!ok) return;
      } else await revoke();
      // The one mutation that updates in place instead of flashing and reloading (OW-02, OW-04).
      toast("Link revoked");
      const holder = element.closest<HTMLElement>("[data-link]");
      if (!holder) return;
      // countRevoked() is keyed by the status the link had.
      const was = holder.dataset.linkStatus ?? "";
      markRevoked(holder, id, pushed);
      // Every holder, card or /links row: the page's counts and keyed nodes follow the fresh copy.
      if (!(await refreshAfterRevoke())) countRevoked(was);
      // The counts are final (a test hook).
      holder.dataset.refreshed = "";
    },
    () => "revoke the link",
  );
  registerAction("dismiss-revoked", (element) => {
    const row = element.closest<HTMLElement>(".lnk.gone");
    if (row) dismissRevoked(row);
  });
  registerAction(
    "revoke-all",
    async (element) => {
      const count = Number(element.dataset.count ?? "0");
      const collection = element.dataset.collectionId;
      let revoked = 0;
      const ok = await confirmDialog({
        title: collection
          ? `Revoke all ${plural(count, "link")}?`
          : `Revoke all ${plural(count, "live link")}?`,
        body: `Everyone using ${count === 1 ? "it" : "them"} loses access within seconds. You can't undo this.`,
        ok: count === 1 ? "Revoke link" : "Revoke all",
        run: async () => {
          const result = await api(
            collection
              ? `/api/collections/${encodeURIComponent(collection)}/share-links/revoke-all`
              : "/api/share-links/revoke-all?state=active",
            "POST",
          );
          const done = field(result, "revoked");
          // The writer always reports it; without it, the count the button showed.
          revoked = typeof done === "number" ? done : count;
        },
      });
      if (!ok) return;
      // /links (no collection) revokes live links only, and says what it left alone.
      flash({
        text: collection
          ? `Revoked ${plural(revoked, "link")}`
          : `Revoked ${plural(revoked, "live link")}. Paused, waiting and expired links are unchanged.`,
      });
      location.reload();
    },
    () => "revoke the links",
  );
  registerAction(
    "extend-link",
    async (element) => {
      const from = Number(element.dataset.from);
      const days = Number(element.dataset.days);
      const requested = Math.max(from, Date.now()) + days * DAY;
      const result = await api(
        `/api/share-links/${encodeURIComponent(element.dataset.id ?? "")}/extend`,
        "POST",
        { expires_at: requested },
      );
      const at = field(field(result, "share_link"), "expires_at");
      const label = $("[data-link-label]", element.closest("[data-link]") ?? document);
      flash({
        text: `Extended “${label?.textContent ?? "No label"}” by ${days} days. It now expires ${fullDate(typeof at === "number" ? at : requested, false)}.`,
      });
      location.reload();
    },
    () => "extend the link",
  );
}

/**
 * Inline confirmations on link cards (Revoke…, Extend…) and /links rows (Extend…) are <details>
 * whose summary hides while open. Focus follows: into the confirmation when it opens, back to
 * the summary when it closes (Keep, Keep as is, Esc).
 */
function bindInlineConfirms(): void {
  for (const details of $$(".lnk details.act, .lrow details.act", HTMLDetailsElement)) {
    const summary = $("summary", details);
    details.addEventListener("toggle", () => {
      if (details.open) {
        $(".pop button", details)?.focus();
        return;
      }
      const active = document.activeElement;
      if (!active || active === document.body || details.contains(active)) summary?.focus();
    });
    details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !details.open) return;
      event.preventDefault();
      details.open = false;
    });
  }
}

/** Keep in step with PREVIEW_LATEST_TITLE in viewer/pages/share.tsx. */
const PREVIEW_LATEST_TITLE = "Opens the Latest URL as a stranger sees it today";

/**
 * Whether a warning track shows. The unchosen target's track is visibility:hidden (it keeps
 * its height), so it still has an offsetParent.
 */
function warned(dialog: HTMLElement): boolean {
  return $$("[data-warn]", dialog).some((warn) =>
    "checkVisibility" in Element.prototype
      ? warn.checkVisibility({ visibilityProperty: true })
      : getComputedStyle(warn).visibility !== "hidden" && warn.offsetParent !== null,
  );
}

function bindDialog(dialog: HTMLDialogElement, root: HTMLElement): void {
  const form = $("[data-share-form]", HTMLFormElement, dialog);
  const create = $('[data-share-step="create"]', dialog);
  const created = $('[data-share-step="created"]', dialog);
  const error = $("[data-share-error]", dialog);
  const copyButton = $("[data-share-copy]", HTMLButtonElement, dialog);
  const open = $("[data-share-open]", HTMLAnchorElement, dialog);
  if (!form || !create || !created || !copyButton) return;
  const sees = $("[data-sees]", HTMLDetailsElement, dialog);
  const preview = $("[data-preview-for=target]", HTMLAnchorElement, dialog);
  // The preview link opens what the checked target publishes (D46: CSS swaps its text).
  const followTarget = () => {
    if (!preview) return;
    const latest = $('input[name="target"][value="latest"]', HTMLInputElement, form)?.checked;
    preview.href = (latest ? preview.dataset.latest : preview.dataset.pinned) ?? preview.href;
    if (latest) preview.title = PREVIEW_LATEST_TITLE;
    else preview.removeAttribute("title");
  };
  for (const radio of $$('input[name="target"]', HTMLInputElement, form))
    radio.addEventListener("change", followTarget);
  // D43: every open starts from Only #N (Latest when #N failed), 7 days, no label.
  const reset = () => {
    form.reset();
    const only = $('input[name="target"][value="only"]', HTMLInputElement, form);
    const target =
      only && !only.disabled
        ? only
        : $('input[name="target"][value="latest"]', HTMLInputElement, form);
    if (target) target.checked = true;
    const week = $('input[name="expires"][value="7"]', HTMLInputElement, form);
    if (week) week.checked = true;
    if (error) error.textContent = "";
    followTarget();
  };
  reset();
  // Per open, never on a target change: phones fold the checklist unless a warning shows.
  const fold = () => {
    if (sees) sees.open = !window.matchMedia("(max-width: 760px)").matches || warned(dialog);
  };
  const focusTarget = () => $('input[name="target"]:checked', HTMLInputElement, form)?.focus();
  // Every way in (Share, s, New public link, the More menu) ends here once the dialog is open.
  dialog.addEventListener("toggle", () => {
    if (!dialog.open) return;
    fold();
    focusTarget();
  });
  onCommand("share", () => {
    if (dialog.open) return;
    dialog.showModal();
    focusTarget();
  });
  let url = "";
  let poll: ReturnType<typeof setTimeout> | undefined;
  // Once a link exists, closing the dialog (Done, Esc) shows it in the Public links tab, where
  // its URL can be copied again. Without one, the form goes back to its defaults.
  dialog.addEventListener("close", () => {
    if (!url) {
      reset();
      return;
    }
    if (poll) clearTimeout(poll);
    const target = new URL(location.href);
    target.searchParams.set("panel", "links");
    location.assign(target.href);
  });
  $("[data-share-done]", dialog)?.addEventListener("click", () => dialog.close());
  copyButton.addEventListener("click", () =>
    run(async () => {
      await copyText(url, "public link");
      showCopied(copyButton);
    }, "copy the link"),
  );
  const paintState = (state: string) => {
    const chip = $("[data-share-state]", dialog);
    const text = $("[data-share-state-text]", dialog);
    if (!chip || !text || state !== "active") return;
    chip.className = "state ok";
    chip.replaceChildren();
    // Public is globe in --public (VS-03), like the server's Live chip; the word keeps its colour.
    chip.insertAdjacentHTML("beforeend", icon("globe", "sm public"));
    chip.append("Live");
    text.textContent = "Works now for anyone who has the link.";
  };
  let painted = "";
  const setState = (state: string) => {
    if (state === painted) return;
    painted = state;
    paintState(state);
  };
  form.addEventListener("submit", (event) => {
    if (event.submitter?.getAttribute("formmethod") === "dialog") return;
    event.preventDefault();
    const data = new FormData(form);
    const target = data.get("target");
    const expires = data.get("expires");
    const rawLabel = data.get("label");
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    const submit = $("[data-share-submit]", HTMLButtonElement, form);
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
    }
    if (error) error.textContent = "";
    const expiresAt = expires === "never" ? null : Date.now() + Number(expires ?? 7) * DAY;
    run(
      async () => {
        try {
          const result = await api(
            `/api/collections/${encodeURIComponent(root.dataset.collectionId ?? "")}/share-links`,
            "POST",
            {
              ...(target === "only" ? { revision_id: root.dataset.revisionId } : {}),
              ...(label ? { label } : {}),
              expires_at: expiresAt,
            },
          );
          const link = field(result, "url");
          const id = field(field(result, "share_link"), "id");
          if (typeof link !== "string" || typeof id !== "string")
            throw new Error("The writer returned no link");
          url = link;
          const dialogN = dialog.dataset.n ?? "";
          const set = (selector: string, text: string) => {
            const node = $(selector, dialog);
            if (node) node.textContent = text;
          };
          set("[data-share-url]", url);
          set("[data-share-label]", label || "(no label)");
          set("[data-share-shows]", target === "only" ? `Only #${dialogN}` : "Latest revision");
          set("[data-share-expires]", expiresAt === null ? "Never" : fullDate(expiresAt, false));
          if (open) open.href = url;
          painted = linkState(result);
          create.hidden = true;
          created.hidden = false;
          dialog.setAttribute("aria-labelledby", "share-created-title");
          paintState(painted);
          // Spec §4.16: Copy has focus once the link exists.
          copyButton.focus();
          const started = Date.now();
          const check = () => {
            api(`/api/share-links/${encodeURIComponent(id)}`)
              .then((value) => {
                const state = linkState(value);
                setState(state);
                if (state !== "active" && Date.now() - started < 180_000)
                  poll = setTimeout(check, 5000);
              })
              .catch(() => {
                poll = setTimeout(check, 5000);
              });
          };
          poll = setTimeout(check, 5000);
        } finally {
          if (submit) {
            submit.disabled = false;
            submit.removeAttribute("aria-busy");
          }
        }
      },
      (cause) => {
        if (error) error.textContent = cause instanceof Error ? cause.message : "Request failed";
      },
    );
  });
}
