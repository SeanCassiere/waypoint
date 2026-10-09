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
 * `aria-current` (and the Files popover's `autofocus`, so it opens on the new file; a tab is
 * scrolled into view instead), updates the Files button's current path, and replaces the URL
 * with that link's own server-rendered href. Before the first `replaceState` it pins every file
 * link to its absolute URL (RX-02), so links written relative to the original page still point at
 * the right files once the URL is in another folder.
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
    for (const a of document.querySelectorAll("#files a[data-p]")) {
      a.toggleAttribute("autofocus", a === hit);
    }
    if (hit.closest(".ptabs2")) hit.scrollIntoView({ inline: "center", block: "nearest" });
    frame.title = path;
    const current = document.querySelector("#files-cur .t");
    if (current) current.textContent = path.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, "\\ufffd");
    if (hit.href !== location.href) {
      pinLinks();
      history.replaceState(null, "", hit.href);
    }
  });
})();`;

/**
 * Popover light dismiss and the tab strip (A11Y-07, R1; D51). For every `[popover]`: opening it
 * first expands any folder around its `autofocus` row, so the native autofocus can reach that
 * row. A press inside the document frame never reaches this document, but it moves focus into
 * the frame, which blurs this window, so that closes them (deferred, and only when the frame took
 * focus, so switching browser tabs doesn't). A closing popover keeps the scrim a moment
 * (`linger`), so the closing tap's click lands on it, not on what's beneath. When focus was inside
 * a popover that closes and is left nowhere (an outside press on something not focusable; Esc and
 * Done already restore it natively) while no other popover opened, it returns to the popover's
 * invoker. The tab strip scrolls
 * its current tab into view on load and keeps `data-more` ("start", "end", "start end") for its
 * edge fades.
 */
export const filesMenuScript: string = `(() => {
  const scrim = document.querySelector(".pop-scrim");
  let lingering;
  let last = null;
  document.addEventListener("focusin", (e) => {
    last = e.target;
  });
  document.addEventListener("beforetoggle", (e) => {
    const popover = e.target;
    if (!(popover instanceof HTMLElement) || !popover.hasAttribute("popover")) return;
    if (e.newState === "open") {
      const row = popover.querySelector("[autofocus]");
      for (let d = row && row.closest("details"); d && popover.contains(d);) {
        d.open = true;
        d = d.parentElement && d.parentElement.closest("details");
      }
      return;
    }
    if (scrim) {
      scrim.classList.add("linger");
      clearTimeout(lingering);
      lingering = setTimeout(() => scrim.classList.remove("linger"), 400);
    }
    const focus = document.activeElement;
    const inside = popover.contains(focus) || ((!focus || focus === document.body) &&
      last instanceof Node && popover.contains(last));
    if (!inside || !popover.id) return;
    const invoker = document.querySelector('[popovertarget="' + CSS.escape(popover.id) +
      '"]:not([popovertargetaction="hide"])');
    if (!invoker) return;
    setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (!document.querySelector(":popover-open")) invoker.focus({ preventScroll: true });
    }, 0);
  }, true);
  addEventListener("blur", () => {
    setTimeout(() => {
      if (!(document.activeElement instanceof HTMLIFrameElement)) return;
      for (const popover of document.querySelectorAll("[popover]")) {
        if (popover.matches(":popover-open")) popover.hidePopover();
      }
    }, 0);
  });
  const strip = document.querySelector(".ptabs2");
  if (!strip) return;
  const more = () => {
    const end = strip.scrollWidth - strip.clientWidth - 1;
    const at = Math.abs(strip.scrollLeft);
    const value = [at > 1 ? "start" : "", at < end ? "end" : ""].join(" ").trim();
    if (value) strip.dataset.more = value;
    else delete strip.dataset.more;
  };
  const current = strip.querySelector("a[aria-current]");
  if (current) current.scrollIntoView({ inline: "center", block: "nearest" });
  more();
  strip.addEventListener("scroll", more, { passive: true });
  addEventListener("resize", more);
})();`;
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
