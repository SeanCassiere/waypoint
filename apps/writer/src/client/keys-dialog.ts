import { $, $$ } from "./dom.ts";

/** The shortcuts list names revisions by number on a collection page: each [data-keys-n] span
 *  ("#N", "the #N" or "#L") gets this revision's (#shell[data-n]) or the latest's
 *  (#shell[data-latest-n]) number. Without one it keeps its words ("the revision", "the newest
 *  revision"). */
export function bindKeysDialog(): void {
  const shell = $("#shell");
  if (!shell) return;
  const { n, latestN } = shell.dataset;
  for (const span of $$("#keys [data-keys-n]")) {
    const token = span.dataset.keysN ?? "";
    if (token.includes("#N") && n) span.textContent = token.replace("#N", `#${n}`);
    else if (token.includes("#L") && latestN) span.textContent = token.replace("#L", `#${latestN}`);
  }
}
