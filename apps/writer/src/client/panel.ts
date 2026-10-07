import { $, $$, storage } from "./dom.js";
import { withTransition } from "./motion.js";

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
function syncToggle(): void {
  const open = String(panelOpen());
  for (const toggle of $$("[data-action=panel-toggle]")) toggle.setAttribute("aria-expanded", open);
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
  if (open) {
    $('#panel [role=tab][aria-selected="true"]')?.focus();
    return;
  }
  if (!was) return;
  // Closing (✕, Esc or the scrim) returns focus to whatever opened the sheet.
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
  if (focus) tab.focus();
  return true;
}
export function showTab(id: string): void {
  if (!selectTab(id)) return;
  setPanel(true);
  $(`#panel [role=tab][data-tab="${id}"]`)?.focus();
}

export function bindPanel(): void {
  const root = shell();
  if (!root) return;
  if (wide() && storage()?.getItem("wp:panel") === "closed") root.classList.add("closed");
  const tabs = $$("#panel [role=tab]");
  for (const tab of tabs) {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      const id = tab.dataset.tab ?? "files";
      void withTransition(() => selectTab(id));
      // Remember the tab in the URL so reloads and copied tailnet links keep it.
      const url = new URL(location.href);
      if (id === "files") url.searchParams.delete("panel");
      else url.searchParams.set("panel", id);
      history.replaceState(history.state, "", url);
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
    // Panels on narrow screens start closed; the bar's ☰, the phone tab bar or "." opens them.
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
}
