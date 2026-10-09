import { icon } from "@waypoint/ui";

import { ApiError } from "./api.ts";
import { $, $$, el } from "./dom.ts";
import { actionTitle, decodeFlash, encodeFlash, type FlashInput } from "./feedback.ts";

export type { FlashInput } from "./feedback.ts";
export type ToastKind = "success" | "error";
export interface ToastOptions {
  /** Default "success". */
  kind?: ToastKind;
  /** Default: false for success, true for error. */
  sticky?: boolean;
  /** Second line. */
  detail?: string;
  /** Error only: the raw text, small in mono. */
  raw?: string;
}

const FLASH_KEY = "wp:flash";
const timers = new Map<ToastKind, ReturnType<typeof setTimeout>>();
/** How long each showing success toast stays up (absent: sticky). */
const lifetimes = new Map<ToastKind, number>();
/** Slots the pointer or keyboard focus is in: their timer waits until it leaves. */
const held = new Map<HTMLElement, { pointer: boolean; focus: boolean }>();
/** Where focus was before it entered a slot, to return it there on Dismiss: the element it came
 *  from, then (when that was the other toast) where focus was before that toast. */
const returnFocus = new Map<HTMLElement, HTMLElement[]>();
/** Modals opened while a toast control had focus: the slot and whether it was Status. */
const beforeModal = new Map<HTMLDialogElement, { slot: HTMLElement; link: boolean }>();
let following = false;
/** The last control focused outside the toasts. An action's button is disabled while it runs,
 *  so focus falls to <body> and a toast focused next has no origin to return to: Dismiss returns
 *  focus here instead (once the button is enabled again). */
let lastOutside: HTMLElement | null = null;
let tracking = false;

function track(): void {
  if (tracking) return;
  tracking = true;
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest("[data-toast]")) lastOutside = target;
    },
    true,
  );
}

/** The topmost open modal dialog, or null. */
function topModal(): HTMLDialogElement | null {
  return (
    $$("dialog[open]", HTMLDialogElement).findLast((dialog) => dialog.matches(":modal")) ?? null
  );
}

/** Somewhere Dismiss can return focus to: still in the page, shown, enabled, and not made inert
 *  by an open modal. */
function usable(element: HTMLElement, slot: HTMLElement): boolean {
  const modal = topModal();
  return (
    element.isConnected &&
    !slot.contains(element) &&
    !element.matches(":disabled") &&
    (!modal || modal.contains(element)) &&
    element.checkVisibility()
  );
}

const CONTROLS = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Where Dismiss puts focus when it didn't come from anywhere still usable (Dismiss reached first
 * on a page that just loaded with a flash): the open modal's first control (or the dialog
 * itself), else the page's main content, as the skip link does. Never <body>.
 */
function fallback(slot: HTMLElement): HTMLElement | null {
  const modal = topModal();
  if (modal) {
    const control = $$(CONTROLS, modal).find(
      (each) => !each.closest("[data-toast]") && usable(each, slot),
    );
    if (control) return control;
    if (!modal.hasAttribute("tabindex")) modal.tabIndex = -1;
    return modal;
  }
  const main = $("#main");
  if (!main?.checkVisibility()) return null;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  return main;
}

/**
 * The host is a manual popover, so it joins the top layer and shows above an open modal dialog
 * instead of under its backdrop. While a modal dialog is open the host lives inside it:
 * everything outside a modal is inert, so a toast outside it would be hidden from assistive
 * technology and couldn't be dismissed.
 */
function raise(host: HTMLElement): void {
  const home = topModal() ?? document.body;
  // Re-showing also moves it above any dialog opened since it was last shown.
  if (host.matches(":popover-open")) host.hidePopover();
  if (host.parentElement !== home) home.append(host);
  host.showPopover();
  follow();
}

/** A toast that's up follows modal dialogs as they open and close (a sticky error stays usable
 *  when a dialog opens after it, and leaves a dialog that closes under it). */
