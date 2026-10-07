import { shellPath } from "../viewer-paths.js";
import { copyHandoff, copyLatest, copyPinned } from "./actions.js";
import { $, $$, run, shellRoot } from "./dom.js";
import { onCommand } from "./keys.js";
import { toast } from "./toast.js";

function goRevision(rpub: string | undefined): void {
  const root = shellRoot();
  if (!root || !rpub) {
    toast("No revision in that direction");
    return;
  }
  const path = root.dataset.path ?? "";
  location.assign(`${shellPath(root.dataset.collection ?? "", rpub, path, true)}?fallback=head`);
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
  // Clicking a revision in a menu keeps the current file (fallback=head when it doesn't exist).
  for (const link of $$(".rv a[href*='fallback=head']", HTMLAnchorElement))
    link.addEventListener("click", () => {
      const path = root.dataset.path ?? "";
      const url = new URL(link.href);
      const rpub = /\/r\/([^/]+)\//.exec(url.pathname)?.[1];
      if (rpub)
        link.href = `${shellPath(root.dataset.collection ?? "", rpub, path, true)}?fallback=head`;
    });
}
