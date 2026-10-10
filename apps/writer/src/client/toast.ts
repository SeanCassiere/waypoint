import { $, $$ } from "./dom.ts";

let timer: ReturnType<typeof setTimeout> | undefined;
/**
 * One toast at a time, bottom centre, two seconds (spec §4.20). It's a manual popover, so it
 * joins the top layer and shows above an open modal dialog instead of under its backdrop.
 * While a modal dialog is open the toast lives inside it: everything outside a modal is inert,
 * so a toast outside it would be hidden from assistive technology.
 */
export function toast(message: string): void {
  const node = $("[data-toast]");
  if (!node) return;
  const modal = $$("dialog[open]", HTMLDialogElement)
    .filter((dialog) => dialog.matches(":modal"))
    .at(-1);
  const home = modal ?? document.body;
  // Re-showing also moves it above any dialog opened since it was last shown.
  if (node.matches(":popover-open")) node.hidePopover();
  if (node.parentElement !== home) home.append(node);
  if (modal)
    // The dialog may close while the toast is up (Rename saves, then closes): move it out.
    modal.addEventListener(
      "close",
      () => {
        if (!modal.contains(node)) return;
        const showing = node.matches(":popover-open");
        if (showing) node.hidePopover();
        document.body.append(node);
        if (showing) node.showPopover();
      },
      { once: true },
    );
  node.showPopover();
  node.textContent = message;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (node.matches(":popover-open")) node.hidePopover();
  }, 2000);
}
