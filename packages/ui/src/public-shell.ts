// The public reader's document shell (spec §9): letterhead, file tabs, sandboxed frame.
// Minimal writer-side version for ?as=public previews; the reader's implementation of this
// same API becomes canonical when the Folio branches merge. Callers supply every URL.
import { escapeHtml } from "./html.js";
import { tokensCss } from "./tokens.js";

export interface PublicShellOptions {
  title: string;
  /** "latest" shows "Updated …"; "pinned" shows a pin and "Snapshot from …". */
  mode: "latest" | "pinned";
  /** The served revision's time (ms). Rendered in UTC; the script localizes it. */
  revisionTime: number;
  files: readonly { path: string; href: string }[];
  current: string;
  frameSrc: string;
}

export const publicShellCss = `${tokensCss}html,body{height:100%}body{display:flex;flex-direction:column}
.pwrap{border-bottom:1px solid var(--rule);background:var(--paper);position:sticky;top:0;z-index:5}
.lh{display:flex;align-items:center;gap:14px;max-width:1120px;margin:0 auto;padding:12px 20px}
.lh .ttl{min-width:0;flex:1}.lh .ttl b{display:block;font:650 15px/1.3 var(--sans);overflow-wrap:anywhere}
.lh .ttl span{font-size:12.5px;color:var(--muted)}
.snap{display:inline-flex;gap:5px;align-items:center;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--sunken);border:1px solid var(--rule);color:var(--ink-2)}
.pin{width:12px;height:12px}
.ro{font-size:12px;color:var(--muted);white-space:nowrap}
.ptabs2{display:flex;gap:4px;max-width:1120px;margin:0 auto;padding:0 16px;overflow:auto}
.ptabs2 a{padding:8px 10px 10px;font-size:13px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}
.ptabs2 a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.pframe{display:block;width:100%;flex:1;border:0;background:var(--paper)}
@media(max-width:600px){.ro{display:none}.lh{padding:10px 14px}}
@media print{.pwrap{display:none}}
@media(prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}
.pwrap{view-transition-name:letterhead}.pframe{view-transition-name:doc-frame}
::view-transition-old(doc-frame){display:none}::view-transition-group(doc-frame),::view-transition-new(doc-frame){animation:none}`;

/** Localizes the letterhead time and follows waypoint:location messages from the frame. */
export const publicShellScript = `(()=>{const t=document.querySelector("time[datetime]");if(t){const d=new Date(t.dateTime);if(!isNaN(d))t.textContent=d.toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}const f=document.querySelector("iframe");const tabs=[...document.querySelectorAll(".ptabs2 a[data-path]")];addEventListener("message",e=>{if(!f||e.source!==f.contentWindow)return;const m=e.data;if(!m||m.type!=="waypoint:location"||typeof m.href!=="string")return;let p;try{p=decodeURIComponent(new URL(m.href,f.src).pathname)}catch{return}const hit=tabs.find(a=>p.endsWith("/"+a.dataset.path));if(!hit)return;for(const a of tabs)a.toggleAttribute("aria-current",a===hit);if(hit.getAttribute("aria-current")!==null)hit.setAttribute("aria-current","page");history.replaceState(null,"",hit.href)})})();`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PIN =
  '<svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h6M6 1.5v5L3.5 9.5h9L10 6.5v-5M8 9.5V15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function renderPublicShell(options: PublicShellOptions): string {
  const at = new Date(options.revisionTime);
  const stamp = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ""} ${at.getUTCFullYear()}, ${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  const time = `<time datetime="${at.toISOString()}">${stamp}</time>`;
  const note =
    options.mode === "pinned"
      ? `<span class="snap">${PIN}Snapshot from ${time}</span>`
      : `<span>Updated ${time}</span>`;
  const tabs =
    options.files.length > 1
      ? `<nav class="ptabs2" aria-label="Files">${options.files
          .map(
            (file) =>
              `<a href="${escapeHtml(file.href)}" data-path="${escapeHtml(file.path)}"${file.path === options.current ? ' aria-current="page"' : ""}>${escapeHtml(file.path)}</a>`,
          )
          .join("")}</nav>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(options.title)}</title><style>${publicShellCss}</style></head><body><div class="pwrap"><header class="lh"><div class="ttl"><b>${escapeHtml(options.title)}</b>${note}</div><span class="ro">Read-only · shared with you</span></header>${tabs}</div><iframe class="pframe" title="${escapeHtml(options.current)}" src="${escapeHtml(options.frameSrc)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe><script>${publicShellScript}</script></body></html>`;
}
