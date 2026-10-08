import { escapeHtml } from "../html.ts";
import type { PublicShellOptions } from "./index.ts";
import { showBidi } from "./text.ts";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "7 Oct 2026, 22:08 UTC": the no-script fallback; the script localizes it. */
const pad = (n: number): string => String(n).padStart(2, "0");
export function formatShellTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function note(options: PublicShellOptions): string {
  if (options.snapshotAt !== null) {
    const at = new Date(options.snapshotAt).toISOString();
    return `<p class="note"><span class="snap"><svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h6M6 1.5v5L3.5 9.5h9L10 6.5v-5M8 9.5V15"/></svg>Snapshot from <time datetime="${at}">${formatShellTime(options.snapshotAt)}</time></span></p>`;
  }
  if (options.updatedAt !== null) {
    const at = new Date(options.updatedAt).toISOString();
    return `<p class="note">Updated <time datetime="${at}">${formatShellTime(options.updatedAt)}</time></p>`;
  }
  return "";
}

/** The letterhead: the title, "Updated …" or "Snapshot from …", and the read-only note. */
export function letterhead(options: PublicShellOptions): string {
  const title = escapeHtml(showBidi(options.title));
  return `<header class="lh"><div class="ttl"><h1 dir="auto">${title}</h1>${note(options)}</div><span class="ro">Read-only · shared with you</span></header>`;
}
