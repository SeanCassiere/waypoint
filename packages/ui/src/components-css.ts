/**
 * Logbook's component system (D78): every control is styled here, once, and the pages' own CSS
 * only lays things out. Split by consumer like the tokens (tokens.ts):
 *  - `controlsCss`: what the public reader shell uses too. The `.btn` family's shape (default,
 *    primary, ghost; sm 28 / md 32 / 44 on touch) with its hover and press films, the neutral
 *    disabled state, the state glyphs' shape with the done and pending glyphs, and the menu box
 *    (`.mbox`). It follows `sharedTokensCss` in `publicShellCss` (so it moves the reader's shell
 *    style hash) and in the writer's stylesheet.
 *  - `writerComponentsCss`: the writer's controls. The public and danger buttons, icon and text
 *    buttons, fields, checkboxes and radios drawn as nodes, choices, segmented controls, tabs,
 *    tokens and tags, kbd and mark, state words and the track, menu items, the toast, the search
 *    list and Find, dialogs, the health pill and its popover, focus inside boxes, the hover rule
 *    per kind, and the side-by-side row metrics. The writer's viewer build appends it after
 *    `controlsCss`; it never reaches the reader.
 *
 * The scales are tokens: heights `--ctl-sm` 28, `--ctl-md` 32, `--tap` 44; radii `--rd-1` 4 (keys,
 * tags), `--rd-2` 6 (controls, boxes inside dialogs), `--rd-box` 8 (boxes on a page), `--rd-3` 10
 * (anything floating), each with an `-in` variant (minus the 1 px border) for whatever sits flush
 * with that box's corner; films `--hover`, `--sel-bg`, `--press` (ink over whatever is beneath);
 * side-by-side rows `--r1`, `--r2`, `--row-fs`, `--row-lh`. No pills: counts are plain numbers,
 * states are a glyph and words, controls are boxes. Focus is a 2 px ink ring outside a control and
 * an inset ring inside a box; it never changes an element's shape.
 */

/** Shared with the reader shell: see the file comment. */
export const controlsCss: string = `.btn{display:inline-flex;align-items:center;gap:7px;height:var(--ctl-md);padding:0 12px;border:1px solid var(--control);border-radius:var(--rd-2);background-color:var(--surface);color:var(--ink);font-size:14px;font-weight:560;text-decoration:none;white-space:nowrap;cursor:pointer}
.btn:hover{background-image:linear-gradient(var(--hover),var(--hover));border-color:var(--ink-2)}
.btn:active:not([disabled],[aria-disabled="true"]){background-image:linear-gradient(var(--press),var(--press))}
.btn.sm{height:var(--ctl-sm);padding:0 10px;font-size:13px}
.btn.primary{background-color:var(--ink);border-color:var(--ink);color:var(--paper)}
.btn.primary:hover{background-color:var(--ink-2);border-color:var(--ink-2);background-image:none}
.btn.ghost,.btn.ghost:hover{border-color:transparent;background-color:transparent}
.btn>svg{flex:none}.btn kbd{margin-left:2px}
.btn:is([disabled],[aria-disabled="true"]),.btn:is(.primary,.public-solid,.danger-solid,.public,.danger,.ghost):is([disabled],[aria-disabled="true"]),.btn:is(.primary,.public-solid,.danger-solid,.public,.danger,.ghost):is([disabled],[aria-disabled="true"]):hover{color:var(--faint);background:var(--sunken);border-color:var(--rule-2);box-shadow:none;cursor:not-allowed}
@media(pointer:coarse){.btn:is(a,button,summary,label){min-height:var(--tap)}}
@media(forced-colors:active){.btn,.btn:hover,.btn.ghost,.btn.primary,.btn.primary:hover{border-color:ButtonText}}
.lb-g,.chip:is(.pending,.failed)::before,.sc::before{content:"";display:inline-block;flex:none;box-sizing:border-box;width:10px;height:10px;border-radius:50%}
.lb-g.done,.sc.ok::before{background:var(--node)}
.lb-g.pending,.chip.pending::before,.sc.p::before{border:2px dashed var(--pending)}
@media(forced-colors:active){.lb-g,.chip:is(.pending,.failed)::before,.sc::before{forced-color-adjust:none;border-color:CanvasText}.lb-g.done,.sc.ok::before{background:CanvasText}}
.mbox{background:var(--dlg);border:1px solid var(--rule-2);border-radius:var(--rd-3);box-shadow:var(--sh-2);padding:4px}
@media(forced-colors:active){.mbox{border-color:CanvasText}}
`;

