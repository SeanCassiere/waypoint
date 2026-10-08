import { escapeHtml } from "./html.ts";
import { tokensCss } from "./tokens.ts";

/**
 * The Folio public shell (spec §9): a quiet letterhead, the file tabs or a "Files (N)" tree,
 * and the document in a sandboxed iframe. Shared by the public reader (Workers) and the
 * writer's `?as=public` preview so both render the same page.
 *
 * Callers own every URL. The shell never builds share or capability URLs itself.
 *
 * CSP contract: the markup has no `style` attributes, no inline event handlers and no
 * external assets. All CSS is `publicShellCss` and all script is `publicShellScript`, emitted
 * as exactly one `<style>` and one `<script>` element (or as external files via `assets`), so
 * one hash each covers them.
 */
export interface PublicShellFile {
  path: string;
}
export interface PublicShellOptions {
  /** Collection title; also the document `<title>`. */
  title: string;
  /** Every file in the served revision. Order does not matter; the shell sorts by path. */
  files: readonly PublicShellFile[];
  /** The revision's head path; listed first. */
  head: string;
  /** The file being shown. */
  current: string;
  /** URL of the shell page for a file (the tab and tree links). */
  fileHref: (path: string) => string;
  /**
   * URL prefix of the raw content for this revision, ending in `/`. The iframe loads
   * `frameBase + encoded path`, and the location listener only accepts frame locations
   * under this prefix.
   */
  frameBase: string;
  /** Latest links: when the served revision was created ("Updated …"). */
  updatedAt: number | null;
  /** Single-revision links: when the snapshot was created ("Snapshot from …"). Wins over updatedAt. */
  snapshotAt: number | null;
  /** Show a download card instead of the iframe (content that can't be previewed). */
  download?: { mime: string; size: number | null } | null;
  /** Serve CSS and script as external files instead of inline elements. */
  assets?: { cssHref: string; scriptHref: string } | null;
}

/** Tabs up to this many files; a "Files (N)" tree above it (spec §9). */
export const PUBLIC_SHELL_TAB_LIMIT = 8;
/** Tree folders start collapsed above this many files, except the current file's (spec §4.9). */
const OPEN_FOLDERS_LIMIT = 200;

const shellCss = `.skip{position:absolute;left:12px;top:-60px;z-index:60;padding:8px 12px;border-radius:8px;background:var(--ink);color:var(--paper);text-decoration:none;font-weight:600}.skip:focus{top:8px}
html,body{height:100%}body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.pwrap{flex:none;position:relative;z-index:5;border-bottom:1px solid var(--rule);background:var(--paper)}
.lh{display:flex;align-items:center;gap:14px;max-width:1120px;margin:0 auto;padding:12px 20px}
.lh .ttl{min-width:0;flex:1}
.lh h1{margin:0;font:650 15px/1.3 var(--sans);letter-spacing:-.005em;overflow-wrap:anywhere}
.lh .note{margin:1px 0 0;font-size:12.5px;color:var(--muted)}
.snap{display:inline-flex;gap:5px;align-items:center;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--sunken);border:1px solid var(--rule);color:var(--ink-2)}
.pin{width:12px;height:12px;flex:none}.pin path{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ro{font-size:12px;color:var(--muted);white-space:nowrap}
.ptabs2{display:flex;gap:4px;max-width:1120px;margin:0 auto;padding:0 16px;overflow-x:auto;scrollbar-width:thin}
.ptabs2 a{display:block;padding:8px 10px 10px;font-size:13px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;outline-offset:-2px}
.ptabs2 a:hover{color:var(--ink)}
.ptabs2 a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.pfiles{max-width:1120px;margin:0 auto;padding:0 16px}
.pfiles>details{position:relative;display:inline-block;max-width:100%}
.pfiles>details>summary{display:flex;align-items:center;gap:8px;padding:8px 10px 10px;font-size:13px;font-weight:600;cursor:pointer;list-style:none;border-bottom:2px solid var(--ink);outline-offset:-2px;min-width:0}
.pfiles>details>summary::-webkit-details-marker{display:none}
.pfiles>details>summary::after{content:"";flex:none;width:6px;height:6px;margin:-3px 2px 0;border:solid var(--muted);border-width:0 1.5px 1.5px 0;rotate:45deg}
.pfiles>details[open]>summary::after{margin-top:3px;rotate:225deg}
.pfiles .n{color:var(--faint);font-weight:500}
.pfiles .cur{font-weight:500;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pmenu{position:absolute;top:calc(100% + 6px);left:0;z-index:40;width:min(440px,calc(100vw - 24px));max-height:min(70dvh,600px);overflow:auto;padding:6px;background:var(--dlg);border:1px solid var(--rule-2);border-radius:var(--r-md);box-shadow:var(--sh-2)}
.tree a,.tree summary{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:7px;text-decoration:none;color:var(--ink-2);font-size:13.5px;overflow-wrap:anywhere}
.tree a:hover,.tree summary:hover{background:var(--hover)}
.tree a[aria-current]{background:var(--sel);color:var(--on-sel);font-weight:600}
.tree summary{color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer;list-style:none}
.tree summary::-webkit-details-marker{display:none}
.tree summary::before{content:"";flex:none;width:5px;height:5px;margin:0 3px 0 1px;border:solid currentColor;border-width:0 1.5px 1.5px 0;rotate:-45deg}
.tree details[open]>summary::before{rotate:45deg}
.tree .in{padding-left:14px}
.tree hr{border:0;border-top:1px solid var(--rule);margin:6px 4px}
.tree .more{margin:6px 8px 2px;font-size:12.5px;color:var(--muted)}
.lh h1,.tree summary,.pfiles .cur{unicode-bidi:isolate}.ptabs2 a,.tree a{unicode-bidi:plaintext}
main{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--paper)}
.pframe{flex:1;display:block;width:100%;min-height:0;border:0;background:var(--paper)}
.scroll{flex:1;overflow:auto;padding:0 16px 32px}
.dl{border:1px solid var(--rule);border-radius:16px;background:var(--surface);max-width:520px;margin:12dvh auto 0;padding:28px;text-align:center;box-shadow:var(--sh-1)}
.dl .ic{width:56px;height:56px;border-radius:14px;background:var(--sunken);display:grid;place-items:center;margin:0 auto 12px;font:700 13px var(--mono);color:var(--muted)}
.dl h2{margin:0 0 4px;font:650 18px var(--mono);overflow-wrap:anywhere}
.dl p{margin:0 0 16px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);text-decoration:none;font-weight:500;box-shadow:var(--sh-1)}
@media(max-width:600px){.ro{display:none}.lh{padding:10px 14px}.ptabs2,.pfiles{padding:0 10px}.ptabs2 a,.pfiles>details>summary{min-height:44px;display:flex;align-items:center}.dl{padding:20px;margin-top:6dvh}}
@media(forced-colors:active){.ptabs2 a[aria-current],.pfiles>details>summary{border-bottom-color:CanvasText}.snap{border-color:CanvasText}.tree a[aria-current]{outline:2px solid CanvasText}}
@media print{.pwrap,.skip{display:none}html,body{height:auto;overflow:visible}.pframe{height:100vh}}
`;

