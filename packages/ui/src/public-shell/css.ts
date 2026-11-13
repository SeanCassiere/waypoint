import { controlsCss } from "../components-css.ts";
import { panelCss, treeCss } from "../panel-css.ts";
import { PHONE_MAX, WIDE_MIN, sharedTokensCss } from "../tokens.ts";

/** Below WIDE_MIN the file panel is a sheet (panelCss's breakpoint). */
const NARROW_MAX = 1099.98;

/** The skip link's print rule; the base rule is in sharedTokensCss. */
export const skipCss: string = `@media print{.skip{display:none}}
`;
/**
 * Page frame and letterhead (R2): a grid with the title and the meta row on the left and the
 * actions on the right (row 3 of column 1 is RX-11's syncing note, `.sync`; on phones it gives way
 * to the `.pend` pill in the meta row); on phones the meta row spans the width. `.lgo`/`.smo` and
 * `.lgt`/`.smt` are long and phone short forms (the hidden one is `display:none`, so it's out of
 * the accessibility tree); `.vh` is visually hidden. Inside the About button and the `.pend` pill
 * (an inline block, not a flex box, for this reason) `.vh` and its parent stay inline, `.vh` at
 * size 0 (an out-of-flow or flex-item span adds a space to the name, "Read-only , about this
 * link"). About is a `.menu` (menuCss): anchored by its right
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
.sync{grid-column:1;grid-row:3;justify-self:start;display:flex;align-items:flex-start;gap:7px;max-width:100%;margin:8px 0 0;padding:4px 11px 4px 8px;border-radius:8px;border:1px solid var(--pending-line);background:var(--pending-bg);color:var(--pending);font-size:12.5px;line-height:18px;font-weight:500}
.sync>svg.ic{flex:none;margin-top:3px}
.pend{display:none;height:20px;padding:0 7px 0 5px;border-radius:99px;border:1px solid var(--pending-line);background:var(--pending-bg);color:var(--pending);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.pend>svg.ic{margin-right:4px;vertical-align:-2px}
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
@supports not (position-area:bottom){@media not all and (max-width:${PHONE_MAX}px){.menu.about{top:52px;left:auto;right:max(20px,calc(50vw - 540px))}.pan .menu.about{right:20px}}}
@media(max-width:${PHONE_MAX}px){.lh{gap:0 10px;padding:10px 14px 8px}
.lh h1{align-self:center;font-size:14.5px}
.lh .note{grid-column:1/-1}
.lh .acts{grid-row:1;align-self:center}
.acts>.ro{display:none}
.sync{display:none}.pend{display:inline-block}.pend>.vh{position:static;width:auto;height:auto;overflow:visible;clip:auto;font-size:0}
.lgo,.lgt,.abt>.lgo{display:none}.smo,.smt{display:inline}
.abt>.smo{display:inline}
.menu.about>.mbox{padding-inline:18px}
.about .full{display:block;margin:0 0 12px;font:650 15px/1.3 var(--sans);overflow-wrap:anywhere;unicode-bidi:isolate}
.about h2{margin-bottom:10px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}}
@media(forced-colors:active){.mode,.abt,.sync,.pend{border-color:CanvasText}}
@media print{.pwrap{display:none}html,body{height:auto;overflow:visible}}
`;
/**
 * The Files row (R1, D74): the "Files N" button that shows, hides or opens the file panel, and the
 * current file's Download control. `.prow` and the letterhead keep the 1120 px column on one-file
 * pages; with a panel (`body.pan`) both span the window, so the title lines up with the panel.
 * The Download control (`.dlb`, RX-06) is a `.btn` (controlsCss, packages/ui/src/components-css.ts,
 * first in the cascade; these rules use `.btn.dlb`): right-aligned at the row's end, in the letterhead actions with a mono
 * name for one file (`.one`), and on phones an icon-only 44 px ghost target. A long name wraps
 * (the button grows, 32 px for one line) rather than being cut, so the file name always shows.
 * Under forced colours the icons inherit the text colour.
 */
