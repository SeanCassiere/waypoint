import { plural } from "../viewer/format.ts";
import { fullDate } from "../viewer/timefmt.ts";
import { registerAction } from "./actions.ts";
import { api, field } from "./api.ts";
import { copyText, showCopied } from "./copy.ts";
import { confirmDialog } from "./dialogs.ts";
import { $, $$, el, run, shellRoot } from "./dom.ts";
import { onCommand } from "./keys.ts";
import { toast } from "./toast.ts";

const DAY = 86_400_000;
/** Keep in step with STOPS_SOON and NOT_PUSHED in viewer/pages/share.tsx. */
const STOPS_SOON = "Public access stops within seconds.";
const NOT_PUSHED = "Revoked, not yet pushed. Public access continues until it syncs.";

function linkState(value: unknown): string {
  const state = field(field(value, "share_link"), "state");
  return typeof state === "string" ? state : "";
}

/** The revocation note on a card (Links tab) or row (/links): pushed yet, or not. */
function setRevokeNote(holder: HTMLElement, pushed: boolean | null): void {
  let note = $("[data-stops]", holder);
  if (pushed === null) {
    note?.remove();
    return;
  }
  if (!note) {
    const meta = $(":scope > .s", holder);
    note = el(meta ? "span" : "p", { class: meta ? "stops" : "note stops" });
    if (meta) meta.append(note);
    else holder.append(note);
  }
  note.dataset.stops = String(pushed);
  note.textContent = pushed ? STOPS_SOON : NOT_PUSHED;
}

function bump(node: HTMLElement | null, by: number): void {
  if (node) node.textContent = String(Math.max(0, Number(node.textContent ?? "0") + by));
}
/** One fewer active link: the Links tab count, /links segment counts and Revoke all. */
function countRevoked(): void {
  bump($("#tab-links .n"), -1);
  bump($('[data-count-of="active"]'), -1);
  bump($('[data-count-of="revoked"]'), 1);
  const all = $("[data-action=revoke-all]");
  if (!all) return;
  const left = Number(all.dataset.count ?? "0") - 1;
  if (left < 2) {
    (all.closest(".lnk-foot") ?? all).remove();
    return;
  }
  all.dataset.count = String(left);
  all.textContent = `Revoke all ${left} ${all.dataset.noun ?? "links"}…`;
}

/**
 * Shows a link as revoked the moment the writer has recorded it: the card (Links tab) or row
 * (/links) loses its actions and its chip reads Revoked. Its note says whether the
 * revocation has reached the cloud yet (until then the public reader still serves the link),
 * and follows it until it has. No reload, so nothing else on the page moves.
 */
function markRevoked(holder: HTMLElement, id: string, pushed: boolean): void {
  holder.classList.add("dead");
  const chip = $("[data-link-state]", holder);
  if (chip) {
    chip.className = holder.classList.contains("r") ? "chip xs" : "chip";
    chip.dataset.linkState = "revoking";
    chip.replaceChildren("Revoked");
  }
  for (const node of $$(".row, .acts, [data-url-missing]", holder))
    if (node.parentElement === holder) node.remove();
  // Expiry no longer applies (/links rows).
  for (const node of $$("[data-live]", holder)) node.remove();
  setRevokeNote(holder, pushed);
  countRevoked();
  holder.tabIndex = -1;
  holder.focus();
  const started = Date.now();
  const check = () => {
    api(`/api/share-links/${encodeURIComponent(id)}`)
      .then((value) => {
        const link = field(value, "share_link");
        const state = field(link, "state");
        if (state === "revoked") {
          setRevokeNote(holder, null);
          return;
        }
        setRevokeNote(holder, field(link, "revocation_pushed") === true);
        if (Date.now() - started < 120_000) setTimeout(check, 2000);
      })
      .catch(() => {
        if (Date.now() - started < 120_000) setTimeout(check, 2000);
      });
  };
  setTimeout(check, 1000);
}

/**
 * The share flow (spec §4.15–4.16). The dialog opens natively (commandfor); script submits
 * the JSON request, shows the link (copyable again later from the Links tab), and polls
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
  bindInlineConfirms();
  registerAction("revoke-link", async (element) => {
    const id = element.dataset.id ?? "";
    let pushed = false;
    const revoke = async () => {
      const result = await api(`/api/share-links/${encodeURIComponent(id)}/revoke`, "POST");
      pushed = field(result, "revocation_pushed") === true;
    };
    if (element.dataset.confirm === "true") {
      const ok = await confirmDialog({
        title: "Revoke this link?",
        body: "People using it lose access within seconds. You can't undo this.",
        ok: "Revoke link",
        run: revoke,
      });
      if (!ok) return;
    } else await revoke();
    toast("Link revoked");
    const holder = element.closest<HTMLElement>("[data-link]");
    if (holder) markRevoked(holder, id, pushed);
  });
  registerAction("revoke-all", async (element) => {
    const count = Number(element.dataset.count ?? "0");
    const collection = element.dataset.collectionId;
    const ok = await confirmDialog({
      title: collection
        ? `Revoke all ${plural(count, "link")}?`
        : `Revoke all ${plural(count, "active link")}?`,
      body: `Everyone using ${count === 1 ? "it" : "them"} loses access within seconds. You can't undo this.`,
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

/**
 * Inline confirmations on link cards (Revoke…, Extend…) are <details> whose summary hides
 * while open. Focus follows: into the confirmation when it opens, back to the summary when
 * it closes (Keep, Keep as is, Esc).
 */
function bindInlineConfirms(): void {
  for (const details of $$(".lnk details.act", HTMLDetailsElement)) {
    const summary = $("summary", details);
    details.addEventListener("toggle", () => {
      if (details.open) {
        $(".pop button", details)?.focus();
        return;
      }
      const active = document.activeElement;
      if (!active || active === document.body || details.contains(active)) summary?.focus();
    });
    details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !details.open) return;
      event.preventDefault();
      details.open = false;
    });
  }
}

function bindDialog(dialog: HTMLDialogElement, root: HTMLElement): void {
  const form = $("[data-share-form]", HTMLFormElement, dialog);
  const create = $('[data-share-step="create"]', dialog);
  const created = $('[data-share-step="created"]', dialog);
  const error = $("[data-share-error]", dialog);
  const copyButton = $("[data-share-copy]", HTMLButtonElement, dialog);
  const open = $("[data-share-open]", HTMLAnchorElement, dialog);
  if (!form || !create || !created || !copyButton) return;
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
  let poll: ReturnType<typeof setTimeout> | undefined;
  // Once a link exists, closing the dialog (Done, Esc) shows it in the Links tab, where its
  // URL can be copied again.
  dialog.addEventListener("close", () => {
    if (!url) return;
    if (poll) clearTimeout(poll);
    const target = new URL(location.href);
    target.searchParams.set("panel", "links");
    location.assign(target.href);
  });
  $("[data-share-done]", dialog)?.addEventListener("click", () => dialog.close());
  copyButton.addEventListener("click", () =>
    run(async () => {
      await copyText(url, "link");
      showCopied(copyButton);
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
    paintState(state);
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
          if (open) open.href = url;
          painted = linkState(result);
          create.hidden = true;
          created.hidden = false;
          dialog.setAttribute("aria-labelledby", "share-created-title");
          paintState(painted);
          // Spec §4.16: Copy has focus once the link exists.
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
