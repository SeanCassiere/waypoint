import { $ } from "./dom.js";

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

/** Opens a dialog that contains a `[data-form]` and submits it with `submit`. */
export function formDialog(id: string, submit: (form: HTMLFormElement) => Promise<void>): void {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return;
  const form = $("form", HTMLFormElement, dialog);
  if (!form) return;
  const error = $("[data-form-error]", dialog);
  if (error) error.textContent = "";
  if (!form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const button = $("button:not([type=button])", HTMLButtonElement, form);
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
    form.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  }
  dialog.showModal();
  $("input,textarea", form)?.focus();
}
