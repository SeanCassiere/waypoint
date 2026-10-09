/**
 * Formats `<time datetime>` elements once at load, in the reader's own time zone (R2; RX-01). No
 * timers: relative times are as of page load. `data-t="rel"` becomes a relative time with a phone
 * short form ("2 hours ago" / "2 hr. ago"), `data-t="date"` a date ("8 Oct 2026, 02:05", the
 * year dropped on phones in the current year), both with the full local time and zone as `title`;
 * `data-t="full"` becomes that full time ("Thu 8 Oct 2026, 02:05 GMT+13"), and any other `<time>`
 * "8 Oct 2026, 02:05". `[data-ago]` and `[data-in]` (in About) get " (2 hours ago)" and
 * "That's in 6 days. ". The server text, kept without JavaScript, is UTC.
 */
export const timeScript: string = `(() => {
  const now = Date.now();
  const year = new Date(now).getFullYear();
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const days = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const day = (d) => d.getDate() + " " + months[d.getMonth()];
  const date = (d, withYear) => day(d) + (withYear ? " " + d.getFullYear() : "") + ", " + clock(d);
  const zone = (d) => {
    try {
      const parts = new Intl.DateTimeFormat("en", { timeZoneName: "short" }).formatToParts(d);
      const part = parts.find((p) => p.type === "timeZoneName");
      return part ? " " + part.value : "";
    } catch {
      return "";
    }
  };
  const full = (d) => days[d.getDay()] + " " + date(d, true) + zone(d);
  const long = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const short = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "short" });
  const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
  const rel = (d, format) => {
    const ms = d.getTime() - now;
    const abs = Math.abs(ms);
    if (ms <= 0 && abs < 60000) return "just now";
    if (ms <= 0 && abs >= 7 * 86400000) {
      return "on " + day(d) + (d.getFullYear() === year ? "" : " " + d.getFullYear());
    }
    for (const [unit, size] of units) {
      const value = Math.floor(abs / size);
      if (value >= 1 || unit === "minute") {
        return format.format(ms <= 0 ? -value : Math.max(1, value), unit);
      }
    }
    return "";
  };
  const span = (className, text) => {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
  };
  const valid = (value) => {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  };
  for (const time of document.querySelectorAll("time[datetime]")) {
    const d = valid(time.dateTime);
    if (!d) continue;
    const kind = time.dataset.t;
    if (kind === "rel" || kind === "date") {
      const pair = kind === "rel"
        ? [rel(d, long), rel(d, short)]
        : [date(d, true), date(d, d.getFullYear() !== year)];
      time.replaceChildren(span("lgt", pair[0]), span("smt", pair[1]));
      time.title = full(d);
    } else if (kind === "full") {
      time.textContent = full(d);
    } else {
      time.textContent = date(d, true);
    }
  }
  for (const element of document.querySelectorAll("[data-ago]")) {
    const d = valid(element.dataset.ago);
    if (d) element.textContent = " (" + rel(d, long) + ")";
  }
  for (const element of document.querySelectorAll("[data-in]")) {
    const d = valid(element.dataset.in);
    if (d) element.textContent = "That's " + rel(d, long) + ". ";
  }
})();`;

