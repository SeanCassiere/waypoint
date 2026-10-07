import { shellPath } from "../viewer-paths.js";
import { api, field } from "./api.js";
import { copyText } from "./copy.js";
import { bindForm, confirmDialog } from "./dialogs.js";
import { $, $$, el, run, shellRoot } from "./dom.js";
import { readMark } from "./lastread.js";
import { setPanel, showTab } from "./panel.js";
import { toast } from "./toast.js";

type Action = (element: HTMLElement) => Promise<void> | void;
const actions = new Map<string, Action>();
export function registerAction(name: string, action: Action): void {
  actions.set(name, action);
}
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function busy(button: HTMLElement, label: string): () => void {
  const original = [...button.childNodes];
  button.setAttribute("aria-busy", "true");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  button.replaceChildren(el("span", { class: "spin", attrs: { "aria-hidden": "true" } }), label);
  // Drop stays disabled while a retry settles (spec §5.8).
  const siblings = $$(
    "[data-action=drop]",
    HTMLButtonElement,
    button.parentElement ?? document.body,
  );
  for (const sibling of siblings) sibling.disabled = true;
  return () => {
    button.removeAttribute("aria-busy");
    if (button instanceof HTMLButtonElement) button.disabled = false;
    button.replaceChildren(...original);
    for (const sibling of siblings) sibling.disabled = false;
  };
}

export function links(): { latest: string; pinned: string } | null {
  const root = shellRoot();
  if (!root) return null;
  const collection = root.dataset.collection ?? "";
  const revision = root.dataset.revision ?? "";
  const path = root.dataset.path ?? "";
  const base = root.dataset.base ?? location.origin;
  return {
    latest: new URL(shellPath(collection, revision, path, false, root.dataset.head), base).href,
    pinned: new URL(shellPath(collection, revision, path, true), base).href,
  };
}
export function handoffText(): string {
  const root = shellRoot();
  const block = $("[data-handoff]")?.textContent?.trim() ?? "";
  if (!root) return block;
  const mark = readMark(root.dataset.collection ?? "");
  if (!mark) return block;
  let revisions: [string, number, string][] = [];
  try {
    const parsed: unknown = JSON.parse(root.dataset.revisions ?? "[]");
    if (Array.isArray(parsed))
      revisions = parsed.flatMap((item: unknown) =>
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "number" &&
        typeof item[2] === "string"
          ? [[item[0], item[1], item[2]] satisfies [string, number, string]]
          : [],
      );
  } catch {
    revisions = [];
  }
  const newer = revisions.filter(([, n]) => n > mark.n).map(([, n]) => `#${n}`);
  const line = `Owner last reviewed #${mark.n}; ${newer.length ? `new since then: ${newer.join(", ")}.` : "nothing newer since then."}`;
  return block.replace(/\nRead: /, `\n${line}\nRead: `);
}
export async function copyLatest(): Promise<void> {
  const value = links();
  if (value) await copyText(value.latest, "link to latest");
}
export async function copyPinned(): Promise<void> {
  const value = links();
  if (value) await copyText(value.pinned, "link to this revision");
}
export async function copyHandoff(): Promise<void> {
  await copyText(handoffText(), "handoff block");
}

