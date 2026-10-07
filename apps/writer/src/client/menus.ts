import { $, $$ } from "./dom.js";

const invokers = new Map<string, HTMLElement>();

function visibleItems(menu: HTMLElement): HTMLElement[] {
  return $$(".mi, .rv a, .acts .btn", menu).filter(
    (item) => item.offsetParent !== null && !item.hasAttribute("disabled"),
  );
}
/** Places a popover next to the control that opened it, inside the viewport. */
export function placePopover(popover: HTMLElement): void {
  const invoker = invokers.get(popover.id);
  if (!invoker || !invoker.isConnected) return;
  const rect = invoker.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const rightAligned = rect.left + rect.width / 2 > window.innerWidth / 2;
  let left = rightAligned ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8 && rect.top - height - 6 >= 8)
    top = rect.top - height - 6;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(8, top))}px`;
}

export function bindMenus(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const invoker = target.closest<HTMLElement>("[popovertarget]");
      const id = invoker?.getAttribute("popovertarget");
      if (invoker && id) invokers.set(id, invoker);
    },
    true,
  );
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Activating a menu item closes its menu (links navigate, buttons run their action).
    const item = target.closest<HTMLElement>("[popover] .mi");
    if (item && !item.hasAttribute("popovertarget"))
      item.closest<HTMLElement>("[popover]")?.hidePopover();
  });
  for (const popover of $$("[popover]")) {
    popover.addEventListener("toggle", (event) => {
      if (!(event instanceof ToggleEvent)) return;
      const invoker = invokers.get(popover.id);
      invoker?.setAttribute("aria-expanded", String(event.newState === "open"));
      if (event.newState !== "open") return;
      placePopover(popover);
      if (popover.getAttribute("role") === "menu" || popover.classList.contains("rmenu"))
        ($("[aria-current] a, .mi", popover) ?? visibleItems(popover)[0])?.focus();
    });
    popover.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = visibleItems(popover);
      if (!items.length) return;
      event.preventDefault();
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
  }
  window.addEventListener("resize", () => {
    for (const popover of $$("[popover]"))
      if (popover.matches(":popover-open")) placePopover(popover);
  });
}

/** Opens a popover as if its invoker had been clicked (for keyboard shortcuts). */
export function openPopover(id: string): void {
  const popover = document.getElementById(id);
  if (!popover) return;
  const invoker = $$(`[popovertarget="${id}"]`).find((item) => item.offsetParent !== null);
  if (invoker) invokers.set(id, invoker);
  if (!popover.matches(":popover-open")) popover.showPopover();
}
