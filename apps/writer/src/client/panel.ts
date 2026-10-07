import { $, $$, storage } from "./dom.js";
import { withTransition } from "./motion.js";

const wide = () => window.matchMedia("(min-width: 1101px)").matches;

function shell(): HTMLElement | null {
  return $("#shell");
}
export function panelOpen(): boolean {
  const root = shell();
  if (!root) return false;
  return wide() ? !root.classList.contains("closed") : root.classList.contains("open");
}
export function setPanel(open: boolean): void {
  const root = shell();
  if (!root) return;
  if (wide()) {
    root.classList.toggle("closed", !open);
    storage()?.setItem("wp:panel", open ? "open" : "closed");
    return;
  }
  root.classList.toggle("open", open);
  const main = $("#main");
  if (main) main.inert = open;
  if (open) $('#panel [role=tab][aria-selected="true"]')?.focus();
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
      withTransition(() => selectTab(tab.dataset.tab ?? "files"));
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
    // Panels on narrow screens start closed; the phone tab bar or "." opens them.
    root.classList.remove("open");
  }
}
