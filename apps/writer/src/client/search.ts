import { matchKey } from "../viewer/keymap.ts";
import { api, field } from "./api.ts";
import { $, $$, el } from "./dom.ts";
import { showTab } from "./panel.ts";

interface Suggestion {
  title: string;
  detail: string;
  href: string;
}
function suggestions(value: unknown): Suggestion[] {
  const items = field(value, "collections");
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    const title = field(item, "title");
    const pub = field(item, "public_id");
    const project = field(field(item, "metadata"), "project");
    const latest = field(item, "latest_revision");
    const message = field(latest, "message");
    const number = field(latest, "display_number");
    if (typeof title !== "string" || typeof pub !== "string") return [];
    const revision = `${typeof number === "number" ? `#${number} ` : ""}${typeof message === "string" ? message : ""}`;
    return [
      {
        title,
        // "{project} · #{n} {message}"
        detail: [typeof project === "string" ? project : "", revision.trim()]
          .filter(Boolean)
          .join(" · "),
        href: `/c/${pub}/`,
      },
    ];
  });
}

/** The title with every case-insensitive match of the query in <mark>. Matched in the title
 *  itself (not a lowercased copy, whose length can differ, as for "İ"), so the slices line up. */
function marked(text: string, query: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let at = 0;
  for (const match of text.matchAll(
    new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"),
  )) {
    if (match.index > at) out.push(text.slice(at, match.index));
    out.push(el("mark", { text: match[0] }));
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A filter token as a whole word; `project:` with any value. The tokens are plain letters and
 *  a colon, so they need no escaping. */
function tokenPattern(token: string): RegExp {
  return new RegExp(`(^|\\s)${token}${token.endsWith(":") ? "\\S*" : ""}(?=\\s|$)`, "g");
}

/** Toggles a filter chip's token in the input, keeping focus (and the caret) in it. */
function toggleToken(input: HTMLInputElement, token: string): void {
  const value = input.value;
  input.value = tokenPattern(token).test(value)
    ? value.replace(tokenPattern(token), " ").replace(/\s+/g, " ").trim()
    : `${value.trimEnd()}${value.trim() ? " " : ""}${token}`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * One [data-search] form: a combobox whose listbox holds a "Collections" group and an "All
 * results" group, suggested after 150 ms of idle typing (spec §4.3). Options activate on click;
 * the keys are the keymap's "find" scope. Each form holds its own input, listbox and status.
 */
function bindForm(form: HTMLFormElement): void {
  const input = $("input[role=combobox]", HTMLInputElement, form);
  const list = $("[role=listbox]", HTMLElement, form);
  const status = $("[data-search-status]", HTMLElement, form);
  if (!input || !list) return;
  const dialog = form.closest("dialog");
  const tokens = $$("[data-token]", HTMLButtonElement, form);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let typedAt = 0;
  let active = -1;
  let options: HTMLElement[] = [];
  // The input generation: every keystroke and every close bumps it, so a response (and its
  // count) for anything but the current text is dropped.
  let sequence = 0;
  const announce = (text: string) => {
    if (status) status.textContent = text;
  };
  const close = () => {
    sequence++;
    if (timer) clearTimeout(timer);
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    if (statusTimer) clearTimeout(statusTimer);
    announce("");
  };
  const highlight = (index: number) => {
    active = index;
    options.forEach((option, position) =>
      option.setAttribute("aria-selected", String(position === index)),
    );
    const option = options[index];
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const activate = (option: HTMLElement) => {
    if (option instanceof HTMLAnchorElement) location.assign(option.href);
    else form.requestSubmit();
  };
  const render = (query: string, items: Suggestion[]) => {
    const groups: HTMLElement[] = [];
    const found = items.map((item, index) =>
      el(
        "a",
        {
          attrs: {
            role: "option",
            id: `${list.id}-${index}`,
            href: item.href,
            tabindex: "-1",
            "aria-selected": "false",
          },
        },
        el("b", {}, ...marked(item.title, query)),
        el("small", { text: item.detail }),
      ),
    );
    if (found.length) {
      const heading = el("div", {
        class: "sg-h",
        text: "Collections",
        attrs: { id: `${list.id}-h`, role: "presentation" },
      });
      groups.push(
        el("div", { attrs: { role: "group", "aria-labelledby": heading.id } }, heading, ...found),
      );
    }
    const all = el(
      "div",
      { class: "all", attrs: { role: "option", id: `${list.id}-all`, "aria-selected": "false" } },
      el("span", { text: `All results for “${query}”` }),
      el("kbd", { text: "⇧↵", attrs: { "aria-hidden": "true" } }),
    );
    groups.push(el("div", { attrs: { role: "group", "aria-label": "All results" } }, all));
    options = [...found, all];
    list.replaceChildren(...groups);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(-1);
    // The count is announced 300 ms after the last keystroke, once the results are in.
    if (statusTimer) clearTimeout(statusTimer);
    const count = found.length;
    statusTimer = setTimeout(
      () =>
        announce(
          count === 0 ? "No collections" : count === 1 ? "1 collection" : `${count} collections`,
        ),
      Math.max(0, typedAt + 300 - performance.now()),
    );
  };
  // Blur doesn't close the list first: a press on an option keeps focus in the input.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[role=option]") : null;
    if (!option || option instanceof HTMLAnchorElement) return; // a collection link navigates
    event.preventDefault();
    activate(option);
  });
  const syncTokens = () => {
    for (const button of tokens)
      button.setAttribute(
        "aria-pressed",
        String(tokenPattern(button.dataset.token ?? "").test(input.value)),
      );
  };
  for (const button of tokens) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => toggleToken(input, button.dataset.token ?? ""));
  }
  input.addEventListener("input", () => {
    typedAt = performance.now();
    syncTokens();
    if (timer) clearTimeout(timer);
    // A count still waiting for its 300 ms belongs to the previous text, and so does the one
    // shown: clear it, so the new text's count is announced even when it is the same.
    if (statusTimer) clearTimeout(statusTimer);
    announce("");
    const query = input.value.trim();
    // Tokens, IDs and URLs go to the full search, which understands them.
    if (!query || /^(?:\S+:\S|col_|rev_|https?:)/.test(query)) {
      close();
      return;
    }
    const mine = ++sequence;
    timer = setTimeout(() => {
      api(`/api/collections?${new URLSearchParams({ query, limit: "8" }).toString()}`)
        .then((value) => {
          if (mine !== sequence) return;
          render(query, suggestions(value));
        })
        .catch(() => {
          if (mine === sequence) close();
        });
    }, 150);
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const match = matchKey(event, "find");
    if (!match) {
      // Esc closes Find in one press, not prevented: a search input with text would only clear
      // it, and the dialog's own Esc would wait for the next press. In the bar's field Esc keeps
      // its behaviour: an open list closes first (prevented, so the text and focus stay), and
      // with no list keys.ts blurs the field.
      if (event.key === "Escape") {
        if (dialog) dialog.close();
        else if (!list.hidden) {
          event.preventDefault();
          close();
        }
      }
      return;
    }
    const open = !list.hidden && options.length > 0;
    // Only the "find" scope matches here, so no other command reaches this switch.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- see above.
    switch (match.command) {
      case "find-prev":
      case "find-next": {
        if (!open) return;
        event.preventDefault();
        const step = match.command === "find-next" ? 1 : -1;
        // Both ends wrap: up from the first option is All results, down from it the first.
        highlight(
          active < 0
            ? step > 0
              ? 0
              : options.length - 1
            : (active + step + options.length) % options.length,
        );
        return;
      }
      case "find-open": {
        event.preventDefault();
        const chosen = open ? options[active] : undefined;
        if (chosen) activate(chosen);
        else form.requestSubmit();
        return;
      }
      case "find-all":
        event.preventDefault();
        form.requestSubmit();
        return;
      default:
        return;
    }
  });
  // The bar's list closes when focus leaves the field; Find's stays with its dialog, and every
  // open of Find starts afresh, however it was last closed (Esc, Cancel, the backdrop, a
  // choice): an empty field, no list, no pressed chips. (Esc in a search field clears it
  // without an input event, which would otherwise leave the old list and chips behind.)
  if (!dialog) input.addEventListener("blur", () => setTimeout(close, 100));
  else {
    const reset = () => {
      input.value = "";
      close();
      syncTokens();
    };
    // beforetoggle runs synchronously inside showModal(), so it can't be overtaken; the close
    // event is queued and can arrive after the next open (and typing), so it resets only a
    // dialog that is still closed (it stops a pending fetch or count there).
    dialog.addEventListener("beforetoggle", (event) => {
      if (event instanceof ToggleEvent && event.newState === "open") reset();
    });
    dialog.addEventListener("close", () => {
      if (!dialog.open) reset();
    });
  }
}