export const filesCss: string = `.prow{display:flex;align-items:flex-end;gap:8px;max-width:1120px;margin:0 auto;padding:0 16px}
.pan .lh,.pan .prow{max-width:none}
.fbtn{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;margin:0;padding:8px 10px 10px;border:0;border-bottom:2px solid var(--ink);border-radius:0;background:none;font:600 13px var(--sans);color:var(--ink);cursor:pointer;outline-offset:-2px}
.fbtn>svg.ic{color:var(--muted)}
.fbtn .n{color:var(--faint);font-weight:500}
.fbtn .cur{display:inline-flex;align-items:center;gap:6px;min-width:0;font-weight:500;color:var(--muted)}
.fbtn .ti{color:var(--faint)}
.fbtn .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;unicode-bidi:isolate}
.prow>.dlb{margin-left:auto;flex:none;align-self:center}
.btn.dlb.one .nm{font:12px/16px var(--mono);unicode-bidi:plaintext}
@media not all and (max-width:${PHONE_MAX}px){.btn.dlb.one{height:auto;padding-block:7px}.btn.dlb.one .nm{max-width:min(44ch,30vw);white-space:normal;overflow-wrap:anywhere}}
@media(max-width:${PHONE_MAX}px){.prow{padding:0 10px}.fbtn{min-height:var(--tap)}
.btn.dlb,.btn.dlb:hover{width:var(--tap);height:var(--tap);justify-content:center;padding:0;border-color:transparent;background:none}
.btn.dlb .lbl{display:none}.btn.dlb svg.ic{width:var(--ic-lg);height:var(--ic-lg)}}
@media(forced-colors:active){.fbtn{border-bottom-color:CanvasText}.fbtn>svg.ic,.fbtn .ti{color:inherit}.btn.dlb,.btn.dlb:hover{border-color:ButtonText}}
`;
/**
 * Popovers (D51). Every `.menu` popover is an invisible positioning shell whose one child, `.mbox`,
 * is the visible box, anchored to its invoker from 600 px and a bottom sheet below (RX-01's
 * About). A popover's ::backdrop never takes pointer events, so on touch screens and under sheets
 * a real scrim (`.pop-scrim`, tinted on phones) takes the closing tap; filesMenuScript keeps it a
 * moment after close (`.linger`) so the tap's click lands there too. The file panel is a popover
 * too, styled by panelCss and sidebarCss.
 */
export const menuCss: string = `[popover]{margin:0;inset:auto;padding:0;border:0;background:none;color:var(--ink);overflow:visible}
.menu{position:fixed;z-index:40;position-area:bottom span-right;position-try-fallbacks:flip-block;margin-block:6px;width:min(400px,calc(100vw - 24px))}
.mbox{padding:6px;max-height:calc(100dvh - 120px);overflow:auto;overscroll-behavior:contain}
.pop-scrim{display:none;opacity:0;position:fixed;inset:0;z-index:50;background:transparent}
@supports not (position-area:bottom){.menu{top:104px;left:max(12px,calc(50vw - 544px))}}
@media(max-width:${PHONE_MAX}px){.menu{position-area:none;position-try-fallbacks:none;inset:auto 0 0 0;width:100%;margin:0}
[popover]>.mbox{border-radius:var(--rd-3) var(--rd-3) 0 0;border-bottom-width:0;max-height:82dvh;padding:0 10px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -8px 32px rgba(27,26,23,.16)}
[popover]>.mbox::before{content:"";display:block;width:36px;height:4px;border-radius:2px;background:var(--rule-2);margin:8px auto 4px}
.pop-scrim{background:var(--scrim)}}
@media(pointer:coarse),(max-width:${PHONE_MAX}px){body:has([popover]:popover-open) .pop-scrim{display:block;opacity:1}.pop-scrim.linger{display:block}}
`;
/**
 * The reader's side of the file panel (D74), after the shared panelCss and treeCss. `#shell` fills
 * the page under the banner; the panel is `nav#files[popover]`, so:
 *  - From WIDE_MIN it's docked without being open: `.panel{display:flex}` (panelCss) beats the
 *    UA's `display:none` for a closed popover, and `position:static` puts it back in the grid.
 *    The document always takes the grid's last column. Collapsed, the peek card and strip are
 *    placed inside `#shell` (`position:absolute`), since the banner's height varies. Without
 *    script the button can't collapse it, so it's hidden; a sheet left open across WIDE_MIN floats.
 *  - Below WIDE_MIN a closed panel is `display:none` (never off-screen and focusable) and the open
 *    one is panelCss's side sheet, a bottom sheet with a grab handle and Done on phones, over a
 *    tinted scrim.
 * The header ("Files N") shows at every width, and above the tree the script's Expand all /
 * Collapse all (D75): the writer's `.ttools` row with a quiet `.btn.ghost.sm` (the writer's
 * `.txtbtn` stays the writer's: it serves many other pages there). Rows: icon, name (`b`, one
 * line with an ellipsis; wrapped without script, which sets the full path as `title`),
 * "download · size" marker.
 */
