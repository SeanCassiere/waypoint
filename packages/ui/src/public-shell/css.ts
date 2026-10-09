import { PHONE_MAX, sharedTokensCss } from "../tokens.ts";

/** The skip link's print rule; the base rule is in sharedTokensCss. */
export const skipCss: string = `@media print{.skip{display:none}}
`;
/**
 * Page frame and letterhead (R2): a grid with the title and the meta row on the left and the
 * actions on the right (row 3 of column 1 is RX-11's syncing note); on phones the meta row spans
 * the width. `.lgo`/`.smo` and `.lgt`/`.smt` are long and phone short forms (the hidden one is
 * `display:none`, so it's out of the accessibility tree); `.vh` is visually hidden. Inside the
 * About button `.vh` and its parent stay inline (an out-of-flow or flex-item span adds a space to
 * the name, "Read-only , about this link"). About is a `.menu` (menuCss): anchored by its right
 * edge from 600 px, A11Y-07's bottom sheet below.
 */
export const letterheadCss: string = `html,body{height:100%}body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.pwrap{flex:none;position:relative;z-index:5;border-bottom:1px solid var(--rule);background:var(--paper)}
.lh{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 16px;align-items:start;max-width:1120px;margin:0 auto;padding:12px 20px 10px}
.lh .ttl{display:contents}
.lh h1{grid-column:1;grid-row:1;margin:0;font:650 15px/1.3 var(--sans);letter-spacing:-.005em;overflow-wrap:anywhere;unicode-bidi:isolate;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.lh .note{grid-column:1;grid-row:2;display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;margin:4px 0 0;font-size:12.5px;line-height:20px;color:var(--muted)}
.lh .acts{grid-column:2;grid-row:1/span 2;align-self:start;display:flex;align-items:center;gap:12px}
.note .f{white-space:nowrap}
.mode{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px 0 6px;border-radius:99px;border:1px solid var(--rule-2);background:var(--sunken);color:var(--ink-2);font-size:12px;font-weight:600;line-height:1;white-space:nowrap}
.note time[title]{text-decoration:underline dotted var(--faint);text-underline-offset:3px;cursor:help}
.exp.soon{display:inline-flex;align-items:center;gap:4px;color:var(--ink);font-weight:600}
.ro{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.abt{position:relative;display:inline-flex;align-items:center;height:var(--ctl-md);margin:0;padding:0 10px;border-radius:8px;border:1px solid var(--rule-2);background:var(--surface);color:var(--ink-2);font:500 12.5px var(--sans);white-space:nowrap;cursor:pointer}
.abt:hover{background:var(--hover);color:var(--ink)}
.smo,.smt{display:none}
.abt>.lgo{display:inline-flex;align-items:center;gap:6px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.abt .vh{position:static;width:auto;height:auto;overflow:visible;clip:auto;font-size:0}
.abt>.smo>svg.ic:first-child{margin-right:6px}.abt>.smo>svg.ic:last-child{margin-left:6px}
.about .full{display:none}
.about h2{margin:0 0 12px;font:650 14px var(--sans)}
.about ul{list-style:none;margin:0;padding:0;display:grid;gap:13px}
.about li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;font-size:13px;line-height:1.45}
.about li>svg.ic{margin-top:1px;color:var(--muted)}
.about b{display:block;font-weight:600;color:var(--ink)}
.about li span{color:var(--muted)}
.about .foot{display:flex;align-items:center;gap:7px;margin:14px 0 0;padding-top:10px;border-top:1px solid var(--rule);font-size:12px;color:var(--muted)}
.wmark{width:16px;height:16px;flex:none}.wmark rect{fill:var(--muted)}.wmark path{fill:none;stroke:var(--paper);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
@media(pointer:coarse){.abt::before{content:"";position:absolute;inset:-7px -3px}}
@media not all and (max-width:${PHONE_MAX}px){.menu.about{position-area:bottom span-left;width:min(372px,calc(100vw - 24px))}.menu.about>.mbox{padding:14px 16px 12px}}
@supports not (position-area:bottom){@media not all and (max-width:${PHONE_MAX}px){.menu.about{top:52px;left:auto;right:max(20px,calc(50vw - 540px))}}}
@media(max-width:${PHONE_MAX}px){.lh{gap:0 10px;padding:10px 14px 8px}
.lh h1{align-self:center;font-size:14.5px}
.lh .note{grid-column:1/-1}
.lh .acts{grid-row:1;align-self:center}
.acts>.ro{display:none}
.lgo,.lgt,.abt>.lgo{display:none}.smo,.smt{display:inline}
.abt>.smo{display:inline}
.menu.about>.mbox{padding-inline:18px}
.about .full{display:block;margin:0 0 12px;font:650 15px/1.3 var(--sans);overflow-wrap:anywhere;unicode-bidi:isolate}
.about h2{margin-bottom:10px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}}
@media(forced-colors:active){.mode,.abt{border-color:CanvasText}}
@media print{.pwrap{display:none}html,body{height:auto;overflow:visible}}
`;
/**
 * The Files row (R1): tabs, or the "Files N" button that opens the tree popover. `.prow` owns the
 * 1120 px column, so a later control at the row's end leaves the tab strip scrolling; the
 * strip's edge fades follow its `data-more` (set by filesMenuScript). A tab is a grid of icon,
 * name and marker; a hidden bold copy of its path (`::after`, a zero-height row under the name)
 * reserves the bold width and tabs never shrink (`flex:none`; the strip scrolls instead), so moving
 * `aria-current` resizes no tab. Under forced colours the icons inherit the text colour.
 */
