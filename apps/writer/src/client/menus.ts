import { $, $$ } from "./dom.js";

// Menus are native popovers (popovertarget, light dismiss, Esc, top layer) placed with CSS
// anchor positioning. Script only adds the menu keyboard pattern: arrow keys move between
// items, and a menu opened from the keyboard moves focus to its first item.
function items(menu: HTMLElement): HTMLElement[] {
  return $$(".mi, .rv a, .acts .btn", menu).filter(
    (item) => item.offsetParent !== null && !item.hasAttribute("disabled"),
  );
}

export function bindMenus(): void {
  for (const popover of $$("[popover]")) {
    popover.addEventListener("toggle", (event) => {
      if (!(event instanceof ToggleEvent) || event.newState !== "open") return;
      const opener = $(`[popovertarget="${popover.id}"]:focus-visible`);
      if (
        opener &&
        (popover.getAttribute("role") === "menu" || popover.classList.contains("rmenu"))
      )
        ($("[aria-current] a", popover) ?? items(popover)[0])?.focus();
    });
    popover.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const list = items(popover);
      if (!list.length) return;
      event.preventDefault();
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? list.indexOf(active) : -1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    });
  }
}
