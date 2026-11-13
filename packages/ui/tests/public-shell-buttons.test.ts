import { describe, expect, it } from "vitest";

import { controlsCss } from "../src/components-css.ts";
import { encodeLinkPath, renderPublicShell } from "../src/index.ts";
import { documentCss, publicShellCss, shellCss } from "../src/public-shell/css.ts";
import { sharedTokensCss } from "../src/tokens.ts";

// VS-05b: the shell's one `.btn` family (default, primary, ghost; md and sm; 44 px on touch), the
// shared controls (D78) the writer's buttons are built on too.
const card = (): string =>
  renderPublicShell({
    title: "Plan",
    files: [{ path: "index.md" }, { path: "archive.zip" }],
    head: "index.md",
    current: "archive.zip",
    fileHref: (path) => `./${encodeLinkPath(path)}`,
    frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
    updatedAt: null,
    snapshotAt: null,
    download: { mime: "application/zip", size: 10 },
  });
/** A selector naming a form field element (not e.g. `[aria-selected]`). */
const FIELD = /(^|[\s,>+~(])(input|select|textarea)\b/;
/** Every top-level and @media-nested rule as [selector, declarations]. */
const rules = (css: string): [string, string][] =>
  [...css.matchAll(/(?<=^|[{}\n])([^{}@\n][^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);

describe("shell button family", () => {
  it("defines the default, primary, ghost and small buttons from shared tokens", () => {
    const base = /(?:^|\n)\.btn\{([^}]*)\}/.exec(controlsCss)?.[1] ?? "";
    expect(base).toContain("height:var(--ctl-md)");
    expect(base).toContain("border:1px solid var(--control)");
    expect(/\.btn\.sm\{[^}]*height:var\(--ctl-sm\)/.test(controlsCss)).toBe(true);
    expect(controlsCss).toContain(".btn.primary");
    expect(controlsCss).toContain(".btn.ghost,.btn.ghost:hover{");
    expect(controlsCss).toContain(
      "@media(pointer:coarse){.btn:is(a,button,summary,label){min-height:var(--tap)}}",
    );
    // The forced-colours border covers hover, ghost and primary too (their selectors are more
    // specific; ghost's transparent border would otherwise be forced to LinkText).
    expect(controlsCss).toContain(
      "@media(forced-colors:active){.btn,.btn:hover,.btn.ghost,.btn.ghost:hover,.btn.primary,.btn.primary:hover{border-color:ButtonText}}",
    );
    expect(controlsCss).not.toContain("transition");
    expect(controlsCss).not.toContain("animation");
  });

  it("has exactly one base .btn rule, in controlsCss", () => {
    const base = /(^|[}\n])\.btn\{/g;
    expect(shellCss.match(base)).toHaveLength(1);
    expect(controlsCss.match(base)).toHaveLength(1);
    expect(documentCss).not.toContain(".btn{");
  });

  it("adds no field font-size rule (the shell has no fields)", () => {
    expect(publicShellCss).not.toContain("font-size:max(16px");
    const selectors = rules(shellCss).map(([selector]) => selector);
    expect(selectors).toContain(".btn.sm");
    for (const selector of selectors) expect(selector).not.toMatch(FIELD);
    // sharedTokensCss's `button,input,select,textarea{font:inherit;…}` reset is the only field
    // rule in the stylesheet, and it sets no size.
    const fields = rules(publicShellCss).filter(([selector]) => FIELD.test(selector));
    expect(fields.map(([, body]) => body)).toEqual([
      "font:inherit;color:inherit;letter-spacing:inherit",
    ]);
  });

  it("renders the download card's button as the primary variant", () => {
    expect(card()).toContain('<a id="doc" class="btn primary"');
  });

  it("uses only tokens defined in sharedTokensCss", () => {
    const used = new Set([...controlsCss.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) expect(sharedTokensCss).toContain(`${token}:`);
  });
});
