import { sharedTokensCss } from "../tokens.ts";

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
/** Tabs and the "Files (N)" summary (R1). */
export const filesCss: string = `.ptabs2{display:flex;gap:4px;max-width:1120px;margin:0 auto;padding:0 16px;overflow-x:auto;scrollbar-width:thin}
.ptabs2 a{display:block;padding:8px 10px 10px;font-size:13px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;outline-offset:-2px}
.ptabs2 a:hover{color:var(--ink)}
.ptabs2 a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.pfiles{max-width:1120px;margin:0 auto;padding:0 16px}
.pfiles>details{position:relative;display:inline-block;max-width:100%}
.pfiles>details>summary{display:flex;align-items:center;gap:8px;padding:8px 10px 10px;font-size:13px;font-weight:600;cursor:pointer;list-style:none;border-bottom:2px solid var(--ink);outline-offset:-2px;min-width:0}
.pfiles>details>summary::-webkit-details-marker{display:none}
.pfiles>details>summary::after{content:"";flex:none;width:6px;height:6px;margin:-3px 2px 0;border:solid var(--muted);border-width:0 1.5px 1.5px 0;rotate:45deg}
.pfiles>details[open]>summary::after{margin-top:3px;rotate:225deg}
.pfiles .n{color:var(--faint);font-weight:500}
.pfiles .cur{font-weight:500;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pfiles .cur{unicode-bidi:isolate}.ptabs2 a{unicode-bidi:plaintext}
@media(max-width:600px){.ptabs2,.pfiles{padding:0 10px}.ptabs2 a,.pfiles>details>summary{min-height:44px;display:flex;align-items:center}}
@media(forced-colors:active){.ptabs2 a[aria-current],.pfiles>details>summary{border-bottom-color:CanvasText}}
`;
/** The file menu and tree rows (R1). */
export const menuCss: string = `.pmenu{position:absolute;top:calc(100% + 6px);left:0;z-index:40;width:min(440px,calc(100vw - 24px));max-height:min(70dvh,600px);overflow:auto;padding:6px;background:var(--dlg);border:1px solid var(--rule-2);border-radius:var(--r-md);box-shadow:var(--sh-2)}
.tree a,.tree summary{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:7px;text-decoration:none;color:var(--ink-2);font-size:13.5px;overflow-wrap:anywhere}
.tree a:hover,.tree summary:hover{background:var(--hover)}
.tree a[aria-current]{background:var(--sel);color:var(--on-sel);font-weight:600}
.tree summary{color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer;list-style:none}
.tree summary::-webkit-details-marker{display:none}
.tree summary::before{content:"";flex:none;width:5px;height:5px;margin:0 3px 0 1px;border:solid currentColor;border-width:0 1.5px 1.5px 0;rotate:-45deg}
.tree details[open]>summary::before{rotate:45deg}
.tree .in{padding-left:14px}
.tree hr{border:0;border-top:1px solid var(--rule);margin:6px 4px}
.tree .more{margin:6px 8px 2px;font-size:12.5px;color:var(--muted)}
.tree summary{unicode-bidi:isolate}.tree a{unicode-bidi:plaintext}
@media(forced-colors:active){.tree a[aria-current]{outline:2px solid CanvasText}}
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
