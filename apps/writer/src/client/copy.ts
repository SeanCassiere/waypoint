import { toast } from "./toast.js";

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
