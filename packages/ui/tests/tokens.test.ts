import { describe, expect, it } from "vitest";

import {
  COMPACT_MAX,
  PHONE_MAX,
  readingTokensCss,
  sharedTokensCss,
  tokensCss,
  WIDE_MIN,
  writerTokensCss,
} from "../src/tokens.ts";

/** Declarations of one `:root{…}` block: outside `@media` (light) or the dark-scheme block. */
function declarations(css: string, scheme: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, media, body] of css.matchAll(/(@media\([^)]*\)\{)?:root\{([^}]*)\}/g)) {
    if (media !== (scheme === "dark" ? "@media(prefers-color-scheme:dark){" : undefined)) continue;
    for (const declaration of body!.split(";")) {
      const colon = declaration.indexOf(":");
      if (declaration.startsWith("--"))
        out.set(declaration.slice(0, colon), declaration.slice(colon + 1));
    }
  }
  return out;
}
const defined = (css: string): Set<string> =>
  new Set([...declarations(css, "light").keys(), ...declarations(css, "dark").keys()]);
const mentions = (css: string, token: string): boolean =>
  new RegExp(`${token}(?![\\w-])`).test(css);

const CHANGED = ["--changed", "--changed-bg", "--changed-line"];
const PENDING = ["--pending", "--pending-bg", "--pending-line"];

describe("Logbook tokens", () => {
  it("exports the breakpoints", () => {
    expect(PHONE_MAX).toBe(599.98);
    expect(COMPACT_MAX).toBe(760);
    expect(WIDE_MIN).toBe(1100);
  });

  it("keeps tokensCss as the shared plus writer alias", () => {
    expect(tokensCss).toBe(sharedTokensCss + writerTokensCss);
  });

  it("has no --mod token anywhere", () => {
    for (const css of [sharedTokensCss, writerTokensCss, readingTokensCss])
      expect(css).not.toContain("--mod");
  });

  it("keeps changed writer-only and pending shared (decision f)", () => {
    for (const token of CHANGED) {
      expect(declarations(writerTokensCss, "light").has(token)).toBe(true);
      expect(declarations(writerTokensCss, "dark").has(token)).toBe(true);
      expect(mentions(sharedTokensCss, token)).toBe(false);
      expect(mentions(readingTokensCss, token)).toBe(false);
    }
    for (const token of PENDING) {
      expect(declarations(sharedTokensCss, "light").has(token)).toBe(true);
      expect(declarations(sharedTokensCss, "dark").has(token)).toBe(true);
      expect(mentions(writerTokensCss, token)).toBe(false);
    }
  });

  it("defines no custom property in both the shared and the writer set", () => {
    const writer = defined(writerTokensCss);
    expect([...defined(sharedTokensCss)].filter((token) => writer.has(token))).toEqual([]);
  });

  it("gives every colour token a dark value, except --on-solid", () => {
    for (const css of [sharedTokensCss, writerTokensCss]) {
      const dark = declarations(css, "dark");
      const missing = [...declarations(css, "light")]
        .filter(([, value]) => /^(?:#|rgba\()/.test(value))
        .map(([token]) => token)
        .filter((token) => !dark.has(token));
      expect(missing).toEqual(css === writerTokensCss ? ["--on-solid"] : []);
    }
  });

  it("pins Logbook's values and scales (D77)", () => {
    const shared = declarations(sharedTokensCss, "light");
    const dark = declarations(sharedTokensCss, "dark");
    const writer = declarations(writerTokensCss, "light");
    const writerDark = declarations(writerTokensCss, "dark");
    expect(shared.get("--paper")).toBe("#f6f7f9");
    expect(shared.get("--ink")).toBe("#1d2026");
    expect(dark.get("--paper")).toBe("#131518");
    expect(shared.get("--faint")).toBe("#5f6772");
    expect(dark.get("--faint")).toBe("#9098a3");
    // nudged from Logbook's #1f5fd1 so it reads at 4.5:1 on a selected row over the paper
    expect(shared.get("--public")).toBe("#1e5ccc");
    expect(writer.get("--ok")).toBe("#2c784b");
    // the films: ink at 7/10/12 % (hover/selected/pressed), 10/14/16 % in dark
    for (const [token, light, night] of [
      ["--hover", 7, 10],
      ["--sel-bg", 10, 14],
      ["--press", 12, 16],
    ] as const) {
      expect(shared.get(token)).toBe(`color-mix(in srgb,var(--ink) ${light}%,transparent)`);
      expect(dark.get(token)).toBe(`color-mix(in srgb,var(--ink) ${night}%,transparent)`);
    }
    expect([shared.get("--ctl-sm"), shared.get("--ctl-md"), shared.get("--tap")]).toEqual([
      "28px",
      "32px",
      "44px",
    ]);
    expect([
      writer.get("--rd-1"),
      shared.get("--rd-2"),
      writer.get("--rd-box"),
      shared.get("--rd-3"),
    ]).toEqual(["4px", "6px", "8px", "10px"]);
    expect(writer.get("--rd-2-in")).toBe("calc(var(--rd-2) - 1px)");
    expect([writer.get("--r1"), writer.get("--r2")]).toEqual(["45px", "45px"]);
    expect([writer.get("--row-fs"), writer.get("--row-lh")]).toEqual(["13.5px", "20px"]);
    expect(shared.get("--sans")?.startsWith('"Recursive",')).toBe(true);
    expect(shared.get("--mono")?.startsWith('"Recursive Mono",')).toBe(true);
    expect(writerDark.get("--spine")).toBe("#3b424c");
    expect(writer.get("--page-max")).toBe("1096px");
  });

  it("retires Folio's --r-sm, --r-md and --r-lg for the --rd-* scale", () => {
    for (const token of ["--r-sm", "--r-md", "--r-lg"])
      expect(mentions(sharedTokensCss + writerTokensCss, token)).toBe(false);
  });

  it("freezes the reading palette (changes only with a RENDERER_VERSION bump)", () => {
    expect(readingTokensCss).toMatchSnapshot();
  });
});
