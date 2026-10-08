// The reader's two static pages (spec §9.2): the bare root and the uniform denial page.
// Both are fixed constants with no per-request data, share one <style> element (one CSP hash),
// and carry no script, no style attributes, no links and no inputs. Built from sharedTokensCss
// plus these page rules, so the static pages can't drift from the shell.

import { sharedTokensCss } from "@waypoint/ui";

export const staticCss: string =
  sharedTokensCss +
  `:root{font:16px/1.6 var(--sans)}
html,body{min-height:100%}body{display:flex;min-height:100dvh;align-items:flex-start;justify-content:center}
main{width:100%;max-width:560px;margin:18dvh 24px 48px}
.mark{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14px;color:var(--muted);margin:0 0 28px;letter-spacing:-.005em}
.mark svg{width:20px;height:20px;flex:none}.mark rect{fill:var(--muted)}.mark path{fill:none;stroke:var(--paper);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-.015em;margin:0 0 10px;text-wrap:balance}
p{margin:0 0 12px;color:var(--ink-2);text-wrap:pretty}
.note{margin-top:24px;padding-top:16px;border-top:1px solid var(--rule);font-size:14px;color:var(--muted)}
@media(max-width:480px){main{margin-top:12dvh}h1{font-size:20px}}`;

const mark =
  '<div class="mark"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15"/><path d="M14 20l10 26 8-17 8 17 10-26"/></svg>Waypoint</div>';
const head = (title: string): string =>
  `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${staticCss}</style></head>`;

/** `GET /` and `HEAD /` only: 200. */
export const rootPage = `<!doctype html><html lang="en">${head("Waypoint")}<body><main>${mark}<h1>This address is for shared Waypoint documents</h1><p>Waypoint documents are shared with a private link. To read one, open the full link you were given.</p><p>If you typed or shortened the address, check that you copied the whole link. It's long, and every character matters.</p><p class="note">Shared links can stop working when they expire or when the person who shared them turns them off. If that happens, ask them for a new one.</p></main></body></html>\n`;

/** Every denial, for every reason: 404, byte-identical. */
export const deniedPage = `<!doctype html><html lang="en">${head("Not available")}<body><main>${mark}<h1>This link isn't available</h1><p>It may have expired or been turned off by the person who shared it, or the address may be incomplete.</p><p class="note">If you were expecting to see something here, check that you copied the whole link, or ask the person who shared it for a new one.</p></main></body></html>\n`;
