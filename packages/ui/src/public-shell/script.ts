import { PANEL_STORAGE_KEY, PEEK_CLOSE_GRACE, PEEK_OPEN_DELAY, PEEK_SLIDE_OUT } from "../panel.ts";
import { WIDE_MIN } from "../tokens.ts";

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
 * `aria-current` (and the panel's `autofocus`, so the Files sheet opens on the new file), opens
 * the folders around the new row and scrolls the panel just enough to show it (by setting the
 * panel body's `scrollTop`, never with `scrollIntoView`: in Chromium that moves the sequential
 * focus starting point to the row, RX-10 d-1), updates the Files button's current path and icon
 * and the page title ("<file name> · <the h1's text>", RX-03), and replaces the URL with that link's own
 * server-rendered href, plus the report's section fragment when it matches `^#[\w.~%-]{1,256}$`
 * (RX-09). A report for the current file changes only the URL, and only when it has a fragment;
 * a file switch drops it. Before the first `replaceState` it pins every file link to its absolute
 * URL (RX-02), so links written relative to the original page still point at the right files
 * once the URL is in another folder. The row's Download control (RX-06) follows the new file:
 * its `?download` URL, saved name and accessible name come from that link's own `data-p`.
 */
export const locationScript: string = `(() => {
  const sectionHash = /^#[\\w.~%-]{1,256}$/;
  const links = () => document.querySelectorAll("a[data-p]");
  let pinned = false;
  const pinLinks = () => {
    if (pinned) return;
    pinned = true;
    for (const a of links()) a.setAttribute("href", a.href);
  };
  addEventListener("message", (e) => {
    const frame = document.getElementById("doc");
    if (!frame || !frame.dataset.base || e.source !== frame.contentWindow) return;
    const baseUrl = new URL(frame.dataset.base, location.href);
    const base = baseUrl.origin + baseUrl.pathname;
    const m = e.data;
    if (!m || typeof m !== "object" || m.type !== "waypoint:location") return;
    if (typeof m.href !== "string" || m.href.length > 8192) return;
    let path;
    let hash = "";
    try {
      const url = new URL(m.href, frame.src);
      hash = sectionHash.test(url.hash) ? url.hash : "";
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
    if (!hit) return;
    if (hit.hasAttribute("aria-current")) {
      if (hash && hit.href + hash !== location.href) {
        pinLinks();
        history.replaceState(null, "", hit.href + hash);
      }
      return;
    }
    for (const a of links()) {
      if (a.dataset.p === path) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    for (const a of document.querySelectorAll("#files a[data-p]")) {
      a.toggleAttribute("autofocus", a === hit);
    }
    const panel = document.getElementById("files");
    for (let d = hit.closest("details"); d && panel && panel.contains(d);) {
      d.open = true;
      d = d.parentElement && d.parentElement.closest("details");
    }
    const body = hit.closest(".pbody");
    if (body && body.clientHeight) {
      const b = body.getBoundingClientRect();
      const r = hit.getBoundingClientRect();
      if (r.top < b.top) body.scrollTop += r.top - b.top;
      else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom;
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
    const target = hit.href + hash;
    if (target !== location.href) {
      pinLinks();
      history.replaceState(null, "", target);
    }
  });
})();`;

/**
 * Popover light dismiss (A11Y-07, R1; D51). For every `[popover]`: opening it
 * first expands any folder around its `autofocus` row, so the native autofocus can reach that
 * row. A press inside the document frame never reaches this document, but it moves focus into
 * the frame, which blurs this window, so that closes them (deferred, and only when the frame took
 * focus, so switching browser tabs doesn't). A closing popover keeps the scrim a moment
 * (`linger`), so the closing tap's click lands on it, not on what's beneath. When focus was inside
 * a popover that closes and is left nowhere (an outside press on something not focusable; Esc and
 * Done already restore it natively) while no other popover opened, it returns to the popover's
 * invoker.
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
})();`;
/**
 * The file panel (D74), a port of the writer's client/panel.ts and client/panel-peek.ts without
 * tabs, dialogs or shortcuts. It puts `autofocus` on the current row after parsing, so the Files
 * sheet opens on it without the docked panel taking the focus at load. Rows get their full path
 * as `title` when first hovered or focused, so 2,000 rows don't carry it twice.
 * From WIDE_MIN the panel is docked: the button collapses and docks it (`#shell.closed`, which
 * panelStateScript applies from storage before the shell paints), saved as "open" or "closed"
 * under PANEL_STORAGE_KEY in localStorage (never with the share token: the key and values are
 * fixed), and its `popovertarget` is removed there, since Chromium reports a popover invoker's
 * expanded state from the popover alone; `aria-expanded` says whether the panel shows. Below
 * WIDE_MIN the button opens the native popover (filesMenuScript's light dismiss and focus return
 * apply) and nothing is saved. Crossing WIDE_MIN closes an open sheet; narrowing past it with the
 * focus in the docked panel (which then hides) moves the focus to the button.
 * Peek (D73): collapsed, from WIDE_MIN, with a mouse, resting PEEK_OPEN_DELAY ms on the shell's
 * left-edge strip or on the button brings the panel out as a card (`.peek`). It stays while the
 * pointer is over the card, the strip, the button or an open popover, or while something holds
 * it (keyboard focus in it, a text selection in it, a press, an open popover), and slides away
 * (`.peek-out`, PEEK_SLIDE_OUT ms) PEEK_CLOSE_GRACE ms after the pointer leaves. Esc, a followed
 * link, the window losing focus or the layout changing close it at once. It listens to no
 * messages: the document frame can't drive the panel.
 */
export const panelScript: string = `(() => {
  const shell = document.getElementById("shell");
  const panel = document.getElementById("files");
  const toggle = document.querySelector(".ptog");
  const edge = document.querySelector("#shell > .peek-edge");
  if (!shell || !panel || !toggle || !edge) return;
  const WIDE = matchMedia("(min-width: ${WIDE_MIN}px)");
  const FINE = matchMedia("(hover: hover) and (pointer: fine)");
  const save = (value) => {
    try {
      localStorage.setItem("${PANEL_STORAGE_KEY}", value);
    } catch {
      return;
    }
  };
  const current = panel.querySelector("a[aria-current]");
  if (current) current.setAttribute("autofocus", "");
  const title = (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-p]") : null;
    if (a && !a.title) a.title = a.dataset.p.replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, "\\ufffd");
  };
  panel.addEventListener("pointerover", title);
  panel.addEventListener("focusin", title);
  const peeking = () => shell.classList.contains("peek");
  const closed = () => shell.classList.contains("closed");
  const sync = () => {
    if (WIDE.matches) toggle.removeAttribute("popovertarget");
    else toggle.setAttribute("popovertarget", "files");
    const open = WIDE.matches ? !closed() || peeking() : panel.matches(":popover-open");
    toggle.setAttribute("aria-expanded", String(open));
  };
  const reveal = () => {
    const row = panel.querySelector("a[aria-current]");
    const body = row && row.closest(".pbody");
    if (!body || !body.clientHeight) return;
    const b = body.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < b.top) body.scrollTop += r.top - b.top;
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom;
  };
  let openTimer;
  let closeTimer;
  let outTimer;
  let inside = false;
  let pressed = false;
  let suppressed = false;
  const enabled = () => closed() && WIDE.matches && FINE.matches;
  const hovered = () => edge.matches(":hover") || toggle.matches(":hover");
  const cancelOpen = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  const open = () => {
    cancelOpen();
    if (!enabled() || peeking()) return;
    clearTimeout(outTimer);
    shell.classList.remove("peek-out");
    shell.classList.add("peek");
    inside = true;
    sync();
    reveal();
  };
  const stop = () => {
    cancelOpen();
    clearTimeout(closeTimer);
    clearTimeout(outTimer);
    inside = false;
    pressed = false;
    if (!peeking()) return;
    shell.classList.remove("peek", "peek-out");
    sync();
  };
  const close = (slide) => {
    cancelOpen();
    clearTimeout(closeTimer);
    if (!peeking()) return;
    const focused = panel.contains(document.activeElement);
    if (slide) {
      shell.classList.add("peek-out");
      clearTimeout(outTimer);
      outTimer = setTimeout(() => shell.classList.remove("peek-out"), ${PEEK_SLIDE_OUT + 50});
    }
    shell.classList.remove("peek");
    inside = false;
    pressed = false;
    suppressed = hovered();
    if (focused) toggle.focus({ preventScroll: true });
    sync();
  };
  const arm = (e) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0) return;
    if (!enabled() || peeking() || suppressed || openTimer !== undefined) return;
    openTimer = setTimeout(() => {
      openTimer = undefined;
      open();
    }, ${PEEK_OPEN_DELAY});
  };
  const held = () => {
    const active = document.activeElement;
    if (active && panel.contains(active) && active.matches(":focus-visible")) return true;
    if (document.querySelector("[popover]:popover-open")) return true;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && panel.contains(selection.anchorNode)) return true;
    return pressed;
  };
  const schedule = () => {
    clearTimeout(closeTimer);
    if (!peeking() || inside) return;
    closeTimer = setTimeout(() => {
      if (!peeking() || inside || held()) return;
      close(true);
    }, ${PEEK_CLOSE_GRACE});
  };
  const recheck = () => {
    if (peeking() && !inside) schedule();
  };
  const inArea = (node) => node instanceof Element && (panel.contains(node) || node === edge ||
    toggle.contains(node) || node.closest("[popover]:popover-open") !== null);
  toggle.addEventListener("click", (e) => {
    if (!WIDE.matches) return;
    e.preventDefault();
    stop();
    const collapse = !closed();
    shell.classList.toggle("closed", collapse);
    save(collapse ? "closed" : "open");
    if (collapse) suppressed = hovered();
    sync();
    if (!collapse) reveal();
  });
  panel.addEventListener("beforetoggle", (e) => {
    if (!WIDE.matches) toggle.setAttribute("aria-expanded", String(e.newState === "open"));
  });
  panel.addEventListener("toggle", sync);
  const layout = () => {
    if (WIDE.matches && panel.matches(":popover-open")) panel.hidePopover();
    if (!enabled()) stop();
    sync();
  };
  let left = null;
  document.addEventListener("focusin", (e) => {
    left = panel.contains(e.target) ? e.target : null;
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Node && panel.contains(e.target))) left = null;
  }, true);
  WIDE.addEventListener("change", () => {
    const active = document.activeElement;
    const lost = (!active || active === document.body) && left !== null;
    layout();
    if (!WIDE.matches && (panel.contains(active) || lost)) toggle.focus({ preventScroll: true });
  });
  FINE.addEventListener("change", layout);
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    if (peeking()) {
      const now = inArea(e.target);
      if (now === inside) return;
      inside = now;
      if (now) clearTimeout(closeTimer);
      else schedule();
      return;
    }
    if (e.target === edge || (e.target instanceof Node && toggle.contains(e.target))) arm(e);
    else {
      cancelOpen();
      suppressed = false;
    }
  }, true);
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || !peeking()) return;
    const to = e.relatedTarget;
    if (to instanceof Element && to.tagName !== "IFRAME") return;
    if (!to && e.clientX <= 0) return;
    inside = false;
    schedule();
  }, true);
  edge.addEventListener("pointermove", arm);
  edge.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    suppressed = false;
    open();
  });
  panel.addEventListener("pointerdown", () => {
    pressed = true;
  });
  document.addEventListener("pointerup", () => {
    if (!pressed) return;
    pressed = false;
    recheck();
  });
  document.addEventListener("selectionchange", recheck);
  panel.addEventListener("focusout", () => setTimeout(recheck));
  document.addEventListener("beforetoggle", recheck, true);
  document.addEventListener("toggle", recheck, true);
  panel.addEventListener("click", (e) => {
    if (!peeking() || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest("a[href]")) close(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !peeking() || document.querySelector(":popover-open")) return;
    close(false);
  });
  addEventListener("blur", () => close(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") close(false);
  });
  sync();
  reveal();
})();`;
/**
 * The file panel's stored state, applied before the shell paints (D74). It runs where the script
 * sits, straight after `#shell`'s start tag and before the panel's rows are parsed, so a panel
 * stored as "closed" never paints docked first; panelScript does the rest once parsing ends.
 */
export const panelStateScript: string = `(() => {
  const shell = document.getElementById("shell");
  if (!shell) return;
  try {
    if (localStorage.getItem("${PANEL_STORAGE_KEY}") === "closed") shell.classList.add("closed");
  } catch {
    return;
  }
})();`;
/** RX-01's About popover (R2). Empty: About is a native popover; timeScript formats its times. */
export const aboutScript: string = "";
/**
 * RX-09's section links (R2). A shell URL opened with a section fragment (`#open-questions`,
 * checked against the same pattern as `locationScript`'s) hands it to the document frame once
 * that has loaded, with `location.replace`: a fragment-only change on a loaded frame is a
 * same-document navigation, so no second request and no history entry (setting `src` instead, if
 * that throws). `locationScript` then keeps it in the address bar from the frame's report. Image
 * stages and download cards have no frame, so they ignore it.
 */
export const hashScript: string = `(() => {
  const frame = document.getElementById("doc");
  const hash = location.hash;
  if (!frame || frame.tagName !== "IFRAME" || !/^#[\\w.~%-]{1,256}$/.test(hash)) return;
  frame.addEventListener(
    "load",
    () => {
      const target = frame.src.split("#")[0] + hash;
      try {
        frame.contentWindow.location.replace(target);
      } catch {
        frame.src = target;
      }
    },
    { once: true },
  );
})();`;
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

/**
 * Exposes the release version to the browser console as `window._WAYPOINT_VERSION`. It reads
 * `<html data-waypoint-version>` instead of embedding the version, so the script's CSP hash
 * doesn't change with every release.
 */
export const versionScript: string = `(() => {
  const version = document.documentElement.dataset.waypointVersion;
  if (version) window._WAYPOINT_VERSION = version;
})();`;

/**
 * Segments that run where the script sits, before the rest of the page is parsed: the script
 * comes straight after `#shell`'s start tag (after the banner on a one-file page), so the banner's
 * times are already there, the panel's stored state applies before the shell paints, and the
 * frame's location reports are heard however early the frame loads.
 */
export const earlyShellScripts: readonly string[] = [
  versionScript,
  timeScript,
  panelStateScript,
  locationScript,
];
/** Segments that need the whole page: they run once it's parsed (`DOMContentLoaded`). */
export const parsedShellScripts: readonly string[] = [
  filesMenuScript,
  panelScript,
  aboutScript,
  hashScript,
  loadingScript,
  stageScript,
];
/** Wraps segments to run once the document is parsed (at once if it already is). */
export const afterParse = (segments: readonly string[]): string => `((run) => {
  if (document.readyState !== "loading") run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });
})(() => {
${segments.filter((segment) => segment !== "").join("\n")}
});`;

/** The shell's only script: the non-empty segments, in this order, one per line group. */
export const publicShellScript: string = [
  ...earlyShellScripts.filter((segment) => segment !== ""),
  afterParse(parsedShellScripts),
].join("\n");
