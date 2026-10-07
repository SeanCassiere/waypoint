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
    const shareStatus = document.querySelector<HTMLElement>("[data-share-availability]");
    if (shareStatus?.closest("dialog[open]")) shareStatus.textContent = message;
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
          } else if (action === "share") {
            document.querySelector<HTMLDialogElement>("[data-share-dialog]")?.showModal();
            await loadShareLinks();
          }
        } catch (cause) {
          report(cause instanceof Error ? cause.message : "Request failed");
        }
      })();
    });
  });
  if (!root) return;
  type Link = {
    id: string;
    label: string | null;
    mode: string;
    status: string;
    created_at: number;
    publicly_available: boolean;
  };
  const dialog = document.querySelector<HTMLDialogElement>("[data-share-dialog]");
  dialog?.addEventListener("close", () => {
    const created = dialog.querySelector<HTMLElement>("[data-share-created]");
    if (created) created.hidden = true;
    const input = dialog.querySelector<HTMLInputElement>("[data-share-url]");
    if (input) input.value = "";
  });
  const collectionId =
    document.querySelector<HTMLButtonElement>('[data-action="delete"]')?.dataset.id;
  async function loadShareLinks(): Promise<void> {
    if (!collectionId) return;
    const response = await fetch(
      `/api/collections/${encodeURIComponent(collectionId)}/share-links`,
    );
    if (!response.ok)
      throw new Error(errorMessage((await response.json()) as unknown, response.status));
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("share_links" in value) ||
      !Array.isArray(value.share_links)
    )
      throw new Error("Invalid share-link response");
    const items: unknown[] = value.share_links;
    const links: Link[] = [];
    for (const item of items) {
      if (
        !item ||
        typeof item !== "object" ||
        !("id" in item) ||
        typeof item.id !== "string" ||
        !("mode" in item) ||
        typeof item.mode !== "string" ||
        !("status" in item) ||
        typeof item.status !== "string" ||
        !("created_at" in item) ||
        typeof item.created_at !== "number" ||
        !("publicly_available" in item) ||
        typeof item.publicly_available !== "boolean" ||
        !("label" in item) ||
        (item.label !== null && typeof item.label !== "string")
      )
        throw new Error("Invalid share link");
      links.push({
        id: item.id,
        label: item.label,
        mode: item.mode,
        status: item.status,
        created_at: item.created_at,
        publicly_available: item.publicly_available,
      });
    }
    const list = document.querySelector<HTMLElement>("[data-share-list]");
    if (!list) return;
    list.replaceChildren();
    for (const link of links) {
      const row = document.createElement("p");
      row.textContent = `${link.label ?? "Untitled"} · ${link.mode} · ${link.status} · ${new Date(link.created_at).toLocaleString()}${link.publicly_available ? "" : " · waiting for sync"} `;
      if (link.status === "active") {
        const revoke = document.createElement("button");
        revoke.textContent = "Revoke";
        revoke.addEventListener("click", () => {
          void (async () => {
            await mutate(`/api/share-links/${encodeURIComponent(link.id)}/revoke`, "POST");
            await loadShareLinks();
          })().catch((cause: unknown) =>
            report(cause instanceof Error ? cause.message : "Request failed"),
          );
        });
        row.append(revoke);
      }
      list.append(row);
    }
  }
  dialog
    ?.querySelector<HTMLButtonElement>("[data-share-close]")
    ?.addEventListener("click", () => dialog.close());
  dialog?.querySelector<HTMLButtonElement>("[data-share-copy]")?.addEventListener("click", () => {
    const url = dialog.querySelector<HTMLInputElement>("[data-share-url]")?.value;
    if (url) void navigator.clipboard.writeText(url);
  });
  dialog
    ?.querySelector<HTMLFormElement>("[data-share-form]")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        if (!collectionId) return;
        const form = event.currentTarget;
        if (!(form instanceof HTMLFormElement)) return;
        const label = form.querySelector<HTMLInputElement>('[name="label"]')?.value.trim() ?? "";
        const expiry = form.querySelector<HTMLInputElement>('[name="expires"]')?.value ?? "";
        const body = {
          ...(root.dataset.pinned === "true" ? { revision_id: root.dataset.revision } : {}),
          ...(label ? { label } : {}),
          ...(expiry ? { expires_at: new Date(expiry).valueOf() } : {}),
        };
        const response = await fetch(
          `/api/collections/${encodeURIComponent(collectionId)}/share-links`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const value: unknown = await response.json();
        if (!value || typeof value !== "object") throw new Error("Invalid share-link response");
        const data = value as { url?: string; share_link?: Link };
        if (!response.ok || !data.url) throw new Error(errorMessage(data, response.status));
        const created = dialog.querySelector<HTMLElement>("[data-share-created]");
        if (created) created.hidden = false;
        const input = dialog.querySelector<HTMLInputElement>("[data-share-url]");
        if (input) input.value = data.url;
        const availability = dialog.querySelector<HTMLElement>("[data-share-availability]");
        if (availability)
          availability.textContent = data.share_link?.publicly_available
            ? "Available publicly now"
            : "The target is not synced yet. This URL becomes available once it syncs.";
        await loadShareLinks();
      })().catch((cause: unknown) =>
        report(cause instanceof Error ? cause.message : "Request failed"),
      );
    });
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
