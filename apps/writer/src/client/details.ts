import { buildDetailsPatch, splitTags } from "../viewer/details-patch.ts";
import { api, field } from "./api.ts";
import { $, $$, el, shellRoot } from "./dom.ts";
import { flash } from "./toast.ts";

/** Most suggested tags shown under the Tags field. */
const SUGGESTIONS = 6;

/** The `value` of every `{ value }` entry in a facets list. */
function values(list: unknown): string[] {
  return Array.isArray(list)
    ? list.flatMap((entry) => {
        const value = field(entry, "value");
        return typeof value === "string" && value ? [value] : [];
      })
    : [];
}

/** The read-only keys the form carries through (data-keep: source_host). */
function keptKeys(form: HTMLFormElement): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(form.dataset.keep ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

/**
 * The Collection details dialog (NAV-11). It opens without script (commandfor); script shows the
 * card's copy button, removes the no-script note, enables Save after the first edit, focuses the
 * opener's field (data-focus), suggests projects and tags from /api/facets on the first opening,
 * and saves with one PATCH (fields win over the extra JSON), then flashes and reloads.
 */
export function bindDetails(): void {
  for (const hidden of $$("[data-needs-js]")) hidden.hidden = false;
  const dialog = $("#details", HTMLDialogElement);
  const form = dialog && $('form[data-form="details"]', HTMLFormElement, dialog);
  const save = dialog && $("[data-details-save]", HTMLButtonElement, dialog);
  if (!dialog || !form || !save) return;
  const input = (name: string) => $(`[name="${name}"]`, HTMLInputElement, form);
  const title = input("title");
  const tags = input("tags");
  const extra = $('textarea[name="extra"]', HTMLTextAreaElement, form);
  const other = $("details.othermeta", HTMLDetailsElement, form);
  const formError = $("[data-form-error]", dialog);
  const jsonError = $("[data-json-error]", dialog);
  const suggest = $("[data-tag-suggest]", dialog);
  const projects = $("#details-projects", HTMLDataListElement);
  if (!title || !tags || !extra) return;
  $("[data-nojs]", dialog)?.remove();

  // Save enables after the first edit, and stays disabled while a save is running.
  let edited = false;
  let busy = false;
  form.addEventListener("input", () => {
    edited = true;
    if (!busy) save.disabled = false;
  });
  const clearJsonError = () => {
    extra.removeAttribute("aria-invalid");
    if (jsonError) jsonError.textContent = "";
  };
  extra.addEventListener("input", clearJsonError);

  // Suggestions: fetched once, on the first opening; a failed fetch shows nothing.
  let fetched = false;
  /** The facets' tags, once fetched. */
  let facetTags: string[] = [];
  const addTag = (button: HTMLButtonElement, tag: string) => {
    const before = tags.value.replace(/[\s,]+$/, "");
    tags.value = before ? `${before}, ${tag}` : tag;
    tags.dispatchEvent(new Event("input", { bubbles: true }));
    // Focus moves on to the next suggestion (or the field), not to <body> with the button.
    const next =
      button.nextElementSibling instanceof HTMLButtonElement
        ? button.nextElementSibling
        : button.previousElementSibling instanceof HTMLButtonElement
          ? button.previousElementSibling
          : null;
    button.remove();
    if (suggest && !$(".tagadd", suggest)) suggest.hidden = true;
    (next ?? tags).focus();
  };
  /** Up to six `+ tag` buttons for the facets' tags not already in the field. */
  const suggestTags = () => {
    if (!suggest) return;
    for (const button of $$(".tagadd", suggest)) button.remove();
    const have = new Set(splitTags(tags.value).map((tag) => tag.toLowerCase()));
    const offered = facetTags.filter((tag) => !have.has(tag.toLowerCase())).slice(0, SUGGESTIONS);
    suggest.hidden = !offered.length;
    for (const tag of offered) {
      const button = el("button", {
        class: "tagadd",
        text: `+ ${tag}`,
        attrs: { type: "button", "data-tag": tag },
      });
      button.addEventListener("click", () => addTag(button, tag));
      suggest.append(button);
    }
  };
  const fill = async () => {
    if (fetched) return;
    fetched = true;
    let facets: unknown;
    try {
      facets = await api("/api/facets");
    } catch {
      return;
    }
    projects?.replaceChildren(
      ...values(field(facets, "projects")).map((value) => el("option", { attrs: { value } })),
    );
    facetTags = values(field(facets, "tags"));
    suggestTags();
  };

  // One dialog serves Rename… and Edit details…, so closing it without saving (Cancel, Esc)
  // drops the edits: the next opening starts from the saved values, with Save disabled.
  dialog.addEventListener("close", () => {
    if (formError) formError.textContent = "";
    if (busy) return;
    form.reset();
    clearJsonError();
    if (other) other.open = false;
    edited = false;
    save.disabled = true;
    suggestTags();
  });

  // Openers name the field to focus (data-focus); without script, autofocus puts it on Title.
  // The command runs after the click's listeners, so the field is focused once the dialog is open.
  document.addEventListener("click", (event) => {
    const opener =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[commandfor="details"][data-focus]')
        : null;
    if (!opener) return;
    const name = opener.dataset.focus ?? "";
    setTimeout(() => {
      if (!dialog.open) return;
      $(`[name="${name}"]`, form)?.focus();
      void fill();
    }, 0);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled || busy) return;
    if (formError) formError.textContent = "";
    clearJsonError();
    const patch = buildDetailsPatch({
      title: title.value,
      project: input("project")?.value ?? "",
      tags: tags.value,
      extra: extra.value,
      keep: keptKeys(form),
    });
    if (!patch.ok) {
      if (patch.field === "title") {
        if (formError) formError.textContent = patch.message;
        title.focus();
      } else {
        if (jsonError) jsonError.textContent = patch.message;
        extra.setAttribute("aria-invalid", "true");
        if (other) other.open = true;
        extra.focus();
      }
      return;
    }
    busy = true;
    save.disabled = true;
    save.setAttribute("aria-busy", "true");
    const id = shellRoot()?.dataset.collectionId ?? "";
    api(`/api/collections/${encodeURIComponent(id)}`, "PATCH", patch.body)
      .then(() => {
        // Every mutation flashes and reloads (OW-02).
        flash({ text: "Details saved" });
        location.reload();
      })
      .catch((cause: unknown) => {
        if (formError)
          formError.textContent = cause instanceof Error ? cause.message : "Request failed";
        busy = false;
        save.disabled = !edited;
        save.removeAttribute("aria-busy");
      });
  });
}
