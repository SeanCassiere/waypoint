import { readFileSync } from "node:fs";

import { publicShellCss, sharedTokensCss, writerTokensCss } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { staticCss } from "../apps/reader/src/pages.ts";
import { viewerCssSource } from "../apps/writer/src/viewer/css.ts";

// Which Folio tokens each consumer may use. The reader's surfaces (the public shell and the static
// pages) are built on sharedTokensCss only; writer-only roles must never reach them, since any
// reader-visible token moves a reader CSP hash. Lives here, not in packages/ui, because it reads
// the reader's staticCss.

/** Custom properties defined (`--x:`) in a stylesheet. */
const definedIn = (css: string): Set<string> =>
  new Set([...css.matchAll(/(--[\w-]+):/g)].map(([, token]) => token!));
/** Custom properties referenced through `var(--x)`. */
const usedIn = (css: string): Set<string> =>
  new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, token]) => token!));
const mentions = (css: string, token: string): boolean =>
  new RegExp(`${token}(?![\\w-])`).test(css);

const READER = { publicShellCss, staticCss };
const shared = definedIn(sharedTokensCss);
const writerOnly = [...definedIn(writerTokensCss)];
// RX-10's preview band rides on the shell's page in the writer's ?as=public preview, whose only
// tokens are sharedTokensCss, so a token it uses stays shared. Read as text: the band's CSS isn't
// exported, and importing the writer's hono/jsx module would make this package depend on it.
const PREVIEW_BAND_CSS = readFileSync(
  new URL("../apps/writer/src/viewer/pages/public-preview.tsx", import.meta.url),
  "utf8",
);

describe("token consumers", () => {
  it("starts every reader stylesheet with the shared tokens", () => {
    expect(publicShellCss.startsWith(sharedTokensCss)).toBe(true);
    expect(staticCss.startsWith(sharedTokensCss)).toBe(true);
  });

  it.each(Object.entries(READER))("%s uses only shared tokens", (_, css) => {
    expect([...usedIn(css)].filter((token) => !shared.has(token))).toEqual([]);
  });

  it.each(Object.entries(READER))(
    "%s never defines or references a writer-only token",
    (_, css) => {
      expect(writerOnly.length).toBeGreaterThan(0);
      expect(writerOnly.filter((token) => mentions(css, token))).toEqual([]);
    },
  );

  // No dead bytes on 2,000-file shells: a shared token that neither reader CSS nor the writer's
  // `?as=public` preview band uses moves to the writer set.
  it("leaves no shared token unused by reader CSS or the preview band", () => {
    const used = usedIn(publicShellCss + staticCss + PREVIEW_BAND_CSS);
    const unused = [...shared].filter((token) => !used.has(token));
    expect(unused).toEqual([]);
  });
});

// Decision (f): violet means changed, amber means pending. The diff surfaces' selectors use
// --changed* and never --pending*; nothing else may use --changed*, and the sync-state selectors
// never do. A later diff surface appends its selector here in the same commit.
const DIFF_SELECTORS = [
  ".k.m",
  ".blk.mod",
  ".shot.mod",
  ".chg .m",
  ".tally .m",
  ".diffkey .m",
  ".stepper",
  // .ichg: RX-04's writer change chip ("~ Changed in #N"), pre-seeded so RX-04 needn't edit this file
  ".ichg",
  ".dt tr.r-mod",
] as const;
/** Selectors that the diff half requires to use --changed*. */
const MUST_BE_CHANGED = [".k.m", ".blk.mod", ".shot.mod", ".chg .m"] as const;
const SYNC_STATES = [".pending", ".failed", ".health", ".status1", ".state"] as const;
const isDiff = (selector: string) => DIFF_SELECTORS.some((diff) => selector.includes(diff));

describe("decision f: changed vs pending", () => {
  // Every rule, including those nested in @media blocks (each has its own selector). Token
  // definitions are in the prepended token CSS, not here.
  const rules = [
    ...viewerCssSource()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(([, selector, body]) => ({
    selector: selector!.trim().replace(/\s+/g, " "),
    changed: [...body!.matchAll(/var\(\s*(--changed[\w-]*)/g)].map(([, token]) => token!),
    pending: [...body!.matchAll(/var\(\s*(--pending[\w-]*)/g)].map(([, token]) => token!),
  }));

  it("finds the writer's rules", () => {
    expect(rules.length).toBeGreaterThan(100);
  });

  it("keeps --pending* out of every diff rule", () => {
    expect(
      rules
        .filter((rule) => isDiff(rule.selector) && rule.pending.length)
        .map((rule) => `${rule.selector} uses ${rule.pending.join(", ")}`),
    ).toEqual([]);
  });

  it.each(MUST_BE_CHANGED)("colours %s with a --changed* token", (selector) => {
    const matching = rules.filter((rule) => rule.selector.includes(selector));
    expect(matching.length, `${selector} has a rule`).toBeGreaterThan(0);
    expect(
      matching.some((rule) => rule.changed.length),
      `${selector} references no --changed* token`,
    ).toBe(true);
  });

  it("uses --changed* only on diff selectors", () => {
    expect(
      rules
        .filter((rule) => rule.changed.length && !isDiff(rule.selector))
        .map((rule) => `${rule.selector} uses ${rule.changed.join(", ")}`),
    ).toEqual([]);
  });

  it("keeps --changed* off sync-state selectors", () => {
    expect(
      rules
        .filter(
          (rule) =>
            rule.changed.length && SYNC_STATES.some((state) => rule.selector.includes(state)),
        )
        .map((rule) => `${rule.selector} uses ${rule.changed.join(", ")}`),
    ).toEqual([]);
  });
});
