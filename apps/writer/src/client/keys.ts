import { $, shellRoot, storage } from "./dom.js";
import { setPanel, showTab, togglePanel, panelOpen } from "./panel.js";

export type Command =
  | "copy-latest"
  | "copy-pinned"
  | "copy-handoff"
  | "share"
  | "changes"
  | "older"
  | "newer"
  | "next-change"
  | "previous-change"
  | "escape";
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

export function bindKeys(): void {
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
    if (event.key === "Escape") {
      if (!window.matchMedia("(min-width: 1101px)").matches && panelOpen()) {
        setPanel(false);
        return;
      }
      handlers.get("escape")?.();
      return;
    }
    if (keysDisabled()) return;
    if (pendingG) {
      clearTimeout(pendingG);
      pendingG = undefined;
      if (event.key === "h") location.assign("/");
      else if (event.key === "s") location.assign("/status");
      return;
    }
    const inShell = Boolean(shellRoot());
    const run = (command: Command) => {
      const handler = handlers.get(command);
      if (!handler) return false;
      event.preventDefault();
      handler();
      return true;
    };
    switch (event.key) {
      case "/": {
        const search = $("[data-search] input", HTMLInputElement);
        event.preventDefault();
        if (search && search.offsetParent !== null) search.focus();
        else location.assign("/?q=");
        return;
      }
      case "?":
        event.preventDefault();
        openKeys();
        return;
      case "g":
        pendingG = setTimeout(() => {
          pendingG = undefined;
        }, 1000);
        return;
      case ".":
        if (inShell) {
          event.preventDefault();
          togglePanel();
        }
        return;
      case "f":
        if (inShell) {
          event.preventDefault();
          showTab("files");
          ($("[data-filter]") ?? $("#tp-files a[aria-current], #tp-files a"))?.focus();
        }
        return;
      case "h":
        if (inShell) {
          event.preventDefault();
          showTab("history");
        }
        return;
      case "[":
        run("older");
        return;
      case "]":
        run("newer");
        return;
      case "d":
        run("changes");
        return;
      case "c":
        run("copy-latest");
        return;
      case "C":
        run("copy-pinned");
        return;
      case "a":
        run("copy-handoff");
        return;
      case "s":
        run("share");
        return;
      case "j":
        run("next-change");
        return;
      case "k":
        run("previous-change");
        return;
      default:
        return;
    }
  });
}
