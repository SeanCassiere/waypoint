import { shellPath } from "../viewer-paths.js";
import { copyHandoff, copyLatest, copyPinned } from "./actions.js";
import { $, $$, run, shellRoot } from "./dom.js";
import { withShellParams } from "./frame-sync.js";
import { onCommand } from "./keys.js";
import { rememberSheet } from "./panel.js";
import { toast } from "./toast.js";

/** A revision's URL for the current file, keeping the shell's panel state (?panel=history). */
function revisionUrl(rpub: string): string {
  const root = shellRoot();
  const path = root?.dataset.path ?? "";
  return `${shellPath(root?.dataset.collection ?? "", rpub, path, true)}${withShellParams(path ? "?fallback=head" : "")}`;
}

function goRevision(rpub: string | undefined): void {
  if (!shellRoot() || !rpub) {
    toast("No revision in that direction");
    return;
  }
  rememberSheet(false);
  location.assign(revisionUrl(rpub));
}

/** Collection-page keyboard commands and the revision menu's Compare… picker. */
export function bindCollection(): void {
  const root = shellRoot();
  if (!root) return;
  onCommand("copy-latest", () => run(copyLatest, toast));
  onCommand("copy-pinned", () => run(copyPinned, toast));
  onCommand("copy-handoff", () => run(copyHandoff, toast));
  onCommand("older", () => goRevision(root.dataset.older));
  onCommand("newer", () => goRevision(root.dataset.newer));
  onCommand("changes", () => {
    const target = $("[data-changes-link]", HTMLAnchorElement);
    if (target) location.assign(target.href);
    else if (root.dataset.parent)
      location.assign(
        `${shellPath(root.dataset.collection ?? "", root.dataset.revision ?? "", "", true)}changes`,
      );
    else toast("This is the first revision");
  });
  // Clicking a revision (History panel or revision menu) keeps the current file
  // (fallback=head when it doesn't exist) and the panel tab, so History stays open while you
  // step through revisions.
  for (const link of $$(".rv a", HTMLAnchorElement))
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      const rpub = /\/r\/([^/]+)\//.exec(new URL(link.href).pathname)?.[1];
      if (!rpub || link.closest(".acts")) return;
      link.href = revisionUrl(rpub);
      if (link.closest("#panel")) rememberSheet(event.detail === 0);
    });
}
