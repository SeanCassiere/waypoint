import { $, $$ } from "./dom.ts";

const words = (node: Node) => (node.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Keeps the phone status line's single tap target in step with the segments, after script
 * adds or removes one ("new since you last read", "document left Waypoint").
 */
export function refreshStatusLine(): void {
  const line = $("[data-status]");
  const tap = line ? $("[data-status-tap]", line) : null;
  if (!line || !tap) return;
  const segments = $$(".seg1", line);
  const text = segments.map(words).filter(Boolean).join(" · ");
  // What the phone shows: each segment without its long explanation.
  const brief = segments
    .map((segment) => {
      const copy = segment.cloneNode(true);
      if (copy instanceof Element) for (const long of copy.querySelectorAll(".long")) long.remove();
      return words(copy);
    })
    .filter(Boolean)
    .join(" · ");
  const links = segments.length > 0 && segments.every((segment) => $(".pubseg", segment));
  tap.dataset.tab = links ? "links" : "history";
  tap.setAttribute("href", `?panel=${tap.dataset.tab}`);
  const tab = links ? "Links" : "History";
  const spoken = text.replace(/\.?$/, ".");
  tap.textContent = brief;
  tap.setAttribute("aria-label", `${spoken} Open ${tab}.`);
  line.hidden = !segments.length;
}