function follow(): void {
  if (following) return;
  following = true;
  new MutationObserver(() => {
    const host = $("[data-toast]");
    const home = topModal() ?? document.body;
    if (host && host.parentElement !== home) {
      if (host.matches(":popover-open")) raise(host);
      // A hidden host (a success that timed out in a modal) goes back when the modal closes.
      else if (home === document.body) home.append(host);
    }
    refocusAfterModal();
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
}

/**
 * A modal opened from a toast control (`?` with Dismiss focused) returns focus to that control
 * when it closes, but the control was inside the modal by then (the host followed it), so focus
 * falls to <body>. Once the host is back, focus the control (or its replacement) instead.
 */
function refocusAfterModal(): void {
  for (const [dialog, { slot, link }] of beforeModal) {
    if (dialog.open) continue;
    beforeModal.delete(dialog);
    // Focus is still on a control of the closed dialog until the next rendering update.
    const active = document.activeElement;
    if (active && active !== document.body && !dialog.contains(active)) continue;
    const control = (link ? $("a", slot) : null) ?? $("[data-toast-close]", slot);
    if (control?.checkVisibility()) control.focus();
  }
}

/** Starts (or restarts) a success toast's timer, unless the pointer or focus is in it. */
function arm(kind: ToastKind, slot: HTMLElement): void {
  clearTimeout(timers.get(kind));
  timers.delete(kind);
  const lifetime = lifetimes.get(kind);
  const state = held.get(slot);
  if (lifetime === undefined || state?.pointer || state?.focus) return;
  timers.set(
    kind,
    setTimeout(() => dismiss(kind), lifetime),
  );
}

/** Once per slot: hovering a toast or focusing its controls pauses its timer. */
function watch(kind: ToastKind, slot: HTMLElement): void {
  if (held.has(slot)) return;
  const state = { pointer: false, focus: false };
  held.set(slot, state);
  const hold = (key: "pointer" | "focus", on: boolean) => {
    state[key] = on;
    if (on) {
      clearTimeout(timers.get(kind));
      timers.delete(kind);
    } else arm(kind, slot);
  };
  slot.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") hold("pointer", true);
  });
  slot.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") hold("pointer", false);
  });
  slot.addEventListener("focusin", (event) => {
    const from = event.relatedTarget;
    // Not a control of a dialog that just closed (focus coming back after a modal).
    if (
      from instanceof HTMLElement &&
      !slot.contains(from) &&
      !from.closest("dialog:not([open])")
    ) {
      // From the other toast: keep its origin too, in case that toast is gone by Dismiss.
      const other = from.closest<HTMLElement>("[data-toast-slot]");
      returnFocus.set(slot, [from, ...((other && returnFocus.get(other)) ?? [])]);
    }
    hold("focus", true);
  });
  slot.addEventListener("focusout", (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && slot.contains(to)) return;
    const modal = to instanceof Element ? to.closest("dialog") : null;
    if (modal?.matches(":modal") && event.target instanceof Element)
      beforeModal.set(modal, { slot, link: event.target.matches("a") });
    hold("focus", false);
  });
}

function dismiss(kind: ToastKind): void {
  const host = $("[data-toast]");
  const slot = host && $(`[data-toast-slot="${kind}"]`, host);
  if (!host || !slot) return;
  clearTimeout(timers.get(kind));
  timers.delete(kind);
  lifetimes.delete(kind);
  // Dismissing with the keyboard returns focus where it was, not to <body>.
  const back = slot.contains(document.activeElement)
    ? ([...(returnFocus.get(slot) ?? []), ...(lastOutside ? [lastOutside] : [])].find((each) =>
        usable(each, slot),
      ) ?? fallback(slot))
    : undefined;
  returnFocus.delete(slot);
  const state = held.get(slot);
  if (state) state.focus = false;
  slot.replaceChildren();
  if (
    $$("[data-toast-slot]", host).every((each) => !each.hasChildNodes()) &&
    host.matches(":popover-open")
  )
    host.hidePopover();
  back?.focus({ preventScroll: back.matches("main, dialog") });
}