async function retry(element: HTMLElement): Promise<void> {
  const ids = (element.dataset.ids ?? "").split(",").filter(Boolean);
  const done = busy(element, "Retrying…");
  try {
    for (const id of ids)
      try {
        await api(`/api/queue/${encodeURIComponent(id)}/retry`, "POST");
      } catch (error) {
        // A descendant retried with its root is no longer failed; that's fine.
        if (!(error instanceof Error && /not failed|not found/i.test(error.message))) throw error;
      }
    toast(ids.length === 1 ? "Retrying" : `Retrying ${ids.length} revisions`);
    location.reload();
  } catch (error) {
    done();
    throw error;
  }
}
async function drop(element: HTMLElement): Promise<void> {
  const id = element.dataset.id ?? "";
  const details = await api(`/api/queue/${encodeURIComponent(id)}/descendants`);
  const numbers = field(details, "display_numbers");
  const list = Array.isArray(numbers)
    ? numbers.map((n: unknown) => (typeof n === "number" ? `#${n}` : "?"))
    : [];
  const self = list[0] ?? "this revision";
  const others = list.slice(1);
  const ok = await confirmDialog({
    title: "",
    band: {
      title: `Drop ${self}${others.length ? ` and its ${plural(others.length, "descendant")} (${others.join(", ")})` : ""}?`,
      body: `${others.length ? "They're" : "It's"} removed from this writer's queue and never ${others.length ? "reach" : "reaches"} the cloud.`,
    },
    body: "Numbers of later revisions may shift. This can't be undone.",
    ok: "Drop",
    okClass: "danger-solid",
    run: async () => {
      await api(`/api/queue/${encodeURIComponent(id)}`, "DELETE");
    },
  });
  if (ok) location.reload();
}
async function trash(): Promise<void> {
  const root = shellRoot();
  if (!root) return;
  const linkCount = Number(root.dataset.links ?? "0");
  const ok = await confirmDialog({
    title: `Move “${root.dataset.title ?? "this collection"}” to Trash?`,
    body: `Hide this collection everywhere.${linkCount ? ` Its ${plural(linkCount, "public link")} stop working until you restore it.` : ""} You can restore it from Trash.`,
    ok: "Move to Trash",
    okClass: "danger",
    run: async () => {
      await api(
        `/api/collections/${encodeURIComponent(root.dataset.collectionId ?? "")}`,
        "DELETE",
      );
    },
  });
  if (ok) location.assign("/trash");
}
async function restore(element: HTMLElement): Promise<void> {
  const id = element.dataset.id ?? "";
  const after = () => (element.dataset.then === "reload" ? location.reload() : location.reload());
  let active: { id: string; label: string | null; revision_display_number: number | null }[] = [];
  try {
    const parsed: unknown = JSON.parse(element.dataset.links ?? "[]");
    if (Array.isArray(parsed))
      active = parsed.flatMap((item: unknown) => {
        const linkId = field(item, "id");
        const label = field(item, "label");
        const number = field(item, "revision_display_number");
        return typeof linkId === "string"
          ? [
              {
                id: linkId,
                label: typeof label === "string" ? label : null,
                revision_display_number: typeof number === "number" ? number : null,
              },
            ]
          : [];
      });
  } catch {
    active = [];
  }
  const undelete = async () => {
    await api(`/api/collections/${encodeURIComponent(id)}/undelete`, "POST");
  };
  if (!active.length) {
    const done = busy(element, "Restoring…");
    try {
      await undelete();
      toast("Restored");
      after();
    } catch (error) {
      done();
      throw error;
    }
    return;
  }
  const describe = active
    .map(
      (link) =>
        `${link.revision_display_number === null ? "Latest" : `Only #${link.revision_display_number}`}${link.label ? `, “${link.label}”` : ""}`,
    )
    .join("; ");
  const body = el(
    "p",
    {},
    `This brings back ${plural(Number(element.dataset.revisions ?? 0), "revision")} and ${plural(Number(element.dataset.files ?? 0), "file")}, and `,
    el("b", { text: `reactivates ${plural(active.length, "public link")}` }),
    ` (${describe}). ${active.length === 1 ? "It works" : "They work"} again for anyone who has ${active.length === 1 ? "it" : "them"} within about a minute.`,
  );
  const ok = await confirmDialog({
    title: `Restore “${element.dataset.title ?? "this collection"}”?`,
    body,
    ok: "Restore",
    okClass: "primary",
    alt: {
      label: active.length === 1 ? "Restore, revoke the link" : "Restore, revoke the links",
      run: async () => {
        await api(`/api/collections/${encodeURIComponent(id)}/share-links/revoke-all`, "POST");
        await undelete();
      },
    },
    run: undelete,
  });
  if (ok) after();
}
async function purge(element: HTMLElement): Promise<void> {
  const id = element.dataset.id ?? "";
  const title = element.dataset.title ?? "";
  const linkCount = Number(element.dataset.linkCount ?? "0");
  const body = el(
    "div",
    { class: "sees" },
    el("h3", { text: "Will be erased" }),
    el(
      "div",
      { class: "row" },
      el("span", { class: "no", text: "✕", attrs: { "aria-hidden": "true" } }),
      el(
        "span",
        {},
        el("b", { text: title }),
        `: ${plural(Number(element.dataset.revisions ?? 0), "revision")}, ${plural(Number(element.dataset.files ?? 0), "file")}${linkCount ? `, ${plural(linkCount, "share link")}` : ""}`,
      ),
    ),
    el(
      "div",
      { class: "row" },
      el("span", { class: "no", text: "✕", attrs: { "aria-hidden": "true" } }),
      el("span", { text: "Blobs that no other collection uses" }),
    ),
  );
  const ok = await confirmDialog({
    title: "",
    band: {
      title: "Permanently purge this collection?",
      body: "This erases every revision and file from this writer, the cloud database, and the bucket. It can't be undone.",
    },
    body,
    typed: {
      expect: title,
      label: "Type the collection's title to confirm",
      hint: "Purge stays disabled until the title matches exactly.",
    },
    note: "Purges are queued and finish in the background; Status shows progress.",
    ok: "Purge permanently",
    okClass: "danger-solid",
    run: async () => {
      await api(`/api/collections/${encodeURIComponent(id)}/purge`, "POST", { confirm: id });
    },
  });
  if (ok) location.reload();
}

