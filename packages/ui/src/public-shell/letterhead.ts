import { escapeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import type { PublicShellOptions } from "./index.ts";
import { showBidi } from "./text.ts";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "7 Oct 2026, 22:08 UTC": the no-script fallback; the script localizes it. */
const pad = (n: number): string => String(n).padStart(2, "0");
export function formatShellTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const DAY = 86_400_000;
/** The expiry shows in the meta row from this far out; About always shows it. */
const EXPIRY_SHOWN = 30 * DAY;

/**
 * A `<time>` the shell script rewrites once at load: "rel" (relative, with a phone short form),
 * "date" (local date and time) or "full" (weekday, date, time and zone). The server text is UTC.
 * `toISOString` throws on an out-of-range timestamp, which the reader turns into a denial.
 */
const time = (ms: number, kind: "rel" | "date" | "full"): string =>
  `<time datetime="${new Date(ms).toISOString()}" data-t="${kind}">${formatShellTime(ms)}</time>`;

/** The meta row: the mode pill, then the facts ("Updated …" or "Taken … won't change", the expiry). */
function note(options: PublicShellOptions, now: number): string {
  const mode =
    options.snapshotAt === null
      ? `<span class="mode">${icon("follow", "sm")}Latest<span class="lgo"> version</span></span>`
      : `<span class="mode">${icon("pin", "sm")}Snapshot</span>`;
  let facts = "";
  if (options.snapshotAt !== null)
    facts = `<span class="f">Taken ${time(options.snapshotAt, "date")}</span><span class="f">won't change</span>`;
  else if (options.updatedAt !== null)
    facts = `<span class="f">Updated ${time(options.updatedAt, "rel")}</span>`;
  const { expiresAt } = options;
  if (typeof expiresAt === "number" && expiresAt - now <= EXPIRY_SHOWN) {
    const soon = expiresAt - now < DAY;
    facts += `<span class="${soon ? "f exp soon" : "f exp"}">${soon ? icon("clock", "sm") : ""}<span class="lgo">Link expires</span><span class="smo">Expires</span> ${time(expiresAt, "rel")}</span>`;
  }
  return `<p class="note">${mode}${facts}</p>`;
}

const row = (svg: string, head: string, body: string): string =>
  `<li>${svg}<div><b>${head}</b><span>${body}</span></div></li>`;

/** About this link: what the link shows, how long it works, and that it's read-only. */
function about(options: PublicShellOptions, title: string): string {
  let mode: string;
  if (options.snapshotAt !== null) {
    mode = row(
      icon("pin"),
      "A fixed snapshot",
      `Taken ${time(options.snapshotAt, "full")}. It won't change. Newer versions may exist; ask the person who shared it for a new link.`,
    );
  } else {
    const at = options.updatedAt;
    const from =
      at === null
        ? ""
        : ` This one is from ${time(at, "full")}<span data-ago="${new Date(at).toISOString()}"></span>.`;
    mode = row(
      icon("follow"),
      "Shows the latest version",
      `When it's updated, you'll see the new version here.${from}`,
    );
  }
  const { expiresAt } = options;
  const expiry =
    expiresAt === undefined
      ? row(
          icon("clock"),
          "Expiry depends on the link",
          "Each public link has its own end date; recipients see theirs here.",
        )
      : expiresAt === null
        ? row(icon("clock"), "No end date", "It works until the person who shared it turns it off.")
        : row(
            icon("clock"),
            `Works until ${time(expiresAt, "full")}`,
            `<span data-in="${new Date(expiresAt).toISOString()}"></span>The person who shared it can also turn it off sooner.`,
          );
  const count = options.files.length;
  const what = count === 1 ? "the file" : `the ${count.toLocaleString("en")} files`;
  const readOnly = row(
    icon("lock"),
    "Read-only",
    `You can read and download ${what} in this version. Nothing can be changed from here.`,
  );
  const mark =
    '<svg class="wmark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15"/><path d="M14 20l10 26 8-17 8 17 10-26"/></svg>';
  return `<div id="about" class="menu about" popover="auto"><div class="mbox" role="group" aria-labelledby="about-h"><p class="full" dir="auto">${title}</p><h2 id="about-h">About this link</h2><ul>${mode}${expiry}${readOnly}</ul><p class="foot">${mark}Shared from Waypoint</p></div></div>`;
}

/**
 * The letterhead: the title (two lines at most) with the meta row beneath, and on the right
 * "Read-only" and the About button with its popover. `actionsLead` is inserted verbatim as the
 * first action (RX-06's single-file Download). Never shows the link's label.
 */
export function letterhead(options: PublicShellOptions, actionsLead = ""): string {
  const title = escapeHtml(showBidi(options.title));
  const now = options.now ?? Date.now();
  const button = `<button type="button" class="abt" popovertarget="about"><span class="lgo">${icon("info", "sm")}About this link</span><span class="smo">${icon("lock", "sm")}Read-only<span class="vh">, about this link</span>${icon("info", "sm")}</span></button>`;
  return `<header class="lh"><div class="ttl"><h1 dir="auto">${title}</h1>${note(options, now)}</div><div class="acts">${actionsLead}<span class="ro">${icon("lock", "sm")}Read-only</span>${button}${about(options, title)}</div></header>`;
}
