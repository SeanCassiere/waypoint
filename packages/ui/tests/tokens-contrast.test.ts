import { describe, expect, it } from "vitest";

import { readingTokensCss, sharedTokensCss, writerTokensCss } from "../src/tokens.ts";

type Scheme = "light" | "dark";

/** Light: `:root{…}` outside `@media`; dark: light overlaid with the dark-scheme `:root{…}`. */
function palettes(css: string): Record<Scheme, Map<string, string>> {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const [, media, body] of css.matchAll(/(@media\([^)]*\)\{)?:root\{([^}]*)\}/g)) {
    if (media !== undefined && media !== "@media(prefers-color-scheme:dark){") continue;
    const target = media === undefined ? light : dark;
    for (const declaration of body!.split(";")) {
      const colon = declaration.indexOf(":");
      if (declaration.startsWith("--"))
        target.set(declaration.slice(2, colon), declaration.slice(colon + 1));
    }
  }
  return { light, dark: new Map([...light, ...dark]) };
}

/** WCAG 2 relative luminance of `#rgb` or `#rrggbb`. */
function luminance(hex: string): number {
  const digits = hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SCHEMES: readonly Scheme[] = ["light", "dark"];
/** A film: `color-mix(in srgb,var(--ink) N%,transparent)`, ink at N % over whatever is beneath. */
const FILM = /^color-mix\(in srgb,var\(--ink\) (\d+)%,transparent\)$/;
/** `#rgb` as `#rrggbb`. */
const long = (hex: string): string =>
  hex.length === 4 ? `#${hex.slice(1).replace(/./g, "$&$&")}` : hex;
/** Channel `i` (0 red, 1 green, 2 blue) of a hex colour, 0–255. */
const channel = (hex: string, i: number): number =>
  Number.parseInt(long(hex).slice(1 + i * 2, 3 + i * 2), 16);
/** `#rrggbb` of `ink` at `percent` % over the solid `base`. */
function composite(ink: string, percent: number, base: string): string {
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(ink, i) * (percent / 100) + channel(base, i) * (1 - percent / 100))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/;
const chrome = palettes(sharedTokensCss + writerTokensCss);
const reading = palettes(readingTokensCss);

const ROLES = [
  "ink",
  "ink-2",
  "muted",
  "faint",
  "pending",
  "failed",
  "public",
  "add",
  "del",
  "changed",
  "ok",
];
const GROUNDS = ["paper", "surface", "sunken", "dlg"];
/**
 * Hover and selected are films of ink (D77), checked over the grounds that hoverable and
 * selectable rows sit on (pages, cards and fields, menus and dialogs; nothing hoverable sits in a
 * sunken well), for the text roles such rows use. Secondary text in a row is --ink-2, never
 * --muted or --faint (in dark, neither reaches 4.5:1 on the selected film), and --ok never labels
 * a row. Pressed (--press) lasts only while the pointer is down, so it isn't a reading ground.
 */
const FILM_GROUNDS = ["hover", "sel-bg"].flatMap((film) =>
  ["paper", "surface", "dlg"].map((base) => `${film} over ${base}`),
);
const ROW_ROLES = ["ink", "ink-2", "pending", "failed", "public"];

/** One case per scheme and pair, with both colours resolved so a missing token fails loudly. */
const resolve = (map: Map<string, string>, token: string): string | undefined => {
  const [film, base] = token.split(" over ");
  if (base === undefined) return map.get(token);
  const percent = FILM.exec(map.get(film!) ?? "")?.[1];
  const ink = map.get("ink");
  const under = map.get(base);
  return percent && ink && under ? composite(ink, Number(percent), under) : undefined;
};
const pairs = (map: Record<Scheme, Map<string, string>>, list: [string, string][]) =>
  SCHEMES.flatMap((scheme) =>
    list.map(([fg, bg]) => ({
      scheme,
      fg,
      bg,
      a: resolve(map[scheme], fg),
      b: resolve(map[scheme], bg),
    })),
  );

const chromePairs: [string, string][] = [
  ...ROLES.flatMap((role) => GROUNDS.map((ground): [string, string] => [role, ground])),
  ...ROW_ROLES.flatMap((role) => FILM_GROUNDS.map((ground): [string, string] => [role, ground])),
  ...ROLES.filter((role) => chrome.light.has(`${role}-bg`)).map((role): [string, string] => [
    role,
    `${role}-bg`,
  ]),
  ["on-solid", "public-solid"],
  ["on-solid", "failed-solid"],
  ["on-solid", "ok-solid"],
  ["on-sel", "sel"],
];
const readingPairs: [string, string][] = ["fg", "fg-2", "muted", "link"].flatMap((role) =>
  ["bg", "subtle", "code-bg"].map((ground): [string, string] => [role, ground]),
);

describe("token contrast (WCAG 2, at least 4.5:1, no exceptions)", () => {
  it("covers every role that has its own tint", () => {
    expect(ROLES.filter((role) => chrome.light.has(`${role}-bg`))).toEqual([
      "pending",
      "failed",
      "public",
      "add",
      "del",
      "changed",
    ]);
  });

  it.each(pairs(chrome, chromePairs))("$scheme: --$fg $a on --$bg $b", ({ a, b }) => {
    expect(a).toMatch(HEX);
    expect(b).toMatch(HEX);
    expect(ratio(a!, b!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(pairs(reading, readingPairs))("reading $scheme: --$fg $a on --$bg $b", ({ a, b }) => {
    expect(a).toMatch(HEX);
    expect(b).toMatch(HEX);
    expect(ratio(a!, b!)).toBeGreaterThanOrEqual(4.5);
  });
});
