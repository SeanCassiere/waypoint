import { frameLocationHref } from "@waypoint/ui";

import { pathFromRaw, rawPath, shellPath } from "../viewer-paths.ts";
import { $, $$, el, shellRoot } from "./dom.ts";
import { loadingLine } from "./loading-line.ts";
import { refreshStatusLine } from "./status-line.ts";

/** Shell-only parameters (panel tab, full history) survive the frame's own query string. */
const SHELL_PARAMS = ["panel", "history"];
export function withShellParams(search: string): string {
  const current = new URLSearchParams(location.search);
  const own = new URLSearchParams(search);
  // The frame's query string is kept verbatim (for example "?source"); only shell keys are added.
  const extra = SHELL_PARAMS.flatMap((key) => {
    const value = current.get(key);
    return value && !own.has(key) ? [`${key}=${encodeURIComponent(value)}`] : [];
  });
  if (!extra.length) return search;
  return `${search ? `${search}&` : "?"}${extra.join("&")}`;
}

/** Shows (or replaces) the "document left Waypoint" segment in the status line. */
function frameNotice(message: string | null, back?: { href: string; label: string }): void {
  const line = $("[data-status]");
  if (!line) return;
  const had = $("[data-frame-notice]", line);
  had?.remove();
  if (!message) {
    if (had) refreshStatusLine();
    return;
  }
  const segment = el("span", { class: "seg1", attrs: { "data-frame-notice": "" } }, message);
  if (back) segment.append(" ", el("a", { text: back.label, attrs: { href: back.href } }));
  line.prepend(segment);
  refreshStatusLine();
}

/** An absolute URL without its fragment. */
function withoutHash(href: string): string {
  const url = new URL(href, location.href);
  url.hash = "";
  return url.href;
}
/** Whether pointing the frame at `next` loads a new document: a change only in the fragment
 *  fires no `load`, so it must not start the loading line (A11Y-08; RX-09 relies on this).
 *  Only a target with a fragment can be fragment-only; any other assignment loads, even back
 *  to the document the frame still shows while a slow switch is pending (A -> B -> A). */
function loadsDocument(frame: HTMLIFrameElement, next: string): boolean {
  if (!new URL(next, location.href).hash) return true;
  let current: string;
  try {
    current = frame.contentWindow?.location.href ?? frame.src;
  } catch {
    return true;
  }
  return withoutHash(current) !== withoutHash(next);
}

export function bindFrameSync(): void {
  const root = shellRoot();
  const frame = $("[data-frame]", HTMLIFrameElement);
  if (!root || root.dataset.mode !== "document") return;
  const loading = loadingLine();
  if (frame) {
    // A frame that loaded before this ran fires no further load. A cross-origin one counts as
    // loaded: reading its location throws (read first, as its contentDocument is just null).
    let loaded: boolean;
    try {
      const href = frame.contentWindow?.location.href;
      loaded = frame.contentDocument?.readyState === "complete" && href !== "about:blank";
    } catch {
      loaded = true;
    }
    if (loaded) loading?.done();
    else loading?.start(root.dataset.path ?? frame.title);
  }
  const links = $$("#tp-files a[data-file]", HTMLAnchorElement);
  const collection = root.dataset.collection ?? "";
  const revision = root.dataset.revision ?? "";
  const pinned = root.dataset.pinned === "true";
  const head = root.dataset.head ?? "";
  let keyboardOpen = false;
  function update(path: string, search: string, hash: string, fromFrame: boolean): void {
    root!.dataset.path = path;
    const matched = links.find((link) => link.dataset.file === path);
    for (const link of links)
      if (link === matched) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    frameNotice(matched ? null : "This file isn't in this revision.");
    const raw = rawPath(revision, path) + search + hash;
    for (const link of $$("[data-open-raw],[data-download-raw],[data-download]", HTMLAnchorElement))
      link.href = raw;
    const latest = $("[data-copy-preview=latest]");
    if (latest) latest.textContent = `…${shellPath(collection, revision, path, false, head)}`;
    const pinnedPreview = $("[data-copy-preview=pinned]");
    if (pinnedPreview)
      pinnedPreview.textContent = `…${shellPath(collection, revision, path, true)}`;
    if (frame) {
      frame.title = path;
      if (!fromFrame && frame.contentWindow?.location.href !== new URL(raw, location.href).href) {
        if (loadsDocument(frame, raw)) loading?.start(path);
        frame.src = raw;
      }
    }
    history.replaceState(
      null,
      "",
      shellPath(collection, revision, path, pinned, head, withShellParams(search), hash),
    );
  }
  function fromUrl(href: string): boolean {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return false;
    const path = pathFromRaw(url.pathname, revision);
    if (!path) return false;
    const matched = links.find((link) => link.dataset.file === path);
    if (matched?.dataset.embed === "false") {
      location.assign(matched.href);
      return true;
    }
    update(path, url.search, url.hash, true);
    return true;
  }
  frame?.addEventListener("load", () => {
    loading?.done();
    try {
      const href = frame.contentWindow?.location.href ?? frame.src;
      if (!fromUrl(href)) throw new Error("left");
      // Same-origin documents: Esc inside the document returns focus to the shell.
      frame.contentDocument?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") $("#tp-files a[aria-current]")?.focus();
      });
      if (keyboardOpen) frame.focus();
      keyboardOpen = false;
    } catch {
      const current = links.find((link) => link.getAttribute("aria-current") === "page");
      frameNotice("The document navigated away from Waypoint.", {
        href: current?.href ?? location.href,
        label: `Back to ${current?.dataset.file ?? "the document"}`,
      });
    }
  });
  // Renditions also report their location by postMessage (needed for the public reader's
  // sandboxed frames; redundant but harmless here). Only the frame's own window is trusted,
  // and only while it shows a same-origin document: a page the frame navigated to elsewhere
  // could post any path (D23).
  window.addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (!frameLocationHref(event.data)) return;
    // On the writer the frame is same-origin, so its live location (with the query string) is
    // authoritative. If it can't be read, the frame has left the origin; ignore the report.
    let live: string | undefined;
    try {
      live = frame.contentWindow?.location.href;
    } catch {
      return;
    }
    if (live && new URL(live).origin === location.origin) fromUrl(live);
  });
  window.addEventListener("popstate", () => {
    const prefix = shellPath(collection, revision, "", pinned);
    if (!location.pathname.startsWith(prefix)) return;
    try {
      const encoded = location.pathname.slice(prefix.length);
      const path = encoded ? encoded.split("/").map(decodeURIComponent).join("/") : head;
      update(path, location.search, location.hash, false);
    } catch {
      frameNotice("Invalid file URL.");
    }
  });
  for (const link of links)
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      if (!frame || link.dataset.embed === "false") {
        location.assign(link.href);
        return;
      }
      keyboardOpen = event.detail === 0;
      const path = link.dataset.file ?? "";
      const raw = rawPath(revision, path);
      if (loadsDocument(frame, raw)) loading?.start(path);
      frame.src = raw;
    });
}
