import { $, $$, storage } from "./dom.js";

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Changes page (its own small bundle): j/k move between changes, Esc returns to the document. */
export function bindChangesNav(): void {
  const page = $(".cmp");
  if (!page) return;
  const done = page.dataset.done;
  const step = (direction: 1 | -1) => {
    const changes = $$("[data-change]").filter((node) => node.offsetParent !== null);
    if (!changes.length) return;
    const top = page.getBoundingClientRect().top + 8;
    const index = changes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const current =
      document.activeElement instanceof HTMLElement ? changes.indexOf(document.activeElement) : -1;
    const next =
      current >= 0
        ? Math.min(changes.length - 1, Math.max(0, current + direction))
        : direction === 1
          ? Math.max(0, index)
          : Math.max(0, (index < 0 ? changes.length : index) - 1);
    const target = changes[next];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing(event.target) || document.querySelector("dialog[open], [popover]:popover-open"))
      return;
    if ($("#shell.open")) return;
    if (event.key === "Escape") {
      if (done) location.assign(done);
      return;
    }
    if (storage()?.getItem("wp:keys") === "off") return;
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      step(event.key === "j" ? 1 : -1);
    }
  });
}
