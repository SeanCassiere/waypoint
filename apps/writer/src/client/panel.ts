import { rawPath } from "../viewer-paths.ts";
import { $, $$, storage } from "./dom.ts";
import { nearestDelta } from "./scroll-nearest.ts";

// The panel docks at ≥ 1100px (spec §3.3) and is an overlay sheet below that.
const WIDE = "(min-width: 1100px)";
export const wide = () => window.matchMedia(WIDE).matches;

function shell(): HTMLElement | null {
  return $("#shell");
}
export function panelOpen(): boolean {
  const root = shell();
  if (!root) return false;
  return wide() ? !root.classList.contains("closed") : root.classList.contains("open");
}
/** The panel toggle says whether the panel is open; the pills and the tab bar's Files and
 *  History say whether it's open on their tab (the status line's tap target has no
 *  aria-controls and is left alone). */
function syncToggle(): void {
  const open = panelOpen();
  for (const toggle of $$("[data-action=panel-toggle]"))
    toggle.setAttribute("aria-expanded", String(open));
  const tab = $('#panel [role=tab][aria-selected="true"]')?.dataset.tab;
  for (const opener of $$('[data-action="panel-tab"][aria-controls="panel"]'))
    opener.setAttribute("aria-expanded", String(open && opener.dataset.tab === tab));
}
/** While the overlay sheet is open, everything behind it is inert (spec §4.8: focus trapped). */
function setBackdrop(inert: boolean): void {
  for (const node of $$("body > .skip, header.bar, .tabbar, #main")) node.inert = inert;
}
let opener: HTMLElement | null = null;
export function setPanel(open: boolean): void {
  const root = shell();
  if (!root) return;
  if (wide()) {
    root.classList.toggle("closed", !open);
    storage()?.setItem("wp:panel", open ? "open" : "closed");
    syncToggle();
    if (open) revealRevision();
    return;
  }
  const was = root.classList.contains("open");
  if (open && !was) {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  root.classList.toggle("open", open);
  setBackdrop(open);
  syncToggle();
  if (open) revealRevision();
  if (open) {
    $('#panel [role=tab][aria-selected="true"]')?.focus();
    return;
  }
  if (!was) return;
  // Closing (the close button, Esc or the scrim) returns focus to whatever opened the sheet.
  const target = opener?.isConnected && !opener.closest("#panel") ? opener : null;
  opener = null;
  const fallback = $$("[data-action=panel-toggle]").find((toggle) => toggle.offsetParent !== null);
  (target ?? fallback ?? $("#main"))?.focus();
}
export function togglePanel(): void {
  setPanel(!panelOpen());
}
export function selectTab(id: string, focus = false): boolean {
  const tab = $(`#panel [role=tab][data-tab="${id}"]`);
  if (!tab) return false;
  for (const item of $$("#panel [role=tab]")) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  for (const panel of $$("#panel [role=tabpanel]")) panel.hidden = panel.dataset.tabpanel !== id;
  // Remember the tab in the URL so reloads, copied tailnet links and revision steps keep it.
  const url = new URL(location.href);
  if (id === "files") url.searchParams.delete("panel");
  else url.searchParams.set("panel", id);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  if (focus) tab.focus();
  revealRevision();
  syncToggle();
  return true;
}
/**
 * Scrolls the current revision into view in the History tab, if the panel shows it. It sets the
 * panel body's `scrollTop` (the "nearest" arithmetic), never `scrollIntoView`: in Chromium that
 * moves the sequential focus starting point to the row, so the first Tab would skip the skip link.
 */
function revealRevision(): void {
  if (!panelOpen()) return;
  const row = $('#tp-history:not([hidden]) .rv[aria-current="true"]');
  const body = row?.closest<HTMLElement>(".pbody");
  if (!row || !body) return;
  const top = body.getBoundingClientRect().top + body.clientTop;
  const bottom = top + body.clientHeight;
  const at = row.getBoundingClientRect();
  body.scrollTop += nearestDelta(top, bottom, at.top, at.bottom);
}

const SHEET = "wp:sheet";
function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
/**
 * Called before navigating to another revision. If the overlay side sheet is open (600 px
 * and wider, iPad mini included), the next page reopens it. Below 600 px the panel is a
 * bottom sheet covering most of the document, so it stays closed and only the tab is kept.
 * `focusRevision` returns keyboard focus to the current revision.
 */
export function rememberSheet(focusRevision: boolean): void {
  const store = session();
  if (!store) return;
  const reopen = !wide() && panelOpen() && window.matchMedia("(min-width: 600px)").matches;
  if (reopen || focusRevision) store.setItem(SHEET, JSON.stringify({ reopen, focusRevision }));
  else store.removeItem(SHEET);
}
function restoreSheet(): void {
  const store = session();
  const raw = store?.getItem(SHEET);
  if (!raw) return;
  store?.removeItem(SHEET);
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return;
  }
  const flag = (key: string) =>
    Boolean(state && typeof state === "object" && key in state && Reflect.get(state, key));
  if (flag("reopen") && !wide()) setPanel(true);
  if (flag("focusRevision") || flag("reopen"))
    $('#panel [role=tabpanel]:not([hidden]) .rv[aria-current="true"] a')?.focus();
}
/** Focus the tab's current row (History) or file (Files), or else the tab itself. */
function focusCurrent(id: string): void {
  const current =
    id === "history"
      ? $('#tp-history li.rv[aria-current="true"] a.rvl')
      : id === "files"
        ? $("#tp-files a[aria-current]")
        : null;
  current?.focus();
  if (!current || document.activeElement !== current)
    $(`#panel [role=tab][data-tab="${id}"]`)?.focus();
}
/** The one path for the pills, the tab bar, h and f and the status line: opens the panel on the
 *  tab (never closes it) and focuses the current row or file. setPanel records the opener first,
 *  so Esc and the scrim return focus to it. */