export const filesCss: string = `.prow{display:flex;align-items:flex-end;gap:8px;max-width:1120px;margin:0 auto;padding:0 16px}
.ptabs2,.pfiles{min-width:0;flex:1 1 auto}
.ptabs2{display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin}
.ptabs2 a{flex:none;display:grid;grid-template-rows:auto 0;column-gap:8px;align-items:center;padding:8px 10px 10px;font-size:13px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;outline-offset:-2px}
.ptabs2 a:hover{color:var(--ink)}
.ptabs2 a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.ptabs2 .ti{grid-area:1/1;color:var(--faint)}.ptabs2 a[aria-current] .ti{color:var(--ink)}
.ptabs2 small{grid-area:1/3;font-size:12px;font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.ptabs2 a::after{content:attr(data-p);grid-area:2/2;height:0;visibility:hidden;overflow:hidden;font-weight:600}
.ptabs2[data-more=start]{mask-image:linear-gradient(90deg,transparent,#000 28px)}
.ptabs2[data-more=end]{mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
.ptabs2[data-more="start end"]{mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
.pfiles{display:flex}
.fbtn{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;margin:0;padding:8px 10px 10px;border:0;border-bottom:2px solid var(--ink);border-radius:0;background:none;font:600 13px var(--sans);color:var(--ink);cursor:pointer;outline-offset:-2px}
.fbtn .n{color:var(--faint);font-weight:500}
.fbtn .cur{display:inline-flex;align-items:center;gap:6px;min-width:0;font-weight:500;color:var(--muted)}
.fbtn .ti{color:var(--faint)}
.fbtn .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fbtn .chev{color:var(--muted)}
.fbtn .t{unicode-bidi:isolate}.ptabs2 a{unicode-bidi:plaintext}
@media(max-width:${PHONE_MAX}px){.prow{padding:0 10px}.ptabs2 a{min-height:var(--tap)}.fbtn{min-height:var(--tap)}}
@media(forced-colors:active){.ptabs2 a[aria-current],.fbtn{border-bottom-color:CanvasText}.ptabs2 .ti,.ptabs2 a[aria-current] .ti,.fbtn .ti{color:inherit}}
`;
/**
 * Popovers (D51) and the tree rows (R1). Every `[popover]` is an invisible positioning shell
 * whose one child, `.mbox`, is the visible box: a `.menu` is anchored to its invoker from 600 px
 * and a bottom sheet below. A popover's ::backdrop never takes pointer events, so on touch
 * screens and under sheets a real scrim (`.pop-scrim`, tinted on phones) takes the closing tap;
 * filesMenuScript keeps it a moment after close (`.linger`) so the tap's click lands there too.
 * Generic: RX-01's About popover reuses all of it.
 */
