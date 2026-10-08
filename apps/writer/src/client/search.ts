import { api, field } from "./api.ts";
import { $, el } from "./dom.ts";

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
    const latest = field(item, "latest_revision");
    const message = field(latest, "message");
    const number = field(latest, "display_number");
    if (typeof title !== "string" || typeof pub !== "string") return [];
    return [
      {
        title,
        detail: `${typeof number === "number" ? `#${number} ` : ""}${typeof message === "string" ? message : ""}`,
        href: `/c/${pub}/`,
      },
    ];
  });
}

/** Search suggestions: a combobox listbox after 150 ms of idle typing (spec §4.3). */
export function bindSearch(): void {
  const form = $("[data-search]", HTMLFormElement);
  const input = form ? $("input", HTMLInputElement, form) : null;
  const list = $("#suggest", HTMLUListElement);
  if (!form || !input || !list) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = -1;
  let current: Suggestion[] = [];
  let sequence = 0;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const highlight = (index: number) => {
    active = index;
    [...list.children].forEach((child, position) =>
      child.setAttribute("aria-selected", String(position === index)),
    );
    if (index >= 0) input.setAttribute("aria-activedescendant", `sg-${index}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    list.replaceChildren(
      ...current.map((item, index) => {
        const option = el(
          "li",
          { attrs: { role: "option", id: `sg-${index}`, "aria-selected": "false" } },
          el("b", { text: item.title }),
          el("small", { text: item.detail }),
        );
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          location.assign(item.href);
        });
        return option;
      }),
    );
    list.hidden = !current.length;
    input.setAttribute("aria-expanded", String(Boolean(current.length)));
    highlight(-1);
  };
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    const query = input.value.trim();
    // Tokens, IDs and URLs go to the full search, which understands them.
    if (!query || /^(?:\S+:\S|col_|rev_|https?:)/.test(query)) {
      close();
      return;
    }
    timer = setTimeout(() => {
      const mine = ++sequence;
      api(`/api/collections?${new URLSearchParams({ query, limit: "8" }).toString()}`)
        .then((value) => {
          if (mine !== sequence) return;
          current = suggestions(value);
          render();
        })
        .catch(() => close());
    }, 150);
  });
  input.addEventListener("keydown", (event) => {
    if (list.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = active + (event.key === "ArrowDown" ? 1 : -1);
      highlight(next < -1 ? current.length - 1 : next >= current.length ? -1 : next);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      const chosen = current[active];
      if (chosen) location.assign(chosen.href);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}