/** The public shell's complete stylesheet: Folio tokens plus the shell rules. */
export const publicShellCss: string = tokensCss + shellCss;

/**
 * The shell's only script, progressive enhancement over server-rendered links:
 * - shows `<time datetime>` values in the reader's own time zone, in the spec's format
 *   ("8 Oct 2026, 02:05", as everywhere else in Waypoint);
 * - follows navigation inside the sandboxed frame. The v2 rendition template posts
 *   `{ type: "waypoint:location", href }` (spec §8). Messages are accepted only from the
 *   frame's own window, and `href` is untrusted: it must be under the frame's raw prefix
 *   and name a file already linked in the shell. The shell then moves `aria-current` and
 *   replaces its URL with that link's own server-rendered href, never with message data.
 */
export const publicShellScript = `(()=>{const M="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");const z=n=>String(n).padStart(2,"0");for(const t of document.querySelectorAll("time[datetime]")){const d=new Date(t.dateTime);if(!isNaN(d.getTime()))t.textContent=d.getDate()+" "+M[d.getMonth()]+" "+d.getFullYear()+", "+z(d.getHours())+":"+z(d.getMinutes())}const f=document.getElementById("doc");if(!f||!f.dataset.base)return;const b=new URL(f.dataset.base,location.href);const base=b.origin+b.pathname;const links=()=>document.querySelectorAll("a[data-p]");addEventListener("message",e=>{if(e.source!==f.contentWindow)return;const m=e.data;if(!m||typeof m!=="object"||m.type!=="waypoint:location"||typeof m.href!=="string"||m.href.length>8192)return;let p;try{const u=new URL(m.href,f.src);const h=u.origin+u.pathname;if(!h.startsWith(base))return;const r=h.slice(base.length);if(/%(?:2f|5c)/i.test(r))return;p=r.split("/").map(decodeURIComponent).join("/").normalize("NFC")}catch{return}let hit=null;for(const a of links())if(a.dataset.p===p){hit=a;break}if(!hit||hit.hasAttribute("aria-current"))return;for(const a of links())if(a.dataset.p===p)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");f.title=p;const c=document.querySelector(".pfiles .cur");if(c)c.textContent=p.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g,"\\ufffd");if(hit.href!==location.href)history.replaceState(null,"",hit.href)})})()`;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "7 Oct 2026, 22:08 UTC": the no-script fallback; the script localizes it. */
const pad = (n: number): string => String(n).padStart(2, "0");
export function formatShellTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : name.slice(0, 6);
}

