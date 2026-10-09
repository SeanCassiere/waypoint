/**
 * Folio design tokens (spec §3), split by consumer so a CSP hash moves only when a role the
 * reader can see moves:
 *  - `sharedTokensCss`: roles the public reader shell, the reader's static pages and the writer
 *    all use, plus the base element rules and the skip link. Every token here is referenced by
 *    reader CSS or by the writer's `?as=public` preview band (tests/tokens-consumers.test.ts).
 *    It starts `publicShellCss` and the reader's `staticCss`, so editing it moves the reader's
 *    shell and static style hashes (regenerate apps/reader/src/csp-hashes.ts).
 *  - `writerTokensCss`: roles only the writer uses, including any role that neither reader CSS
 *    nor the preview band references. Appended only by apps/writer/viewer.build.ts; it never
 *    reaches the reader, so editing it never moves a reader hash.
 *  - `readingTokensCss`: a frozen copy of the reading palette, in the renderer's own variable
 *    names, for the renderer (VS-07). Its snapshot changes only with a `RENDERER_VERSION` bump.
 */

import { iconCss } from "./icons.ts";

/** Phones: bottom sheets, the phone letterhead (CSS: `@media (max-width: 599.98px)`). */
export const PHONE_MAX = 599.98;
/** Compact: the phone bar, 44 px rows, Browse chips (`@media (max-width: 760px)`). */
export const COMPACT_MAX = 760;
/** Wide: the panel sits beside the document (`@media (min-width: 1100px)`). */
export const WIDE_MIN = 1100;

/** Roles shared by the reader shell, the reader's static pages and the writer. */
export const sharedTokensCss: string =
  `:root{color-scheme:light dark;--paper:#fcfbf9;--surface:#fff;--sunken:#f4f2ee;--dlg:#fff;--hover:#f0ede7;--stage:#efece6;--ink:#1b1a17;--ink-2:#46433d;--muted:#66615a;--faint:#6f6a62;--rule:#e7e3dc;--rule-2:#d6d1c7;--sel-ring:#d6d1c7;--sel-bar:#1b1a17;--pending:#9a5b00;--pending-bg:#fdf1dc;--pending-line:#e9c27a;--public:#1f5fd1;--public-bg:#e8f0fd;--public-line:#9dbcf3;--img-frame:rgba(27,26,23,.14);--check-a:#f4f2ee;--check-b:#e9e6e0;--scrim:rgba(20,18,14,.42);--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--r-md:10px;--sh-1:0 1px 2px rgba(27,26,23,.06),0 1px 1px rgba(27,26,23,.04);--sh-2:0 16px 48px rgba(27,26,23,.16),0 2px 8px rgba(27,26,23,.08);--ic-sm:12px;--ic-md:16px;--ic-lg:18px;--ic-xl:20px;--tap:44px;--ctl-sm:28px;--ctl-md:32px;font:14px/1.45 var(--sans)}
@media(prefers-color-scheme:dark){:root{--paper:#151514;--surface:#1c1c1a;--sunken:#11110f;--dlg:#222220;--hover:#232320;--stage:#0e0e0d;--ink:#ebe8e2;--ink-2:#c6c1b8;--muted:#9a958b;--faint:#969188;--rule:#2b2a27;--rule-2:#3a3935;--sel-ring:#45433e;--sel-bar:#ebe8e2;--pending:#f0b452;--pending-bg:#33270f;--pending-line:#6d5220;--public:#82adff;--public-bg:#172540;--public-line:#2f4f8a;--img-frame:rgba(255,255,255,.12);--check-a:#1a1a18;--check-b:#222220;--scrim:rgba(0,0,0,.62);--sh-1:0 1px 2px rgba(0,0,0,.4);--sh-2:0 16px 48px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--paper);color:var(--ink)}
a{color:inherit}button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:8px;top:-60px;z-index:70;padding:8px 12px;border-radius:8px;background:var(--ink);color:var(--paper);text-decoration:none;font-weight:600}.skip:focus{top:8px}
` + iconCss;

/** Roles only the writer uses; appended to `sharedTokensCss` by the writer's viewer build. */
export const writerTokensCss: string = `:root{--control:#8c867c;--ok:#2c784b;--failed:#b42318;--failed-bg:#fde8e6;--failed-line:#f1a59d;--on-public:#fff;--add:#17663a;--add-bg:#e3f3e8;--add-word:#b9e3c6;--del:#a4221a;--del-bg:#fbe9e7;--del-word:#f4c1bb;--changed:#7d3c98;--changed-bg:#f6eff9;--changed-line:#d9bfe6;--public-solid:#1f5fd1;--failed-solid:#b42318;--ok-solid:#2d7a4c;--on-solid:#fff;--panel-w:300px;--bar-h:52px;--page-max:1096px;--page-pad:clamp(16px,4vw,32px);--sel:#1b1a17;--on-sel:#fcfbf9;--sel-bg:#fff;--r-sm:6px;--r-lg:14px}
@media(prefers-color-scheme:dark){:root{--control:#75716a;--ok:#6cc391;--failed:#ff8a7e;--failed-bg:#3b1a17;--failed-line:#7a2e27;--on-public:#0b1530;--add:#7fd6a0;--add-bg:#14291c;--add-word:#235238;--del:#ff9b90;--del-bg:#2f1715;--del-word:#5e2620;--changed:#d4b4ee;--changed-bg:#2a2130;--changed-line:#5a4468;--public-solid:#2b5bc4;--failed-solid:#b3372b;--ok-solid:#2d7a4c;--sel:#ebe8e2;--on-sel:#151514;--sel-bg:#2a2926}}
`;

/** The reading palette in the renderer's variable names. Frozen: see the file comment. */
export const readingTokensCss: string = `:root{color-scheme:light dark;--fg:#1b1a17;--fg-2:#46433d;--muted:#66615a;--bg:#fcfbf9;--line:#e7e3dc;--line-2:#d6d1c7;--subtle:#f4f2ee;--code-bg:#f4f2ee;--link:#1f5fd1;--link-u:#9dbcf3;--focus:#1b1a17;--mark:#fff1a8;--note:#1d5bd6;--tip:#18794e;--warn:#9a6700;--caution:#c4320a;--measure:68ch}
@media(prefers-color-scheme:dark){:root{--fg:#ebe8e2;--fg-2:#c6c1b8;--muted:#958f86;--bg:#151514;--line:#2b2a27;--line-2:#3a3935;--subtle:#1e1d1a;--code-bg:#1e1d1a;--link:#82adff;--link-u:#2f4f8a;--focus:#ebe8e2;--mark:#5a4a00;--note:#8db4ff;--tip:#5fd39a;--warn:#e3b341;--caution:#ff8a65}}
`;

/** @deprecated One-release alias: the writer bundle is `sharedTokensCss + writerTokensCss`. */
export const tokensCss: string = sharedTokensCss + writerTokensCss;
