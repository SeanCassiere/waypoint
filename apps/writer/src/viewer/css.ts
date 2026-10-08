import { readFileSync } from "node:fs";

/** The viewer stylesheet's partials (apps/writer/src/viewer/css/), in cascade order. */
export const VIEWER_CSS_PARTIALS: readonly string[] = [
  "00-base.css",
  "05-chips.css",
  "10-home.css",
  "20-menus.css",
  "40-collection.css",
  "45-timeline.css",
  "50-links.css",
  "60-dialogs.css",
  "70-changes.css",
  "75-gallery.css",
  "80-pages.css",
  "90-responsive.css",
  "95-motion.css",
  "97-a11y-print.css",
  "99-lightbox.css",
];

/** The viewer stylesheet without tokens: the partials concatenated byte for byte, in order. */
export function viewerCssSource(): string {
  return VIEWER_CSS_PARTIALS.map((name) =>
    readFileSync(new URL(`./css/${name}`, import.meta.url), "utf8"),
  ).join("");
}
