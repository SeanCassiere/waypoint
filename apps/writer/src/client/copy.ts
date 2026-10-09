import { icon } from "@waypoint/ui";

import { toast } from "./toast.ts";

const CHECK = icon("check");

function fallback(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-label", "Text to copy");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
/** Copies text and confirms with a toast; falls back to a selected read-only field. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`);
  } catch {
    if (fallback(text)) toast(`Copied ${what}`);
    else window.prompt(`Copy the ${what}:`, text);
  }
}

const restore = new WeakMap<HTMLElement, { timer: ReturnType<typeof setTimeout>; nodes: Node[] }>();
/** The copy → "Copied" confirmation on the button that copied (a CSS state transition). */
export function showCopied(button: HTMLElement, ms = 1600): void {
  const previous = restore.get(button);
  if (previous) clearTimeout(previous.timer);
  const nodes = previous?.nodes ?? [...button.childNodes];
  // Keep the button's width while it shows the check and "Copied", so nothing next to it moves.
  if (!previous) button.style.minWidth = `${button.getBoundingClientRect().width}px`;
  button.dataset.copied = "";
  button.replaceChildren();
  button.insertAdjacentHTML("beforeend", CHECK);
  button.append(" Copied");
  restore.set(button, {
    nodes,
    timer: setTimeout(() => {
      restore.delete(button);
      delete button.dataset.copied;
      button.replaceChildren(...nodes);
      button.style.minWidth = "";
    }, ms),
  });
}
