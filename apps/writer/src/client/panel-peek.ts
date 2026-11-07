import { $ } from "./dom.ts";

/**
 * Peek (D73): while the docked panel (≥ 1100 px) is collapsed, a mouse resting 150 ms on the
 * window's left edge (the shell's .peek-edge strip) or on the bar's panel button brings the panel
 * out as a floating card (#shell.closed.peek). It stays out while the pointer is over the card,
 * the strip or the button, and while something in it is in use: typing, keyboard focus, a text
 * selection, a press or drag, an open menu, row action or dialog. 250 ms after the pointer leaves
 * (and nothing holds it) it slides away. Esc, following a link in it, the window losing focus or
 * the layout leaving the docked breakpoint close it at once. Docking it (the button, ".", f, h)
 * goes through setPanel, which calls stopPeek first. Pointer-only: keyboard and touch users dock
 * the panel instead, and the module never writes the stored panel state.
 */

const OPEN_DELAY = 150;
const CLOSE_GRACE = 250;
/** The slide-out's length in 95-motion.css; .peek-out is dropped after it. */
const SLIDE_OUT = 100;

const WIDE = window.matchMedia("(min-width: 1100px)");
const FINE = window.matchMedia("(hover: hover) and (pointer: fine)");

let shell: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let edge: HTMLElement | null = null;
let toggle: HTMLElement | null = null;
let changed: () => void = () => {};

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let outTimer: ReturnType<typeof setTimeout> | undefined;
/** The pointer is over the peek's area: the card, the strip, the panel button or an open menu. */
let inside = false;
/** A press that started in the card hasn't been released yet. */
let pressed = false;
/** Closed or collapsed under the pointer: nothing peeks again until it moves off the strip and
 *  the button. */
let suppressed = false;

export function peeking(): boolean {
  return shell?.classList.contains("peek") ?? false;
}
function enabled(): boolean {
  return Boolean(shell?.classList.contains("closed")) && WIDE.matches && FINE.matches;
}
function modalOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}
function hovered(): boolean {
  return Boolean(edge?.matches(":hover") || toggle?.matches(":hover"));
}
function cancelOpen(): void {
  clearTimeout(openTimer);
  openTimer = undefined;
}

function open(): void {
  cancelOpen();
  if (!shell || !enabled() || peeking() || modalOpen()) return;
  clearTimeout(outTimer);
  shell.classList.remove("peek-out");
  shell.classList.add("peek");
  inside = true;
  changed();
}

/** Ends a peek without moving focus or animating, for docking and layout changes. */
export function stopPeek(): void {
  cancelOpen();
  clearTimeout(closeTimer);
  clearTimeout(outTimer);
  inside = false;
  pressed = false;
  if (!shell || !shell.classList.contains("peek")) return;
  shell.classList.remove("peek", "peek-out");
  changed();
}

/** Closes the peek; focus inside it moves to the panel button. `slide` animates it away. */
export function closePeek(slide: boolean): void {
  cancelOpen();
  clearTimeout(closeTimer);
  if (!shell || !peeking()) return;
  const focused = panel?.contains(document.activeElement) ?? false;
  if (slide) {
    shell.classList.add("peek-out");
    clearTimeout(outTimer);
    outTimer = setTimeout(() => shell?.classList.remove("peek-out"), SLIDE_OUT + 50);
  }
  shell.classList.remove("peek");
  inside = false;
  pressed = false;
  suppressed = hovered();
  if (focused) toggle?.focus({ preventScroll: true });
  changed();
}

/** The panel was just collapsed: with the pointer still on the button, it doesn't peek back. */
export function collapsedUnderPointer(): void {
  suppressed = hovered();
}

function arm(event: PointerEvent): void {
  if (event.pointerType !== "mouse" || event.buttons !== 0) return;
  if (!enabled() || peeking() || suppressed || openTimer !== undefined || modalOpen()) return;
  openTimer = setTimeout(() => {
    openTimer = undefined;
    open();
  }, OPEN_DELAY);
}

