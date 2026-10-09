import { belowRows, pickSummary } from "../viewer/compare-text.ts";
import { makeLineage, type LineageRow } from "../viewer/lineage.ts";
import { $, $$ } from "./dom.ts";
import { showTab } from "./panel.ts";

// The swap note (?swapped=1) belongs to the page it redirected to; the mode drops it, as the
// server's Compare… and Cancel links do.
const COMPARE_KEYS = ["compare", "r", "err", "swapped"];
// Set when Compare… has to load a page that runs down to its pre-ticks: that page finishes the
// entry (opens History, focuses the current revision's box).
const ENTRY = "wp:compare-entry";
function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Edits the address bar in place (no history entry). */
function setUrl(edit: (url: URL) => void): void {
  const url = new URL(location.href);
  edit(url);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

/** History's compare mode (NAV-10): tick two revisions, then the form's native GET submits them
 *  (the server orders the pair). Without script the same form works from ?compare=1. */
export function bindCompareMode(): void {
  const form = $("form[data-compare-form]", HTMLFormElement);
  const on = $("#cmp-on", HTMLInputElement);
  if (!form || !on) return;
  const status = $("[data-compare-status]", form);
  const go = $("button[data-compare-go]", HTMLButtonElement, form);
  const boxes = $$("input[name=r]", HTMLInputElement, form);
  const boxOf = (pub: string) => boxes.find((box) => box.value === pub);
  // Revisions below the page where shown rows' histories meet (so a branch off an old revision
  // isn't read as a separate history).
  const below = belowRows($("fieldset.cmpset", form)?.dataset.below ?? "");
  // NAV-05b's Show all and "joins at" links (the only links in History's legends).
  const allLinks = $$("p.legend > a", HTMLAnchorElement, form);
  // Ticks in the order they were made; a third tick drops the earliest.
  let order: string[] = [];

  const syncUrl = () =>
    setUrl((url) => {
      for (const key of COMPARE_KEYS) url.searchParams.delete(key);
      url.searchParams.set("panel", "history");
      url.searchParams.set("compare", "1");
      for (const pub of order) url.searchParams.append("r", pub);
    });
  const setInert = (inert: boolean) => {
    for (const link of $$("a.rvl", HTMLAnchorElement, form)) link.inert = inert;
  };
  // Show all (and "joins at") keep the mode and its current ticks; outside it, NAV-05b's link.
  const setAllLinks = (mode: boolean) => {
    const url = new URL(location.href);
    for (const key of ["err", "swapped"]) url.searchParams.delete(key);
    url.searchParams.set("history", "all");
    for (const link of allLinks)
      link.setAttribute("href", mode ? url.search : "?panel=history&history=all");
  };
  const update = (keepStatus = false) => {
    const rows: LineageRow[] = $$("li.rv", form).map((li) => ({
      id: li.dataset.rev ?? "",
      parent_revision_id: li.dataset.parent || null,
      display_number: Number(li.dataset.n ?? 0),
      sync_state: li.dataset.state ?? "synced",
    }));
    const lineage = makeLineage([...rows, ...below]);
    const picked = order.flatMap((pub) => {
      const row = lineage.byId.get(pub);
      return row ? [row] : [];
    });
    const summary = pickSummary(lineage, picked);
    if (status && !keepStatus) status.textContent = summary.status;
    if (go) {
      go.textContent = summary.button;
      go.disabled = !summary.ready;
    }
    for (const li of $$("li.rv", form)) {
      const pub = li.dataset.rev ?? "";
      li.classList.toggle("inr", summary.inRange.has(pub));
      const note = $("[data-cmp-note]", li);
      if (!note) continue;
      const text = summary.notes.get(pub) ?? "";
      note.textContent = text;
      note.hidden = !text;
    }
    setAllLinks(true);
  };
  const focusCurrent = () => $('li.rv[aria-current="true"] input[name=r]', form)?.focus();
  const enter = (picks: readonly string[]) => {
    on.checked = true;
    for (const box of boxes) box.checked = false;
    order = [...new Set(picks)].filter((pub) => boxOf(pub));
    for (const pub of order) {
      const box = boxOf(pub);
      if (box) box.checked = true;
    }
    setInert(true);
    syncUrl();
    update();
  };
  const leave = () => {
    on.checked = false;
    order = [];
    for (const box of boxes) box.checked = false;
    setInert(false);
    for (const li of $$("li.rv", form)) li.classList.remove("inr");
    for (const note of $$("[data-cmp-note]", form)) note.hidden = true;
    setUrl((url) => {
      for (const key of COMPARE_KEYS) url.searchParams.delete(key);
    });
    setAllLinks(false);
    $("[data-compare-open]", form)?.focus();
  };

  for (const link of $$("[data-compare-open]", HTMLAnchorElement))
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      // A pre-tick below this page (an older revision's own page): follow the link, and the
      // server renders the mode with the page running down to it.
      const picks = new URL(link.href).searchParams.getAll("r");
      if (picks.some((pub) => !boxOf(pub))) {
        session()?.setItem(ENTRY, location.pathname);
        return;
      }
      event.preventDefault();
      const popover = link.closest("[popover]");
      if (popover instanceof HTMLElement) popover.hidePopover();
      showTab("history");
      enter(picks);
      focusCurrent();
    });
  for (const cancel of $$("[data-compare-cancel]", HTMLAnchorElement, form))
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      leave();
    });
  for (const box of boxes)
    box.addEventListener("change", () => {
      order = order.filter((pub) => pub !== box.value);
      if (box.checked) order.push(box.value);
      while (order.length > 2) {
        const first = order.shift();
        const earliest = first ? boxOf(first) : undefined;
        if (earliest) earliest.checked = false;
      }
      syncUrl();
      update();
    });

  // Entered without script, or reloaded: the server ticked the boxes; keep the URL's order.
  if (on.checked) {
    const ticked = boxes.filter((box) => box.checked).map((box) => box.value);
    // Distinct, as the server ticked them (a repeated r= ticks one box).
    const asked = [
      ...new Set(new URL(location.href).searchParams.getAll("r").map((r) => r.toLowerCase())),
    ];
    order = [
      ...asked.filter((pub) => ticked.includes(pub)),
      ...ticked.filter((pub) => !asked.includes(pub)),
    ];
    setInert(true);
    update(new URL(location.href).searchParams.get("err") === "pick2");
  }
  // The rest of a Compare… click that loaded this page: History open (a sheet below 1100 px)
  // and focus on the current revision's box.
  const store = session();
  const entry = store?.getItem(ENTRY);
  if (entry) {
    store?.removeItem(ENTRY);
    if (on.checked && entry === location.pathname) {
      showTab("history");
      focusCurrent();
    }
  }
}
