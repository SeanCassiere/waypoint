import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { readingTokensCss } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { GRAMMARS, SYNTAX_COLOURS } from "../src/render.ts";

// Every colour the highlighter can give a token, after SYNTAX_COLOURS, reads at 4.5:1 (WCAG 2 AA)
// on every ground code sits on in its scheme: the page (`--bg`), the wells (`--code-bg`,
// `--subtle`) and the `:target` line (`--mark`). D88.

type Scheme = "light" | "dark";

/** The grounds code sits on, from one scheme's reading tokens. */
const pick = (map: Record<string, string>): Record<string, string> =>
  Object.fromEntries(["bg", "code-bg", "subtle", "mark"].map((name) => [name, map[name]!]));

/** The reading palette's grounds: light, and dark overlaid on light. */
function grounds(): Record<Scheme, Record<string, string>> {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [, media, body] of readingTokensCss.matchAll(/(@media\([^)]*\)\{)?:root\{([^}]*)\}/g))
    for (const declaration of body!.split(";")) {
      const [name, value] = declaration.split(":");
      if (name?.startsWith("--")) (media ? dark : light)[name.slice(2)] = value!;
    }
  return { light: pick(light), dark: pick({ ...light, ...dark }) };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Scopes whose theme colour assumes the theme's own token background, which the reading
 * template doesn't draw. No grammar the renderer loads emits them (checked below), so their
 * colours never reach a document.
 */
const UNUSED_SCOPES = ["carriage-return", "markup.ignored", "markup.untracked"];

const themes = { light: githubLight, dark: githubDark } as const;
const GROUNDS = grounds();

function tokenColours(scheme: Scheme): string[] {
  const theme = themes[scheme];
  const replace = SYNTAX_COLOURS[theme.name!] ?? {};
  const colours = new Set<string>();
  for (const rule of theme.tokenColors ?? []) {
    const scopes = [rule.scope ?? []].flat();
    const colour = rule.settings.foreground?.toLowerCase();
    if (!colour || scopes.some((scope) => UNUSED_SCOPES.includes(scope))) continue;
    colours.add(replace[colour] ?? colour);
  }
  return [...colours];
}

describe("syntax colours on the reading palette (WCAG 2, at least 4.5:1)", () => {
  it("loads no grammar that emits the scopes left out", () => {
    const grammars = JSON.stringify(GRAMMARS);
    for (const scope of UNUSED_SCOPES) expect(grammars).not.toContain(scope);
  });

  it("replaces only colours the themes use", () => {
    for (const scheme of ["light", "dark"] as const) {
      const theme = themes[scheme];
      const used = new Set(
        (theme.tokenColors ?? []).flatMap((rule) => rule.settings.foreground?.toLowerCase() ?? []),
      );
      for (const colour of Object.keys(SYNTAX_COLOURS[theme.name!] ?? {}))
        expect(used, `${scheme}: ${colour}`).toContain(colour);
    }
  });

  it.each(
    (["light", "dark"] as const).flatMap((scheme) =>
      tokenColours(scheme).flatMap((colour) =>
        Object.entries(GROUNDS[scheme]).map(([ground, hex]) => ({ scheme, colour, ground, hex })),
      ),
    ),
  )("$scheme: $colour on --$ground $hex", ({ colour, hex }) => {
    expect(ratio(colour, hex)).toBeGreaterThanOrEqual(4.5);
  });
});