/** What keeps the peek out with the pointer elsewhere; "" when nothing does. */
export function peekHold(): string {
  if (!panel) return "";
  const active = document.activeElement;
  if (active instanceof HTMLElement && panel.contains(active)) {
    if (active.matches("input:not([type=checkbox], [type=radio]), textarea, select"))
      return "typing";
    if (active.matches(":focus-visible")) return "keyboard";
  }
  if (modalOpen()) return "dialog";
  if (document.querySelector("[popover]:popover-open:not([data-toast])")) return "menu";
  if (panel.querySelector("details.act[open]")) return "action";
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && panel.contains(selection.anchorNode))
    return "selection";
  if (pressed) return "press";
  return "";
}

function scheduleClose(): void {
  clearTimeout(closeTimer);
  if (!peeking() || inside) return;
  closeTimer = setTimeout(() => {
    if (!peeking() || inside || peekHold()) return;
    closePeek(true);
  }, CLOSE_GRACE);
}
/** A hold may have ended: with the pointer outside, the grace period starts again. */
function recheck(): void {
  if (peeking() && !inside) scheduleClose();
}

function inArea(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;
  return Boolean(
    panel?.contains(node) ||
    node === edge ||
    toggle?.contains(node) ||
    node.closest("[popover]:popover-open"),
  );
}

/** The window left the docked layout, or the mouse went away: no peek. */
function leftLayout(): void {
  if (!enabled()) stopPeek();
}

export function bindPeek(onChange: () => void): void {
  shell = $("#shell");
  panel = $("#panel");
  edge = $("[data-peek-edge]");
  toggle = $(".ptog");
  if (!shell || !panel || !edge) return;
  changed = onChange;
  const strip = edge;
  const card = panel;

  // One capture listener sees every element the pointer enters in the shell's document. The
  // document frame's own pointer events never reach it, so moving into the frame shows up as a
  // pointerout whose relatedTarget is the iframe (or null).
  document.addEventListener(
    "pointerover",
    (event) => {
      if (event.pointerType !== "mouse") return;
      if (peeking()) {
        const now = inArea(event.target);
        if (now === inside) return;
        inside = now;
        if (now) clearTimeout(closeTimer);
        else scheduleClose();
        return;
      }
      const target = event.target;
      if (target === strip || (target instanceof Node && toggle?.contains(target))) arm(event);
      else {
        cancelOpen();
        suppressed = false;
      }
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (event.pointerType !== "mouse" || !peeking()) return;
      const to = event.relatedTarget;
      if (to instanceof Element && to.tagName !== "IFRAME") return;
      // Off the window's left edge, right past the flush-left card: it stays.
      if (!to && event.clientX <= 0) return;
      inside = false;
      scheduleClose();
    },
    true,
  );
  // A pointer already resting on the strip (after a page load or a released drag) arms on move.
  strip.addEventListener("pointermove", arm);
  strip.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    suppressed = false;
    open();
  });

  card.addEventListener("pointerdown", () => {
    pressed = true;
  });
  document.addEventListener("pointerup", () => {
    if (!pressed) return;
    pressed = false;
    recheck();
  });
  document.addEventListener("selectionchange", recheck);
  card.addEventListener("focusout", () => setTimeout(recheck));
  // toggle (popovers, details) and close (dialogs) don't bubble; capture sees them.
  document.addEventListener("toggle", recheck, true);
  document.addEventListener("close", recheck, true);

  // Following a link out of the peek closes it at once; the panel stays collapsed. The tabs and
  // History's Compare… and Cancel only change the panel itself, so it stays out for those.
  card.addEventListener("click", (event) => {
    if (!peeking() || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.matches("[role=tab], [data-compare-open], [data-compare-cancel]")) return;
    closePeek(false);
  });

  window.addEventListener("blur", () => closePeek(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") closePeek(false);
  });
  WIDE.addEventListener("change", leftLayout);
  FINE.addEventListener("change", leftLayout);
}
