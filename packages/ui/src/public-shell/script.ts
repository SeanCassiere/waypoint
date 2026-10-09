/** Shows `<time datetime>` values in the reader's own time zone, as "8 Oct 2026, 02:05" (R2). */
export const timeScript: string = `(() => {
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const pad = (n) => String(n).padStart(2, "0");
  for (const time of document.querySelectorAll("time[datetime]")) {
    const d = new Date(time.dateTime);
    if (isNaN(d.getTime())) continue;
    time.textContent =
      d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear() + ", " +
      pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
})();`;

/**
 * Follows navigation inside the sandboxed frame (spec §8) (R1). Accepts `{ type:
 * "waypoint:location", href }` only from the frame's own window; `href` is untrusted: it must be
 * under the frame's raw prefix and name a file already linked in the shell. Then it moves
 * `aria-current` and replaces the URL with that link's own server-rendered href. Before the first
 * `replaceState` it pins every file link to its absolute URL (RX-02), so links written relative to
 * the original page still point at the right files once the URL is in another folder.
 */
export const locationScript: string = `(() => {
  const frame = document.getElementById("doc");
  if (!frame || !frame.dataset.base) return;
  const baseUrl = new URL(frame.dataset.base, location.href);
  const base = baseUrl.origin + baseUrl.pathname;
  const links = () => document.querySelectorAll("a[data-p]");
  let pinned = false;
  const pinLinks = () => {
    if (pinned) return;
    pinned = true;
    for (const a of links()) a.setAttribute("href", a.href);
  };
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.type !== "waypoint:location") return;
    if (typeof m.href !== "string" || m.href.length > 8192) return;
    let path;
    try {
      const url = new URL(m.href, frame.src);
      const href = url.origin + url.pathname;
      if (!href.startsWith(base)) return;
      const rest = href.slice(base.length);
      if (/%(?:2f|5c)/i.test(rest)) return;
      path = rest.split("/").map(decodeURIComponent).join("/").normalize("NFC");
    } catch {
      return;
    }
    let hit = null;
    for (const a of links()) {
      if (a.dataset.p === path) {
        hit = a;
        break;
      }
    }
    if (!hit || hit.hasAttribute("aria-current")) return;
    for (const a of links()) {
      if (a.dataset.p === path) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    frame.title = path;
    const current = document.querySelector(".pfiles .cur");
    if (current) current.textContent = path.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, "\\ufffd");
    if (hit.href !== location.href) {
      pinLinks();
      history.replaceState(null, "", hit.href);
    }
  });
})();`;

/** A11Y-07's file menu / sheet behaviour (R1). Empty until A11Y-07. */
export const filesMenuScript: string = "";
/** RX-01's About popover and relative times (R2). Empty until RX-01. */
export const aboutScript: string = "";
/** RX-09's section-link hash handling (R2). Empty until RX-09. */
export const hashScript: string = "";
/** A11Y-08's loading line (R2). Empty until A11Y-08. */
export const loadingScript: string = "";

/** The shell's only script: the non-empty segments, in this order, one per line group. */
export const publicShellScript: string = [
  timeScript,
  locationScript,
  filesMenuScript,
  aboutScript,
  hashScript,
  loadingScript,
]
  .filter((segment) => segment !== "")
  .join("\n");
