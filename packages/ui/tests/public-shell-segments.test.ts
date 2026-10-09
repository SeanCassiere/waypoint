import { describe, expect, it } from "vitest";

import {
  buttonCss,
  documentCss,
  filesCss,
  letterheadCss,
  menuCss,
  publicShellCss,
  shellCss,
  skipCss,
  stageCss,
} from "../src/public-shell/css.ts";
import {
  aboutScript,
  filesMenuScript,
  hashScript,
  loadingScript,
  locationScript,
  publicShellScript,
  stageScript,
  timeScript,
} from "../src/public-shell/script.ts";
import { sharedTokensCss } from "../src/tokens.ts";

const cssSegments = { skipCss, letterheadCss, filesCss, menuCss, documentCss, stageCss, buttonCss };
const scriptSegments = [
  timeScript,
  locationScript,
  filesMenuScript,
  aboutScript,
  hashScript,
  loadingScript,
  stageScript,
];
/** Compiles a script without running it, so a syntax error throws. */
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);

describe("public shell segments", () => {
  it("composes the stylesheet from its segments in the fixed order", () => {
    expect(publicShellCss).toBe(sharedTokensCss + shellCss);
    expect(shellCss).toBe(
      skipCss + letterheadCss + filesCss + menuCss + documentCss + stageCss + buttonCss,
    );
  });

  it("joins the non-empty script segments in the fixed order", () => {
    expect(publicShellScript).toBe(scriptSegments.filter((s) => s !== "").join("\n"));
  });

  it("keeps every script segment a self-contained IIFE that parses on its own", () => {
    for (const segment of scriptSegments.filter((s) => s !== "")) {
      expect(segment.startsWith("(() => {\n")).toBe(true);
      expect(segment.endsWith("\n})();")).toBe(true);
      expect(() => parse(segment)).not.toThrow();
    }
    expect(() => parse(publicShellScript)).not.toThrow();
  });

  it("emits a readable script with short lines and no comments", () => {
    for (const line of publicShellScript.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(publicShellScript).not.toContain("//");
    expect(publicShellScript).not.toContain("/*");
  });

  it("balances the braces of every CSS segment", () => {
    for (const [name, css] of Object.entries(cssSegments)) {
      const close = css.split("}").length - 1;
      expect({ name, open: css.split("{").length - 1 }).toEqual({ name, open: close });
    }
  });
});