/** Binds every [data-search] form: the bar's field, Find and the empty search page's field. */
export function bindSearch(): void {
  for (const form of $$("form[data-search]", HTMLFormElement)) bindForm(form);
}

/** Find's light dismiss without closedby, and its Files row (the `f` key's targets). */
export function bindFind(): void {
  const dialog = $("#find", HTMLDialogElement);
  if (!dialog) return;
  // The form fills the dialog, so a click on the dialog itself landed on ::backdrop.
  const lightDismiss = "closedBy" in HTMLDialogElement.prototype;
  if (!lightDismiss)
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  // A tap on the dimmed page closes Find, and the click the tap synthesises afterwards would land
  // on whatever lies under it (a Recent row, say) once the page is no longer inert. Cancel that
  // click; without closedby the fallback above never sees it, so close here instead.
  dialog.addEventListener(
    "touchend",
    (event) => {
      if (event.target !== dialog) return;
      event.preventDefault();
      if (!lightDismiss) dialog.close();
    },
    { passive: false },
  );
  $("[data-find-files]", HTMLAnchorElement, dialog)?.addEventListener("click", (event) => {
    if (!$("#panel")) return; // no panel here: the href opens it
    event.preventDefault();
    dialog.close();
    showTab("files");
    ($("[data-filter]") ?? $("#tp-files a[aria-current], #tp-files a"))?.focus();
  });
}
