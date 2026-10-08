/**
 * Folio icons (VS-03): the one SVG icon set the writer and the reader share. 16-unit grid,
 * 1.5 stroke, round caps and joins, `currentColor`, always `aria-hidden` (the control's visible
 * text or `aria-label` carries the name).
 *
 * The markup is static and uses presentation attributes only (never `style=`), so it is safe
 * inside the reader shell under its hash-only CSP, and the same-document `<use href="#i-…">` of
 * `iconUse` needs no CSP source. `cls` must be a constant class list, never user data.
 *
 * A name counts as consumed (tests/icons-consumers.test.ts) only when a source passes it as a
 * string literal to `icon(…)` or `iconUse(…)`, or lists it literally in an `iconSprite([…])` array.
 * Keep this module free of imports: the writer's client bundle tree-shakes it.
 */

export const ICON_NAMES = [
  "search",
  "more",
  "panel",
  "chevronDown",
  "chevronLeft",
  "chevronRight",
  "close",
  "check",
  "copy",
  "external",
  "download",
  "history",
  "grid",
  "alert",
  "clock",
  "okcircle",
  "dot",
  "globe",
  "branch",
  "follow",
  "pin",
  "lock",
  "info",
  "doc",
  "image",
  "table",
  "code",
  "binary",
  "folder",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, string> = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>', // NAV-01 bar · NAV-02 Find field · NAV-04 bar
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>', // ⋯ in NAV-01 / NAV-04 bars · phone tab bar
  panel: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/>', // NAV-04 panel toggle · phone tab bar Files
  chevronDown: '<path d="M4.5 6.5 8 10l3.5-3.5"/>', // A11Y-07 Files · Copy ▾ · NAV-01 phone switcher · OW-12 folds
  chevronLeft: '<path d="M10 3.5 5.5 8l4.5 4.5"/>', // NAV-04 ‹ up · A11Y-05 Previous · OW-12 stepper
  chevronRight: '<path d="M6 3.5 10.5 8 6 12.5"/>', // A11Y-05 Next · OW-12 stepper Next
  close: '<path d="M4 4l8 8M12 4l-8 8"/>', // A11Y-07 sheet · dialogs · OW-02 error toast · OW-04 row
  check: '<path d="M3 8.5l3 3 7-7"/>', // copy.ts “Copied” · OW-03 public-sees checklist
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>', // NAV-04 Copy link · OW-05 Copy URL · phone tab bar
  external:
    '<path d="M9.5 2.5h4v4M13.5 2.5l-6 6M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>', // VS-05 ghost Open · Preview as public · Open raw
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>', // RX-06 Download · writer Download · phone 44 px icon
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.3 2.5v2.4h2.4M8 5v3l2 1.5"/>', // NAV-04 revision pill · phone tab bar History
  grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>', // RX-04 Open in gallery · gallery row
  alert: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v3.6M8 11h.01"/>', // failed: chips · status line · OW-10 pill · OW-02 error toast
  clock: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.3 1.4"/>', // uploading / stalled / waiting · expiry < 24 h (OW-05, RX-01)
  okcircle: '<circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9"/>', // synced: OW-06 strip · OW-10 popover · OW-02 flash
  dot: '<circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none"/>', // health pill: synced, sync off · OW-10 phone count
  globe:
    '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2.8 4.2 2.8 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.2 5.7 5.2 8S6 12.5 8 14.5" stroke-width="1.3"/>', // Public chip · status line · Share button
  branch:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3.5-7 4"/>', // NAV-05 lane label · NAV-10 picker · OW-06 strip
  follow: '<path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11M3.5 2.5V5H6M12.5 13.5V11H10"/>', // RX-01 “Latest version” · OW-03 Latest target
  pin: '<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>', // RX-01 “Snapshot” · OW-03 Only #N target
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>', // RX-01 Read-only · About row · NAV-09 Tailnet links
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.3v3.9M8 4.9h.01"/>', // RX-01 “Read-only ⓘ” / About this link
  doc: '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13M5.5 8h5M5.5 10.5h5"/>', // RX-03 tabs and tree (.ti)
  image:
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M14.5 11 10.5 7.5 3 13.5"/>', // RX-03 · RX-04 caption
  table:
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M1.5 9.5h13M6 6v7.5"/>', // RX-03 (csv, tsv)
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>', // RX-03 (json, scripts, logs)
  binary:
    '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13M8 7.5v4.5M6 10l2 2 2-2"/>', // RX-03 download rows
  folder:
    '<path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>', // A11Y-07 folder rows
};

const ATTRS =
  'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

/** One icon, inline. Default size is --ic-md; pass "sm", "lg" or "xl" (or extra constant classes) as cls. */
export function icon(name: IconName, cls?: string): string {
  return `<svg class="ic${cls ? ` ${cls}` : ""}" ${ATTRS} aria-hidden="true">${PATHS[name]}</svg>`;
}

/** Repeated rows: emit once per page, then reference each name with iconUse(). Names are de-duplicated. */
export function iconSprite(names: readonly IconName[]): string {
  const symbols = [...new Set(names)]
    .map((name) => `<symbol id="i-${name}" viewBox="0 0 16 16">${PATHS[name]}</symbol>`)
    .join("");
  return `<svg class="sprite" width="0" height="0" aria-hidden="true"><defs>${symbols}</defs></svg>`;
}

/** A row's icon from the page's sprite: about 60 characters instead of about 370. Default class "ti" (tree mark, --ic-sm). */
export function iconUse(name: IconName, cls = "ti"): string {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/**
 * Icon sizing and stroke (part of sharedTokensCss). Scoped to `svg.` because the download tile is a
 * `<div class="ic">`. Stroke and caps are set here because a `<use>` shadow tree doesn't inherit the
 * sprite's presentation attributes; the sprite is 0x0 and out of flow because the `hidden`
 * attribute doesn't hide an `<svg>` in Chromium. No forced-colours rule: icons follow currentColor.
 */
export const iconCss: string =
  "svg.ic{width:var(--ic-md);height:var(--ic-md);flex:none;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}" +
  "svg.ic.sm,svg.ic.ti{width:var(--ic-sm);height:var(--ic-sm);vertical-align:-1px}" +
  "svg.ic.lg{width:var(--ic-lg);height:var(--ic-lg)}svg.ic.xl{width:var(--ic-xl);height:var(--ic-xl)}" +
  "svg.sprite{position:absolute;width:0;height:0;overflow:hidden}\n";