export const menuCss: string = `[popover]{margin:0;inset:auto;padding:0;border:0;background:none;color:var(--ink);overflow:visible}
.menu{position:fixed;z-index:40;position-area:bottom span-right;position-try-fallbacks:flip-block;margin-block:6px;width:min(400px,calc(100vw - 24px))}
.mbox{background:var(--dlg);border:1px solid var(--rule-2);border-radius:var(--r-md);box-shadow:var(--sh-2);padding:6px;max-height:calc(100dvh - 120px);overflow:auto;overscroll-behavior:contain}
.files{width:min(440px,calc(100vw - 24px))}
.files>.mbox{max-height:min(70dvh,600px)}
.shd{display:none}
.pop-scrim{display:none;opacity:0;position:fixed;inset:0;z-index:50;background:transparent}
.tree a,.tree summary{display:flex;align-items:center;gap:8px;min-height:30px;padding:5px 8px;border-radius:7px;text-decoration:none;color:var(--ink-2);font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.tree a:hover,.tree summary:hover{background:var(--hover)}
.tree a[aria-current]{background:var(--sunken);box-shadow:inset 3px 0 0 var(--sel-bar),inset 0 0 0 1px var(--sel-ring);color:var(--ink);font-weight:600}
.tree summary{color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer;list-style:none}
.tree summary::-webkit-details-marker{display:none}
.tree .ti{flex:none;color:var(--faint)}.tree a[aria-current] .ti{color:var(--ink)}
.tree small{margin-left:auto;font-size:12px;font-weight:400;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.tree summary::before{content:"";flex:none;width:5px;height:5px;margin:0 3px 0 1px;border:solid currentColor;border-width:0 1.5px 1.5px 0;rotate:-45deg}
.tree details[open]>summary::before{rotate:45deg}
.tree .in{padding-left:14px}
.tree hr{border:0;border-top:1px solid var(--rule);margin:6px 4px}
.tree .more{margin:6px 8px 2px;font-size:12.5px;color:var(--muted)}
.tree summary{unicode-bidi:isolate}.tree a{unicode-bidi:plaintext}
@supports not (position-area:bottom){.menu{top:104px;left:max(12px,calc(50vw - 544px))}}
@media(max-width:${PHONE_MAX}px){.menu{position-area:none;position-try-fallbacks:none;inset:auto 0 0 0;width:100%;margin:0}
[popover]>.mbox{border-radius:16px 16px 0 0;border-bottom-width:0;max-height:82dvh;padding:0 10px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -8px 32px rgba(27,26,23,.16)}
[popover]>.mbox::before{content:"";display:block;width:36px;height:4px;border-radius:2px;background:var(--rule-2);margin:8px auto 4px}
.shd{display:flex;align-items:center;gap:8px;position:sticky;top:0;z-index:1;background:var(--dlg);padding:2px 4px 8px;border-bottom:1px solid var(--rule);margin-bottom:6px}
.shd h2{flex:1;margin:0;font:650 15px var(--sans)}.shd .n{color:var(--faint);font-weight:500}
.done{min-width:64px;min-height:var(--tap);padding:0 14px;border-radius:var(--r-md);border:1px solid var(--rule-2);background:var(--surface);font:600 14px var(--sans);color:var(--ink);cursor:pointer}
.tree a,.tree summary{min-height:var(--tap);font-size:15px}.tree summary{font-size:13.5px}
.pop-scrim{background:var(--scrim)}}
@media(pointer:coarse),(max-width:${PHONE_MAX}px){body:has([popover]:popover-open) .pop-scrim{display:block;opacity:1}.pop-scrim.linger{display:block}}
@media(forced-colors:active){.tree a[aria-current]{outline:2px solid CanvasText}.mbox{border-color:CanvasText}.tree .ti,.tree a[aria-current] .ti{color:inherit}}
`;
/** The document area: frame, scroller, download card (shared by R1 and R2; see Risks). */
export const documentCss: string = `main{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--paper)}
.pframe{flex:1;display:block;width:100%;min-height:0;border:0;background:var(--paper)}
.scroll{flex:1;overflow:auto;padding:0 16px 32px}
.dl{border:1px solid var(--rule);border-radius:16px;background:var(--surface);max-width:520px;margin:12dvh auto 0;padding:28px;text-align:center;box-shadow:var(--sh-1)}
.dl .ic{width:56px;height:56px;border-radius:14px;background:var(--sunken);display:grid;place-items:center;margin:0 auto 12px;font:700 13px var(--mono);color:var(--muted)}
.dl h2{margin:0 0 4px;font:650 18px var(--mono);overflow-wrap:anywhere}
.dl p{margin:0 0 16px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);text-decoration:none;font-weight:500;box-shadow:var(--sh-1)}
@media(max-width:600px){.dl{padding:20px;margin-top:6dvh}}
@media print{.pframe{height:100vh}}
`;
/** RX-04's image stage (R2). Empty until RX-04. */
export const stageCss: string = "";
/** VS-05b's shared .btn family (R2). Empty until VS-05b moves .btn here. */
export const buttonCss: string = "";

/** The shell rules, in cascade order. Lanes fill their own segment; the order is fixed here. */
export const shellCss: string =
  skipCss + letterheadCss + filesCss + menuCss + documentCss + stageCss + buttonCss;

/** The public shell's complete stylesheet: the shared Folio tokens plus the shell rules. */
export const publicShellCss: string = sharedTokensCss + shellCss;
