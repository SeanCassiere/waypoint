import { $, $$ } from "./dom.ts";

export interface ConfirmOptions {
  title: string;
  body: string | Node;
  ok: string;
  okClass?: "danger" | "danger-solid" | "primary";
  /** A third, alternative action (for example "Restore, revoke the link"). */
  alt?: { label: string; run: () => Promise<void> } | undefined;
  /** Danger band shown above the body (Purge, Drop). */
  band?: { title: string; body: string } | undefined;
  /** The OK button stays disabled until this exact text is typed. */
  typed?: { expect: string; label: string; hint: string } | undefined;
  note?: string | undefined;
  run: () => Promise<void>;
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.setAttribute("aria-busy", String(busy));
  button.disabled = busy;
  button.replaceChildren();
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spin";
    spinner.setAttribute("aria-hidden", "true");
    button.append(spinner);
  }
  button.append(label);
}

/** Fills and opens the shared confirmation dialog; resolves true when an action succeeded. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const dialog = $("#confirm", HTMLDialogElement);
  if (!dialog) return Promise.resolve(false);
  const band = $("[data-confirm-band]", dialog)!;
  const title = $("[data-confirm-title]", dialog)!;
  const body = $("[data-confirm-body]", dialog)!;
  const typed = $("[data-confirm-typed]", dialog)!;
  const input = $("input", HTMLInputElement, typed)!;
  const error = $("[data-confirm-error]", dialog)!;
  const note = $("[data-confirm-note]", dialog)!;
  const ok = $("[data-confirm-ok]", HTMLButtonElement, dialog)!;
  const alt = $("[data-confirm-alt]", HTMLButtonElement, dialog)!;
  const cancel = $("[data-confirm-cancel]", HTMLButtonElement, dialog)!;
  dialog.classList.toggle("danger", Boolean(options.band));
  band.hidden = !options.band;
  if (options.band) {
    $("[data-confirm-band-title]", band)!.textContent = options.band.title;
    $("[data-confirm-band-body]", band)!.textContent = options.band.body;
    title.hidden = true;
    dialog.setAttribute("aria-labelledby", "confirm-band-title");
  } else {
    title.hidden = false;
    dialog.setAttribute("aria-labelledby", "confirm-title");
  }
  title.textContent = options.title;
  body.replaceChildren(options.body);
  note.textContent = options.note ?? "";
  error.textContent = "";
  ok.className = `btn ${options.okClass ?? "danger"}`;
  setBusy(ok, false, options.ok);
  alt.hidden = !options.alt;
  if (options.alt) setBusy(alt, false, options.alt.label);
  typed.hidden = !options.typed;
  input.value = "";
  const sync = () => {
    const matches = !options.typed || input.value === options.typed.expect;
    ok.disabled = !matches;
    ok.setAttribute("aria-disabled", String(!matches));
  };
  if (options.typed) {
    $("[data-confirm-typed-label]", typed)!.textContent = options.typed.label;
    $("[data-confirm-hint]", typed)!.textContent = options.typed.hint;
  }
  sync();
  return new Promise((resolve) => {
    let done = false;
    const controller = new AbortController();
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      controller.abort();
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const attempt = (button: HTMLButtonElement, label: string, work: () => Promise<void>) => {
      error.textContent = "";
      setBusy(button, true, label.endsWith("…") ? label : `${label}…`);
      cancel.disabled = true;
      work()
        .then(() => finish(true))
        .catch((cause: unknown) => {
          error.textContent = cause instanceof Error ? cause.message : "Request failed";
          setBusy(button, false, label);
          cancel.disabled = false;
          sync();
        });
    };
    const { signal } = controller;
    input.addEventListener("input", sync, { signal });
    ok.addEventListener("click", () => attempt(ok, options.ok, options.run), { signal });
    if (options.alt) {
      const run = options.alt.run;
      const label = options.alt.label;
      alt.addEventListener("click", () => attempt(alt, label, run), { signal });
    }
    cancel.addEventListener("click", () => finish(false), { signal });
    dialog.addEventListener("close", () => finish(false), { signal });
    dialog.showModal();
    (options.typed ? input : cancel).focus();
  });
}

/**
 * Binds the form inside a dialog. Dialogs open natively (commandfor + command="show-modal")
 * and cancel through <form method="dialog">; script only performs the fetch on submit.
 */
