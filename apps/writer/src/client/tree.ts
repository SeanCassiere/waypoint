import { $, $$, shellRoot } from "./dom.ts";

/** The open folders of one collection's Files tree, kept for the tab's session (D72). */
const KEY = "wp:tree:";
function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

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
    $("#tp-files .tree > :is(a, details > summary)")
  )?.focus();
}

/**
 * The Files tree's folders (D72): restores the folders opened earlier in this tab for this
 * collection (the current file's stay open), names and runs Expand all / Collapse all, and filters
 * large trees (every folder opens while a query is typed; clearing it puts them back).
 */
export function bindTree(): void {
  const panel = $("#tp-files");
  if (!panel) return;
  const folders = $$("details[data-dir]", HTMLDetailsElement, panel);
  const button = $("[data-tree-all]", HTMLButtonElement, panel);
  const filter = $("[data-filter]", HTMLInputElement, panel);
  const collection = shellRoot()?.dataset.collection;
  const store = collection ? session() : null;
  const key = `${KEY}${collection ?? ""}`;
  const query = () => filter?.value.trim().toLowerCase() ?? "";
  const openDirs = () =>
    folders.filter((folder) => folder.open).map((folder) => folder.dataset.dir);

  const raw = store?.getItem(key);
  if (raw) {
    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = null;
    }
    if (Array.isArray(saved)) {
      const open = new Set(saved);
      for (const folder of folders) folder.open = open.has(folder.dataset.dir);
    }
  }
  revealRow($("a[aria-current]", panel));

  const label = () => {
    if (button)
      button.textContent = folders.every((folder) => folder.open) ? "Collapse all" : "Expand all";
  };
  label();
  // toggle doesn't bubble and fires a task after the change, so this reads the live state: the
  // folders a query opened are never saved.
  panel.addEventListener(
    "toggle",
    (event) => {
      if (!(event.target instanceof HTMLDetailsElement)) return;
      label();
      if (!query()) store?.setItem(key, JSON.stringify(openDirs()));
    },
    true,
  );
  button?.addEventListener("click", () => {
    const open = !folders.every((folder) => folder.open);
    for (const folder of folders) folder.open = open;
    label();
  });

  let before: Set<string | undefined> | null = null;
  filter?.addEventListener("input", () => {
    const text = query();
    if (text && !before) before = new Set(openDirs());
    for (const link of $$("a[data-file]", HTMLAnchorElement, panel))
      link.hidden = Boolean(text) && !(link.dataset.file ?? "").toLowerCase().includes(text);
    for (const folder of folders) {
      if (text) folder.open = true;
      else if (before) folder.open = before.has(folder.dataset.dir);
      folder.hidden =
        Boolean(text) &&
        !$$("a[data-file]", HTMLAnchorElement, folder).some((link) => !link.hidden);
    }
    if (!text) before = null;
    if (button) button.disabled = Boolean(text);
    label();
  });
}
