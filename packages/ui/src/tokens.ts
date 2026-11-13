/**
 * Logbook design tokens (D77; Folio's roles, spec §3, with Logbook's values), split by consumer so a
 * CSP hash moves only when a role the reader can see moves:
 *  - `sharedTokensCss`: roles the public reader shell, the reader's static pages and the writer
 *    all use, plus the chrome's font faces (font.ts), the base element rules and the skip link.
 *    Every token here is referenced by reader CSS (the shell's own rules, or the shared controls
 *    in components-css.ts) or by the writer's `?as=public` preview band
 *    (tests/tokens-consumers.test.ts). It starts `publicShellCss` and the reader's `staticCss`, so
 *    editing it moves the reader's shell and static style hashes (regenerate
 *    apps/reader/src/csp-hashes.ts).
 *  - `writerTokensCss`: roles only the writer uses, including any role that neither reader CSS
 *    nor the preview band references. Appended only by apps/writer/viewer.build.ts; it never
 *    reaches the reader, so editing it never moves a reader hash. A writer token moves to the
 *    shared set in the commit whose reader CSS starts using it. The panel and tree styles
 *    (panel-css.ts) are shared, so their roles (`--panel-w`, `--panel-top`, `--sel-bg`, `--sel-ring`) are too;
 *    `--panel-top` (where the panel starts) is 0 in the reader, and the writer sets it to its
 *    bar's height on `.shell`.
 *  - `readingTokensCss`: a frozen copy of the reading palette, in the renderer's own variable
 *    names, for the renderer (VS-07). Its snapshot changes only with a `RENDERER_VERSION` bump. The
 *    document keeps Folio's warm paper inside Logbook's cool shell.
 *
 * The scales: heights `--ctl-sm` 28, `--ctl-md` 32, `--tap` 44; radii `--rd-1` 4 (keys, tags),
 * `--rd-2` 6 (controls, boxes inside dialogs), `--rd-box` 8 (boxes on a page), `--rd-3` 10
 * (anything floating), and `--rd-2-in`, `--rd-box-in`, `--rd-3-in` (the radius minus a 1 px
 * border) for whatever sits flush with such a box's corner; `--hover` (ink 7 %, dark 10 %),
 * `--sel-bg` (10 %, 14 %) and `--press` (12 %, 16 %) are films of ink over whatever they sit on;
 * rows that sit side by side share `--r1`/`--r2` (height, rule included) and `--row-fs`/`--row-lh`
 * (text metrics), so their rules and baselines meet. `--sans` is Recursive's sans and `--mono` its
 * mono cut (times, revision numbers, IDs, hashes, paths and query syntax only), each with the
 * system stack behind it.
 */

import { fontFaceCss } from "./font.ts";
import { iconCss } from "./icons.ts";

/** Phones: bottom sheets, the phone letterhead (CSS: `@media (max-width: 599.98px)`). */
export const PHONE_MAX = 599.98;
/** Compact: the phone bar, 44 px rows, Browse chips (`@media (max-width: 760px)`). */
export const COMPACT_MAX = 760;
/** Wide: the panel sits beside the document (`@media (min-width: 1100px)`). */
export const WIDE_MIN = 1100;

/** Roles shared by the reader shell, the reader's static pages and the writer. */
export const sharedTokensCss: string =
  fontFaceCss +
  `:root{color-scheme:light dark;--paper:#f6f7f9;--surface:#fff;--sunken:#eef0f3;--dlg:#fff;--hover:color-mix(in srgb,var(--ink) 7%,transparent);--press:color-mix(in srgb,var(--ink) 12%,transparent);--sel-bg:color-mix(in srgb,var(--ink) 10%,transparent);--stage:#eceef1;--ink:#1d2026;--ink-2:#4b525c;--faint:#5f6772;--rule:#e1e5ea;--rule-2:#cdd3db;--sel-ring:#cdd3db;--control:#8a919b;--node:#1d2026;--pending:#8f5400;--pending-bg:#fdf1dc;--pending-line:#d9a441;--public:#1e5ccc;--public-bg:#e8f0fd;--public-line:#9dbcf3;--img-frame:rgba(29,32,38,.14);--check-a:#eef0f3;--check-b:#e3e6ea;--scrim:rgba(17,20,26,.42);--sans:"Recursive",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;--mono:"Recursive Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--rd-2:6px;--rd-box:8px;--rd-3:10px;--sh-2:0 14px 40px rgba(17,20,26,.16),0 2px 6px rgba(17,20,26,.08);--ic-sm:12px;--ic-md:16px;--ic-lg:18px;--ic-xl:20px;--tap:44px;--ctl-sm:28px;--ctl-md:32px;--panel-w:300px;--panel-top:0px;--r1:45px;--row-fs:13.5px;--row-lh:20px;font:14.5px/1.45 var(--sans);letter-spacing:-.006em}
@media(prefers-color-scheme:dark){:root{--paper:#131518;--surface:#1a1d21;--sunken:#101215;--dlg:#1f2227;--hover:color-mix(in srgb,var(--ink) 10%,transparent);--press:color-mix(in srgb,var(--ink) 16%,transparent);--sel-bg:color-mix(in srgb,var(--ink) 14%,transparent);--stage:#0e1012;--ink:#e6e8ec;--ink-2:#a9b0ba;--faint:#9098a3;--rule:#262a30;--rule-2:#353b44;--sel-ring:#3b424c;--control:#6c747f;--node:#e6e8ec;--pending:#f0b452;--pending-bg:#33270f;--pending-line:#a87a2a;--public:#82adff;--public-bg:#172540;--public-line:#2f4f8a;--img-frame:rgba(255,255,255,.12);--check-a:#16191c;--check-b:#1d2024;--scrim:rgba(0,0,0,.62);--sh-2:0 16px 48px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased}
a{color:inherit}button,input,select,textarea{font:inherit;color:inherit;letter-spacing:inherit}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.skip{position:absolute;left:8px;top:-60px;z-index:70;padding:8px 12px;border-radius:var(--rd-2);background:var(--ink);color:var(--paper);text-decoration:none;font-weight:600}.skip:focus{top:8px}
` +
  iconCss;

