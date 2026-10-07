import { fullDate } from "../viewer/timefmt.js";
import { registerAction } from "./actions.js";
import { api, field } from "./api.js";
import { copyText } from "./copy.js";
import { confirmDialog } from "./dialogs.js";
import { $, $$, el, run, shellRoot } from "./dom.js";
import { onCommand } from "./keys.js";
import { withTransition } from "./motion.js";
import { toast } from "./toast.js";

const DAY = 86_400_000;
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function linkState(value: unknown): string {
  const state = field(field(value, "share_link"), "state");
  return typeof state === "string" ? state : "";
}

/**
 * The share flow (spec §4.15–4.16). The dialog opens natively (commandfor); script submits
 * the JSON request, shows the one-time link, guards closing before copying, and polls
 * activation every 5 s for up to 3 minutes.
 */
export function bindShare(): void {
  const dialog = $("#share", HTMLDialogElement);
  const root = shellRoot();
  if (dialog && root) bindDialog(dialog, root);
  registerAction("close-details", (element) => {
    const details = element.closest("details");
    if (details) details.open = false;
  });
  registerAction("revoke-link", async (element) => {
    const id = element.dataset.id ?? "";
    const revoke = async () => {
      await api(`/api/share-links/${encodeURIComponent(id)}/revoke`, "POST");
    };
    if (element.dataset.confirm === "true") {
      const ok = await confirmDialog({
        title: "Revoke this link?",
        body: "People using it lose access within about a minute. You can't undo this.",
        ok: "Revoke link",
        run: revoke,
      });
      if (!ok) return;
    } else await revoke();
    toast("Revoking. It stops working within a minute.");
    const card = element.closest("[data-link]");
    withTransition(() => {
      const chip = card ? $("[data-link-state]", card) : null;
      chip?.replaceChildren(
        el("span", { class: "spin", attrs: { "aria-hidden": "true" } }),
        "Revoking",
      );
      if (chip) chip.className = "chip";
      card?.classList.add("dead");
      card?.querySelector(".row")?.remove();
    });
    setTimeout(() => location.reload(), 900);
  });
  registerAction("revoke-all", async (element) => {
    const count = Number(element.dataset.count ?? "0");
    const collection = element.dataset.collectionId;
    const ok = await confirmDialog({
      title: collection
        ? `Revoke all ${plural(count, "link")}?`
        : `Revoke all ${plural(count, "active link")}?`,
      body: `Everyone using ${count === 1 ? "it" : "them"} loses access within about a minute. You can't undo this.`,
      ok: count === 1 ? "Revoke link" : "Revoke all",
      run: async () => {
        await api(
          collection
            ? `/api/collections/${encodeURIComponent(collection)}/share-links/revoke-all`
            : "/api/share-links/revoke-all?state=active",
          "POST",
        );
      },
    });
    if (ok) location.reload();
  });
  registerAction("extend-link", async (element) => {
    const from = Number(element.dataset.from);
    const days = Number(element.dataset.days);
    await api(`/api/share-links/${encodeURIComponent(element.dataset.id ?? "")}/extend`, "POST", {
      expires_at: Math.max(from, Date.now()) + days * DAY,
    });
    toast(`Extended by ${days} days`);
    location.reload();
  });
}

