import { escapeHtml } from "../html.ts";
import { iconSprite } from "../icons.ts";
import { publicShellCss } from "./css.ts";
import { downloadLink } from "./download.ts";
import { letterhead } from "./letterhead.ts";
import { publicShellScript } from "./script.ts";
import { imageTypeLabel, stageHtml } from "./stage.ts";
import { bytes, encodePathSegments, extension, showBidi } from "./text.ts";
import { files } from "./tree.ts";

export { publicShellCss, stageCss } from "./css.ts";
export { formatShellTime } from "./letterhead.ts";
export { publicShellScript } from "./script.ts";
export { IMAGE_ERROR_HEADING, imageTypeLabel, isStageImage, stageHtml } from "./stage.ts";
export { encodeLinkPath, encodePathSegments } from "./text.ts";
export {
  PUBLIC_SHELL_LIST_BUDGET,
  PUBLIC_SHELL_TAB_LIMIT,
  PUBLIC_SHELL_TREE_DEPTH,
} from "./tree.ts";
export { shellFileKind, type ShellFileKind } from "./tree.ts";

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
  /** Stored MIME type: picks the row's type icon (a document when absent). */
  mime?: string | undefined;
  /** Bytes, shown as "download · size" on files that can't be previewed. */
  size?: number | null | undefined;
}
export interface PublicShellOptions {
  /** Collection title; the document `<title>` is `<current file's name> · <title>`. */
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
  /** Single-revision links: when the snapshot was created ("Taken …"). Wins over updatedAt. */
  snapshotAt: number | null;
  /** The link's own expiry in ms; null = no end date; undefined (omitted) = unknown, e.g. the writer's preview. */
  expiresAt?: number | null;
  /** "Now" for the expiry thresholds (ms). Defaults to Date.now(); the reader passes its clock. */
  now?: number;
  /** RX-11: a newer revision of a following link's collection is still syncing; ignored for snapshots. */
  syncing?: boolean;
  /** Show a download card instead of the iframe (content that can't be previewed). */
  download?: { mime: string; size: number | null } | null;
  /** RX-04: show the image on the stage instead of the iframe. `download` wins over it. */
  image?: { mime: string; size: number | null } | null;
  /** Serve CSS and script as external files instead of inline elements. */
  assets?: { cssHref: string; scriptHref: string } | null;
}

function documentArea(options: PublicShellOptions): string {
  const src = options.frameBase + encodePathSegments(options.current);
  if (options.download) {
    const { mime, size } = options.download;
    // Bidi controls in a file name could spoof its extension ("invoice\u202Efdp.exe").
    const shown = showBidi(options.current);
    const name = shown.slice(shown.lastIndexOf("/") + 1);
    const meta = `${size === null ? "" : `${bytes(size)} · `}${showBidi(mime)} · can't be previewed in the browser`;
    return `<main id="main" class="scroll"><div class="dl"><div class="ic" aria-hidden="true">${escapeHtml(extension(shown))}</div><h2>${escapeHtml(shown)}</h2><p>${escapeHtml(meta)}</p><a id="doc" class="btn primary" href="${escapeHtml(src)}" download="${escapeHtml(name)}">Download</a></div></main>`;
  }
  if (options.image) {
    const shown = showBidi(options.current);
    return `<main id="main" class="imgmain">${stageHtml({
      src,
      alt: shown,
      name: shown.slice(shown.lastIndexOf("/") + 1),
      size: options.image.size === null ? null : bytes(options.image.size),
      type: imageTypeLabel(options.image.mime),
      errorHref: options.fileHref(options.current),
    })}</main>`;
  }
  return `<main id="main"><div class="docwrap"><div class="loading"><p id="loading" role="status"></p></div><iframe id="doc" class="pframe" title="${escapeHtml(showBidi(options.current))}" src="${escapeHtml(src)}" data-base="${escapeHtml(options.frameBase)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div></main>`;
}

/** Renders the complete public shell document. Cost is linear in the number of files. */
export function renderPublicShell(options: PublicShellOptions): string {
  // The location listener's prefix check relies on a whole-segment prefix.
  if (!options.frameBase.endsWith("/")) throw new Error("frameBase must end with /");
  const name = options.current.slice(options.current.lastIndexOf("/") + 1);
  const title = `${escapeHtml(showBidi(name))} · ${escapeHtml(showBidi(options.title))}`;
  // One sprite for every row's icon; same-document <use> references resolve forward.
  const sprite =
    options.files.length > 1
      ? iconSprite(["doc", "image", "table", "code", "binary", "folder"])
      : "";
  const style = options.assets
    ? `<link rel="stylesheet" href="${escapeHtml(options.assets.cssHref)}">`
    : `<style>${publicShellCss}</style>`;
  const script = options.assets
    ? `<script src="${escapeHtml(options.assets.scriptHref)}"></script>`
    : `<script>${publicShellScript}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${title}</title>${style}</head><body><a class="skip" href="#doc">Skip to document</a><div class="pwrap">${letterhead(options, options.files.length <= 1 ? downloadLink(options, "letterhead") : "")}${files(options)}</div>${documentArea(options)}${sprite}<div class="pop-scrim" aria-hidden="true"></div>${script}</body></html>`;
}
