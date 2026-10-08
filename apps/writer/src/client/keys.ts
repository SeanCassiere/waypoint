import { matchKey, scopesFor, type KeyCommand } from "../viewer/keymap.ts";
import { $, $$, shellRoot, storage } from "./dom.ts";
import { setPanel, showTab, togglePanel, panelOpen, wide } from "./panel.ts";

// Every key is a viewer/keymap.ts entry. This listener handles the "all" and "collection" scopes;
// the Changes and gallery pages match their own entries in the pages bundle.
export type Command = KeyCommand;
const handlers = new Map<Command, () => void>();
export function onCommand(command: Command, handler: () => void): void {
  handlers.set(command, handler);
}
export function keysDisabled(): boolean {
  return storage()?.getItem("wp:keys") === "off";
}
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
export function openKeys(): void {
  const dialog = $("#keys", HTMLDialogElement);
  const toggle = $("[data-keys-off]", HTMLInputElement);
  if (toggle) toggle.checked = keysDisabled();
  dialog?.showModal();
}

/** The first rendered inline search field outside Find. */
function inlineSearch(): HTMLInputElement | undefined {
  return $$("[data-search] input", HTMLInputElement).find(
    (input) => !input.closest("#find") && input.offsetParent !== null,
  );
}

/** `/`: the first rendered inline search field outside Find, else the Find dialog, else /?q=. */
function openFind(): void {
  const search = inlineSearch();
  if (search) {
    search.focus();
    return;
  }
  const dialog = document.getElementById("find");
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
  else location.assign("/?q=");
}

/** An auto popover (a menu, the revision menu, the health popover) is open; the toast is manual
 *  and doesn't count. */
function menuOpen(): boolean {
  return $$("[popover]").some(
    (popover) => popover.popover === "auto" && popover.matches(":popover-open"),
  );
}

/** Runs a built-in command; false when it has none here (or nothing to do), so the caller tries
 *  the onCommand handlers. */
function runBuiltIn(command: KeyCommand, event: KeyboardEvent): boolean {
  const inShell = Boolean(shellRoot());
  // Not exhaustive on purpose: every other command goes to its onCommand handler (default).
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- see above.
  switch (command) {
    case "find":
      event.preventDefault();
      openFind();
      return true;
    case "keys":
      event.preventDefault();
      openKeys();
      return true;
    case "escape":
      // An open menu closes first: the browser's own Esc closes it (so no preventDefault here),
      // and the sheet behind it waits for the next press.
      if (wide() || !panelOpen() || menuOpen()) return false;
      // Closing the sheet consumes the press, so the page's own Esc doesn't also run.
      event.preventDefault();
      setPanel(false);
      return true;
    case "go-recent":
      event.preventDefault();
      location.assign("/");
      return true;
    case "go-links":
      event.preventDefault();
      location.assign("/links");
      return true;
    case "go-trash":
      event.preventDefault();
      location.assign("/trash");
      return true;
    case "go-status":
      event.preventDefault();
      location.assign("/status");
      return true;
    case "panel":
      if (!inShell) return false;
      event.preventDefault();
      togglePanel();
      return true;
    case "files":
      if (!inShell) return false;
      event.preventDefault();
      showTab("files");
      ($("[data-filter]") ?? $("#tp-files a[aria-current], #tp-files a"))?.focus();
      return true;
    case "history":
      if (!inShell) return false;
      event.preventDefault();
      showTab("history");
      return true;
    default:
      return false;
  }
}

function run(command: KeyCommand, event: KeyboardEvent): void {
  if (runBuiltIn(command, event)) return;
  const handler = handlers.get(command);
  if (!handler) return;
  event.preventDefault();
  handler();
}

/** `/?q=` (where `/` falls back to without Find): the page opens with its search field focused,
 *  so the key never leaves the user on a page with nothing focused. */
function focusEmptySearch(): void {
  if (location.pathname !== "/" || new URLSearchParams(location.search).get("q") !== "") return;
  if (document.activeElement && document.activeElement !== document.body) return;
  inlineSearch()?.focus();
}

export function bindKeys(): void {
  focusEmptySearch();
  $("[data-keys-off]", HTMLInputElement)?.addEventListener("change", (event) => {
    const box = event.currentTarget;
    if (box instanceof HTMLInputElement) storage()?.setItem("wp:keys", box.checked ? "off" : "on");
  });
  let pendingG: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing(event.target)) {
      if (
        event.key === "Escape" &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "search"
      )
        event.target.blur();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const scopes = scopesFor(document.body.dataset.page).filter(
      (scope) => scope === "all" || scope === "collection",
    );
    if (pendingG) {
      clearTimeout(pendingG);
      pendingG = undefined;
      const chord = matchKey(event, scopes, "g");
      if (chord && !keysDisabled()) run(chord.command, event);
      return;
    }
    const match = matchKey(event, scopes);
    if (!match) {
      if (event.key === "g" && !keysDisabled())
        pendingG = setTimeout(() => {
          pendingG = undefined;
        }, 1000);
      return;
    }
    if (!match.binding.always && keysDisabled()) return;
    run(match.command, event);
  });
}