/**
 * At most one success and one error toast, bottom centre, success above error (spec §4.20,
 * OW-02). A success hides after 3 s (6 s with a second line); an error stays until Dismiss or
 * the next error. Both slots are live regions from page load (status and alert).
 */
export function toast(message: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? "success";
  const host = $("[data-toast]");
  const slot = host && $(`[data-toast-slot="${kind}"]`, host);
  if (!host || !slot) return;
  track();
  const detail = options.detail ?? "";
  const raw = kind === "error" ? (options.raw ?? "") : "";
  const lines = el("div", { class: "tb" }, el("p", { class: "tt", text: message }));
  if (detail || raw) {
    const line = el("p", { class: "td" }, detail);
    if (raw) line.append(detail ? " " : "", el("code", { class: "raw", text: raw }));
    lines.append(line);
  }
  const close = el("button", {
    class: "tx",
    attrs: { type: "button", "data-toast-close": "", "aria-label": "Dismiss" },
  });
  close.insertAdjacentHTML("beforeend", icon("close", "sm"));
  close.addEventListener("click", () => dismiss(kind));
  const status =
    kind === "error"
      ? el("a", { class: "btn sm", text: "Status", attrs: { href: "/status" } })
      : null;
  // Replacing a toast whose Dismiss (or Status) has focus hands focus to the new one, so it
  // doesn't fall to <body>.
  const focused = document.activeElement;
  const refocus =
    focused instanceof HTMLElement && slot.contains(focused)
      ? (focused.matches("a") && status) || close
      : null;
  raise(host);
  slot.replaceChildren(lines);
  if (status) slot.append(status);
  slot.append(close);
  slot.insertAdjacentHTML("afterbegin", kind === "error" ? icon("alert") : icon("check"));
  watch(kind, slot);
  refocus?.focus();
  // Replacing the content may have dropped focus from the slot without a focusout.
  const state = held.get(slot);
  if (state) state.focus = slot.contains(document.activeElement);
  if (options.sticky ?? kind === "error") lifetimes.delete(kind);
  else lifetimes.set(kind, detail ? 6000 : 3000);
  arm(kind, slot);
}

/** A sticky error toast: "Couldn't <what>", the cause and next step, the raw text, Status. */
export function errorToast(what: string, cause: unknown): void {
  if (cause instanceof ApiError)
    toast(actionTitle(what), {
      kind: "error",
      detail: cause.message,
      // validation and conflict errors already show the writer's own words.
      ...(cause.raw && !cause.message.startsWith(cause.raw) ? { raw: cause.raw } : {}),
    });
  else
    toast(actionTitle(what), {
      kind: "error",
      detail: cause instanceof Error ? cause.message : "",
    });
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
/** Leaves a success toast for the next page load (write it before reload or assign). */
export function flash(input: FlashInput): void {
  try {
    session()?.setItem(FLASH_KEY, encodeFlash(input));
  } catch {
    // Storage full or blocked: the page still reloads, without the message.
  }
}
/** Shows (and consumes) the flash the previous page left, and highlights its target rows. The
 *  highlight isn't stored, so the next navigation shows none. */
export function showFlash(): void {
  // From page load, so the control an action started from is known when its error toast shows.
  track();
  const store = session();
  let raw: string | null = null;
  try {
    raw = store?.getItem(FLASH_KEY) ?? null;
    store?.removeItem(FLASH_KEY);
  } catch {
    return;
  }
  const value = decodeFlash(raw);
  if (!value) return;
  toast(value.text, value.detail ? { detail: value.detail } : {});
  if (value.id)
    for (const node of $$(`[data-flash-target="${CSS.escape(value.id)}"]`))
      node.classList.add("flashed");
}