export const sidebarCss: string = `.shell{flex:1;min-height:0;position:relative}
.shell>main{grid-column:-2;min-width:0;min-height:0}
.panel{height:auto}
.shd{display:flex;align-items:center;gap:8px;flex:none;min-height:41px;padding:6px 10px 6px 16px;border-bottom:1px solid var(--rule)}
.shd h2{flex:1;margin:0;font:650 13px var(--sans)}.shd .n{color:var(--faint);font-weight:500}
.done{display:none}
.tree a>svg,.tree summary>svg.ti{color:var(--faint)}.tree a[aria-current]>svg{color:var(--ink)}
.tree a>b{font-weight:400}
@media(scripting:none){.tree a>b{white-space:normal;overflow-wrap:anywhere}}
.tree small{margin-left:auto;flex:none;font-size:12px;font-weight:400;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.tree details:not([open])>summary>svg.ti{transform:none}
.tree hr{border:0;border-top:1px solid var(--rule);margin:6px 4px}
.tree .more{margin:6px 8px 2px;font-size:12.5px;color:var(--muted)}
.tree summary{unicode-bidi:isolate}.tree a{unicode-bidi:plaintext}
.ttools{display:flex;justify-content:flex-end;margin:0 4px 2px}.ttools:has(>[hidden]){display:none}
.ttools .btn.sm{padding:0 6px;color:var(--muted)}.ttools .btn:hover{color:var(--ink)}
@media(min-width:${WIDE_MIN}px){.panel{display:flex;position:static;width:auto}
.panel:popover-open{position:fixed;inset:0 auto 0 0;width:var(--panel-w);box-shadow:var(--sh-2)}}
@media(min-width:${WIDE_MIN}px) and (scripting:none){.ptog{display:none}}
@media(min-width:${WIDE_MIN}px) and (hover:hover) and (pointer:fine){.shell.closed>.peek-edge,.shell.closed .panel{position:absolute}}
@media(max-width:${NARROW_MAX}px){.panel:not(:popover-open){display:none}
body:has(#files:popover-open) .pop-scrim{display:block;opacity:1;background:var(--scrim)}}
@media(max-width:${PHONE_MAX}px){.panel:popover-open::before{content:"";display:block;flex:none;width:36px;height:4px;border-radius:2px;background:var(--rule-2);margin:8px auto 4px}
.shd{padding:2px 10px 8px 14px}.shd h2{font-size:15px}.pbody{padding-bottom:calc(16px + env(safe-area-inset-bottom))}
.done{display:block;min-width:64px;min-height:var(--tap);padding:0 14px;border-radius:var(--rd-2);border:1px solid var(--rule-2);background:var(--surface);font:600 14px var(--sans);color:var(--ink);cursor:pointer}
.tree a,.tree summary{min-height:var(--tap);font-size:15px}.tree summary{font-size:13.5px}}
@media(forced-colors:active){.tree a>svg,.tree a[aria-current]>svg,.tree summary>svg.ti{color:inherit}.panel:popover-open{border:1px solid CanvasText}}
`;
/** The document area: frame, scroller, download card (shared by R1 and R2; see Risks). */
export const documentCss: string = `main{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--paper)}
.pframe{flex:1;display:block;width:100%;min-height:0;border:0;background:var(--paper)}
.scroll{flex:1;overflow:auto;padding:0 16px 32px}
.dl{border:1px solid var(--rule);border-radius:16px;background:var(--surface);max-width:520px;margin:12dvh auto 0;padding:28px;text-align:center;box-shadow:var(--sh-1)}
.dl .ic{width:56px;height:56px;border-radius:14px;background:var(--sunken);display:grid;place-items:center;margin:0 auto 12px;font:700 13px var(--mono);color:var(--muted)}
.dl h2{margin:0 0 4px;font:650 18px var(--mono);overflow-wrap:anywhere}
.dl p{margin:0 0 16px;color:var(--muted)}
@media(max-width:600px){.dl{padding:20px;margin-top:6dvh}}
@media print{.pframe{height:100vh}}
.docwrap{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}
.docwrap>.pframe{position:relative;z-index:1}
.docwrap:not([data-loaded])>.pframe{background:transparent}
.loading{position:absolute;inset:0;z-index:0;display:flex;justify-content:center;padding:40px 32px 0;pointer-events:none}
.loading p{margin:0;width:min(660px,100%);font-size:14px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}
.docwrap[data-loaded]>.loading{display:none}
@media(max-width:${PHONE_MAX}px){.loading{padding:24px 18px 0}}
`;
/** RX-04's image stage (R2): a sunken scroller that fits images to its width, never grows them,
 *  starts tall ones at the top, and a caption bar under it. The writer's image pages use it too.
 *  `.fit` spans the stage and the image centres in it, so an SVG with only a viewBox (no size of
 *  its own) fills the width instead of collapsing to nothing. */