function bindDialog(dialog: HTMLDialogElement, root: HTMLElement): void {
  const form = $("[data-share-form]", HTMLFormElement, dialog);
  const create = $('[data-share-step="create"]', dialog);
  const created = $('[data-share-step="created"]', dialog);
  const error = $("[data-share-error]", dialog);
  const copyButton = $("[data-share-copy]", HTMLButtonElement, dialog);
  const uncopied = $("[data-share-uncopied]", dialog);
  if (!form || !create || !created || !copyButton || !uncopied) return;
  onCommand("share", () => {
    if (!dialog.open) dialog.showModal();
  });
  // Phones start with the checklist folded, unless a warning applies (spec §4.15).
  const sees = $("[data-sees]", HTMLDetailsElement, dialog);
  if (
    sees &&
    window.matchMedia("(max-width: 760px)").matches &&
    !$$("[data-warn]", dialog).some((warn) => warn.offsetParent !== null)
  )
    sees.open = false;
  let url = "";
  let copied = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (poll) clearTimeout(poll);
    const target = new URL(location.href);
    target.searchParams.set("panel", "links");
    location.assign(target.href);
  };
  const guard = () => {
    if (!url) return false;
    if (copied) {
      finish();
      return true;
    }
    uncopied.hidden = false;
    $("[data-share-back]", uncopied)?.focus();
    return true;
  };
  dialog.addEventListener("cancel", (event) => {
    if (url) {
      event.preventDefault();
      guard();
    }
  });
  $("[data-share-done]", dialog)?.addEventListener("click", () => guard());
  $("[data-share-back]", uncopied)?.addEventListener("click", () => {
    uncopied.hidden = true;
    copyButton.focus();
  });
  $("[data-share-force]", uncopied)?.addEventListener("click", finish);
  copyButton.addEventListener("click", () =>
    run(async () => {
      await copyText(url, "link");
      copied = true;
      uncopied.hidden = true;
      copyButton.textContent = "✓ Copied";
      copyButton.classList.add("done");
    }, toast),
  );
  const paintState = (state: string) => {
    const chip = $("[data-share-state]", dialog);
    const text = $("[data-share-state-text]", dialog);
    if (!chip || !text || state !== "active") return;
    chip.className = "state ok";
    chip.replaceChildren("● Active");
    text.textContent = "Works now for anyone who has the link.";
  };
  let painted = "";
  const setState = (state: string) => {
    if (state === painted) return;
    painted = state;
    withTransition(() => paintState(state));
  };
  form.addEventListener("submit", (event) => {
    if (event.submitter?.getAttribute("formmethod") === "dialog") return;
    event.preventDefault();
    const data = new FormData(form);
    const target = data.get("target");
    const expires = data.get("expires");
    const rawLabel = data.get("label");
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    const submit = $("[data-share-submit]", HTMLButtonElement, form);
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
    }
    if (error) error.textContent = "";
    const expiresAt = expires === "never" ? null : Date.now() + Number(expires ?? 7) * DAY;
    run(
      async () => {
        try {
          const result = await api(
            `/api/collections/${encodeURIComponent(root.dataset.collectionId ?? "")}/share-links`,
            "POST",
            {
              ...(target === "only" ? { revision_id: root.dataset.revisionId } : {}),
              ...(label ? { label } : {}),
              expires_at: expiresAt,
            },
          );
          const link = field(result, "url");
          const id = field(field(result, "share_link"), "id");
          if (typeof link !== "string" || typeof id !== "string")
            throw new Error("The writer returned no link");
          url = link;
          const dialogN = dialog.dataset.n ?? "";
          const set = (selector: string, text: string) => {
            const node = $(selector, dialog);
            if (node) node.textContent = text;
          };
          set("[data-share-url]", url);
          set("[data-share-label]", label || "(no label)");
          set("[data-share-shows]", target === "only" ? `Only #${dialogN}` : "Latest revision");
          set("[data-share-expires]", expiresAt === null ? "Never" : fullDate(expiresAt, false));
          painted = linkState(result);
          withTransition(() => {
            create.hidden = true;
            created.hidden = false;
            dialog.setAttribute("aria-labelledby", "share-created-title");
            paintState(painted);
          });
          copyButton.focus();
          const started = Date.now();
          const check = () => {
            api(`/api/share-links/${encodeURIComponent(id)}`)
              .then((value) => {
                const state = linkState(value);
                setState(state);
                if (state !== "active" && Date.now() - started < 180_000)
                  poll = setTimeout(check, 5000);
              })
              .catch(() => {
                poll = setTimeout(check, 5000);
              });
          };
          poll = setTimeout(check, 5000);
        } finally {
          if (submit) {
            submit.disabled = false;
            submit.removeAttribute("aria-busy");
          }
        }
      },
      (message) => {
        if (error) error.textContent = message;
      },
    );
  });
}
