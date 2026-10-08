import type { PublicShellOptions } from "./index.ts";
import { esc, label } from "./text.ts";

/** Tabs up to this many files; a "Files (N)" tree above it (spec §9). */
export const PUBLIC_SHELL_TAB_LIMIT = 8;
/** Tree folders start collapsed above this many files, except the current file's (spec §4.9). */
const OPEN_FOLDERS_LIMIT = 200;

/** Folders nest at most this deep in the tree; deeper segments join the file's label. */
export const PUBLIC_SHELL_TREE_DEPTH = 6;
/**
 * Upper bound on the size of the file-list markup, in characters (non-ASCII names count
 * triple). A 2,000-file manifest with ordinary names and relative links uses about a third. Past it the list stops with a count of the files not listed, so
 * pathological manifests (very long, deep or non-ASCII paths) can't blow the Worker CPU budget.
 */
export const PUBLIC_SHELL_LIST_BUDGET = 300_000;

const nonAscii = /[^ -~\t\n\r]/;
interface Budget {
  used: number;
  listed: number;
}

function link(options: PublicShellOptions, path: string, text: string, budget: Budget): string {
  const current = path === options.current ? ' aria-current="page"' : "";
  const out = `<a href="${esc(options.fileHref(path))}" data-p="${esc(path)}"${current}>${label(text)}</a>`;
  // Count UTF-8 bytes roughly: non-ASCII names cost up to three bytes per character.
  budget.used += nonAscii.test(path) ? out.length * 3 : out.length;
  budget.listed++;
  return out;
}

interface Folder {
  name: string;
  /** Subfolders and file paths, in path order. */
  entries: (Folder | string)[];
  folders: Map<string, Folder>;
  open: boolean;
}
const folder = (name: string): Folder => ({ name, entries: [], folders: new Map(), open: false });

/** Length of the folder key: the path up to its last `/`, but at most `PUBLIC_SHELL_TREE_DEPTH` folders deep. */
function keyLength(path: string): number {
  let end = 0;
  for (let depth = 0; depth < PUBLIC_SHELL_TREE_DEPTH; depth++) {
    const slash = path.indexOf("/", end);
    if (slash < 0) break;
    end = slash + 1;
  }
  return end;
}

function folderFor(root: Folder, key: string): Folder {
  let node = root;
  let start = 0;
  while (start < key.length) {
    const slash = key.indexOf("/", start);
    const name = key.slice(start, slash);
    let next = node.folders.get(name);
    if (!next) {
      next = folder(name);
      node.folders.set(name, next);
      node.entries.push(next);
    }
    node = next;
    start = slash + 1;
  }
  return node;
}

function renderFolder(
  options: PublicShellOptions,
  node: Folder,
  prefix: number,
  openAll: boolean,
  budget: Budget,
  out: string[],
): void {
  for (const entry of node.entries) {
    if (budget.used > PUBLIC_SHELL_LIST_BUDGET) return;
    if (typeof entry === "string") {
      out.push(link(options, entry, entry.slice(prefix), budget));
      continue;
    }
    // Collapse chains of folders that hold only one folder into one row.
    let child = entry;
    let name = `${child.name}/`;
    while (child.entries.length === 1 && typeof child.entries[0] !== "string") {
      child = child.entries[0]!;
      name += `${child.name}/`;
    }
    // A folder holding a single file shows as that file, labelled with its folders.
    const only = child.entries.length === 1 ? child.entries[0] : undefined;
    if (typeof only === "string") {
      out.push(link(options, only, only.slice(prefix), budget));
      continue;
    }
    const open = openAll || child.open ? " open" : "";
    out.push(`<details${open}><summary dir="auto">${label(name)}</summary><div class="in">`);
    renderFolder(options, child, prefix + name.length, openAll, budget, out);
    out.push("</div></details>");
  }
}

/** Tree of every file but the head. Linear in the total length of the paths, and bounded. */
function tree(options: PublicShellOptions, paths: readonly string[], budget: Budget): string {
  const root = folder("");
  let previousKey: string | null = null;
  let previous = root;
  for (const path of paths) {
    const key = path.slice(0, keyLength(path));
    // Fast path: sorted input keeps a folder's files together.
    if (key !== previousKey) {
      previousKey = key;
      previous = folderFor(root, key);
    }
    previous.entries.push(path);
  }
  const currentKey = options.current.slice(0, keyLength(options.current));
  let node: Folder | undefined = root;
  for (let start = 0; node && start < currentKey.length;) {
    const slash = currentKey.indexOf("/", start);
    node = node.folders.get(currentKey.slice(start, slash));
    if (node) node.open = true;
    start = slash + 1;
  }
  const out: string[] = [];
  renderFolder(options, root, 0, paths.length <= OPEN_FOLDERS_LIMIT, budget, out);
  return out.join("");
}

/** The file list: tabs, a "Files (N)" tree past the tab limit, or "" for one file. */
export function files(options: PublicShellOptions): string {
  const all = options.files.map((file) => file.path);
  if (all.length <= 1) return "";
  // Callers usually pass paths in order already (SQL ORDER BY path); sort only if not.
  let sorted = true;
  for (let i = 1; i < all.length && sorted; i++) sorted = (all[i - 1] ?? "") < (all[i] ?? "");
  if (!sorted) all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hasHead = all.includes(options.head);
  const rest = hasHead ? all.filter((path) => path !== options.head) : all;
  const budget: Budget = { used: 0, listed: 0 };
  if (all.length <= PUBLIC_SHELL_TAB_LIMIT) {
    const ordered = hasHead ? [options.head, ...rest] : rest;
    return `<nav class="ptabs2" aria-label="Files">${ordered.map((path) => link(options, path, path, budget)).join("")}</nav>`;
  }
  const head = hasHead ? `${link(options, options.head, options.head, budget)}<hr>` : "";
  const list = tree(options, rest, budget);
  const missing = all.length - budget.listed;
  const more =
    missing > 0
      ? `<p class="more">${missing} more ${missing === 1 ? "file isn't" : "files aren't"} listed here.</p>`
      : "";
  return `<nav class="pfiles" aria-label="Files"><details><summary>Files <span class="n">(${all.length})</span><span class="cur" dir="auto">${label(options.current)}</span></summary><div class="pmenu tree">${head}${list}${more}</div></details></nav>`;
}
