import { describe, expect, it } from "vitest";

import { ICON_NAMES, icon, iconCss, iconSprite, iconUse } from "../src/icons.ts";
import { sharedTokensCss } from "../src/tokens.ts";

const NAMES = [
  "search",
  "more",
  "panel",
  "chevronDown",
  "chevronLeft",
  "chevronRight",
  "close",
  "check",
  "copy",
  "external",
  "download",
  "history",
  "grid",
  "alert",
  "clock",
  "okcircle",
  "dot",
  "globe",
  "branch",
  "follow",
  "pin",
  "lock",
  "info",
  "doc",
  "image",
  "table",
  "code",
  "binary",
  "folder",
];

const INLINE =
  /^<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">(.+)<\/svg>$/;
const ELEMENT = /<(path|circle|rect)((?: [a-z-]+="[^"]*")*)\/>/y;
const ATTRIBUTE = / ([a-z-]+)="([^"]*)"/g;
const ALLOWED = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "width",
  "height",
  "rx",
  "fill",
  "stroke",
  "stroke-width",
]);
const ON_GRID = new Set(["cx", "cy", "r", "x", "y", "width", "height", "rx"]);
/** Arguments per group of each SVG path command (case-insensitive). */
const ARITY = new Map([
  ["m", 2],
  ["l", 2],
  ["t", 2],
  ["h", 1],
  ["v", 1],
  ["c", 6],
  ["s", 4],
  ["q", 4],
  ["a", 7],
  ["z", 0],
]);
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** Arc radii are nonnegative-number in the grammar: no sign. */
const NONNEGATIVE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const FLAG = /[01]/y;
/** SVG wsp is space, tab, CR or LF only (no form feed). */
const SPACE = /[\x20\t\n\r]*/y;

/**
 * Checks SVG path data against the SVG 1.1 path grammar: it starts with a moveto,
 * every command letter is followed by one or more complete argument groups (none
 * for closepath), arc radii are unsigned, arc flags are 0 or 1, and arguments are
 * separated by optional whitespace (space, tab, CR, LF) and at most one comma.
 * Returns the first problem, or null.
 */
function pathDataError(d: string): string | null {
  let i = 0;
  const read = (pattern: RegExp): boolean => {
    pattern.lastIndex = i;
    if (!pattern.test(d)) return false;
    i = pattern.lastIndex;
    return true;
  };
  /** comma-wsp?: returns whether a comma was consumed. */
  const separator = (): boolean => {
    read(SPACE);
    if (d[i] !== ",") return false;
    i += 1;
    read(SPACE);
    return true;
  };
  read(SPACE);
  if (i === d.length) return "empty path data";
  let first = true;
  while (i < d.length) {
    const command = d[i]!;
    const arity = ARITY.get(command.toLowerCase());
    if (arity === undefined) return `expected a command at ${i}`;
    if (first && command.toLowerCase() !== "m") return "path data must start with a moveto";
    first = false;
    i += 1;
    read(SPACE);
    if (arity === 0) continue;
    for (let group = 0; ; group += 1) {
      let ended = false;
      for (let arg = 0; arg < arity; arg += 1) {
        const comma = group === 0 && arg === 0 ? false : separator();
        const isArc = command.toLowerCase() === "a";
        const pattern =
          isArc && arg < 2 ? NONNEGATIVE : isArc && arg > 2 && arg < 5 ? FLAG : NUMBER;
        if (read(pattern)) continue;
        if (group > 0 && arg === 0 && !comma) {
          ended = true;
          break;
        }
        return `${command} needs ${arity} arguments per group (failed at ${i})`;
      }
      if (ended) break;
    }
    read(SPACE);
  }
  return null;
}

/** The inner markup of `icon(name)`. */
const inner = (name: (typeof ICON_NAMES)[number]): string => INLINE.exec(icon(name))![1]!;

/** Every attribute of every element in an icon's inner markup; throws on anything else. */
function elements(markup: string): Array<Array<[string, string]>> {
  const out: Array<Array<[string, string]>> = [];
  ELEMENT.lastIndex = 0;
  while (ELEMENT.lastIndex < markup.length) {
    const match = ELEMENT.exec(markup);
    if (!match) throw new Error(`unexpected markup at ${ELEMENT.lastIndex}: ${markup}`);
    out.push([...match[2]!.matchAll(ATTRIBUTE)].map(([, key, value]) => [key!, value!]));
  }
  return out;
}

