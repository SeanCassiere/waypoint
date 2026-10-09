import { icon, iconUse } from "../icons.ts";
import type { PublicShellFile, PublicShellOptions } from "./index.ts";
import { bytes, esc, label } from "./text.ts";

/** Tabs up to this many files; a "Files N" tree above it (spec §9). */
export const PUBLIC_SHELL_TAB_LIMIT = 8;
/** Tree folders start collapsed above this many files, except the current file's (spec §4.9). */
const OPEN_FOLDERS_LIMIT = 200;

/** Folders nest at most this deep in the tree; deeper segments join the file's label. */
export const PUBLIC_SHELL_TREE_DEPTH = 6;
/**
 * Upper bound on the size of the file-list markup, in characters (non-ASCII names count
 * triple), row icons and download markers included. Past it the list stops with a count of the
 * files not listed, so pathological manifests (very long, deep or non-ASCII paths) can't blow the
 * Worker CPU budget.
 */
export const PUBLIC_SHELL_LIST_BUDGET = 340_000;

/** A file's type icon in the tabs and the tree (RX-03); `binary` files can't be previewed. */
export type ShellFileKind = "doc" | "image" | "table" | "code" | "binary";
// Mirrors the reader's `previewable` (isTextMime or image/*) without depending on @waypoint/core;
// apps/reader/tests/reader-files.test.ts keeps the two in step.
const textApplications = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/toml",
  "application/x-toml",
  "application/ndjson",
  "application/x-ndjson",
]);
const structuredSuffix = /^application\/[\w.+-]+\+(?:json|xml|yaml)$/;
const codeText = new Set([
  "text/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-shellscript",
  "text/css",
  "text/x-diff",
  "text/xml",
]);
/** The icon kind of a stored MIME type; a file without one shows as a document. */
export function shellFileKind(mime: string | undefined): ShellFileKind {
  if (!mime) return "doc";
  const essence = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (essence.startsWith("image/")) return "image";
  if (essence === "text/csv" || essence === "text/tab-separated-values") return "table";
  if (essence.startsWith("text/")) return codeText.has(essence) ? "code" : "doc";
  return textApplications.has(essence) || structuredSuffix.test(essence) ? "code" : "binary";
}

const nonAscii = /[^ -~\t\n\r]/;
interface Budget {
  used: number;
  listed: number;
  /** The last row's MIME type and kind: most rows share their neighbour's type. */
  mime: string | undefined;
  kind: ShellFileKind;
}

/**
 * One file row: a bare link with its type icon (from the page's sprite), the label, and for files
 * that can't be previewed a "download · size" marker. `popover` rows (inside the Files popover)
 * also carry `autofocus` on the current file, so opening the popover focuses it; tabs never do.
 */
function link(
  options: PublicShellOptions,
  file: PublicShellFile,
  text: string,
  budget: Budget,
  popover: boolean,
): string {
  const path = file.path;
  const current =
    path === options.current ? ` aria-current="page"${popover ? " autofocus" : ""}` : "";
  if (file.mime !== budget.mime) {
    budget.mime = file.mime;
    budget.kind = shellFileKind(file.mime);
  }
  const kind = budget.kind;
  // The leading space keeps the accessible name "name download · 4.1 MB".
  const marker =
    kind !== "binary"
      ? ""
      : typeof file.size === "number"
        ? `<small> download · ${bytes(file.size)}</small>`
        : "<small> download</small>";
  const out = `<a href="${esc(options.fileHref(path))}" data-p="${esc(path)}"${current}>${iconUse(kind)}${label(text)}${marker}</a>`;
  // Count UTF-8 bytes roughly: non-ASCII names cost up to three bytes per character.
  budget.used += nonAscii.test(path) ? out.length * 3 : out.length;
  budget.listed++;
  return out;
}

