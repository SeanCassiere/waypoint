import { matchKey } from "../viewer/keymap.ts";

/** Open things an Esc closes before the page's own Esc. The toast host is a manual popover that
 *  stays open while a toast shows (sticky errors too), so it doesn't count. */
export const OPEN_LAYER = "dialog[open], [popover]:popover-open:not([data-toast]), #shell.open";

/** True when the key goes to a text field, select or editable region. */
export function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

let bound = false;

/** Changes and Gallery pages: Esc goes to `done` (works with single-key shortcuts off), unless
 *  that press closed something. Whether anything was open is read in a capture-phase listener on
 *  window, before any other handler runs: popovers and dialogs close through the browser's own
 *  Esc handling, which doesn't prevent default, and the sheet closes in client/keys.ts. */
export function bindPageEscape(done: string, scope: "changes" | "gallery"): void {
  if (bound) return;
  bound = true;
  const command = scope === "changes" ? "changes-done" : "gallery-done";
  let wasOpen = false;
  window.addEventListener(
    "keydown",
    () => {
      wasOpen = document.querySelector(OPEN_LAYER) !== null;
    },
    { capture: true },
  );
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || wasOpen || typing(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (matchKey(event, scope)?.command !== command) return;
    event.preventDefault();
    location.assign(done);
  });
}
