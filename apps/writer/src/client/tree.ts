import { TREE_STORAGE_PREFIX } from "@waypoint/ui";

import { $, $$, shellRoot } from "./dom.ts";

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const dir = (folder: HTMLDetailsElement): string => folder.dataset.dir ?? "";

/** Opens every folder holding `row`, so it can be seen and focused. */
export function revealRow(row: Element | null): void {
  for (let folder = row?.parentElement?.closest("#tp-files details"); folder;) {
    if (folder instanceof HTMLDetailsElement) folder.open = true;
    folder = folder.parentElement?.closest("#tp-files details");
  }
}

/** Where f and Find's "Files" land: the filter, else the current file, else the tree's first row
 *  (the gallery has no current file). */
export function focusFilesStart(): void {
  const current = $("#tp-files a[aria-current]");
  revealRow(current);
  (
    $("#tp-files [data-filter]") ??
    current ??
    $("#tp-files .tree > a, #tp-files .tree > details > summary")
  )?.focus();
}

/**
 * The Files tree's folders (D72): reopens the folders the reader opened earlier in this tab for
 * this collection, names and runs Expand all / Collapse all, and filters large trees (every folder
 * opens while a query is typed; clearing it puts them back). Only the reader's own choices are
 * kept (a folder's row, the button), never the folders opened to show a file or a query's matches.
 */
export function bindTree(): void {
  const panel = $("#tp-files");
  if (!panel) return;
  const folders = $$("details[data-dir]", HTMLDetailsElement, panel);
  const button = $("[data-tree-all]", HTMLButtonElement, panel);
  const filter = $("[data-filter]", HTMLInputElement, panel);
  const collection = shellRoot()?.dataset.collection;
  const store = collection ? session() : null;
  const key = `${TREE_STORAGE_PREFIX}${collection ?? ""}`;
  const query = () => filter?.value.trim().toLowerCase() ?? "";

  const chosen = new Set<string>();
  try {
    const saved: unknown = JSON.parse(store?.getItem(key) ?? "[]");
    if (Array.isArray(saved))
      for (const entry of saved) if (typeof entry === "string") chosen.add(entry);
  } catch {
    // A damaged entry is the same as none.
  }
  // Additive: the server already opened the current file's folders (or the gallery's).
  for (const folder of folders) if (chosen.has(dir(folder))) folder.open = true;
  const save = () => store?.setItem(key, JSON.stringify([...chosen]));

  const label = () => {
    if (button)
      button.textContent = folders.every((folder) => folder.open) ? "Collapse all" : "Expand all";
  };
  label();
  // A press on a folder's row (or Enter or Space on it, which clicks it) marks the folder; its
  // toggle, a task later, records the choice. toggle doesn't bubble, hence the capture.
  const pressed = new WeakSet<HTMLDetailsElement>();
  panel.addEventListener("click", (event) => {
    const summary = event.target instanceof Element ? event.target.closest("summary") : null;
    if (summary?.parentElement instanceof HTMLDetailsElement) pressed.add(summary.parentElement);
  });
  panel.addEventListener(
    "toggle",
    (event) => {
      const folder = event.target;
      if (!(folder instanceof HTMLDetailsElement)) return;
      label();
      if (!pressed.has(folder)) return;
      pressed.delete(folder);
      if (query()) return;
      if (folder.open) chosen.add(dir(folder));
      else chosen.delete(dir(folder));
      save();
    },
    true,
  );
  button?.addEventListener("click", () => {
    const open = !folders.every((folder) => folder.open);
    chosen.clear();
    for (const folder of folders) {
      folder.open = open;
      if (open) chosen.add(dir(folder));
    }
    save();
    label();
  });

  let before: Set<string> | null = null;
  filter?.addEventListener("input", () => {
    const text = query();
    if (text && !before) before = new Set(folders.filter((f) => f.open).map(dir));
    for (const link of $$("a[data-file]", HTMLAnchorElement, panel))
      link.hidden = Boolean(text) && !(link.dataset.file ?? "").toLowerCase().includes(text);
    for (const folder of folders) {
      if (text) folder.open = true;
      else if (before) folder.open = before.has(dir(folder));
      folder.hidden =
        Boolean(text) &&
        !$$("a[data-file]", HTMLAnchorElement, folder).some((link) => !link.hidden);
    }
    if (!text) before = null;
    if (button) button.disabled = Boolean(text);
    label();
  });
}
