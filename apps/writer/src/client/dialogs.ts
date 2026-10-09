import { icon } from "@waypoint/ui";

import { copyText, showCopied } from "./copy.ts";
import { $, $$, el } from "./dom.ts";

export interface ConfirmChoice {
  /** Accessible name of the radio group ("What happens to the link"). */
  label: string;
  /** Footer note while nothing is chosen ("Choose what happens to the link"). */
  prompt: string;
  options: readonly { value: string; title: string; detail: string | Node }[];
}
export interface ConfirmOptions {
  title: string;
  body: string | Node;
  ok: string;
  okClass?: "danger-solid" | "primary";
  /** Danger band shown above the body (Purge, Drop). */
  band?: { title: string; body: string } | undefined;
  /** The OK button stays disabled until the typed text matches (Purge, OW-14). */
  typed?:
    | {
        /** What the value matches ("title", "public ID"), or null. */
        expect: (value: string) => string | null;
        label: string;
        /** Hint while the field is empty. */
        hint: string;
        /** Hint while the field has text that matches nothing. */
        mismatch: string;
        /** Hint once something matched. */
        matched: (what: string) => string;
        /** Values listed above the field, each with a Copy button. */
        values?: readonly {
          key: string;
          label: string;
          value: string;
          mono?: boolean;
          copyLabel: string;
          copyWhat: string;
        }[];
      }
    | undefined;
  note?: string | undefined;
  /** Radio choice with no default; OK stays disabled until one is checked. */
  choice?: ConfirmChoice | undefined;
  /** Receives the checked choice value (null when the dialog has no choice). */
  run: (choice: string | null) => Promise<void>;
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
  const values = $("[data-confirm-values]", typed)!;
  const hint = $("[data-confirm-hint]", typed)!;
  const error = $("[data-confirm-error]", dialog)!;
  const note = $("[data-confirm-note]", dialog)!;
  const ok = $("[data-confirm-ok]", HTMLButtonElement, dialog)!;
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
  // The dialog is reused: replacing the body drops the previous choice, so nothing is checked.
  body.replaceChildren(options.body);
  const radios = options.choice ? choiceGroup(body, options.choice) : [];
  const chosen = () => radios.find((radio) => radio.checked)?.value ?? null;
  error.textContent = "";
  ok.className = `btn ${options.okClass ?? "danger-solid"}`;
  setBusy(ok, false, options.ok);
  // A confirm dismissed while its run was pending may have left Cancel disabled.
  cancel.disabled = false;
  typed.hidden = !options.typed;
  input.value = "";
  // The dialog is reused: every open starts with no values, no match and no "Copied" state.
  values.replaceChildren();
  values.hidden = true;
  const copies: { button: HTMLButtonElement; value: string; what: string }[] = [];
  if (options.typed) {
    $("[data-confirm-typed-label]", typed)!.textContent = options.typed.label;
    for (const item of options.typed.values ?? []) {
      const button = el("button", {
        class: "btn sm cpy",
        attrs: { type: "button", "data-copy": item.key, "aria-label": item.copyLabel },
      });
      button.insertAdjacentHTML("afterbegin", icon("copy", "sm"));
      button.append("Copy");
      copies.push({ button, value: item.value, what: item.copyWhat });
      values.append(
        el(
          "div",
          {},
          el("dt", { text: item.label }),
          el("dd", { class: item.mono ? "v mono" : "v", text: item.value }),
          el("dd", { class: "b" }, button),
        ),
      );
    }
    values.hidden = !copies.length;
  }
  // While run() is pending nothing re-enables OK: changing the choice can't start a second run.
  let busy = false;
  // Every open writes the hint once (the dialog is reused), then only on a state change.
  let hintState = "";
  const sync = () => {
    const what = options.typed ? options.typed.expect(input.value) : null;
    const matches = !options.typed || what !== null;
    const picked = !options.choice || chosen() !== null;
    const blocked = busy || !(matches && picked);
    ok.disabled = blocked;
    ok.setAttribute("aria-disabled", String(blocked));
    note.textContent = picked ? (options.note ?? "") : (options.choice?.prompt ?? "");
    if (options.typed) {
      typed.toggleAttribute("data-matched", what !== null);
      // The hint is a live region: touch it only when its state changes, so typing a long title
      // doesn't re-announce the same mismatch after every character.
      const state = what !== null ? `match:${what}` : input.value.trim() ? "mismatch" : "idle";
      if (state === hintState) return;
      hintState = state;
      if (what !== null) {
        hint.replaceChildren(options.typed.matched(what));
        hint.insertAdjacentHTML("afterbegin", icon("check", "sm"));
      } else hint.textContent = input.value.trim() ? options.typed.mismatch : options.typed.hint;
    }
  };
  sync();
  return new Promise((resolve) => {
    let done = false;
    // Escape is held off while run() is pending, but a second Escape still forces the dialog shut.
    // The run then carries on: this call stops touching the shared dialog (it may already show
    // another confirm) and resolves with the run's outcome once it settles.
    let dismissed = false;
    const controller = new AbortController();
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      controller.abort();
      if (!dismissed && dialog.open) dialog.close();
      resolve(result);
    };
    const attempt = () => {
      if (busy || ok.disabled) return;
      const value = chosen();
      busy = true;
      error.textContent = "";
      setBusy(ok, true, options.ok.endsWith("…") ? options.ok : `${options.ok}…`);
      cancel.disabled = true;
      for (const radio of radios) radio.disabled = true;
      sync();
      options
        .run(value)
        .then(() => finish(true))
        .catch((cause: unknown) => {
          if (dismissed) {
            finish(false);
            return;
          }
          busy = false;
          error.textContent = cause instanceof Error ? cause.message : "Request failed";
          setBusy(ok, false, options.ok);
          cancel.disabled = false;
          for (const radio of radios) radio.disabled = false;
          sync();
        });
    };
    const { signal } = controller;
    input.addEventListener("input", sync, { signal });
    for (const copy of copies)
      copy.button.addEventListener(
        "click",
        () => {
          showCopied(copy.button);
          void copyText(copy.value, copy.what);
        },
        { signal },
      );
    for (const radio of radios) radio.addEventListener("change", sync, { signal });
    ok.addEventListener("click", attempt, { signal });
    cancel.addEventListener("click", () => finish(false), { signal });
    dialog.addEventListener(
      "cancel",
      (event) => {
        if (busy) event.preventDefault();
      },
      { signal },
    );
    dialog.addEventListener(
      "close",
      () => {
        if (!busy) {
          finish(false);
          return;
        }
        dismissed = true;
        controller.abort();
      },
      { signal },
    );
    dialog.showModal();
    // focusVisible: Cancel shows its focus ring even when the dialog was opened with the mouse.
    (options.typed ? input : cancel).focus({ focusVisible: true });
  });
}

/** Appends the choice's radio group (no option checked) to the body; returns its radios. */
function choiceGroup(body: Element, choice: ConfirmChoice): HTMLInputElement[] {
  const radios: HTMLInputElement[] = [];
  const group = el("div", {
    class: "ch2",
    attrs: { role: "radiogroup", "aria-label": choice.label },
  });
  for (const [index, option] of choice.options.entries()) {
    // The radio's name is the option's title; its detail is the description, not part of the name.
    const titleId = `confirm-choice-${index}-title`;
    const detailId = `confirm-choice-${index}-detail`;
    const radio = el("input", {
      attrs: {
        type: "radio",
        name: "confirm-choice",
        value: option.value,
        "aria-labelledby": titleId,
        "aria-describedby": detailId,
      },
    });
    radios.push(radio);
    group.append(
      el(
        "label",
        {},
        radio,
        el("b", { text: option.title, attrs: { id: titleId } }),
        el("span", { attrs: { id: detailId } }, option.detail),
      ),
    );
  }
  body.append(group);
  return radios;
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
 * already closed, so focus falls to <body>. Remember the menu's own invoker (More or the
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
