// The reader's three static pages (spec §9.2): the bare root, the denial page and the framable
// denial card for the raw route (`/x/`). All are fixed constants with no per-request data, share
// one <style> element (one CSP hash), and carry no script, no style attributes, no links and no
// inputs. Built from sharedTokensCss plus these page rules, so the static pages can't drift from
// the shell.

import { FRAME_DENIED_BODY, FRAME_DENIED_HEADING, sharedTokensCss } from "@waypoint/ui";

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
@media(max-width:480px){main{margin-top:12dvh}h1{font-size:20px}}
.steps{margin:20px 0 0;padding:16px 0 0;border-top:1px solid var(--rule);list-style:none;display:grid;gap:10px;font-size:14.5px;color:var(--ink-2)}
.steps li{display:grid;grid-template-columns:22px 1fr;gap:6px}
.steps li::before{content:"";width:0;height:0;margin:9px 0 0 6px;border:3px solid var(--muted);border-radius:50%}
.steps b{color:var(--ink);font-weight:600}
.card{margin-top:10dvh;padding:24px;border:1px solid var(--rule);border-radius:14px;background:var(--sunken)}
.card h1{font-size:18px;line-height:1.35;margin-bottom:8px}.card p{margin:0;font-size:15px}
@media(max-width:480px){.card{margin-top:8dvh}}`;

const mark =
  '<div class="mark"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15"/><path d="M14 20l10 26 8-17 8 17 10-26"/></svg>Waypoint</div>';
const head = (title: string): string =>
  `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${staticCss}</style></head>`;

/** `GET /` and `HEAD /` only: 200. */
export const rootPage = `<!doctype html><html lang="en">${head("Waypoint")}<body><main>${mark}<h1>This address is for shared Waypoint documents</h1><p>Waypoint documents are shared with a private link. To read one, open the full link you were given.</p><p>If you typed or shortened the address, check that you copied the whole link. It's long, and every character matters.</p><p class="note">Shared links can stop working when they expire or when the person who shared them turns them off. If that happens, ask them for a new one.</p></main></body></html>\n`;

/** Every denial outside the raw route (`/x/`), for every reason: 404, byte-identical. */
export const deniedPage = `<!doctype html><html lang="en">${head("Link not available · Waypoint")}<body><main>${mark}<h1>This link isn't available</h1><p>It may have expired or been turned off by the person who shared it, or the address may be incomplete.</p><ul class="steps" role="list"><li><span><b>Check the whole link.</b> Shared links are long, and chat apps sometimes cut them off or wrap them onto two lines.</span></li><li><span><b>Opened several links that didn't work?</b> Wait a minute, then open yours again.</span></li><li><span><b>Still not working?</b> Ask the person who shared it for a new link. Waypoint can't tell you why a link stopped working.</span></li></ul></main></body></html>\n`;

/**
 * Every denial on the raw route (`/x/`), for every reason: 404, byte-identical. A small card with
 * no mark, framable by the shell (`frame-ancestors 'self'`), so a denied file inside the shell's
 * frame reads as a message instead of a browser error page.
 */
export const frameDeniedPage = `<!doctype html><html lang="en">${head("File not available · Waypoint")}<body><main class="card"><h1>${FRAME_DENIED_HEADING}</h1><p>${FRAME_DENIED_BODY}</p></main></body></html>\n`;
