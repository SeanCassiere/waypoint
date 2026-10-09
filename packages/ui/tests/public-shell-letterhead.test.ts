import { describe, expect, it } from "vitest";

import { icon } from "../src/icons.ts";
import { letterheadCss } from "../src/public-shell/css.ts";
import type { PublicShellOptions } from "../src/public-shell/index.ts";
import { letterhead } from "../src/public-shell/letterhead.ts";
import { timeScript } from "../src/public-shell/script.ts";

const now = Date.UTC(2026, 9, 8, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const base: PublicShellOptions = {
  title: "Webhook idempotency research",
  files: [{ path: "index.md" }, { path: "a.md" }, { path: "b.md" }],
  head: "index.md",
  current: "index.md",
  fileHref: (path) => `./${path}`,
  frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
  updatedAt: now - 2 * HOUR,
  snapshotAt: null,
  expiresAt: null,
  now,
};
const render = (options: Partial<PublicShellOptions> = {}): string =>
  letterhead({ ...base, ...options });
const about = (html: string): string => html.slice(html.indexOf('<div id="about"'));
/** Row 2 of About: the expiry. */
const row2 = (html: string): string => about(html).split("<li>")[2] ?? "";
/** Compiles a script without running it, so a syntax error throws. */
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);
/** Innermost CSS rules as [selector, body]; at-rule wrappers drop away. */
const rules = (css: string): [string, string][] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);

describe("letterhead", () => {
  it("follows the latest with no end date", () => {
    const html = render();
    expect(html).toContain(
      `<span class="mode">${icon("follow", "sm")}Latest<span class="lgo"> version</span></span>`,
    );
    expect(html).toContain(
      `Updated <time datetime="${new Date(now - 2 * HOUR).toISOString()}" data-t="rel">8 Oct 2026, 10:00 UTC</time>`,
    );
    expect(html).not.toContain('class="f exp');
    expect(row2(html)).toContain("<b>No end date</b>");
    expect(html).not.toContain("Snapshot");
  });

  it("shows the expiry from 30 days out, and always in About", () => {
    const six = render({ expiresAt: now + 6 * DAY });
    expect(six).toMatch(
      /<span class="f exp"><span class="lgo">Link expires<\/span><span class="smo">Expires<\/span> <time datetime="[^"]+" data-t="rel">/,
    );
    expect(about(six)).toContain("Works until <time");
    expect(about(six)).toContain("data-in=");
    const later = render({ expiresAt: now + 31 * DAY });
    expect(later).not.toContain('class="f exp');
    expect(row2(later)).toContain("<b>Works until <time");
  });

  it("marks an expiry under 24 hours with the clock", () => {
    const html = render({ expiresAt: now + 5 * HOUR });
    expect(html).toContain(
      `<span class="f exp soon">${icon("clock", "sm")}<span class="lgo">Link expires</span>`,
    );
  });

  it("says Snapshot, Taken and won't change for a pinned link", () => {
    const html = render({ updatedAt: null, snapshotAt: now - DAY });
    expect(html).toContain(`<span class="mode">${icon("pin", "sm")}Snapshot</span>`);
    expect(html).toMatch(/Taken <time datetime="[^"]+" data-t="date">/);
    expect(html).toContain(`<span class="f">won't change</span>`);
    expect(about(html)).toContain("<b>A fixed snapshot</b>");
    expect(html).not.toContain("Latest");
    expect(html).not.toContain('class="snap"');
    expect(html).not.toContain('class="pin"');
  });

  it("says the expiry depends on the link when it's unknown", () => {
    const { expiresAt: _, ...unknown } = base;
    const html = letterhead(unknown);
    expect(row2(html)).toContain("<b>Expiry depends on the link</b>");
    expect(row2(html)).toContain(
      "Each public link has its own end date; recipients see theirs here.",
    );
    expect(row2(render({ expiresAt: null }))).toContain("<b>No end date</b>");
  });

  it("counts the files in the read-only row", () => {
    expect(render()).toContain("the 3 files in this version");
    expect(render({ files: [{ path: "index.md" }] })).toContain("the file in this version");
    const many = Array.from({ length: 2000 }, (_, i) => ({ path: `f${i}.md` }));
    expect(render({ files: many })).toContain("the 2,000 files");
  });

  it("has one About button with long and phone forms, and an unbranded-link footer", () => {
    const html = render();
    expect(html.match(/popovertarget="about"/g)).toHaveLength(1);
    const button = html.slice(html.indexOf('<button type="button" class="abt"'));
    expect(button).toMatch(/<span class="lgo">(?:(?!<\/span>).)*About this link<\/span>/);
    expect(button).toMatch(
      /<span class="smo">.*Read-only<span class="vh">, about this link<\/span>/,
    );
    expect(html).toContain('<div id="about" class="menu about" popover="auto">');
    expect(html).toContain('<div class="mbox" role="group" aria-labelledby="about-h">');
    expect(about(html)).toContain("Shared from Waypoint");
    expect(about(html)).not.toContain("<a");
  });

  it("puts actionsLead first in the actions", () => {
    expect(letterhead(base, "<x-lead></x-lead>")).toContain(
      '<div class="acts"><x-lead></x-lead><span class="ro">',
    );
  });

  it("escapes the title and shows bidi controls in the heading and in About", () => {
    const html = render({ title: `<img src=x onerror=alert(1)>"' ‮RTL` });
    const escaped = "&lt;img src=x onerror=alert(1)&gt;&quot;&#39; �RTL";
    expect(html).toContain(`<h1 dir="auto">${escaped}</h1>`);
    expect(html).toContain(`<p class="full" dir="auto">${escaped}</p>`);
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/[‪-‮⁦-⁩]/);
  });
});

