import { pathFromRaw, rawPath, shellPath } from "../viewer-paths.js";
import { report } from "./actions.js";

export function bindFrameSync(): void {
  const root = document.querySelector<HTMLElement>("[data-viewer]");
  if (!root) return;
  if (matchMedia("(max-width: 720px)").matches)
    document.querySelector("[data-tree]")?.removeAttribute("open");
  const frame = document.querySelector<HTMLIFrameElement>("[data-frame]");
  const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-file]")];
  const collection = root.dataset.collection ?? "";
  const revision = root.dataset.revision ?? "";
  const pinned = root.dataset.pinned === "true";
  const head = root.dataset.head ?? "";
  const notice = document.querySelector<HTMLElement>("[data-frame-notice]");
  function update(path: string, search: string, hash: string, fromFrame: boolean): void {
    root!.dataset.path = path;
    const matched = links.find((link) => link.dataset.file === path);
    links.forEach((link) => {
      link.classList.toggle("current", link === matched);
      if (link === matched) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (notice) notice.textContent = matched ? "" : "This file is not in the revision.";
    const raw = rawPath(revision, path) + search + hash;
    const open = document.querySelector<HTMLAnchorElement>("[data-open-raw]");
    if (open) open.href = raw;
    const download = document.querySelector<HTMLAnchorElement>("[data-download]");
    if (download) download.href = raw;
    if (
      frame &&
      !fromFrame &&
      frame.contentWindow?.location.href !== new URL(raw, location.href).href
    )
      frame.src = raw;
    history.replaceState(
      null,
      "",
      shellPath(collection, revision, path, pinned, head, search, hash),
    );
  }
  frame?.addEventListener("load", () => {
    try {
      const frameUrl = new URL(frame.contentWindow?.location.href ?? frame.src);
      const path = pathFromRaw(frameUrl.pathname, revision);
      if (!path) return;
      const matched = links.find((link) => link.dataset.file === path);
      if (matched?.dataset.embed === "false") {
        location.assign(matched.href);
        return;
      }
      update(path, frameUrl.search, frameUrl.hash, true);
    } catch {
      report("The document left this origin.");
    }
  });
  window.addEventListener("popstate", () => {
    const prefix = shellPath(collection, revision, "", pinned);
    if (!location.pathname.startsWith(prefix)) return;
    try {
      const encoded = location.pathname.slice(prefix.length);
      const path = encoded ? encoded.split("/").map(decodeURIComponent).join("/") : head;
      update(path, location.search, location.hash, false);
    } catch {
      report("Invalid file URL.");
    }
  });
  links.forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (!frame || link.dataset.embed === "false") {
        location.assign(link.href);
        return;
      }
      frame.src = rawPath(revision, link.dataset.file ?? "");
    }),
  );
}