/** Roles only the writer uses; appended to `sharedTokensCss` by the writer's viewer build. */
export const writerTokensCss: string = `:root{--muted:#565e68;--sel-bar:#1d2026;--sh-1:none;--ok:#2c784b;--failed:#b42318;--failed-bg:#fde8e6;--failed-line:#f1a59d;--on-public:#fff;--add:#17663a;--add-bg:#e3f3e8;--add-word:#b9e3c6;--del:#a4221a;--del-bg:#fbe9e7;--del-word:#f4c1bb;--changed:#7d3c98;--changed-bg:#f6eff9;--changed-line:#d9bfe6;--public-solid:#1f5fd1;--failed-solid:#b42318;--ok-solid:#2d7a4c;--on-solid:#fff;--sel:#1d2026;--on-sel:#f6f7f9;--spine:#b9c1cb;--mark-bg:#dde2e8;--rd-1:4px;--rd-2-in:calc(var(--rd-2) - 1px);--rd-box-in:calc(var(--rd-box) - 1px);--rd-3-in:calc(var(--rd-3) - 1px);--r2:45px;--bar-h:52px;--page-max:1096px;--page-pad:clamp(16px,4vw,32px)}
@media(prefers-color-scheme:dark){:root{--muted:#9aa2ad;--sel-bar:#e6e8ec;--ok:#6cc391;--failed:#ff8a7e;--failed-bg:#3b1a17;--failed-line:#7a2e27;--on-public:#0b1530;--add:#7fd6a0;--add-bg:#14291c;--add-word:#235238;--del:#ff9b90;--del-bg:#2f1715;--del-word:#5e2620;--changed:#d4b4ee;--changed-bg:#2a2130;--changed-line:#5a4468;--public-solid:#2b5bc4;--failed-solid:#b3372b;--ok-solid:#2d7a4c;--sel:#e6e8ec;--on-sel:#131518;--spine:#3b424c;--mark-bg:#343b45}}
`;

/** The reading palette in the renderer's variable names. Frozen: see the file comment. */
export const readingTokensCss: string = `:root{color-scheme:light dark;--fg:#1b1a17;--fg-2:#46433d;--muted:#66615a;--bg:#fcfbf9;--line:#e7e3dc;--line-2:#d6d1c7;--subtle:#f4f2ee;--code-bg:#f4f2ee;--link:#1f5fd1;--link-u:#9dbcf3;--focus:#1b1a17;--mark:#fff1a8;--note:#1d5bd6;--tip:#18794e;--warn:#9a6700;--caution:#c4320a;--measure:68ch}
@media(prefers-color-scheme:dark){:root{--fg:#ebe8e2;--fg-2:#c6c1b8;--muted:#958f86;--bg:#151514;--line:#2b2a27;--line-2:#3a3935;--subtle:#1e1d1a;--code-bg:#1e1d1a;--link:#82adff;--link-u:#2f4f8a;--focus:#ebe8e2;--mark:#5a4a00;--note:#8db4ff;--tip:#5fd39a;--warn:#e3b341;--caution:#ff8a65}}
`;

/** @deprecated One-release alias: the writer bundle is `sharedTokensCss + writerTokensCss`. */
export const tokensCss: string = sharedTokensCss + writerTokensCss;