/** The writer's controls: see the file comment. Appended after `controlsCss` by the writer only. */
export const writerComponentsCss: string = `
/* ---------- text links: underlined in a soft tint of their own colour; hover makes it solid ---------- */
a {
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, currentColor 38%, transparent);
}
a:hover {
  text-decoration-color: currentColor;
}
/* a link that isn't underlined at rest gets one on hover (titles, crumbs, #n links) */
a:not(.btn, .iconbtn, .pill, .mi, .logo, .shot, .bchip, .facet, .tlink, [role="option"], [role="tab"], .ptabs a, .seg a, .gnav a, .tree a, .tabbar a, .stap):hover {
  text-decoration-line: underline;
}

/* ---------- buttons: the colours (D69). Shape, films and disabled are controlsCss ---------- */
.btn.center {
  justify-content: center;
}
.btn.public {
  color: var(--public);
  border-color: var(--public-line);
}
.btn.public:hover {
  border-color: var(--public);
  background-color: color-mix(in srgb, var(--public) 12%, var(--surface));
  background-image: none;
}
.btn.public-solid {
  background-color: var(--public-solid);
  border-color: var(--public-solid);
  color: var(--on-solid);
}
.btn.public-solid:hover {
  background-color: color-mix(in srgb, var(--public-solid) 86%, black);
  border-color: var(--public-solid);
  background-image: none;
}
.btn.danger {
  color: var(--failed);
  border-color: var(--failed-line);
}
.btn.danger:hover {
  border-color: var(--failed);
  background-color: color-mix(in srgb, var(--failed) 11%, var(--surface));
  background-image: none;
}
.btn.danger-solid {
  background-color: var(--failed-solid);
  border-color: var(--failed-solid);
  color: var(--on-solid);
}
.btn.danger-solid:hover {
  background-color: color-mix(in srgb, var(--failed-solid) 86%, black);
  border-color: var(--failed-solid);
  background-image: none;
}
@media (prefers-color-scheme: dark) {
  .btn.public:hover {
    background-color: color-mix(in srgb, var(--public) 20%, var(--surface));
  }
  .btn.danger:hover {
    background-color: color-mix(in srgb, var(--failed) 18%, var(--surface));
  }
}
@media (forced-colors: active) {
  .btn.public,
  .btn.danger,
  .btn.public-solid,
  .btn.danger-solid {
    border-color: ButtonText;
  }
}
/* Copied: a colour change only, so nothing moves */
.btn[data-copied] {
  justify-content: center;
  color: var(--ok);
  border-color: var(--ok);
}

/* ---------- icon buttons and quiet text actions ---------- */
.iconbtn {
  width: var(--ctl-md);
  height: var(--ctl-md);
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid transparent;
  border-radius: var(--rd-2);
  background: none;
  color: var(--ink-2);
  text-decoration: none;
  cursor: pointer;
}
.iconbtn:hover {
  background: var(--hover);
  color: var(--ink);
}
.iconbtn:active {
  background: var(--press);
}
.iconbtn > svg {
  flex: none;
}
@media (pointer: coarse) {
  .iconbtn:is(a, button) {
    min-width: var(--tap);
    min-height: var(--tap);
  }
}
/* a button that reads as a link: underlined in the spine colour, solid on hover */
.linkbtn {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--spine);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.linkbtn:hover {
  text-decoration-color: currentColor;
}
/* quiet secondary and danger actions (Preview, Revoke…, Revoke all): text, so hover underlines */
.txtbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: var(--ctl-sm);
  padding: 2px 6px;
  border: 0;
  border-radius: var(--rd-2);
  background: none;
  color: var(--ink-2);
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.txtbtn:hover {
  color: var(--ink);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.txtbtn.danger,
.txtbtn.danger:hover {
  color: var(--failed);
}
@media (pointer: coarse) {
  .txtbtn:is(a, button, summary, label) {
    min-height: var(--tap);
  }
}
summary.txtbtn {
  list-style: none;
}
summary.txtbtn::-webkit-details-marker {
  display: none;
}

/* ---------- fields: the same heights as buttons ---------- */
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
legend,
.lbl-h {
  padding: 0;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}
.fl {
  display: grid;
  gap: 6px;
  align-content: start;
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}
.fl small,
.fl .hint {
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--ink-2);
}
:is(.fl input, .fl select, .fl textarea, .confirm-input, .othermeta textarea) {
  width: 100%;
  height: var(--ctl-md);
  padding: 0 10px;
  border: 1px solid var(--control);
  border-radius: var(--rd-2);
  background: var(--surface);
  color: var(--ink);
  font: 400 14px/1.4 var(--sans);
}
:is(.fl textarea, .othermeta textarea) {
  height: auto;
  min-height: 140px;
  padding: 8px 10px;
  font: 12.5px/1.5 var(--mono);
  resize: vertical;
}
:is(.fl input, .fl select, .fl textarea, .confirm-input, .othermeta textarea):hover {
  border-color: var(--ink-2);
}
:is(.fl input, .fl select, .fl textarea, .confirm-input, .othermeta textarea):focus {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
  border-color: var(--ink);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-2);
}

/* ---------- checkboxes and radios, drawn as the spine's nodes ---------- */
input:is([type="checkbox"], [type="radio"]) {
  appearance: none;
  width: 16px;
  height: 16px;
  margin: 1px 0 0;
  flex: none;
  display: inline-grid;
  place-content: center;
  border: 1.5px solid var(--control);
  background: var(--surface);
  cursor: pointer;
}
input[type="radio"] {
  border-radius: 50%;
}
input[type="checkbox"] {
  border-radius: var(--rd-1);
}
input[type="radio"]:checked {
  border-color: var(--ink);
  background: var(--ink);
  box-shadow: inset 0 0 0 3px var(--surface);
}
input[type="checkbox"]:checked {
  border-color: var(--ink);
  background: var(--ink) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.2 6.6 11 12.5 5' fill='none' stroke='%23fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 12px no-repeat;
}
@media (prefers-color-scheme: dark) {
  input[type="checkbox"]:checked {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.2 6.6 11 12.5 5' fill='none' stroke='%23131518' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  }
}
input:is([type="checkbox"], [type="radio"]):disabled {
  cursor: not-allowed;
  background-color: var(--sunken);
  border-color: var(--rule-2);
}
label:hover > input:is([type="checkbox"], [type="radio"]):not(:checked, :disabled),
input:is([type="checkbox"], [type="radio"]):not(:checked, :disabled):hover {
  border-color: var(--ink-2);
}
/* Forced colours repaint the drawn fills away: the native control keeps its state visible. */
@media (forced-colors: active) {
  input:is([type="checkbox"], [type="radio"]) {
    appearance: auto;
  }
}

/* ---------- choices: options are rows of one ruled box ---------- */
.opts,
.ch2 {
  display: grid;
  gap: 0;
  border: 1px solid var(--control);
  border-radius: var(--rd-2);
  overflow: hidden;
  background: var(--surface);
}
.opts {
  grid-template-columns: 1fr 1fr;
}
.ch2 {
  margin: 12px 0 4px;
}
.opt,
.ch2 label {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 2px 10px;
  padding: 12px 14px;
  cursor: pointer;
}
.ch2 label {
  min-height: var(--tap);
}
.opt + .opt {
  border-left: 1px solid var(--rule-2);
}
.ch2 label + label {
  border-top: 1px solid var(--rule-2);
}
.opt b,
.ch2 b {
  font-size: 14px;
  font-weight: 650;
}
.opt span,
.ch2 label > span {
  grid-column: 2;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--ink-2);
}
.ch2 .pub {
  color: var(--public);
  font-weight: 600;
}
.opt:has(input:checked) {
  background: var(--sel-bg);
  box-shadow: inset 0 -2px 0 var(--ink);
}
.ch2 label:has(input:checked) {
  background: var(--sel-bg);
  box-shadow: inset 2px 0 0 var(--ink);
}
:is(.opt, .ch2 label):not(:has(input:checked)):hover {
  background: var(--hover);
}
/* the share target is a public choice: its selection is public blue, not ink */
#share .opt:has(input:checked) {
  background: var(--public-bg);
  box-shadow: inset 0 -2px 0 var(--public);
}
#share .opt input:checked {
  border-color: var(--public);
  background: var(--public);
}
.opt:first-child {
  border-radius: var(--rd-2-in) 0 0 var(--rd-2-in);
}
.opt:last-child {
  border-radius: 0 var(--rd-2-in) var(--rd-2-in) 0;
}
.ch2 label:first-of-type {
  border-radius: var(--rd-2-in) var(--rd-2-in) 0 0;
}
.ch2 label:last-of-type {
  border-radius: 0 0 var(--rd-2-in) var(--rd-2-in);
}
.ch2 label:only-of-type {
  border-radius: var(--rd-2-in);
}
@media (max-width: 760px) {
  /* the two options stack: corners move from left/right to top/bottom */
  .opts {
    grid-template-columns: 1fr;
  }
  .opt + .opt {
    border-left: 0;
    border-top: 1px solid var(--rule-2);
  }
  .opt:first-child {
    border-radius: var(--rd-2-in) var(--rd-2-in) 0 0;
  }
  .opt:last-child {
    border-radius: 0 0 var(--rd-2-in) var(--rd-2-in);
  }
}
@media (forced-colors: active) {
  :is(.opt, .ch2 label):has(input:checked) {
    outline: 2px solid Highlight;
    outline-offset: -3px;
  }
}

/* ---------- segmented: sets a value (expiry). A joined box, the chosen one filled with ink ---------- */
.expiry {
  display: flex;
  height: var(--ctl-md);
  border: 1px solid var(--control);
  border-radius: var(--rd-2);
  overflow: hidden;
  background: var(--surface);
}
.expiry label {
  flex: 1;
  position: relative;
  display: grid;
  place-items: center;
  border-left: 1px solid var(--rule-2);
  font-size: 13px;
  font-weight: 560;
  cursor: pointer;
}
.expiry label:first-child {
  border-left: 0;
  border-radius: var(--rd-2-in) 0 0 var(--rd-2-in);
}
.expiry label:last-child {
  border-radius: 0 var(--rd-2-in) var(--rd-2-in) 0;
}
.expiry label:hover {
  background: var(--hover);
}
.expiry label:has(input:checked) {
  background: var(--ink);
  color: var(--paper);
  font-weight: 650;
}
.expiry input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
@media (forced-colors: active) {
  .expiry label:has(input:checked) {
    forced-color-adjust: none;
    background: Highlight;
    color: HighlightText;
  }
}

/* ---------- tabs: switch what's shown. Underlined, in a ruled row ---------- */
.seg {
  display: inline-flex;
  align-items: stretch;
  gap: 18px;
  height: var(--ctl-md);
  padding: 0;
  border: 0;
  background: none;
}
.seg a,
.seg button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: inset 0 -2px 0 transparent;
  color: var(--ink-2);
  font: 600 var(--row-fs) / var(--row-lh) var(--sans);
  text-decoration: none;
  cursor: pointer;
}
.seg :is([aria-current], [aria-pressed="true"], [aria-selected="true"]) {
  color: var(--ink);
  font-weight: 650;
  box-shadow: inset 0 -2px 0 var(--ink);
}
/* an unselected tab previews its underline in the spine colour */
.seg :is(a, button):not([aria-current], [aria-pressed="true"], [aria-selected="true"]):hover {
  color: var(--ink);
  box-shadow: inset 0 -2px 0 var(--spine);
}
.seg .n {
  font-size: 12.5px;
  font-weight: 450;
  line-height: 1;
  color: var(--ink-2);
}
@media (forced-colors: active) {
  .seg :is([aria-current], [aria-pressed="true"], [aria-selected="true"]) {
    text-decoration: underline 2px;
    text-underline-offset: 6px;
  }
}

/* ---------- tokens (search filters: query syntax, so mono) and tags ---------- */
.find-tokens button,
.tagadd {
  height: var(--ctl-sm);
  min-height: var(--ctl-sm);
  padding: 0 9px;
  border: 1px solid var(--control);
  border-radius: var(--rd-2);
  background-color: var(--surface);
  color: var(--ink);
  font: 500 12.5px/1 var(--mono);
  cursor: pointer;
}
.tagadd {
  font-family: var(--sans);
}
.bchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: var(--ctl-md);
  padding: 0 11px;
  border: 1px solid var(--control);
  border-radius: var(--rd-2);
  background-color: var(--surface);
  font-weight: 560;
  text-decoration: none;
}
.bchip span {
  color: var(--ink-2);
  font-size: 12.5px;
}
.bchip.pub {
  border-color: var(--public-line);
  color: var(--public);
}
:is(.find-tokens button, .tagadd, .bchip):hover {
  background-image: linear-gradient(var(--hover), var(--hover));
  border-color: var(--ink-2);
}
.find-tokens button[aria-pressed="true"] {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}
@media (forced-colors: active) {
  .find-tokens button[aria-pressed="true"] {
    forced-color-adjust: none;
    background: Highlight;
    border-color: Highlight;
    color: HighlightText;
  }
}
.tag {
  font-size: 12.5px;
  color: var(--ink-2);
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--rule-2);
  border-bottom-width: 2px;
  border-radius: var(--rd-1);
  background: var(--surface);
  color: var(--ink-2);
  font: 500 11.5px/1 var(--mono);
}
/* a highlighted match is neutral: amber means uploading */
mark {
  padding: 0 1px;
  border-radius: 2px;
  background: var(--mark-bg);
  color: var(--ink);
}

/* ---------- state: a glyph and coloured words, never a pill ----------
   The glyph's shape, done and pending are controlsCss; these add failed (a ringed red dot), the
   elsewhere ring (D71: a fill is here, a ring is elsewhere) and waiting. */
.lb-g.failed,
.chip.failed::before,
.sc.f::before {
  background: var(--failed);
  box-shadow:
    inset 0 0 0 1.5px var(--failed),
    inset 0 0 0 3px var(--surface);
}
.lb-g.ring {
  border: 2px solid var(--failed);
}
.lb-g.ring.pending {
  border: 2px dashed var(--pending);
}
.sc.w::before {
  border: 1.5px dashed var(--ink-2);
}
/* state chips: the words, coloured; the glyph is their ::before */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 620;
  color: var(--ink-2);
  white-space: nowrap;
  text-decoration: none;
}
.chip.pending {
  color: var(--pending);
}
.chip.failed {
  color: var(--failed);
}
.chip.public {
  color: var(--public);
  font-weight: 500;
}
.chip.ink {
  color: var(--ink);
}
.chip.paused,
.chip.waiting {
  color: var(--ink-2);
}
.chip:is(.pending, .failed) > svg {
  display: none;
}
/* a chip whose text is user content (OW-07) never widens its row: it ends in an ellipsis */
.chip:has(> .chip-t) {
  max-width: 100%;
}
.chip-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* state words in lines, tracks and the share dialog */
.sc {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--row-fs);
  font-weight: 620;
  white-space: nowrap;
}
.sc > svg {
  display: none;
}
.sc.ok {
  color: var(--ink);
}
.sc.p {
  color: var(--pending);
}
.sc.f {
  color: var(--failed);
}
.sc.f s {
  text-decoration-thickness: 1px;
}
.sc.w {
  color: var(--ink-2);
}
/* a line of states joined by the spine */
.track {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  font-size: var(--row-fs);
  color: var(--ink-2);
}
.track .lab {
  margin-right: 4px;
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}
.track .to {
  display: inline-flex;
  width: 28px;
  height: 1.5px;
  background: var(--spine);
}
.track .to svg {
  display: none;
}
.track .tnote {
  flex-basis: 100%;
  margin: 2px 0 0;
  color: var(--ink-2);
}
dialog.dlg .track {
  padding: 11px 14px;
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-2);
  background: var(--surface);
}
.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 620;
}
.state.pending {
  color: var(--pending);
}
.state.ok {
  color: var(--ok);
}
.state > .ic.public {
  color: var(--public);
}

/* ---------- menus: items in the floating box (controlsCss) ---------- */
.menu .mi {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1px 12px;
  width: 100%;
  min-height: var(--ctl-md);
  padding: 6px 10px;
  border: 0;
  border-radius: var(--rd-2);
  background: none;
  color: var(--ink);
  font-size: 14px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.menu .mi:hover {
  background: var(--hover);
}
.menu .mi:active {
  background: var(--press);
}
.menu .mi:focus-visible {
  outline: 0;
  background: var(--hover);
  box-shadow: inset 0 0 0 2px var(--ink);
}
.menu .mi small,
.menu .mnote {
  grid-column: 1 / -1;
  font-size: 12.5px;
  color: var(--ink-2);
}
.menu .mnote {
  margin: 0;
  padding: 8px 10px 4px;
}
.menu .mi small.mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu .mi.pubitem {
  color: var(--public);
}
.menu .mi.dangeritem {
  color: var(--failed);
}
.menu .lbl {
  padding: 9px 10px 5px;
  font: 650 12.5px/1.2 var(--sans);
  color: var(--ink-2);
}
.menu .lbl .lbl-ic {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  vertical-align: middle;
}
.menu .lbl .lbl-note {
  font-weight: 400;
  color: var(--ink-2);
}
/* separators run edge to edge: a menu is a stack of ruled sections */
.menu hr {
  margin: 4px -4px;
  border: 0;
  border-top: 1px solid var(--rule);
}
.mbox.has-list > .mfoot {
  border-top: 1px solid var(--rule);
  background: var(--paper);
  border-radius: 0 0 var(--rd-3-in) var(--rd-3-in);
}
@media (forced-colors: active) {
  .menu .mi:focus-visible {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
  }
}

/* ---------- toast: a floating box; success leads with the ok dot ---------- */
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-3);
  background: var(--dlg);
  color: var(--ink);
  box-shadow: var(--sh-2);
  font-size: var(--row-fs);
}
.toast:empty {
  display: none;
}
.toast.success > .ic {
  display: none;
}
.toast.success::before {
  content: "";
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ok);
}
.toast.error {
  border-color: var(--failed-line);
}
.toast.error > .ic {
  flex: none;
  color: var(--failed);
}
.toast .tb {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.toast .tt {
  margin: 0;
  font-weight: 600;
}
.toast .td {
  margin: 2px 0 0;
  font-weight: 400;
  color: var(--ink-2);
}
.toast .raw {
  font: 12px/1.4 var(--mono);
  color: var(--ink-2);
}
.toast .btn {
  flex: none;
}
.toast .tx {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: var(--ctl-sm);
  height: var(--ctl-sm);
  margin: -4px 0;
  padding: 0;
  border: 0;
  border-radius: var(--rd-2);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.toast .tx:hover {
  background: var(--hover);
  color: var(--ink);
}
@media (pointer: coarse) {
  .toast .tx,
  .toast .btn {
    min-width: var(--tap);
    min-height: var(--tap);
  }
}
@media (forced-colors: active) {
  .toast {
    border-color: CanvasText;
  }
  .toast.success::before {
    forced-color-adjust: none;
    background: CanvasText;
  }
}

/* ---------- the search list and the Find palette: one list under ruled group headers ---------- */
.suggest {
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-3);
  background: var(--dlg);
  box-shadow: var(--sh-2);
}
.suggest [role="group"] + [role="group"] {
  border-top: 1px solid var(--rule);
}
.suggest .sg-h {
  padding: 9px 14px;
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
  font: 650 12.5px/1 var(--sans);
  color: var(--ink-2);
}
.suggest [role="option"] {
  display: grid;
  gap: 1px;
  padding: 8px 14px;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}
.suggest [role="option"] + [role="option"] {
  border-top: 1px solid var(--rule);
}
.suggest [role="option"] b {
  font-weight: 620;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.suggest [role="option"] small {
  font-size: 12.5px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.suggest [role="option"]:hover {
  background: var(--hover);
}
.suggest [role="option"]:active {
  background: var(--press);
}
.suggest [role="option"][aria-selected="true"] {
  background: var(--sel-bg);
  box-shadow: inset 2px 0 0 var(--ink);
}
.suggest .all {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}
/* a long unbroken query wraps inside its column, clear of the keycap */
.suggest .all span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.suggest [role="group"]:first-child > :first-child {
  border-radius: var(--rd-3-in) var(--rd-3-in) 0 0;
}
.suggest > :last-child [role="option"]:last-child,
.suggest > [role="option"]:last-child {
  border-radius: 0 0 var(--rd-3-in) var(--rd-3-in);
}
@media (forced-colors: active) {
  .suggest [role="option"][aria-selected="true"] {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
}
dialog.find {
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-3);
  background: var(--dlg);
  color: var(--ink);
  box-shadow: var(--sh-2);
}
dialog.find .suggest {
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: none;
}
.find-q {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--rule-2);
  border-radius: var(--rd-3-in) var(--rd-3-in) 0 0;
  color: var(--ink-2);
}
.find-q input {
  flex: 1;
  min-width: 0;
  height: 50px;
  border: 0;
  background: none;
  outline: 0;
  color: var(--ink);
  font-size: 16px;
}
.find-q input::placeholder {
  color: var(--ink-2);
}
.find-q input::-webkit-search-cancel-button {
  display: none;
}
/* the field draws no outline of its own: the row shows focus with an ink underline */
.find-q:has(input:focus-visible) {
  box-shadow: inset 0 -2px 0 var(--ink);
}
@media (forced-colors: active) {
  .find-q:has(input:focus-visible) {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
  }
}
.find-cancel {
  flex: none;
  min-height: var(--ctl-md);
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--spine);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.find-cancel:hover {
  text-decoration-color: currentColor;
}
.find-tokens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
}
.find-tl {
  margin-right: 6px;
  font: 650 12.5px/1 var(--sans);
  color: var(--ink-2);
}
/* key hints: items (a key and what it does), laid out with space. The keys and the words share one
   baseline (a keycap's 2 px bottom edge would lift it if centred); the padding centres the keys. */
.find-hints {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  min-height: 40px;
  margin: 0;
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
  border-radius: 0 0 var(--rd-3-in) var(--rd-3-in);
  background: var(--paper);
  font-size: 12.5px;
  color: var(--ink-2);
}
.find-hints .hint {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.find-hints .hint:last-child:not(:has(kbd)) {
  margin-left: auto;
}

/* ---------- dialogs: a header row, the body, a ruled footer row ---------- */
dialog.dlg {
  padding: 0;
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-3);
  background: var(--dlg);
  color: var(--ink);
  box-shadow: var(--sh-2);
}
dialog:is(.dlg, .find)::backdrop {
  background: var(--scrim);
}
/* the consequence band (public or destructive): a tinted header row with a coloured top edge */
.dlg .band {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 20px 14px 18px;
  border-bottom: 1px solid var(--public-line);
  border-radius: var(--rd-3-in) var(--rd-3-in) 0 0;
  background: var(--public-bg);
  box-shadow: inset 0 3px 0 var(--public);
  color: var(--ink);
}
.dlg .band svg {
  flex: none;
  margin-top: 2px;
  color: var(--public);
}
.dlg .band h2 {
  margin: 0;
  font: 700 16px/1.3 var(--sans);
  letter-spacing: -0.01em;
  color: var(--ink);
}
.dlg .band p {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--ink-2);
}
.dlg.danger .band {
  border-bottom-color: var(--failed-line);
  background: var(--failed-bg);
  box-shadow: inset 0 3px 0 var(--failed);
}
.dlg.danger .band svg {
  color: var(--failed);
}
@media (forced-colors: active) {
  .dlg .band {
    border-top: 3px solid CanvasText;
  }
}
.dlg .bd {
  display: grid;
  gap: 18px;
  padding: 18px 20px 20px;
}
.dlg .bd p {
  margin: 0;
}
/* a dialog whose title sits in the body gets the same header row as the band */
.dlg .bd > h2:first-child:not([hidden]) {
  display: flex;
  align-items: center;
  min-height: var(--r1);
  margin: -18px -20px 0;
  padding: 0 20px;
  border-bottom: 1px solid var(--rule);
  font: 700 16px/1.3 var(--sans);
  letter-spacing: -0.01em;
}
.dlg .bd h2 {
  margin: 0;
  font: 700 16px/1.3 var(--sans);
  letter-spacing: -0.01em;
}
.dlg .ft {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: 52px;
  padding: 10px 16px 10px 20px;
  border-top: 1px solid var(--rule-2);
  border-bottom-left-radius: var(--rd-3-in);
  border-bottom-right-radius: var(--rd-3-in);
  background: var(--paper);
}
.dlg .ft .grow {
  font-size: 13px;
  color: var(--ink-2);
}
.dlg .alert {
  margin: 0;
  padding: 0 20px 12px;
  background: var(--paper);
  font-size: 13px;
  color: var(--failed);
}
.dlg .alert:empty {
  display: none;
}
/* boxes inside dialogs: the same ruled box as everywhere */
.sees,
.cpv,
.kv.flat {
  border: 1px solid var(--rule-2);
  border-radius: var(--rd-2);
  background: var(--surface);
}
.kv.flat {
  padding: 10px 14px;
}
.sees h3,
details.sees > summary {
  margin: 0;
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
  font: 650 13px/1.2 var(--sans);
  color: var(--ink);
}
.sees h3 {
  padding: 11px 14px;
}
details.sees > summary h3 {
  border: 0;
  background: none;
}
.sees > h3:first-child,
details.sees > summary {
  border-radius: var(--rd-2-in) var(--rd-2-in) 0 0;
}
details.sees:not([open]) > summary {
  border-radius: var(--rd-2-in);
}
.cpv dt {
  font: 600 12.5px/1.3 var(--sans);
  color: var(--ink-2);
}
.cpv > div + div {
  border-top: 1px solid var(--rule);
}
dialog.dlg .when h3 {
  margin: 0 0 6px;
  font: 650 13px/1.2 var(--sans);
  color: var(--ink);
}
dialog.dlg .when li::marker {
  color: var(--ink-2);
  font-weight: 650;
}
/* phones: a sheet keeps the container radius on the edge it doesn't touch */
@media (max-width: 760px) {
  dialog.dlg,
  dialog.dlg.narrow {
    border-radius: var(--rd-3) var(--rd-3) 0 0;
  }
  .dlg .ft {
    border-radius: 0;
  }
}
@media (max-width: 599.98px) {
  [popover] > .mbox {
    border-radius: var(--rd-3) var(--rd-3) 0 0;
  }
  dialog.find {
    border-radius: 0 0 var(--rd-3) var(--rd-3);
  }
  dialog.find .find-q {
    border-radius: 0;
  }
}

/* ---------- keyboard shortcuts: ruled groups, rows of keys and words ---------- */
.kg h3 {
  margin: 18px 0 4px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--rule);
  font: 650 13px/1.2 var(--sans);
  color: var(--ink);
}
.kg h3 span {
  margin-left: 4px;
  font-weight: 450;
  color: var(--ink-2);
}
.kg dd small {
  display: block;
  font-size: 12.5px;
  color: var(--ink-2);
}

/* ---------- the health pill (writer health): a state button; tint, line and glyph ---------- */
.health {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: var(--ctl-md);
  padding: 0 11px 0 10px;
  border: 1px solid transparent;
  border-radius: var(--rd-2);
  background: none;
  color: var(--ink-2);
  font-size: var(--row-fs);
  font-weight: 560;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}
.health:hover {
  background-image: linear-gradient(var(--hover), var(--hover));
}
.health.ok .ic {
  color: var(--ok);
}
.health.off .ic {
  color: var(--ink-2);
}
.health.failed {
  border-color: var(--failed-line);
  background-color: var(--failed-bg);
  color: var(--failed);
  font-weight: 650;
}
.health.pending {
  border-color: var(--pending-line);
  background-color: var(--pending-bg);
  color: var(--pending);
  font-weight: 650;
}
/* the glyph on a tint: its inner ring takes the tint, not the surface */
.health.failed > .lb-g.failed {
  box-shadow:
    inset 0 0 0 1.5px var(--failed),
    inset 0 0 0 3px var(--failed-bg);
}
/* elsewhere (OW-10b, D71): this collection is fine, so the pill is neutral and only its ring is red,
   or amber when only stalls are elsewhere */
.health.away {
  border-color: var(--rule-2);
  background-color: var(--surface);
  color: var(--ink-2);
}
/* the visible words by width (the page's responsive CSS): .lbl from 1100 px, the elsewhere .mid
   below it, .short up to 760 px */
.health .short,
.health .mid {
  display: none;
}
@media (forced-colors: active) {
  .health {
    border: 1px solid CanvasText;
  }
}

/* ---------- the writer status popover (every page's health pill) ---------- */
.pop2 > .mbox {
  padding: 14px 16px;
}
.pop2 .big {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 680;
}
.pop2 .big .ic.ok {
  color: var(--ok);
}
.pop2 .big .ic.off {
  color: var(--ink-2);
}
.pop2 .big > .lb-g {
  width: 12px;
  height: 12px;
}
.pop2 .big > .lb-g.failed {
  box-shadow:
    inset 0 0 0 2px var(--failed),
    inset 0 0 0 3.5px var(--dlg);
}
.pop2 .kv dt {
  color: var(--ink-2);
}
.pop2 .acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
/* the scoped popover (OW-10b): This collection, Elsewhere on this writer, then the writer */
.pop2 .hp + .hp {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--rule);
}
.pop2 .hp h3 {
  margin: 0 0 8px;
  font: 650 12.5px/1.2 var(--sans);
  color: var(--ink-2);
}
.pop2 .hp .acts {
  margin-top: 10px;
}
.hrows {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hrows li {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.hrows li > .lb-g,
.hrows li > .ic {
  align-self: start;
  justify-self: center;
  margin-top: 4px;
}
.hrows li > .ic {
  margin-top: 2px;
}
.hrows .ok .ic {
  color: var(--ok);
}
.hrows b {
  font-weight: 600;
}
.hrows small {
  display: block;
  font-size: 12.5px;
  color: var(--ink-2);
}
.hrows .more {
  display: block;
  padding-left: 24px;
}
.hpw {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--rule);
  font-size: 12.5px;
  color: var(--ink-2);
}

/* ---------- focus inside a box: an inset ring that follows the corner, never an outline ---------- */
:is(.opt, .ch2 label, .expiry label):has(input:focus-visible),
:is(.suggest, .sees, .hosts, .fd, .mbox, .cpv, .lgroup) :is(a, button:not(.btn), summary, [role="option"]):focus-visible,
.fd .blk:focus-visible,
.codeblock pre:focus-visible {
  outline: 0;
  box-shadow: inset 0 0 0 2px var(--ink);
}
/* inside a choice the row shows focus, not the glyph */
:is(.opt, .ch2 label, .expiry label) input:focus-visible {
  outline: 0;
}
@media (forced-colors: active) {
  :is(.opt, .ch2 label, .expiry label):has(input:focus-visible),
  :is(.suggest, .sees, .hosts, .fd, .mbox, .cpv, .lgroup) :is(a, button:not(.btn), summary, [role="option"]):focus-visible,
  .fd .blk:focus-visible,
  .codeblock pre:focus-visible {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
  }
}

/* ---------- things you open: cards and disclosures get the film ---------- */
summary:hover {
  background-image: linear-gradient(var(--hover), var(--hover));
}

/* ---------- side-by-side rows: one height and one baseline across the panel edge ----------
   Rows beside each other (panel tabs | state notice, panel tools | revision strip) share a height
   (--r1, --r2) and a baseline: the same text metrics (--row-fs, --row-lh) centred in the row;
   underlines are inset shadows (a border would take 2 px and lift the label); a glyph or icon
   groups with its word on the word's baseline, the glyph centred on the line. */
.ptabs {
  display: flex;
  align-items: stretch;
  gap: 18px;
  flex: none;
  height: var(--r1);
  padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--rule);
}
.ptabs a {
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  align-items: baseline;
  gap: 0 6px;
  height: auto;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  color: var(--ink-2);
  font: 600 var(--row-fs) / var(--row-lh) var(--sans);
  text-decoration: none;
}
.ptabs a[aria-selected="true"] {
  color: var(--ink);
  box-shadow: inset 0 -2px 0 var(--ink);
}
.ptabs a.pub[aria-selected="true"] {
  color: var(--public);
  box-shadow: inset 0 -2px 0 var(--public);
}
.ptabs a:not([aria-selected="true"]):hover {
  color: var(--ink);
  box-shadow: inset 0 -2px 0 var(--spine);
}
.ptabs a.pub:not([aria-selected="true"]):hover {
  color: var(--public);
  box-shadow: inset 0 -2px 0 var(--public-line);
}
/* a smaller part inside a row's label has a tight line height: it must not move the baseline */
.ptabs .n {
  font-size: 12.5px;
  font-weight: 450;
  line-height: 1;
  color: var(--ink-2);
}
.ptabs a.pub .n {
  color: inherit;
}
@media (forced-colors: active) {
  .ptabs a[aria-selected="true"] {
    text-decoration: underline 2px;
    text-underline-offset: 6px;
  }
}
.status1 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 22px;
  min-height: var(--r1);
  padding: 6px 16px 6px 22px;
  border-bottom: 1px solid var(--rule);
  background: var(--surface);
  font: 400 var(--row-fs) / var(--row-lh) var(--sans);
}
@media (min-width: 1100px) {
  .status1 {
    height: var(--r1);
    padding-block: 0;
    flex-wrap: nowrap;
    overflow: hidden;
    white-space: nowrap;
  }
  /* one line beside the tabs: the long clauses drop out (the full sentence stays in the tap label) */
  .status1 .long {
    display: none;
  }
}
.status1 .seg1 {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status1 :is(.pubseg, .f, .p) {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-weight: 650;
  vertical-align: baseline;
}
.status1 .pubseg {
  color: var(--public);
}
.status1 .f {
  color: var(--failed);
}
.status1 .p {
  color: var(--pending);
}
.status1 :is(.pubseg, .f, .p) > :is(svg, .lb-g) {
  align-self: center;
}
`;
