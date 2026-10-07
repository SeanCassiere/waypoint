import { $ } from "./dom.js";

let timer: ReturnType<typeof setTimeout> | undefined;
/** One toast at a time, bottom centre, two seconds (spec §4.20). */
export function toast(message: string): void {
  const node = $("[data-toast]");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    node.hidden = true;
  }, 2000);
}
