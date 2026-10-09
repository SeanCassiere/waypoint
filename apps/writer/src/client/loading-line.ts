import { $ } from "./dom.ts";

/** A11Y-08: the document loading line in the collection shell. */
export interface LoadingLine {
  /** A navigation of the frame started: busy now, "Opening <path>…" after 300 ms, busy dropped after 8 s. */
  start(path: string): void;
  /** The frame fired load (or was already loaded): hide and empty the line, not busy. */
  done(): void;
}

const SHOW_AFTER_MS = 300;
const BUSY_FOR_MS = 8000;
const text = (path: string) => `Opening ${path}…`;

/** null when the page has no [data-docwrap] (image stage, download card, other pages). */
export function loadingLine(): LoadingLine | null {
  const wrap = $("[data-docwrap]");
  const line = wrap && $("[data-loading]", wrap);
  if (!wrap || !line) return null;
  const main = $("#main");
  let show: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  return {
    start(path) {
      clearTimeout(show);
      clearTimeout(fallback);
      wrap.removeAttribute("data-loaded");
      main?.setAttribute("aria-busy", "true");
      fallback = setTimeout(() => main?.removeAttribute("aria-busy"), BUSY_FOR_MS);
      // A second switch while a slow load already shows its line: the frame stays hidden (the
      // stale document never comes back) and the line names the new file at once.
      if (wrap.hasAttribute("data-opening")) {
        line.textContent = text(path);
        return;
      }
      line.textContent = "";
      // One step, no motion: the line appears and the frame (still showing the previous
      // document until the new one commits) is hidden in the same task.
      show = setTimeout(() => {
        line.textContent = text(path);
        wrap.setAttribute("data-opening", "");
      }, SHOW_AFTER_MS);
    },
    done() {
      clearTimeout(show);
      clearTimeout(fallback);
      wrap.setAttribute("data-loaded", "");
      wrap.removeAttribute("data-opening");
      line.textContent = "";
      main?.removeAttribute("aria-busy");
    },
  };
}
