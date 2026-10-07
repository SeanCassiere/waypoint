import { pathFromRaw, rawPath, shellPath } from "./viewer-paths.js";

function errorMessage(value: unknown, status: number): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return `Request failed (${status})`;
}
async function mutate(url: string, method: string, body: object = {}): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(result, response.status));
}
function client(): void {
  document.querySelectorAll<HTMLTimeElement>("time[datetime]").forEach((time) => {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.valueOf())) time.textContent = date.toLocaleString();
  });
  const root = document.querySelector<HTMLElement>("[data-viewer]");
  const error = document.querySelector<HTMLElement>("[data-error]");
  const report = (message: string): void => {
    if (error) error.textContent = message;
  };
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      void (async () => {
        const action = button.dataset.action;
        const id = button.dataset.id;
        try {
          if ((action === "copy-latest" || action === "copy-pinned") && root) {
            const path = root.dataset.path ?? "";
            const link = shellPath(
              root.dataset.collection ?? "",
              root.dataset.revision ?? "",
              path,
              action === "copy-pinned",
              root.dataset.head,
              location.search,
              location.hash,
            );
            await navigator.clipboard.writeText(new URL(link, location.href).href);
            const original = button.textContent;
            button.textContent = "Copied";
            setTimeout(() => {
              button.textContent = original;
            }, 2000);
          } else if (action === "rename" && id) {
            const title = document.querySelector<HTMLInputElement>("[data-title]")?.value.trim();
            if (!title) throw new Error("Enter a title");
            await mutate(`/api/collections/${encodeURIComponent(id)}`, "PATCH", { title });
            document.title = `${title} · Waypoint`;
            report("Saved");
          } else if (action === "delete" && id) {
            if (confirm("Move this collection to Trash?")) {
              await mutate(`/api/collections/${encodeURIComponent(id)}`, "DELETE");
              location.assign("/");
            }
          } else if (action === "undelete" && id) {
            await mutate(`/api/collections/${encodeURIComponent(id)}/undelete`, "POST");
            location.assign("/");
          } else if (action === "purge" && id) {
            if (prompt(`Type ${id} to permanently purge this collection`) !== id) return;
            await mutate(`/api/collections/${encodeURIComponent(id)}/purge`, "POST", {
              confirm: id,
            });
            location.reload();
          } else if (action === "retry" && id) {
            await mutate(`/api/queue/${encodeURIComponent(id)}/retry`, "POST");
            location.reload();
          } else if (action === "drop" && id) {
            if (confirm("Drop this revision and its descendants?")) {
              await mutate(`/api/queue/${encodeURIComponent(id)}`, "DELETE");
              location.reload();
            }
          } else if (action === "go-revision" && root) {
            const picker = document.querySelector<HTMLSelectElement>("[data-picker]");
            if (!picker) return;
            const params = new URLSearchParams(location.search);
            params.set("fallback", "head");
            const path = root.dataset.path ?? root.dataset.head ?? "";
            const target = shellPath(
              root.dataset.collection ?? "",
              picker.value || root.dataset.revision || "",
              path,
              Boolean(picker.value),
              undefined,
              `?${params}`,
              location.hash,
            );
            location.assign(target);
          }
        } catch (cause) {
          report(cause instanceof Error ? cause.message : "Request failed");
        }
      })();
    });
  });
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
client();