interface Folder {
  name: string;
  /** Subfolders and files, in path order. */
  entries: (Folder | PublicShellFile)[];
  folders: Map<string, Folder>;
  open: boolean;
}
const folder = (name: string): Folder => ({ name, entries: [], folders: new Map(), open: false });
const isFolder = (entry: Folder | PublicShellFile | undefined): entry is Folder =>
  entry !== undefined && "entries" in entry;

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
    if (!isFolder(entry)) {
      out.push(link(options, entry, entry.path.slice(prefix), budget, true));
      continue;
    }
    // Collapse chains of folders that hold only one folder into one row.
    let child = entry;
    let name = `${child.name}/`;
    while (child.entries.length === 1 && isFolder(child.entries[0])) {
      child = child.entries[0];
      name += `${child.name}/`;
    }
    // A folder holding a single file shows as that file, labelled with its folders.
    const only = child.entries.length === 1 ? child.entries[0] : undefined;
    if (only && !isFolder(only)) {
      out.push(link(options, only, only.path.slice(prefix), budget, true));
      continue;
    }
    const open = openAll || child.open ? " open" : "";
    out.push(
      `<details${open}><summary dir="auto">${iconUse("folder")}${label(name)}</summary><div class="in">`,
    );
    renderFolder(options, child, prefix + name.length, openAll, budget, out);
    out.push("</div></details>");
  }
}

/** Tree of every file but the head. Linear in the total length of the paths, and bounded. */
function tree(
  options: PublicShellOptions,
  list: readonly PublicShellFile[],
  budget: Budget,
): string {
  const root = folder("");
  let previousKey: string | null = null;
  let previous = root;
  for (const file of list) {
    const key = file.path.slice(0, keyLength(file.path));
    // Fast path: sorted input keeps a folder's files together.
    if (key !== previousKey) {
      previousKey = key;
      previous = folderFor(root, key);
    }
    previous.entries.push(file);
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
  renderFolder(options, root, 0, list.length <= OPEN_FOLDERS_LIMIT, budget, out);
  return out.join("");
}

/**
 * The file list, in a `.prow` row: tabs, a "Files N" button past the tab limit that opens the tree
 * in a light-dismiss popover (a bottom sheet on phones), or "" for one file.
 */
export function files(options: PublicShellOptions): string {
  let all = options.files;
  if (all.length <= 1) return "";
  // Callers usually pass paths in order already (SQL ORDER BY path); sort only if not.
  let sorted = true;
  for (let i = 1; i < all.length && sorted; i++)
    sorted = (all[i - 1]?.path ?? "") < (all[i]?.path ?? "");
  if (!sorted) all = all.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const head = all.find((file) => file.path === options.head);
  const rest = head ? all.filter((file) => file.path !== options.head) : all;
  const budget: Budget = { used: 0, listed: 0, mime: undefined, kind: "doc" };
  if (all.length <= PUBLIC_SHELL_TAB_LIMIT) {
    const ordered = head ? [head, ...rest] : rest;
    return `<div class="prow"><nav class="ptabs2" aria-label="Files">${ordered.map((file) => link(options, file, file.path, budget, false)).join("")}</nav></div>`;
  }
  const headRow = head ? `${link(options, head, head.path, budget, true)}<hr>` : "";
  const list = tree(options, rest, budget);
  const missing = all.length - budget.listed;
  const more =
    missing > 0
      ? `<p class="more">${missing} more ${missing === 1 ? "file isn't" : "files aren't"} listed here.</p>`
      : "";
  const count = `Files <span class="n">${all.length}</span>`;
  // The current path is the button's description too; the popover is a sibling, never inside it.
  const button = `<button type="button" class="fbtn" popovertarget="files" aria-describedby="files-cur">${count}<span class="cur" id="files-cur">${iconUse(shellFileKind(all.find((file) => file.path === options.current)?.mime))}<span class="t" dir="auto">${label(options.current)}</span></span>${icon("chevronDown", "sm chev")}</button>`;
  // The heading and Done show only on phones, where the popover is a bottom sheet.
  const sheetHead = `<div class="shd"><h2 id="files-h">${count}</h2><button type="button" class="done" popovertarget="files" popovertargetaction="hide">Done</button></div>`;
  return `<div class="prow"><nav class="pfiles" aria-label="Files">${button}<div id="files" class="menu files" popover="auto"><div class="mbox tree" role="group" aria-labelledby="files-h">${sheetHead}${headRow}${list}${more}</div></div></nav></div>`;
}
