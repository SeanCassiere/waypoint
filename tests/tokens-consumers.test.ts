import { publicShellCss, sharedTokensCss, writerTokensCss } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { staticCss } from "../apps/reader/src/pages.ts";

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

// Shared tokens no reader CSS uses yet (or will stop using in a lane). Only shrinks; VS-01b
// empties it. Lanes don't edit it.
const NOT_YET_CONSUMED: readonly string[] = [
  "--stage",
  "--sel-bg",
  "--sel-ring",
  "--sel-bar",
  "--pending",
  "--pending-bg",
  "--pending-line",
  "--public",
  "--public-bg",
  "--public-line",
  "--img-frame",
  "--check-a",
  "--check-b",
  "--scrim",
  "--r-sm",
  "--r-lg",
  "--tap",
  "--ctl-sm",
  "--ctl-md",
  // Consumed by the shell until A11Y-07 retires the solid-ink row.
  "--sel",
  "--on-sel",
];

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

  it("leaves no shared token unused outside the not-yet-consumed list", () => {
    const used = usedIn(publicShellCss + staticCss);
    const unused = [...shared].filter((token) => !used.has(token));
    expect(unused.filter((token) => !NOT_YET_CONSUMED.includes(token))).toEqual([]);
  });

  it("lists only shared tokens, each once", () => {
    expect(NOT_YET_CONSUMED.filter((token) => !shared.has(token))).toEqual([]);
    expect(new Set(NOT_YET_CONSUMED).size).toBe(NOT_YET_CONSUMED.length);
  });
});