const special = /[&<>"']/;
/** escapeHtml with a fast path: most paths and URLs need no escaping. */
const esc = (value: string): string => (special.test(value) ? escapeHtml(value) : value);

const unreserved = /^[A-Za-z0-9._~/-]*$/;
/**
 * Per-segment encodeURIComponent, cheaply: most paths need no encoding, and otherwise `%2F` can
 * only come from `/`, since a literal `%` becomes `%25`.
 */
export const encodePathSegments = (path: string): string =>
  unreserved.test(path) ? path : encodeURIComponent(path).replaceAll("%2F", "/");

// oxlint-disable-next-line eslint/no-control-regex -- Controls and spaces must be percent-encoded in URLs.
const linkUnsafe = /[\u0000- "#%<>?\\^`{|}\u007f]/g;
/**
 * A path for an HTML link, IRI style: only characters that would change how the URL parses
 * (`%`, `?`, `#`, `\`, spaces and controls, and a few that browsers escape anyway) are
 * percent-encoded. Other characters, including non-ASCII, stay as they are; the browser
 * percent-encodes them as UTF-8 when it follows the link, so the server decodes the same path.
 * Much smaller than `encodePathSegments` for non-ASCII names.
 */
export const encodeLinkPath = (path: string): string =>
  unreserved.test(path) ? path : path.replace(linkUnsafe, (char) => encodeURIComponent(char));

// Explicit bidi embeddings, overrides and isolates. In a label they could make a name read
// differently from what it is ("invoice<RLO>fdp.exe"), so labels show them as U+FFFD.
const bidiControls = /[‪-‮⁦-⁩]/g;
const showBidi = (text: string): string => text.replace(bidiControls, "�");

/** Labels longer than this are shortened in the middle; `data-p` keeps the full path. */
const LABEL_MAX = 80;
function label(text: string): string {
  let shown = text;
  if (shown.length > LABEL_MAX) {
    let head = 38;
    let tail = shown.length - 38;
    // Don't split a surrogate pair.
    if (/[\ud800-\udbff]/.test(shown.charAt(head - 1))) head--;
    if (/[\udc00-\udfff]/.test(shown.charAt(tail))) tail++;
    shown = `${shown.slice(0, head)}…${shown.slice(tail)}`;
  }
  return esc(showBidi(shown));
}

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

function files(options: PublicShellOptions): string {
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

function note(options: PublicShellOptions): string {
  if (options.snapshotAt !== null) {
    const at = new Date(options.snapshotAt).toISOString();
    return `<p class="note"><span class="snap"><svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h6M6 1.5v5L3.5 9.5h9L10 6.5v-5M8 9.5V15"/></svg>Snapshot from <time datetime="${at}">${formatShellTime(options.snapshotAt)}</time></span></p>`;
  }
  if (options.updatedAt !== null) {
    const at = new Date(options.updatedAt).toISOString();
    return `<p class="note">Updated <time datetime="${at}">${formatShellTime(options.updatedAt)}</time></p>`;
  }
  return "";
}

function documentArea(options: PublicShellOptions): string {
  const src = options.frameBase + encodePathSegments(options.current);
  if (options.download) {
    const { mime, size } = options.download;
    // Bidi controls in a file name could spoof its extension ("invoice\u202Efdp.exe").
    const shown = showBidi(options.current);
    const name = shown.slice(shown.lastIndexOf("/") + 1);
    const meta = `${size === null ? "" : `${bytes(size)} · `}${showBidi(mime)} · can't be previewed in the browser`;
    return `<main id="main" class="scroll"><div class="dl"><div class="ic" aria-hidden="true">${escapeHtml(extension(shown))}</div><h2>${escapeHtml(shown)}</h2><p>${escapeHtml(meta)}</p><a id="doc" class="btn" href="${escapeHtml(src)}" download="${escapeHtml(name)}">Download</a></div></main>`;
  }
  return `<main id="main"><iframe id="doc" class="pframe" title="${escapeHtml(showBidi(options.current))}" src="${escapeHtml(src)}" data-base="${escapeHtml(options.frameBase)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></main>`;
}

/** Renders the complete public shell document. Cost is linear in the number of files. */
export function renderPublicShell(options: PublicShellOptions): string {
  // The location listener's prefix check relies on a whole-segment prefix.
  if (!options.frameBase.endsWith("/")) throw new Error("frameBase must end with /");
  const title = escapeHtml(showBidi(options.title));
  const style = options.assets
    ? `<link rel="stylesheet" href="${escapeHtml(options.assets.cssHref)}">`
    : `<style>${publicShellCss}</style>`;
  const script = options.assets
    ? `<script src="${escapeHtml(options.assets.scriptHref)}"></script>`
    : `<script>${publicShellScript}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${title}</title>${style}</head><body><a class="skip" href="#doc">Skip to document</a><div class="pwrap"><header class="lh"><div class="ttl"><h1 dir="auto">${title}</h1>${note(options)}</div><span class="ro">Read-only · shared with you</span></header>${files(options)}</div>${documentArea(options)}${script}</body></html>`;
}