export function bindForm(id: string, submit: (form: HTMLFormElement) => Promise<void>): void {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return;
  const form = $("form", HTMLFormElement, dialog);
  if (!form) return;
  const error = $("[data-form-error]", dialog);
  dialog.addEventListener("close", () => {
    if (error) error.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    if (event.submitter?.getAttribute("formmethod") === "dialog") return;
    event.preventDefault();
    const button = $("button:not([formmethod])", HTMLButtonElement, form);
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    submit(form)
      .then(() => dialog.close())
      .catch((cause: unknown) => {
        if (error) error.textContent = cause instanceof Error ? cause.message : "Request failed";
      })
      .finally(() => {
        if (button) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
  });
}

/**
 * Dialogs opened from a menu item (Rename…, Compare…, Move to Trash…, Edit metadata…,
 * Keyboard shortcuts) would return focus to that item, which sits in a popover that has
 * already closed, so focus falls to <body>. Remember the menu's own invoker (⋯ or the
 * revision pill) and focus it when the dialog closes and nothing else has focus.
 */
export function bindFocusReturn(): void {
  const invokers = new Map<string, HTMLElement>();
  let origin: HTMLElement | null = null;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const invoker = target.closest<HTMLElement>("[popovertarget]");
      const targetId = invoker?.getAttribute("popovertarget") ?? "";
      // A menu's own invoker, not the items inside it that also name it (to hide it).
      if (invoker && targetId && !invoker.closest(`[id="${CSS.escape(targetId)}"]`))
        invokers.set(targetId, invoker);
      if (document.querySelector("dialog[open]")) return;
      const control = target.closest<HTMLElement>("button, a, [tabindex]");
      const menu = control?.closest<HTMLElement>("[popover]");
      origin = (menu ? invokers.get(menu.id) : null) ?? control ?? null;
    },
    true,
  );
  for (const dialog of $$("dialog", HTMLDialogElement))
    dialog.addEventListener("close", () => {
      const back = origin;
      setTimeout(() => {
        if (document.querySelector("dialog[open]")) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (back?.isConnected && back.checkVisibility()) back.focus();
      }, 0);
    });
}

/** A text field, select or textarea inside an open dialog. */
function dialogField(node: unknown): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.matches("input, select, textarea") &&
    node.closest("dialog[open]") !== null
  );
}
/** Scrolls a dialog's field into view, above the sticky footer that scrollIntoView ignores. */
function reveal(field: HTMLElement): void {
  requestAnimationFrame(() => {
    field.scrollIntoView({ block: "nearest" });
    const dialog = field.closest("dialog");
    const footer = dialog && $$(".ft", dialog).find((ft) => ft.checkVisibility());
    if (!dialog || !footer || footer.contains(field)) return;
    const hidden = field.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
    if (hidden > 0) dialog.scrollBy(0, hidden + 8);
  });
}

/**
 * iOS on-screen keyboard: sets --kb (px) on <html> while any dialog is open; removes it otherwise.
 * iOS Safari lays the keyboard over the page without resizing it, so a phone sheet (margin-top:
 * auto, bottom: var(--kb, 0px)) would sit under the keyboard. Android resizes the layout viewport
 * instead (interactive-widget=resizes-content), so the inset there stays 0 and --kb stays unset.
 * Touch screens only: a desktop pinch-zoom shrinks the visual viewport too, with no keyboard.
 */
export function bindKeyboardInset(): void {
  const viewport = window.visualViewport;
  if (!viewport || !matchMedia("(pointer: coarse)").matches) return;
  const root = document.documentElement;
  let listening = false;
  const update = () => {
    const inset = Math.max(
      0,
      Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
    );
    const before = root.style.getPropertyValue("--kb");
    if (inset > 0) root.style.setProperty("--kb", `${inset}px`);
    else root.style.removeProperty("--kb");
    // The sheet just moved or shrank: keep the field being typed in on screen.
    const active = document.activeElement;
    if (root.style.getPropertyValue("--kb") !== before && dialogField(active)) reveal(active);
  };
  const stop = () => {
    if (document.querySelector("dialog[open]")) return;
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    root.style.removeProperty("--kb");
    listening = false;
  };
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("dialog[open]")) return;
    if (!listening) {
      listening = true;
      viewport.addEventListener("resize", update);
      viewport.addEventListener("scroll", update);
      update();
    }
    if (dialogField(target)) reveal(target);
  });
  // close doesn't bubble: capture it, so a dialog added after bind time stops the listener too.
  document.addEventListener("close", stop, true);
}
