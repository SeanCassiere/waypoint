import { $, $$ } from "./dom.js";

// Menus are native popover="auto" elements (popovertarget, light dismiss, Esc, top layer)
// placed with CSS anchor positioning. Script adds what the platform can't do:
// - the menu keyboard pattern: arrow keys move between items, and a menu opened from the
//   keyboard moves focus to its first item;
// - light dismiss from inside the document iframe, whose clicks and keys never reach this
//   document;
// - on phones, a scrim that takes the closing tap so it can't act on what's beneath;
// - the entrance's transform-origin in browsers without anchored container queries.
function items(menu: HTMLElement): HTMLElement[] {
  return $$(".mi, .rv a, .acts .btn", menu).filter(
    (item) => item.offsetParent !== null && !item.hasAttribute("disabled"),
  );
}

/** Hides every open auto popover (menus, the revision menu, the health popover). */
export function closePopovers(): boolean {
  let closed = false;
  for (const popover of $$("[popover]")) {
    if (popover.popover !== "auto" || !popover.matches(":popover-open")) continue;
    popover.hidePopover();
    closed = true;
  }
  return closed;
}

const watched = new WeakSet<Document>();
/** Light dismiss for same-origin frames: a press or Esc inside the document closes menus. */
function watchFrame(frame: HTMLIFrameElement): void {
  const attach = () => {
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      doc = null;
    }
    // Each document the frame loads is watched once (load fires again on navigation).
    if (!doc || watched.has(doc)) return;
    watched.add(doc);
    doc.addEventListener("pointerdown", () => closePopovers(), true);
    doc.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") closePopovers();
      },
      true,
    );
  };
  frame.addEventListener("load", attach);
  attach();
}

/** Where the popover's box sits relative to its trigger, as a transform-origin. */
function originFor(popover: HTMLElement, anchor: HTMLElement): string {
  const box = popover.getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  const vertical =
    box.top >= at.bottom - 2 ? "top" : box.bottom <= at.top + 2 ? "bottom" : "center";
  const horizontal =
    Math.abs(box.left - at.left) <= Math.abs(box.right - at.right) ? "left" : "right";
  return `${vertical} ${horizontal}`;
}

/**
 * Phones show menus as sheets over a scrim. A tap on the scrim closes the sheet on pointerup,
 * before the tap's click, and an element on its way out isn't hit-tested, so the scrim
 * lingers (fading) for a moment to take that click.
 */
let lingering: ReturnType<typeof setTimeout> | undefined;
function linger(): void {
  const scrim = $(".pop-scrim");
  if (!scrim) return;
  scrim.classList.add("linger");
  if (lingering) clearTimeout(lingering);
  lingering = setTimeout(() => scrim.classList.remove("linger"), 400);
}

export function bindMenus(): void {
  const invokers = new Map<string, HTMLElement>();
  document.addEventListener(
    "click",
    (event) => {
      const invoker =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[popovertarget]")
          : null;
      const id = invoker?.getAttribute("popovertarget");
      if (invoker && id && !invoker.closest(`[id="${CSS.escape(id)}"]`)) invokers.set(id, invoker);
    },
    true,
  );
  const anchored = CSS.supports("container-type: anchored");
  for (const popover of $$("[popover]")) {
    // beforetoggle fires synchronously as the popover hides, before the tap's click.
    popover.addEventListener("beforetoggle", (event) => {
      if (event instanceof ToggleEvent && event.newState === "closed") linger();
    });
    popover.addEventListener("toggle", (event) => {
      if (!(event instanceof ToggleEvent) || event.newState !== "open") return;
      const invoker = invokers.get(popover.id);
      const box = $(":scope > .mbox", popover);
      if (!anchored && invoker && box) box.style.setProperty("--origin", originFor(box, invoker));
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
  for (const frame of $$("iframe", HTMLIFrameElement)) watchFrame(frame);
  // Cross-origin, PDF and image frames: a press inside moves focus into the frame, which
  // blurs this window.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement) closePopovers();
    }, 0);
  });
}
