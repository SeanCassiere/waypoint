import { describe, expect, it } from "vitest";

import type { Health } from "../src/health.ts";
import { HomeBar, type Chrome, type HomeBarCurrent } from "../src/viewer/layout.tsx";

const health: Health = {
  state: "synced",
  label: "Synced",
  short: "Synced",
  aria: "Synced",
  failed: [],
  pending: [],
  oldestPendingAt: null,
  lastPushAt: null,
  lastPullAt: null,
  cloudLastOkAt: null,
  cloudError: null,
  blockedReason: null,
  environment: "dev",
  syncEnabled: false,
};

function chrome(counts: Partial<Chrome> = {}): Chrome {
  return {
    health,
    now: 0,
    host: "writer.example.test",
    liveLinkCount: 4,
    pausedLinkCount: 1,
    trashCount: 2,
    trashedPending: [],
    ...counts,
  };
}

async function render(current: HomeBarCurrent, counts?: Partial<Chrome>): Promise<string> {
  const node = await HomeBar({ chrome: chrome(counts), current });
  return node.toString();
}

/** The markup from `open` to its closing tag (the first `close` after it). */
function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  if (start < 0) return "";
  return html.slice(start, html.indexOf(close, start) + close.length);
}
const gnav = (html: string) => between(html, '<nav class="gnav', "</nav>");
const more = (html: string) => between(html, '<div id="home-more"', "</div></div>");
const goTo = (html: string) => between(html, '<div id="go-to"', "</nav>");
/** The `<a …>…</a>` in `html` whose href is exactly `href`. */
function link(html: string, href: string): string {
  return (
    [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)]
      .map(([match]) => match)
      .find((match) => match.includes(`href="${href}"`)) ?? ""
  );
}
const currentHrefs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map(
    ([tag]) => /href="([^"]*)"/.exec(tag)?.[1],
  );