registerAction("retry", retry);
registerAction("drop", drop);
registerAction("trash", trash);
registerAction("restore", restore);
registerAction("purge", purge);
registerAction("panel-tab", (element) => showTab(element.dataset.tab ?? "files"));
registerAction("panel-close", () => setPanel(false));
registerAction("print", () => {
  const frame = $("[data-frame]", HTMLIFrameElement);
  try {
    if (frame?.contentWindow) {
      frame.contentWindow.print();
      return;
    }
  } catch {
    // Cross-origin documents can't be printed from the shell; print the page instead.
  }
  window.print();
});
registerAction("copy-link", (element) =>
  element.dataset.kind === "pinned" ? copyPinned() : copyLatest(),
);
registerAction("copy-handoff", () => copyHandoff());
registerAction("copy-text", (element) =>
  copyText(element.dataset.text ?? "", element.dataset.label ?? "text"),
);
registerAction("copy-raw", () => {
  const raw = $("[data-download]", HTMLAnchorElement)?.href;
  return raw ? copyText(raw, "raw URL") : undefined;
});
function bindCollectionForms(): void {
  bindForm("rename", async (form) => {
    const title = new FormData(form).get("title");
    if (typeof title !== "string" || !title.trim()) throw new Error("Enter a title");
    const root = shellRoot();
    await api(`/api/collections/${encodeURIComponent(root?.dataset.collectionId ?? "")}`, "PATCH", {
      title: title.trim(),
    });
    for (const node of $$("[data-title-text]")) node.textContent = title.trim();
    if (root) root.dataset.title = title.trim();
    document.title = `${title.trim()} · Waypoint`;
    toast("Renamed");
  });
  bindForm("metadata", async (form) => {
    const raw = new FormData(form).get("metadata");
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      throw new Error("Metadata must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Metadata must be a JSON object");
    await api(
      `/api/collections/${encodeURIComponent(shellRoot()?.dataset.collectionId ?? "")}`,
      "PATCH",
      { metadata: parsed },
    );
    toast("Metadata saved");
    location.reload();
  });
}

export function bindActions(): void {
  bindCollectionForms();
  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    const action = target ? actions.get(target.dataset.action ?? "") : undefined;
    if (!target || !action) return;
    event.preventDefault();
    run(async () => {
      await action(target);
    }, toast);
  });
}
