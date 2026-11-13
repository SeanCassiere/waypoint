import { describe, expect, it } from "vitest";

import { panelCss, treeCss } from "../src/panel-css.ts";
import {
  buttonCss,
  documentCss,
  filesCss,
  letterheadCss,
  menuCss,
  publicShellCss,
  shellCss,
  sidebarCss,
  skipCss,
  stageCss,
} from "../src/public-shell/css.ts";
import {
  aboutScript,
  afterParse,
  earlyShellScripts,
  filesMenuScript,
  hashScript,
  loadingScript,
  locationScript,
  panelScript,
  panelStateScript,
  parsedShellScripts,
  publicShellScript,
  stageScript,
  timeScript,
  versionScript,
} from "../src/public-shell/script.ts";
import { sharedTokensCss } from "../src/tokens.ts";

const cssSegments = {
  skipCss,
  letterheadCss,
  filesCss,
  menuCss,
  sidebarCss,
  documentCss,
  stageCss,
  buttonCss,
};
const early = [versionScript, timeScript, panelStateScript, locationScript];
const parsed = [filesMenuScript, panelScript, aboutScript, hashScript, loadingScript, stageScript];
const scriptSegments = [...early, ...parsed];
/** Compiles a script without running it, so a syntax error throws. */
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);

describe("public shell segments", () => {
  it("composes the stylesheet from its segments in the fixed order", () => {
    expect(publicShellCss).toBe(sharedTokensCss + shellCss);
    expect(shellCss).toBe(
      skipCss +
        letterheadCss +
        filesCss +
        menuCss +
        panelCss +
        treeCss +
        sidebarCss +
        documentCss +
        stageCss +
        buttonCss,
    );
  });

  it("joins the non-empty script segments in the fixed order, the rest after parsing", () => {
    expect(earlyShellScripts).toEqual(early);
    expect(parsedShellScripts).toEqual(parsed);
    const wrapped = afterParse(parsed);
    expect(wrapped).toContain(parsed.filter((s) => s !== "").join("\n"));
    expect(wrapped).toContain(
      'document.addEventListener("DOMContentLoaded", run, { once: true });',
    );
    expect(publicShellScript).toBe([...early.filter((s) => s !== ""), wrapped].join("\n"));
  });

  it("applies the stored panel state with nothing but the shell element", () => {
    // It runs before the panel's rows are parsed (the script follows #shell's start tag).
    expect(panelStateScript).not.toMatch(/querySelector|"files"|"doc"/);
    expect(panelStateScript).toContain('localStorage.getItem("wp:panel") === "closed"');
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
