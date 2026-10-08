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

describe("Folio tokens", () => {
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

  it("pins the nudged and new values", () => {
    const shared = declarations(sharedTokensCss, "light");
    const writer = declarations(writerTokensCss, "light");
    expect(shared.get("--faint")).toBe("#6f6a62");
    expect(declarations(sharedTokensCss, "dark").get("--faint")).toBe("#969188");
    expect(writer.get("--ok")).toBe("#2c784b");
    expect(shared.get("--tap")).toBe("44px");
    expect(writer.get("--page-max")).toBe("1096px");
  });

  it("freezes the reading palette (changes only with a RENDERER_VERSION bump)", () => {
    expect(readingTokensCss).toMatchSnapshot();
  });
});
