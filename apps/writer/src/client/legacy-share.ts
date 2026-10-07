import { registerAction } from "./actions.js";
import { api, field } from "./api.js";
import { $, el, run, shellRoot } from "./dom.js";
import { toast } from "./toast.js";

/** The phase-2 share dialog, kept working until the Folio share flow lands (plan step 5). */
export function bindLegacyShare(): void {
  const root = shellRoot();
  const dialog = $("[data-share-dialog]", HTMLDialogElement);
  if (!root || !dialog) return;
  const collectionId = root.dataset.collectionId ?? "";
  const status = $("[data-share-availability]", dialog);
  async function load(): Promise<void> {
    const value = await api(`/api/collections/${encodeURIComponent(collectionId)}/share-links`);
    const items = field(value, "share_links");
    const list = $("[data-share-list]", dialog!);
    if (!list || !Array.isArray(items)) return;
    list.replaceChildren(
      ...items.map((item: unknown) => {
        const label = field(item, "label");
        const row = el("p", {
          text: `${typeof label === "string" ? label : "Untitled"} · ${String(field(item, "mode"))} · ${String(field(item, "status"))} `,
        });
        const id = field(item, "id");
        if (field(item, "status") === "active" && typeof id === "string") {
          const revoke = el("button", {
            class: "btn sm danger",
            text: "Revoke",
            attrs: { type: "button" },
          });
          revoke.addEventListener("click", () =>
            run(async () => {
              await api(`/api/share-links/${encodeURIComponent(id)}/revoke`, "POST");
              await load();
            }, toast),
          );
          row.append(revoke);
        }
        return row;
      }),
    );
  }
  registerAction("share", async () => {
    dialog.showModal();
    await load();
  });
  $("[data-share-close]", dialog)?.addEventListener("click", () => dialog.close());
  $("[data-share-copy]", dialog)?.addEventListener("click", () => {
    const url = $("[data-share-url]", HTMLInputElement, dialog)?.value;
    if (url) void navigator.clipboard.writeText(url);
  });
  $("[data-share-form]", HTMLFormElement, dialog)?.addEventListener("submit", (event) => {
    event.preventDefault();
    run(
      async () => {
        const form = event.currentTarget;
        if (!(form instanceof HTMLFormElement)) return;
        const label = $('[name="label"]', HTMLInputElement, form)?.value.trim() ?? "";
        const expiry = $('[name="expires"]', HTMLInputElement, form)?.value ?? "";
        const created = await api(
          `/api/collections/${encodeURIComponent(collectionId)}/share-links`,
          "POST",
          {
            ...(root.dataset.pinned === "true" ? { revision_id: root.dataset.revisionId } : {}),
            ...(label ? { label } : {}),
            ...(expiry ? { expires_at: new Date(expiry).valueOf() } : {}),
          },
        );
        const url = field(created, "url");
        const box = $("[data-share-created]", dialog);
        if (box) box.hidden = false;
        const input = $("[data-share-url]", HTMLInputElement, dialog);
        if (input && typeof url === "string") input.value = url;
        await load();
      },
      (message) => {
        if (status) status.textContent = message;
      },
    );
  });
}
