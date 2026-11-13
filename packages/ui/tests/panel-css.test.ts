import { describe, expect, it } from "vitest";

import { panelCss, treeCss } from "../src/panel-css.ts";
import {
  PANEL_STORAGE_KEY,
  PEEK_CLOSE_GRACE,
  PEEK_OPEN_DELAY,
  PEEK_SLIDE_OUT,
  TREE_STORAGE_PREFIX,
} from "../src/panel.ts";
import { publicShellCss } from "../src/public-shell/css.ts";

/** Whether every block that opens closes, and none closes before it opens. */
function balanced(css: string): boolean {
  let depth = 0;
  for (const char of css) {
    if (char === "{") depth++;
    else if (char === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

describe("panel constants", () => {
  it("keeps the peek's timings and the storage keys", () => {
    expect([PEEK_OPEN_DELAY, PEEK_CLOSE_GRACE, PEEK_SLIDE_OUT]).toEqual([150, 250, 100]);
    expect(PANEL_STORAGE_KEY).toBe("wp:panel");
    expect(TREE_STORAGE_PREFIX).toBe("wp:tree:");
  });
});

describe("panelCss and treeCss", () => {
  it.each(Object.entries({ panelCss, treeCss }))("%s has balanced braces", (_, css) => {
    expect(css.length).toBeGreaterThan(0);
    expect(balanced(css)).toBe(true);
    expect(css.endsWith("\n")).toBe(true);
  });

  it("slides the peek out in PEEK_SLIDE_OUT ms and keeps every duration within 150 ms", () => {
    const peekOut = /\.shell\.closed\.peek-out \.panel\{transition:([^}]*)\}/.exec(panelCss)?.[1];
    expect(peekOut).toBe(
      `opacity ${PEEK_SLIDE_OUT}ms ease-out,transform ${PEEK_SLIDE_OUT}ms cubic-bezier(.2,0,0,1),visibility 0s linear ${PEEK_SLIDE_OUT}ms`,
    );
    const durations = [...panelCss.matchAll(/(\d+)ms/g)].map(([, ms]) => Number(ms));
    expect(durations.filter((ms) => ms > 150)).toEqual([]);
  });

  it("transitions only under prefers-reduced-motion: no-preference", () => {
    const motion = panelCss.indexOf("@media(prefers-reduced-motion:no-preference){");
    expect(motion).toBeGreaterThan(0);
    expect(panelCss.slice(0, motion)).not.toMatch(/\btransition:/);
    expect(treeCss).not.toMatch(/\btransition:/);
  });

  it("starts the panel and the peek strip at --panel-top, never the writer's bar", () => {
    expect(panelCss).not.toContain("--bar-h");
    expect(panelCss).toContain("top:var(--panel-top,0px)");
    expect(panelCss).toContain("top:calc(var(--panel-top,0px) + 32px)");
  });

  it("leaves the shell's height to the page", () => {
    expect(panelCss).not.toMatch(/(?<![-\w])height:(?!78dvh)/);
  });

  it("is part of the public shell, which opens the panel as a popover", () => {
    expect(publicShellCss).toContain(panelCss + treeCss);
    expect(panelCss).toContain(
      ".shell.open .panel,.panel:popover-open{transform:none;visibility:visible}",
    );
    expect(panelCss).toMatch(/\.shell\.open \.panel,\.panel:popover-open\{width:100%/);
  });
});