describe("icon set", () => {
  it("has exactly the 29 agreed names, in order, each once", () => {
    expect([...ICON_NAMES]).toEqual(NAMES);
    expect(new Set(ICON_NAMES).size).toBe(29);
    for (const cut of ["keyboard", "plug", "trash", "restore", "edit"])
      expect(ICON_NAMES as readonly string[]).not.toContain(cut);
  });

  it.each(ICON_NAMES)("%s is static 16-unit markup whose paths parse", (name) => {
    expect(icon(name)).toMatch(INLINE);
    const parsed = elements(inner(name));
    expect(parsed.length).toBeGreaterThan(0);
    const attributes = parsed.flat();
    expect(attributes.filter(([key]) => !ALLOWED.has(key))).toEqual([]);
    expect(
      attributes
        .filter(([key]) => key === "d")
        .map(([, value]) => [value, pathDataError(value)])
        .filter(([, error]) => error !== null),
    ).toEqual([]);
    expect(
      attributes.filter(([key, value]) => {
        if (!ON_GRID.has(key)) return false;
        const number = Number(value);
        return !(number >= 0 && number <= 16);
      }),
    ).toEqual([]);
  });

  it.each([
    "M8 8",
    "M1,2l3-4",
    "m1 1 2 2 3 3",
    "M8 11h.01",
    "M2.5 8a5.5 5.5 0 1 0 1.6-3.9",
    "M0 0A1 1 0 011 1",
    "M1 1h2v2zm3 3",
    "M1e1 2E-1L3 4",
    "M0\t0\r\nL1 1",
  ])("the path-data check accepts %s", (d) => {
    expect(pathDataError(d)).toBeNull();
  });

  it.each([
    "",
    "M8",
    "M0 0L1",
    "M0 0Z8",
    "L1 1",
    "M0 0C1 1 2 2 3",
    "M0 0A1 1 0 2 0 1 1",
    "M0 0,",
    "M0 0L1 1,",
    "M,0 0",
    "M0 0,,1 1",
    "M0 0X1 1",
    "M0 0A-1 1 0 0 0 1 1",
    "M0 0A1 +1 0 0 0 1 1",
    "M0 0\fL1 1",
  ])("the path-data check rejects %j", (d) => {
    expect(pathDataError(d)).not.toBeNull();
  });

  it("never emits styles, handlers, scripts or non-ASCII", () => {
    const outputs = [
      ...ICON_NAMES.flatMap((name) => [icon(name), icon(name, "sm"), iconUse(name)]),
      iconSprite(ICON_NAMES),
    ];
    for (const out of outputs) {
      expect(out).not.toContain("style=");
      expect(out).not.toMatch(/\son[a-z]*=/i);
      expect(out).not.toContain("<script");
      expect(out).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("adds constant classes after ic", () => {
    expect(icon("search", "sm").startsWith('<svg class="ic sm" ')).toBe(true);
    expect(icon("more", "lg xl").startsWith('<svg class="ic lg xl" ')).toBe(true);
  });

  it("references the sprite per row", () => {
    expect(iconUse("doc")).toBe('<svg class="ic ti" aria-hidden="true"><use href="#i-doc"/></svg>');
    expect(iconUse("doc", "sm")).toContain('class="ic sm"');
  });

  it("emits a 0x0 sprite of de-duplicated symbols without the hidden attribute", () => {
    const sprite = iconSprite(["doc", "folder", "doc"]);
    expect(
      sprite.startsWith('<svg class="sprite" width="0" height="0" aria-hidden="true"><defs>'),
    ).toBe(true);
    expect(sprite.endsWith("</defs></svg>")).toBe(true);
    expect(sprite).not.toContain(" hidden");
    const symbols = [
      ...sprite.matchAll(/<symbol id="i-([A-Za-z]+)" viewBox="0 0 16 16">(.*?)<\/symbol>/g),
    ];
    expect(symbols.map(([, name, content]) => [name, content])).toEqual([
      ["doc", inner("doc")],
      ["folder", inner("folder")],
    ]);
    expect(sprite.match(/<symbol /g)).toHaveLength(2);
  });

  it("sizes and strokes only svg icons, from the shared tokens", () => {
    const selectors = [...iconCss.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap(([, list]) =>
      list!.trim().split(","),
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith("svg.")).toBe(true);
    for (const part of [
      "svg.sprite{position:absolute;width:0;height:0;overflow:hidden}",
      "fill:none",
      "stroke:currentColor",
      "stroke-width:1.5",
      "stroke-linecap:round",
      "stroke-linejoin:round",
      "var(--ic-sm)",
      "var(--ic-md)",
      "var(--ic-lg)",
      "var(--ic-xl)",
    ])
      expect(iconCss).toContain(part);
    expect(iconCss).not.toContain("forced-colors");
    const defined = new Set([...sharedTokensCss.matchAll(/(--[\w-]+):/g)].map(([, t]) => t));
    for (const [, token] of iconCss.matchAll(/var\(\s*(--[\w-]+)/g))
      expect(defined).toContain(token);
    expect(sharedTokensCss.endsWith(iconCss)).toBe(true);
  });
});