export const stageCss: string = `.imgmain{overflow:hidden}
.stage{flex:1;min-height:0;margin:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;background:var(--stage)}
.stage .fit{margin:auto;padding:28px;width:100%}
.stage img{display:block;margin:0 auto;max-width:100%;height:auto;box-shadow:0 0 0 1px var(--img-frame);background-color:var(--check-b);background-image:conic-gradient(var(--check-a) 25%,transparent 0 50%,var(--check-a) 0 75%,transparent 0);background-size:16px 16px}
.icap{margin:0;flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:9px 20px;border-top:1px solid var(--rule);background:var(--paper);font-size:12.5px;color:var(--muted)}
.icap b{font:600 12.5px var(--mono);color:var(--ink);overflow-wrap:anywhere}
.imgerr{margin:auto;max-width:440px;padding:22px 24px;border:1px solid var(--rule-2);border-radius:14px;background:var(--surface);box-shadow:var(--sh-1)}
.imgerr h2{display:flex;align-items:center;gap:8px;margin:0 0 6px;font:650 15px var(--sans);color:var(--ink)}
.imgerr p{margin:0 0 14px;color:var(--ink-2);font-size:13.5px;line-height:1.5}
@media(max-width:${PHONE_MAX}px){.stage .fit{padding:12px}.icap{padding:8px 14px}.icap .ty{display:none}.imgerr{margin:auto 14px}}
@media(forced-colors:active){.stage img{box-shadow:none;outline:1px solid CanvasText}}
@media print{.stage{overflow:visible}}
`;
/** The shell rules, in cascade order. Lanes fill their own segment; the order is fixed here. */
export const shellCss: string =
  controlsCss +
  skipCss +
  letterheadCss +
  filesCss +
  menuCss +
  panelCss +
  treeCss +
  sidebarCss +
  documentCss +
  stageCss;

/** The public shell's complete stylesheet: the shared tokens plus the shell rules. */
export const publicShellCss: string = sharedTokensCss + shellCss;
