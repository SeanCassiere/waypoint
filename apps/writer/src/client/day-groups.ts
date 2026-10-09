import { dayLabel, trashDayLabel } from "../viewer/timefmt.ts";
import { $$, el } from "./dom.ts";

/**
 * Day groups in the browser's time zone (A11Y-04). The server groups rows by UTC day; this redraws
 * only the section boundaries and heading text for the local day. Rows never move relative to each
 * other: the existing <li> nodes are moved into the new sections in document order, never cloned
 * (later code attaches state to them). A no-op when the local groups already match.
 */
export function localizeDayGroups(root: ParentNode = document): void {
  const now = Date.now();
  for (const container of $$("[data-groups]", HTMLElement, root)) {
    const kind = container.dataset.groups ?? "";
    const label = kind === "trash" ? trashDayLabel : dayLabel;
    const items = $$("li.item[data-at]", HTMLLIElement, container);
    const groups: { label: string; items: HTMLLIElement[] }[] = [];
    for (const item of items) {
      const text = label(Number(item.dataset.at), now, false);
      const last = groups.at(-1);
      if (last?.label === text) last.items.push(item);
      else groups.push({ label: text, items: [item] });
    }
    const sections = $$(":scope > section", HTMLElement, container);
    const same =
      sections.length === groups.length &&
      sections.every(
        (section, index) =>
          section.querySelector("h2.day")?.textContent === groups[index]?.label &&
          section.querySelectorAll("li.item[data-at]").length === groups[index]?.items.length,
      );
    if (same) continue;
    container.replaceChildren(
      ...groups.map((group, index) => {
        const id = `${kind}-day-${index}`;
        return el(
          "section",
          { attrs: { "aria-labelledby": id } },
          el("h2", { class: "day", text: group.label, attrs: { id } }),
          el("ul", { class: "list" }, ...group.items),
        );
      }),
    );
  }
}