/**
 * Follows navigation inside the sandboxed frame (spec §8) (R1). Accepts `{ type:
 * "waypoint:location", href }` only from the frame's own window; `href` is untrusted: it must be
 * under the frame's raw prefix and name a file already linked in the shell. Then it moves
 * `aria-current` (and the Files popover's `autofocus`, so it opens on the new file; a tab is
 * scrolled into view instead), updates the Files button's current path and icon and the page
 * title ("<file name> · <the h1's text>", RX-03), and replaces the URL with that link's own
 * server-rendered href. Before the first `replaceState` it pins every file link to its absolute
 * URL (RX-02), so links written relative to the original page still point at the right files
 * once the URL is in another folder. The row's Download control (RX-06) follows the new file:
 * its `?download` URL, saved name and accessible name come from that link's own `data-p`.
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
    const strip = hit.closest(".ptabs2");
    if (strip) {
      const s = strip.getBoundingClientRect();
      const r = hit.getBoundingClientRect();
      strip.scrollLeft += r.left + r.width / 2 - (s.left + s.width / 2);
    }
    frame.title = path;
    const shown = path.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, "\\ufffd");
    const current = document.querySelector("#files-cur .t");
    if (current) current.textContent = shown;
    const icon = document.querySelector("#files-cur use");
    const kind = hit.querySelector("use");
    if (icon && kind) icon.setAttribute("href", kind.getAttribute("href"));
    const h1 = document.querySelector("h1");
    document.title = shown.slice(shown.lastIndexOf("/") + 1) + (h1 ? " · " + h1.textContent : "");
    const download = document.querySelector(".prow > .dlb");
    if (download) {
      const p = hit.dataset.p;
      const name = p.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, "\\ufffd");
      const href = base + p.split("/").map(encodeURIComponent).join("/") + "?download";
      download.setAttribute("href", href);
      download.setAttribute("download", name.slice(name.lastIndexOf("/") + 1));
      download.setAttribute("aria-label", "Download " + name);
    }
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
 * edge fades. Both here and in `locationScript` the tab is centred by setting the strip's
 * `scrollLeft`, never with `scrollIntoView`: in Chromium that moves the sequential focus starting
 * point to the tab, so a first Tab from load would skip the skip link (RX-10, decision d-1).
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
  if (current) {
    const s = strip.getBoundingClientRect();
    const r = current.getBoundingClientRect();
    strip.scrollLeft += r.left + r.width / 2 - (s.left + s.width / 2);
  }
  more();
  strip.addEventListener("scroll", more, { passive: true });
  addEventListener("resize", more);
})();`;
/** RX-01's About popover (R2). Empty: About is a native popover; timeScript formats its times. */
export const aboutScript: string = "";
/** RX-09's section-link hash handling (R2). Empty until RX-09. */
export const hashScript: string = "";
/**
 * A11Y-08's loading line (R2). `main` is busy until the document frame loads (busy dropped after
 * 8 s at the latest); the empty `role=status` line behind the transparent frame gets "Opening
 * <path>…" only after 300 ms, so a fast load is never announced. No motion: one visibility step.
 * Download and image pages have no `#loading`, so nothing happens there.
 */
export const loadingScript: string = `(() => {
  const frame = document.getElementById("doc");
  const line = document.getElementById("loading");
  const main = document.getElementById("main");
  const wrap = frame && frame.parentElement;
  if (!frame || frame.tagName !== "IFRAME" || !line || !main || !wrap) return;
  const name = frame.title;
  let done = false;
  main.setAttribute("aria-busy", "true");
  const show = setTimeout(() => {
    if (!done) line.textContent = "Opening " + name + "\\u2026";
  }, 300);
  const fallback = setTimeout(() => main.removeAttribute("aria-busy"), 8000);
  const finish = () => {
    done = true;
    clearTimeout(show);
    clearTimeout(fallback);
    wrap.setAttribute("data-loaded", "");
    line.textContent = "";
    main.removeAttribute("aria-busy");
  };
  frame.addEventListener("load", finish, { once: true });
})();`;

/**
 * RX-04's image stage: when the image fails (a revoked or expired link answers the raw request
 * with the frame denial, which an <img> can't show), the `#imgerr` template's card replaces it.
 * Last, and independent of the other segments.
 */
export const stageScript: string = `(() => {
  const img = document.querySelector("#doc.stage img");
  const template = document.getElementById("imgerr");
  if (!img || !template || !template.content) return;
  const swap = () => {
    const fit = img.closest(".fit");
    if (fit) fit.replaceChildren(template.content.cloneNode(true));
  };
  if (img.complete && !img.naturalWidth) swap();
  else img.addEventListener("error", swap, { once: true });
})();`;

/** The shell's only script: the non-empty segments, in this order, one per line group. */
export const publicShellScript: string = [
  timeScript,
  locationScript,
  filesMenuScript,
  aboutScript,
  hashScript,
  loadingScript,
  stageScript,
]
  .filter((segment) => segment !== "")
  .join("\n");
