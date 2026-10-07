import { $ } from "./dom.js";

let timer: ReturnType<typeof setTimeout> | undefined;
/**
 * One toast at a time, bottom centre, two seconds (spec §4.20). It's a manual popover, so it
 * joins the top layer and shows above an open modal dialog instead of under its backdrop.
 */
export function toast(message: string): void {
  const node = $("[data-toast]");
  if (!node) return;
  // Re-showing moves it above any dialog opened since it was last shown.
  if (node.matches(":popover-open")) node.hidePopover();
  node.showPopover();
  node.textContent = message;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (node.matches(":popover-open")) node.hidePopover();
  }, 2000);
}
