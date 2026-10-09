import { icon } from "../icons.ts";
import type { PublicShellOptions } from "./index.ts";
import { encodePathSegments, esc, label, showBidi } from "./text.ts";

/**
 * The current file's Download control (RX-06): a plain link to its raw URL with `?download`, which
 * the raw routes answer with the stored bytes as an attachment. Same prefix and encoding as the
 * frame's `src`, so it's same-origin with the shell and needs no `allow-downloads` in the frame's
 * sandbox. `row` ends the tab or Files row ("Download"); `letterhead` leads the letterhead actions
 * of a one-file link, labelled with the file's path in mono. Phones show the icon only (filesCss).
 * Bidi controls in the name show as U+FFFD, as in every other label.
 */
export function downloadLink(options: PublicShellOptions, place: "row" | "letterhead"): string {
  const href = options.frameBase + encodePathSegments(options.current) + "?download";
  const shown = showBidi(options.current);
  const name = shown.slice(shown.lastIndexOf("/") + 1);
  const text =
    place === "row"
      ? '<span class="lbl">Download</span>'
      : `<span class="lbl nm">${label(options.current)}</span>`;
  return `<a class="btn dlb${place === "row" ? "" : " one"}" href="${esc(href)}" download="${esc(name)}" aria-label="Download ${esc(shown)}">${icon("download")}${text}</a>`;
}