describe("letterhead CSS and script", () => {
  it("has no motion and no writer-only tokens, with a phone layout and a two-line title", () => {
    for (const banned of ["transition", "animation", "view-transition", "--control", "--ok"])
      expect(letterheadCss).not.toContain(banned);
    expect(letterheadCss).toMatch(/\(max-width: ?599\.98px\)/);
    expect(letterheadCss).toContain("-webkit-line-clamp:2");
  });

  it("never colours the expiry amber; under 24 hours it's ink at weight 600", () => {
    const exp = rules(letterheadCss).filter(([selector]) => selector.includes(".exp"));
    expect(exp.length).toBeGreaterThan(0);
    for (const [selector, body] of exp) expect(`${selector}{${body}}`).not.toMatch(/--pending/);
    const soon = exp.filter(([selector]) => selector.includes(".exp.soon"));
    expect(soon).toHaveLength(1);
    expect(soon[0]![1]).toContain("var(--ink)");
    expect(soon[0]![1]).toMatch(/font-weight: ?600/);
  });

  it("formats times once, with no timers or comments", () => {
    for (const banned of ["setInterval", "setTimeout", "//", "/*"])
      expect(timeScript).not.toContain(banned);
    expect(() => parse(timeScript)).not.toThrow();
    expect(timeScript).toContain("RelativeTimeFormat");
    expect(timeScript).toContain("timeZoneName");
  });
});

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("syncing note", () => {
  const SENTENCE = "A newer version is being synced. It will appear here once it has uploaded.";
  const clock = icon("clock", "sm");

  it("shows the box under the meta row and the phone pill at the end of it", () => {
    const html = render({ syncing: true });
    expect(count(html, 'class="sync"')).toBe(1);
    expect(count(html, 'class="f pend"')).toBe(1);
    const note = html.slice(html.indexOf('<p class="note">'), html.indexOf("</p>") + 4);
    expect(note).toMatch(
      new RegExp(
        `<span class="f pend">${clock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}Newer version syncing<span class="vh">\\. It will appear here once it has uploaded\\.</span></span></p>$`,
      ),
    );
    expect(html).toContain(
      `${note}<p class="sync">${clock}<span>${SENTENCE}</span></p></div><div class="acts">`,
    );
  });

  it("never shows on a snapshot", () => {
    const html = render({ syncing: true, snapshotAt: now - DAY, updatedAt: null });
    expect(html).not.toContain('class="sync"');
    expect(html).not.toContain("pend");
    expect(html).not.toContain("Newer version syncing");
  });

  it("is absent unless syncing is true", () => {
    for (const html of [render(), render({ syncing: false })]) {
      expect(html).not.toContain('class="sync"');
      expect(html).not.toContain("pend");
    }
  });

  it("uses the pending tint and line only in its own rules, without motion", () => {
    const tinted = rules(letterheadCss).filter(([, body]) => /--pending-(?:bg|line)/.test(body));
    expect(tinted.length).toBeGreaterThan(0);
    for (const [selector] of tinted)
      expect(selector.split(",").every((part) => /\.(?:sync|pend)\b/.test(part))).toBe(true);
    const sync = rules(letterheadCss).find(([selector]) => selector === ".sync")?.[1] ?? "";
    expect(sync).toContain("background:var(--pending-bg)");
    expect(sync).toContain("border:1px solid var(--pending-line)");
    expect(sync).toContain("color:var(--pending)");
    const pend = rules(letterheadCss).find(([selector]) => selector === ".pend")?.[1] ?? "";
    expect(pend).toContain("display:none");
    expect(pend).toContain("var(--pending-bg)");
    expect(letterheadCss).toMatch(
      /@media\(max-width:599\.98px\)\{[^@]*\.sync\{display:none\}\.pend\{display:inline-block\}/,
    );
    expect(letterheadCss).toMatch(
      /@media\(forced-colors:active\)\{[^}]*\.sync,\.pend\{border-color:CanvasText\}/,
    );
    for (const banned of ["animation", "transition"]) expect(letterheadCss).not.toContain(banned);
  });
});
