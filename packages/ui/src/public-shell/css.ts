import { PHONE_MAX, sharedTokensCss } from "../tokens.ts";

/** The skip link's print rule; the base rule is in sharedTokensCss. */
export const skipCss: string = `@media print{.skip{display:none}}
`;
/** Page frame and letterhead (R2). */
export const letterheadCss: string = `html,body{height:100%}body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.pwrap{flex:none;position:relative;z-index:5;border-bottom:1px solid var(--rule);background:var(--paper)}
.lh{display:flex;align-items:center;gap:14px;max-width:1120px;margin:0 auto;padding:12px 20px}
.lh .ttl{min-width:0;flex:1}
.lh h1{margin:0;font:650 15px/1.3 var(--sans);letter-spacing:-.005em;overflow-wrap:anywhere}
.lh .note{margin:1px 0 0;font-size:12.5px;color:var(--muted)}
.snap{display:inline-flex;gap:5px;align-items:center;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--sunken);border:1px solid var(--rule);color:var(--ink-2)}
.pin{width:12px;height:12px;flex:none}.pin path{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ro{font-size:12px;color:var(--muted);white-space:nowrap}
.lh h1{unicode-bidi:isolate}
@media(max-width:600px){.ro{display:none}.lh{padding:10px 14px}}
@media(forced-colors:active){.snap{border-color:CanvasText}}
@media print{.pwrap{display:none}html,body{height:auto;overflow:visible}}
`;
/**
 * The Files row (R1): tabs, or the "Files N" button that opens the tree popover. `.prow` owns the
 * 1120 px column, so a later control at the row's end leaves the tab strip scrolling; the
 * strip's edge fades follow its `data-more` (set by filesMenuScript).
 */
export const filesCss: string = `.prow{display:flex;align-items:flex-end;gap:8px;max-width:1120px;margin:0 auto;padding:0 16px}
.ptabs2,.pfiles{min-width:0;flex:1 1 auto}
.ptabs2{display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin}
.ptabs2 a{display:block;padding:8px 10px 10px;font-size:13px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;outline-offset:-2px}
.ptabs2 a:hover{color:var(--ink)}
.ptabs2 a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.ptabs2[data-more=start]{mask-image:linear-gradient(90deg,transparent,#000 28px)}
.ptabs2[data-more=end]{mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
.ptabs2[data-more="start end"]{mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
.pfiles{display:flex}
.fbtn{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;margin:0;padding:8px 10px 10px;border:0;border-bottom:2px solid var(--ink);border-radius:0;background:none;font:600 13px var(--sans);color:var(--ink);cursor:pointer;outline-offset:-2px}
.fbtn .n{color:var(--faint);font-weight:500}
.fbtn .cur{display:inline-flex;min-width:0;font-weight:500;color:var(--muted)}
.fbtn .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fbtn .chev{color:var(--muted)}
.fbtn .t{unicode-bidi:isolate}.ptabs2 a{unicode-bidi:plaintext}
@media(max-width:${PHONE_MAX}px){.prow{padding:0 10px}.ptabs2 a{min-height:var(--tap);display:flex;align-items:center}.fbtn{min-height:var(--tap)}}
@media(forced-colors:active){.ptabs2 a[aria-current],.fbtn{border-bottom-color:CanvasText}}
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
.tree a,.tree summary{display:flex;align-items:center;gap:7px;min-height:30px;padding:5px 8px;border-radius:7px;text-decoration:none;color:var(--ink-2);font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.tree a:hover,.tree summary:hover{background:var(--hover)}
.tree a[aria-current]{background:var(--sunken);box-shadow:inset 3px 0 0 var(--sel-bar),inset 0 0 0 1px var(--sel-ring);color:var(--ink);font-weight:600}
.tree summary{color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer;list-style:none}
.tree summary::-webkit-details-marker{display:none}
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
@media(forced-colors:active){.tree a[aria-current]{outline:2px solid CanvasText}.mbox{border-color:CanvasText}}
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
