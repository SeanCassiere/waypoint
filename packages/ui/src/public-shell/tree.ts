import { icon, iconUse } from "../icons.ts";
import { downloadLink } from "./download.ts";
import type { PublicShellFile, PublicShellOptions } from "./index.ts";
import { bytes, esc, label } from "./text.ts";

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

/** A file's type icon in the tree and the Files button (RX-03); `binary` files can't be previewed. */
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
 * One file row: a bare link with its type icon (from the page's sprite; drawn by `.tree a>svg`, so
 * without the `ic` classes: 2,000 rows would carry them), the label in a `b` (the part that's cut short with an ellipsis; the script
 * sets the full path as the row's `title` on hover or focus), and for files that can't be previewed
 * a "download · size" marker. No `autofocus` here: a docked panel is open at load, and a parsed
 * `autofocus` would take the focus from the skip link; the script puts it on the current row, so
 * opening the Files sheet focuses it.
 */
function link(
  options: PublicShellOptions,
  file: PublicShellFile,
  text: string,
  budget: Budget,
): string {
  const path = file.path;
  const current = path === options.current ? ' aria-current="page"' : "";
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
  const out = `<a href="${esc(options.fileHref(path))}" data-p="${esc(path)}"${current}><svg aria-hidden="true"><use href="#i-${kind}"/></svg><b>${label(text)}</b>${marker}</a>`;
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
      out.push(link(options, entry, entry.path.slice(prefix), budget));
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
      out.push(link(options, only, only.path.slice(prefix), budget));
      continue;
    }
    const open = openAll || child.open ? " open" : "";
    out.push(
      `<details${open}><summary dir="auto">${iconUse("chevronDown", "sm")}${iconUse("folder")}${label(name)}</summary><div>`,
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

/** The Files row and panel of a shell with two or more files; null for one file. */
export interface ShellFiles {
  /** The `.prow` row under the letterhead: the panel button, then the current file's Download. */
  row: string;
  /** The `#files` panel: the "Files N" header and the tree. */
  panel: string;
}

/**
 * The file list (D74): a "Files N" button in a `.prow` row under the letterhead, and the tree in a
 * `nav#files.panel` popover beside the document. The popover is the panel at every width: from
 * WIDE_MIN the CSS shows it docked as the shell's first column without opening it, and the script
 * collapses it with `#shell.closed`; below that the button opens it natively as a side sheet (a
 * bottom sheet on phones). The current file's Download control (RX-06) ends the row; a one-file
 * shell has it in the letterhead instead, and no row or panel.
 */
export function files(options: PublicShellOptions): ShellFiles | null {
  let all = options.files;
  if (all.length <= 1) return null;
  // Callers usually pass paths in order already (SQL ORDER BY path); sort only if not.
  let sorted = true;
  for (let i = 1; i < all.length && sorted; i++)
    sorted = (all[i - 1]?.path ?? "") < (all[i]?.path ?? "");
  if (!sorted) all = all.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const head = all.find((file) => file.path === options.head);
  const rest = head ? all.filter((file) => file.path !== options.head) : all;
  const budget: Budget = { used: 0, listed: 0, mime: undefined, kind: "doc" };
  const headRow = head ? `${link(options, head, head.path, budget)}<hr>` : "";
  const list = tree(options, rest, budget);
  const missing = all.length - budget.listed;
  const more =
    missing > 0
      ? `<p class="more">${missing} more ${missing === 1 ? "file isn't" : "files aren't"} listed here.</p>`
      : "";
  const count = `Files <span class="n">${all.length}</span>`;
  const kind = shellFileKind(all.find((file) => file.path === options.current)?.mime);
  // The current path is the button's description too; the panel is a sibling, never inside it.
  const button = `<button type="button" class="fbtn ptog" popovertarget="files" aria-controls="files" aria-describedby="files-cur">${icon("panel")}${count}<span class="cur" id="files-cur">${iconUse(kind)}<span class="t" dir="auto">${label(options.current)}</span></span></button>`;
  // Done shows only on phones, where the panel is a bottom sheet.
  const header = `<div class="shd"><h2 id="files-h">${count}</h2><button type="button" class="done" popovertarget="files" popovertargetaction="hide">Done</button></div>`;
  return {
    row: `<div class="prow">${button}${downloadLink(options, "row")}</div>`,
    panel: `<nav id="files" class="panel" popover="auto" aria-label="Files">${header}<div class="pbody"><div class="tree">${headRow}${list}${more}</div></div></nav>`,
  };
}
