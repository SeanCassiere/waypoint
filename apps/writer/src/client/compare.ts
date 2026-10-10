import { $, shellRoot } from "./dom.ts";

/** The revision menu's Compare… picker (the dialog itself opens natively). */
export function bindCompare(): void {
  const dialog = $("#compare", HTMLDialogElement);
  const form = dialog ? $("form", HTMLFormElement, dialog) : null;
  // Without script the picker submits ?base=&head= and the server redirects.
  form?.addEventListener("submit", (event) => {
    if (event.submitter?.getAttribute("formmethod") === "dialog") return;
    event.preventDefault();
    const data = new FormData(form);
    const base = data.get("base");
    const head = data.get("head");
    const root = shellRoot();
    if (typeof base !== "string" || typeof head !== "string" || !root) return;
    const error = dialog ? $("[data-form-error]", dialog) : null;
    if (base === head) {
      if (error) error.textContent = "Choose two different revisions.";
      return;
    }
    location.assign(`/c/${root.dataset.collection ?? ""}/r/${head}/changes?base=${base}`);
  });
}
