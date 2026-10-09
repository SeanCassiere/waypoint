import { beforeAll, describe, expect, it } from "vitest";

import {
  KEYMAP,
  keycaps,
  SCOPE_HEADINGS,
  scopesFor,
  type KeyBinding,
  type KeyScope,
} from "../src/viewer/keymap.ts";
import { keyGroups, KeysDialog } from "../src/viewer/keys-dialog.tsx";

const PAGES = [
  "changes",
  "gallery",
  "collection",
  "recent",
  "search",
  "links",
  "trash",
  "status",
  "mcp",
  "deleted",
  "not-found",
  "not-public",
  undefined,
];
const SCOPES: KeyScope[] = ["all", "collection", "changes", "gallery", "find"];

async function render(page: string | undefined): Promise<string> {
  // The layout always passes body[data-page]; undefined stands for a page without one.
  const node = await KeysDialog({ page: page ?? "" });
  return node.toString();
}
/** Text content, tags removed, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  if (start < 0) return "";
  return html.slice(start, html.indexOf(close, start) + close.length);
}
/** The group sections, in document order, with whether each is inside the collapsed details. */
function groups(html: string): { scope: KeyScope; collapsed: boolean }[] {
  const details = html.indexOf('<details class="kother">');
  const end = html.indexOf("</details>");
  return [...html.matchAll(/<section class="kg" aria-labelledby="kg-(\w+)">/g)].map((found) => {
    const scope = SCOPES.find((name) => name === found[1]);
    if (!scope) throw new Error(`Unknown group ${found[1]}`);
    return { scope, collapsed: found.index > details && found.index < end };
  });
}
function headings(html: string): string[] {
  return [...html.matchAll(/<h3 id="kg-\w+">(.*?)<\/h3>/g)].map((found) => text(found[1] ?? ""));
}
interface RowHtml {
  dt: string;
  dd: string;
}
function rows(html: string): RowHtml[] {
  return [...html.matchAll(/<div><dt>(.*?)<\/dt><dd>(.*?)<\/dd><\/div>/g)].map((found) => ({
    dt: found[1] ?? "",
    dd: found[2] ?? "",
  }));
}
const kbds = (dt: string): string[] =>
  [...dt.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((found) => found[1] ?? "");
/** A row's label as rendered without script. */
const labelText = (binding: KeyBinding): string =>
  binding.label.replace(/(?:the )?#N/g, "the revision").replace(/#L/g, "the newest revision");
const rowOf = (html: string, binding: KeyBinding): RowHtml[] =>
  rows(html).filter(
    (row) =>
      kbds(row.dt).join(" ") === binding.keys.flatMap(keycaps).join(" ") &&
      text(row.dd.replace(/<small>.*<\/small>/, "")) === labelText(binding),
  );

describe("KeysDialog", () => {
  const rendered = new Map<string | undefined, string>();
  beforeAll(async () => {
    const htmls = await Promise.all(PAGES.map(render));
    PAGES.forEach((page, index) => rendered.set(page, htmls[index] ?? ""));
  });
  const of = (page: string | undefined): string => rendered.get(page) ?? "";

  it("opens the Changes page's own group first, in two columns", () => {
    const html = of("changes");
    expect(headings(html)).toEqual([
      "On the Changes page",
      "In this collection collection, Changes and Gallery pages",
      "Everywhere",
      "In Find",
      "In the gallery viewer",
    ]);
    expect(groups(html).filter((group) => group.collapsed)).toEqual([
      { scope: "find", collapsed: true },
      { scope: "gallery", collapsed: true },
    ]);
    expect(text(between(html, "<summary>", "</summary>"))).toBe("Inside Find and the gallery");
    expect(html.match(/<div class="kcols"><div class="kcol">/g)).toHaveLength(1);
    expect(html.match(/<div class="kcol">/g)).toHaveLength(2);
  });

  it("opens only Everywhere off a collection; collection and Changes keys are collapsed", () => {
    const html = of("recent");
    expect(headings(html)[0]).toBe("Everywhere");
    const details = between(html, '<details class="kother">', "</details>");
    const open = html.replace(details, "");
    for (const key of ["j", "c", "[", "d"]) {
      expect(rows(details).some((row) => kbds(row.dt).includes(key))).toBe(true);
      expect(rows(open).some((row) => kbds(row.dt).includes(key))).toBe(false);
    }
    expect(text(between(html, "<summary>", "</summary>"))).toBe(
      "Other pages, Find and the gallery",
    );
  });

  it("opens the gallery viewer's group first on the Gallery page", () => {
    const html = of("gallery");
    expect(headings(html)[0]).toBe(SCOPE_HEADINGS.gallery);
    expect(text(between(html, "<summary>", "</summary>"))).toBe("Other pages and Find");
  });

  it("shows exactly scopesFor(page) and collapses the rest, every scope once", () => {
    for (const page of PAGES) {
      const found = groups(of(page));
      const shown = found.filter((group) => !group.collapsed).map((group) => group.scope);
      const { shown: order, collapsed } = keyGroups(page);
      // Each check carries the page, so a failure names it.
      expect([page, shown.toSorted()]).toEqual([page, [...scopesFor(page)].toSorted()]);
      expect([page, found.map((group) => group.scope).toSorted()]).toEqual([
        page,
        SCOPES.toSorted(),
      ]);
      expect([page, shown]).toEqual([page, order]);
      expect([page, found.filter((group) => group.collapsed).map((group) => group.scope)]).toEqual([
        page,
        collapsed,
      ]);
    }
  });

  it("heads each group with SCOPE_HEADINGS", () => {
    const html = of("changes");
    for (const found of html.matchAll(/<h3 id="kg-(\w+)">(.*?)<\/h3>/g)) {
      const scope = SCOPES.find((name) => name === found[1]);
      if (!scope) throw new Error(`Unknown group ${found[1]}`);
      expect(text((found[2] ?? "").replace(/<span>.*<\/span>/, ""))).toBe(SCOPE_HEADINGS[scope]);
    }
    expect(between(html, '<h3 id="kg-collection">', "</h3>")).toContain(
      "<span>collection, Changes and Gallery pages</span>",
    );
  });

  it("draws one keycap per key and chord step, from keycaps()", () => {
    const html = of("changes");
    const caps = (command: string, scope?: KeyScope) => {
      const binding = KEYMAP.find(
        (entry) => entry.command === command && (!scope || entry.scope === scope),
      );
      if (!binding) throw new Error(command);
      const [row] = rowOf(html, binding);
      return kbds(row?.dt ?? "");
    };
    expect(caps("go-recent")).toEqual(["g", "h"]);
    expect(caps("older")).toEqual(["[", "]"]);
    expect(caps("changes-done")).toEqual(["Esc"]);
    expect(caps("copy-pinned")).toEqual(["⇧C"]);
  });

  it("pins the opt-out in the footer and starts focus on Close", () => {
    const html = of("changes");
    const footer = between(html, '<form method="dialog" class="ft">', "</form>");
    expect(text(between(footer, '<label class="check">', "</label>"))).toBe(
      "Turn off single-key shortcuts · / ? and Esc keep working",
    );
    expect(footer).toMatch(/<input type="checkbox" data-keys-off(?:="[^"]*")?\/?>/);
    expect(footer).toMatch(/<button[^>]*\bautofocus\b[^>]*>Close<\/button>/);
    expect(html).toMatch(/^<dialog class="dlg keys" id="keys" aria-labelledby="keys-title">/);
    expect(html).not.toContain("narrow");
    expect(text(between(html, '<p class="muted small knote">', "</p>"))).toBe(
      "Keys work when focus is on Waypoint, not inside a document: press Esc in the document first. Every key here also has a button or menu item.",
    );
  });

  it("lists every KEYMAP entry exactly once on every page", () => {
    for (const page of PAGES) {
      const html = of(page);
      expect([page, rows(html).length]).toEqual([page, KEYMAP.length]);
      for (const binding of KEYMAP)
        expect([page, binding.command, rowOf(html, binding).length]).toEqual([
          page,
          binding.command,
          1,
        ]);
    }
  });

  it("names the revision in words until the client fills in its number", () => {
    const html = of("collection");
    const spans = [...html.matchAll(/<span data-keys-n="([^"]*)">(.*?)<\/span>/g)];
    const current = spans.filter((found) => found[1]?.includes("#N"));
    expect(current.length).toBeGreaterThan(0);
    for (const found of current) expect(found[2]).toBe("the revision");
    expect(between(html, '<span data-keys-n="the #N">', "</span>")).not.toBe("");
  });

  it("names the latest revision as the newest one, and never shows a literal #N or #L", () => {
    const older = KEYMAP.find((binding) => binding.command === "older");
    if (!older) throw new Error("older");
    const [row] = rowOf(of("changes"), older);
    const small = between(row?.dd ?? "", "<small>", "</small>");
    expect(text(small)).toBe(
      "At the end of a branch: End of this branch. Latest is the newest revision",
    );
    expect(small.match(/<span data-keys-n="#L">the newest revision<\/span>/g)).toHaveLength(1);
    for (const page of PAGES) {
      const html = of(page);
      expect(`${String(page)}: ${text(html.replace(/<[^>]+>/g, " "))}`).not.toMatch(/#[NL]/);
    }
  });
});
