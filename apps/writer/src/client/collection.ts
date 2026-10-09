import { shellPath } from "../viewer-paths.ts";
import { copyHandoff, copyLatest, copyPinned } from "./actions.ts";
import { $, $$, run, shellRoot } from "./dom.ts";
import { withShellParams } from "./frame-sync.ts";
import { onCommand } from "./keys.ts";
import { rememberSheet } from "./panel.ts";
import { toast } from "./toast.ts";

/** A revision's URL for the current file, keeping the shell's panel state (?panel=history). */
function revisionUrl(rpub: string): string {
  const root = shellRoot();
  const path = root?.dataset.path ?? "";
  return `${shellPath(root?.dataset.collection ?? "", rpub, path, true)}${withShellParams(path ? "?fallback=head" : "")}`;
}

/** At an end, `end` is the server's text (data-older-end / data-newer-end), shown verbatim. */
function goRevision(rpub: string | undefined, end?: string): void {
  if (!shellRoot() || !rpub) {
    toast(end ?? "No revision in that direction");
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
  onCommand("older", () => goRevision(root.dataset.older, root.dataset.olderEnd));
  onCommand("newer", () => goRevision(root.dataset.newer, root.dataset.newerEnd));
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
