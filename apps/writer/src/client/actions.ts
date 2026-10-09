import { shellPath } from "../viewer-paths.ts";
import { plural } from "../viewer/format.ts";
import { ApiError, api, field } from "./api.ts";
import { copyText, showCopied } from "./copy.ts";
import { bindForm, confirmDialog } from "./dialogs.ts";
import { $, $$, el, run, shellRoot } from "./dom.ts";
import {
  collectionName,
  dropFlash,
  restoreFlash,
  retryFlash,
  revisionName,
  revisionsName,
  trashFlash,
} from "./feedback.ts";
import { readMark } from "./lastread.ts";
import { setPanel, showTab, togglePanel } from "./panel.ts";
import { flash } from "./toast.ts";

type Action = (element: HTMLElement) => Promise<void> | void;
type What = (element: HTMLElement) => string;
const actions = new Map<string, { action: Action; what: What | undefined }>();
/** `what` names the action for its error toast ("Couldn't <what>"); default "finish that". */
export function registerAction(name: string, action: Action, what?: What): void {
  actions.set(name, { action, what });
}

/** The revision a Retry or Drop button acts on: data-n, and data-title or the shell's title. */
function named(element: HTMLElement): { n: number | null; title: string | null } {
  const n = Number(element.dataset.n ?? "");
  return {
    n: element.dataset.n && Number.isInteger(n) ? n : null,
    title: element.dataset.title ?? shellRoot()?.dataset.title ?? null,
  };
}
const idsOf = (element: HTMLElement): string[] =>
  (element.dataset.ids ?? "").split(",").filter(Boolean);

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
  const ids = idsOf(element);
  const { n, title } = named(element);
  const done = busy(element, "Retrying…");
  try {
    for (const id of ids)
      try {
        await api(`/api/queue/${encodeURIComponent(id)}/retry`, "POST");
      } catch (error) {
        // A descendant retried with its root is no longer failed; that's fine.
        if (!(error instanceof ApiError && /not failed|not found/i.test(error.raw))) throw error;
      }
    flash({ text: retryFlash(ids.length, n, title) });
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
  const dropped = Array.isArray(numbers)
    ? numbers.filter((n: unknown): n is number => typeof n === "number")
    : [];
  const { title } = named(element);
  const self = list[0] ?? "this revision";
  const others = list.slice(1);
  const ok = await confirmDialog({
    title: "",
    band: {
      title: `Drop ${self}${others.length ? ` and its ${plural(others.length, "descendant")} (${others.join(", ")})` : ""}${title ? ` from “${title}”` : ""}?`,
      body: `${others.length ? "They're" : "It's"} removed from this writer's queue and never ${others.length ? "reach" : "reaches"} the cloud.`,
    },
    body: "Numbers of later revisions may shift. This can't be undone.",
    ok: "Drop",
    okClass: "danger-solid",
    run: async () => {
      await api(`/api/queue/${encodeURIComponent(id)}`, "DELETE");
    },
  });
  if (!ok) return;
  flash({ text: dropFlash(dropped, title) });
  location.reload();
}
async function trash(): Promise<void> {
  const root = shellRoot();
  if (!root) return;
  const linkCount = Number(root.dataset.links ?? "0");
  const ok = await confirmDialog({
    title: `Move “${root.dataset.title ?? "this collection"}” to Trash?`,
    body: `Hide this collection everywhere.${linkCount ? ` Its ${plural(linkCount, "public link")} ${linkCount === 1 ? "stops" : "stop"} working until you restore it.` : ""} You can restore it from Trash.`,
    ok: "Move to Trash",
    okClass: "danger",
    run: async () => {
      await api(
        `/api/collections/${encodeURIComponent(root.dataset.collectionId ?? "")}`,
        "DELETE",
      );
    },
  });
  if (!ok) return;
  flash({
    ...trashFlash(root.dataset.title ?? "", linkCount),
    id: root.dataset.collectionId ?? "",
  });
  location.assign("/trash");
}
async function restore(element: HTMLElement): Promise<void> {
  const id = element.dataset.id ?? "";
  const title = element.dataset.title ?? null;
  let revoked = 0;
  const after = () => {
    flash({ text: restoreFlash(title, revoked) });
    location.reload();
  };
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
    ` (${describe}). ${active.length === 1 ? "It works" : "They work"} again for anyone who has ${active.length === 1 ? "it" : "them"} within seconds.`,
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
        revoked = active.length;
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
  if (!ok) return;
  flash({ text: `Purge queued for ${collectionName(title)}` });
  location.reload();
}

const titleOf = (element: HTMLElement): string | null =>
  element.dataset.title ?? shellRoot()?.dataset.title ?? null;
registerAction("retry", retry, (element) => {
  const { n, title } = named(element);
  return `retry ${revisionsName(idsOf(element).length, n, title)}`;
});
registerAction("drop", drop, (element) => {
  const { n, title } = named(element);
  return `drop ${revisionName(n, title)}`;
});
registerAction("trash", trash, (element) => `move ${collectionName(titleOf(element))} to Trash`);
registerAction("restore", restore, (element) => `restore ${collectionName(titleOf(element))}`);
registerAction("purge", purge, (element) => `purge ${collectionName(titleOf(element))}`);
registerAction("panel-tab", (element) => showTab(element.dataset.tab ?? "files"));
registerAction("panel-close", () => setPanel(false));
registerAction("panel-toggle", () => togglePanel());
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
registerAction(
  "copy-link",
  (element) => (element.dataset.kind === "pinned" ? copyPinned() : copyLatest()),
  () => "copy the link",
);
registerAction(
  "copy-handoff",
  () => copyHandoff(),
  () => "copy the handoff block",
);
registerAction(
  "copy-text",
  async (element) => {
    await copyText(element.dataset.text ?? "", element.dataset.label ?? "text");
    if (element.classList.contains("btn")) showCopied(element);
  },
  (element) => `copy the ${element.dataset.label ?? "text"}`,
);
registerAction(
  "copy-raw",
  () => {
    const raw = $("[data-download]", HTMLAnchorElement)?.href;
    return raw ? copyText(raw, "raw URL") : undefined;
  },
  () => "copy the raw URL",
);
function bindCollectionForms(): void {
  bindForm("rename", async (form) => {
    const title = new FormData(form).get("title");
    if (typeof title !== "string" || !title.trim()) throw new Error("Enter a title");
    await api(
      `/api/collections/${encodeURIComponent(shellRoot()?.dataset.collectionId ?? "")}`,
      "PATCH",
      { title: title.trim() },
    );
    // Every mutation flashes and reloads (OW-02); only revoke updates in place.
    flash({ text: "Renamed" });
    location.reload();
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
    flash({ text: "Metadata saved" });
    location.reload();
  });
}

export function bindActions(): void {
  bindCollectionForms();
  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    const entry = target ? actions.get(target.dataset.action ?? "") : undefined;
    if (!target || !entry) return;
    // preventDefault also cancels the item's popovertargetaction="hide", so a menu item
    // closes its own menu before acting (focus may move to what the action shows).
    event.preventDefault();
    const menu = target.closest<HTMLElement>("[popover]");
    if (menu?.matches(":popover-open") && menu.popover === "auto") menu.hidePopover();
    run(
      async () => {
        await entry.action(target);
      },
      entry.what?.(target) ?? "finish that",
    );
  });
}
