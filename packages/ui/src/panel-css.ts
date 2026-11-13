import { PEEK_SLIDE_OUT } from "./panel.ts";
import { PHONE_MAX, WIDE_MIN } from "./tokens.ts";

/** Below WIDE_MIN the panel is a sheet; the same 1099.98 the writer's partials use. */
const NARROW_MAX = 1099.98;
const PEEK_MEDIA = `(min-width:${WIDE_MIN}px) and (hover:hover) and (pointer:fine)`;
const PEEK_EASE = `opacity ${PEEK_SLIDE_OUT}ms ease-out,transform ${PEEK_SLIDE_OUT}ms cubic-bezier(.2,0,0,1)`;

/**
 * The file panel (`.shell` > `.panel` > `.pbody`): docked as the shell's first grid column from
 * WIDE_MIN, collapsed by `.shell.closed`; a side sheet below it (`.shell.open` in the writer; in the
 * reader the panel is a popover, open as `:popover-open`), a bottom sheet below PHONE_MAX. Peek (D73): with the docked panel collapsed, a mouse resting on the window's
 * left edge (the `.peek-edge` strip) or on the panel button brings the panel out as a floating
 * card over the document (`.shell.closed.peek`); only a close from a peek animates
 * (`.peek-out`), in PEEK_SLIDE_OUT ms. The panel leaves the grid while collapsed, so the document
 * keeps the whole row and nothing reflows. Touch and narrow windows keep the plain toggle.
 *
 * `--panel-top` is where the panel and the peek strip start (0 in sharedTokensCss; the writer sets
 * it to its bar's height on `.shell`). The shell's height belongs to its page, and so does the print height.
 */
export const panelCss: string = `.shell{display:grid;grid-template-columns:var(--panel-w) minmax(0,1fr)}
.shell.closed{grid-template-columns:0 minmax(0,1fr)}
.shell.closed .panel{visibility:hidden}
.peek-edge{display:none}
@media ${PEEK_MEDIA}{.shell.closed{grid-template-columns:minmax(0,1fr)}
.shell.closed>.peek-edge{display:block;position:fixed;left:0;top:var(--panel-top,0px);bottom:0;width:16px;z-index:31}
.shell.closed .panel{position:fixed;left:0;top:calc(var(--panel-top,0px) + 32px);bottom:24px;width:var(--panel-w);z-index:32;border:1px solid var(--rule);border-left:0;border-radius:0 var(--r-md) var(--r-md) 0;box-shadow:var(--sh-2)}
.shell.closed.peek .panel{visibility:visible}}
.panel{border-right:1px solid var(--rule);background:var(--paper);display:flex;flex-direction:column;min-height:0;overflow:hidden}
.pbody{flex:1;overflow:auto;padding:10px 8px 16px}
.panel-scrim{display:none}
@media(max-width:${NARROW_MAX}px){.shell,.shell.closed{grid-template-columns:minmax(0,1fr)}
.shell.closed .panel{visibility:visible}
.panel{position:fixed;top:var(--panel-top,0px);bottom:0;left:0;width:min(360px,92vw);z-index:30;box-shadow:var(--sh-2);transform:translateX(-102%);visibility:hidden}
.shell.open .panel,.panel:popover-open{transform:none;visibility:visible}
.shell.open~.panel-scrim{display:block;position:fixed;inset:0;background:var(--scrim);z-index:29}}
@media(max-width:${PHONE_MAX}px){.shell.open .panel,.panel:popover-open{width:100%;top:auto;bottom:0;height:78dvh;border-radius:16px 16px 0 0}}
@media(prefers-reduced-motion:no-preference){.panel{transition:transform 150ms cubic-bezier(.2,0,0,1)}
@media ${PEEK_MEDIA}{.shell.closed:not(.peek) .panel{opacity:0;transform:translateX(-12px)}
.shell.closed.peek .panel{transition:${PEEK_EASE}}
.shell.closed.peek-out .panel{transition:${PEEK_EASE},visibility 0s linear ${PEEK_SLIDE_OUT}ms}}}
@media print{.panel{display:none !important}.shell{display:block}}
`;

/**
 * The file tree's rows (`.tree`): files (`a`, the current one `a[aria-current]`, its name in
 * `.nm` in the writer and a `b` in the reader, whose rows lead with a type icon `svg`) and folders (`details` > `summary` with a chevron `svg.ic`, contents in a `div`). One
 * selection style (VS-04): a raised row with a ring and an ink bar at the start edge. Touch:
 * folders start collapsed (D72), so their rows are the tree's main target; 44 px rows.
 */
export const treeCss: string = `.tree a,.tree .dir,.tree summary{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:7px;text-decoration:none;color:var(--ink-2);font-size:13.5px;min-width:0}
@media(pointer:coarse){.tree a,.tree summary{min-height:var(--tap)}}
.tree a span.nm,.tree a>b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree a:hover,.tree summary:hover{background:var(--hover)}
.tree a[aria-current]{background:var(--sel-bg);color:var(--ink);box-shadow:inset 3px 0 0 var(--sel-bar),0 0 0 1px var(--sel-ring)}
.tree a[aria-current] .nm,.tree a[aria-current]>b{font-weight:600}
.tree a>svg{flex:none;width:var(--ic-sm);height:var(--ic-sm);fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tree .dir,.tree summary{color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer}
.tree summary{list-style:none}
.tree summary::-webkit-details-marker{display:none}
.tree details:not([open])>summary>svg.ic{transform:rotate(-90deg)}
.tree details>div{padding-left:14px}
@media(forced-colors:active){.tree a[aria-current]{outline:2px solid CanvasText}}
`;