export function showTab(id: string): void {
  if (!selectTab(id)) return;
  setPanel(true);
  focusCurrent(id);
}

export function bindPanel(): void {
  const root = shell();
  if (!root) return;
  if (wide() && storage()?.getItem("wp:panel") === "closed") root.classList.add("closed");
  const tabs = $$("#panel [role=tab]");
  for (const tab of tabs) {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      selectTab(tab.dataset.tab ?? "files");
    });
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(tabs[next]?.dataset.tab ?? "files", true);
    });
  }
  const filter = $("[data-filter]", HTMLInputElement);
  filter?.addEventListener("input", () => {
    const query = filter.value.trim().toLowerCase();
    for (const link of $$("#tp-files a[data-file]", HTMLAnchorElement))
      link.hidden = Boolean(query) && !(link.dataset.file ?? "").toLowerCase().includes(query);
    for (const folder of $$("#tp-files details", HTMLDetailsElement)) {
      if (query) folder.open = true;
      folder.hidden =
        Boolean(query) &&
        !$$("a[data-file]", HTMLAnchorElement, folder).some((link) => !link.hidden);
    }
  });
  if (!wide()) {
    // Panels on narrow screens start closed; the bar's panel button, the phone tab bar or "."
    // opens them.
    root.classList.remove("open");
  }
  // Crossing the breakpoint: a docked panel never leaves the page behind it inert.
  window.matchMedia(WIDE).addEventListener("change", () => {
    if (wide()) {
      root.classList.remove("open");
      setBackdrop(false);
      opener = null;
    }
    syncToggle();
  });
  syncToggle();
  // The file crumb, the phone state line and the hidden "Document: …" heading name the document
  // shown, which can change by following a link inside it (frame-sync updates the shell's
  // data-path). Download file keeps asking for the stored bytes (?download): frame-sync points
  // the raw links at the frame's own URL in the same task, and this observer runs after it.
  const named = $$(".cbar .pill.file .mono, .cbar .idsub .mono");
  const heading = $$("#main > h2.vh").find((node) => node.textContent?.startsWith("Document: "));
  const downloads = $$("[data-download-raw]", HTMLAnchorElement);
  const revision = root.dataset.revision ?? "";
  if (named.length || heading || downloads.length)
    new MutationObserver(() => {
      const path = root.dataset.path ?? "";
      for (const node of named) node.textContent = path;
      if (heading) heading.textContent = `Document: ${path}`;
      if (path && revision)
        for (const link of downloads) link.href = `${rawPath(revision, path)}?download`;
    }).observe(root, { attributeFilter: ["data-path"] });
  restoreSheet();
  // The current revision is in view in the History tab after stepping to it.
  revealRevision();
}