/** The text a name is built from: tags and aria-hidden spans (none nest) removed. */
const text = (html: string) =>
  html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("HomeBar", () => {
  it.each([
    ["recent", "/"],
    ["links", "/links"],
    ["trash", "/trash"],
  ] as const)("marks the %s tab current, and only it", async (current, href) => {
    const html = await render(current);
    expect(currentHrefs(gnav(html))).toEqual([href]);
    expect(currentHrefs(goTo(html))).toEqual([href]);
    expect(currentHrefs(more(html))).toEqual([]);
  });

  it.each([
    ["status", "/status", "Status"],
    ["mcp", "/mcp", "Connect an agent"],
  ] as const)("marks %s in ⋯ and the Go to sheet, not in the tabs", async (current, href, name) => {
    const html = await render(current);
    expect(currentHrefs(gnav(html))).toEqual([]);
    expect(currentHrefs(more(html))).toEqual([href]);
    expect(currentHrefs(goTo(html))).toEqual([href]);
    expect(text(between(html, '<button type="button" class="where', "</button>"))).toBe(
      `${name}, go to another page`,
    );
  });

  it("marks nothing current on a page outside the destinations", async () => {
    const html = await render(null);
    expect(html).not.toContain("aria-current");
    expect(text(between(html, '<button type="button" class="where', "</button>"))).toBe(
      "Go to, go to another page",
    );
  });

  it("names the switcher after the current page", async () => {
    const html = await render("trash");
    const where = between(html, '<button type="button" class="where', "</button>");
    expect(where).toMatch(
      /^<button type="button" class="where show-sm" popovertarget="go-to"><span aria-hidden="true">Trash<\/span><svg class="ic sm"/,
    );
    expect(where).toContain('<span class="sr">Trash, go to another page</span>');
  });

  it("shows the live link count with its tooltip, and nothing at 0", async () => {
    const four = link(gnav(await render("recent", { liveLinkCount: 4 })), "/links");
    expect(four).toContain('<span class="n">4</span>');
    expect(four).toContain('title="4 live public links"');
    expect(text(four)).toBe("Public links 4");

    const one = link(gnav(await render("recent", { liveLinkCount: 1 })), "/links");
    expect(one).toContain('title="1 live public link"');

    const none = link(gnav(await render("recent", { liveLinkCount: 0 })), "/links");
    expect(none).not.toContain('class="n"');
    expect(none).not.toContain("title=");
    expect(text(none)).toBe("Public links");
  });

  it("counts Trash and names the paused links for screen readers", async () => {
    const html = await render("recent", { trashCount: 2, pausedLinkCount: 1 });
    for (const trash of [link(gnav(html), "/trash"), link(goTo(html), "/trash")]) {
      expect(trash).toContain(
        '<span class="n" aria-hidden="true">2</span><span class="sr">2, 1 public link paused</span>',
      );
      expect(text(trash)).toBe("Trash 2, 1 public link paused");
    }
    const many = link(gnav(await render("recent", { pausedLinkCount: 3 })), "/trash");
    expect(many).toContain('<span class="sr">2, 3 public links paused</span>');

    const unpaused = link(gnav(await render("recent", { pausedLinkCount: 0 })), "/trash");
    expect(unpaused).not.toContain('class="sr"');
    expect(unpaused).toContain('<span class="n">2</span>');
    expect(text(unpaused)).toBe("Trash 2");

    const empty = await render("recent", { trashCount: 0, pausedLinkCount: 0 });
    expect(link(gnav(empty), "/trash")).not.toContain('class="n"');
    expect(text(link(gnav(empty), "/trash"))).toBe("Trash");

    // No count to repeat: the hidden text repeats the label, so the name has no " ," gap.
    const pausedOnly = link(gnav(await render("recent", { trashCount: 0 })), "/trash");
    expect(pausedOnly).not.toContain('class="n"');
    expect(pausedOnly).toContain(
      '<span aria-hidden="true">Trash</span><span class="sr">Trash, 1 public link paused</span>',
    );
    expect(text(pausedOnly)).toBe("Trash, 1 public link paused");
  });

  it("lists the destinations in the Go to sheet, in order", async () => {
    const sheet = goTo(await render("recent"));
    expect(sheet).toContain('<nav class="mbox" aria-label="Go to">');
    expect([...sheet.matchAll(/<a class="mi" href="([^"]*)"/g)].map(([, href]) => href)).toEqual([
      "/",
      "/links",
      "/trash",
      "/status",
      "/mcp",
    ]);
    expect(sheet.indexOf("<hr/>")).toBeGreaterThan(sheet.indexOf('href="/trash"'));
    expect(sheet.indexOf("<hr/>")).toBeLessThan(sheet.indexOf('href="/status"'));
  });

  it("trims ⋯ to Status, Connect an agent and Keyboard shortcuts", async () => {
    const menu = more(await render("recent"));
    const items = [...menu.matchAll(/<(a|button) [^>]*class="mi"[^>]*>([\s\S]*?)<\/\1>/g)].map(
      ([, , inner]) => text(inner ?? ""),
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^Status/);
    expect(items[1]).toMatch(/^Connect an agent/);
    expect(items[2]).toMatch(/^Keyboard shortcuts/);
    expect(menu).toContain("<kbd>g</kbd> <kbd>s</kbd>");
    expect(menu).toContain("<kbd>?</kbd>");
    expect(menu).not.toContain('href="/links"');
    expect(menu).not.toContain('href="/trash"');
  });

  it("uses icons, not glyphs", async () => {
    const pages = await Promise.all(
      (["recent", "status", null] as const).map((page) => render(page)),
    );
    for (const page of pages)
      for (const glyph of ["⌕", "⌫", "◍", "⚯", "◉"]) expect(page).not.toContain(glyph);
    const html = pages[0] ?? "";
    expect(between(html, "<form", "</form>")).toContain('<svg class="ic"');
    expect(link(html, "/?q=")).toContain('aria-label="Find"');
    expect(link(html, "/?q=")).toContain('<svg class="ic lg"');
  });
});
