import { historyDay } from "../viewer/timefmt.ts";
import { $$, el } from "./dom.ts";

/**
 * History's day rows in the browser's time zone (Logbook). The server draws them by UTC day; this
 * redraws only the day rows (decorative, aria-hidden) and each row's spoken day words for the
 * local day. Revision rows are never moved or cloned.
 */
export function localizeHistoryDays(root: ParentNode = document): void {
  const now = Date.now();
  for (const list of $$("ol[data-days]", HTMLOListElement, root)) {
    for (const old of $$(":scope > li.lb-day", HTMLLIElement, list)) old.remove();
    let last = "";
    for (const row of $$(":scope > li.rv[data-at]", HTMLLIElement, list)) {
      const day = historyDay(Number(row.dataset.at), now, false);
      const words = row.querySelector("[data-day-words]");
      if (words) words.textContent = `${day.word} ${day.date}, `;
      if (day.key === last) continue;
      last = day.key;
      row.before(
        el(
          "li",
          { class: "lb-day", attrs: { "aria-hidden": "true" } },
          el("b", { text: day.word }),
          " ",
          el("span", { text: day.date }),
        ),
      );
    }
  }
}
