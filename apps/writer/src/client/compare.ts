import { $, $$, shellRoot } from "./dom.js";
import { onCommand } from "./keys.js";

/** Changes page: j/k move between changes, Esc returns to the document; the Compare… picker. */
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
  const page = $(".cmp");
  if (!page) return;
  const done = page.dataset.done;
  onCommand("escape", () => {
    if (done) location.assign(done);
  });
  const step = (direction: 1 | -1) => {
    const changes = $$("[data-change]").filter((node) => node.offsetParent !== null);
    if (!changes.length) return;
    const top = page.getBoundingClientRect().top + 8;
    const index = changes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const current =
      document.activeElement instanceof HTMLElement ? changes.indexOf(document.activeElement) : -1;
    const next =
      current >= 0
        ? Math.min(changes.length - 1, Math.max(0, current + direction))
        : direction === 1
          ? Math.max(0, index)
          : Math.max(0, (index < 0 ? changes.length : index) - 1);
    const target = changes[next];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  };
  onCommand("next-change", () => step(1));
  onCommand("previous-change", () => step(-1));
}
