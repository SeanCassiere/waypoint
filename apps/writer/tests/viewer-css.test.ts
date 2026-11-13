import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VIEWER_CSS_PARTIALS, viewerCssSource } from "../src/viewer/css.ts";

const dir = new URL("../src/viewer/css/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");

describe("viewer stylesheet partials", () => {
  it("lists every partial in src/viewer/css/ once, in name order", () => {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".css"))
      .toSorted();
    expect(VIEWER_CSS_PARTIALS).toEqual(files);
  });
  it("names each partial NN-name.css", () => {
    for (const name of VIEWER_CSS_PARTIALS) expect(name).toMatch(/^\d{2}-[a-z0-9-]+\.css$/);
  });
  it("concatenates the non-empty, newline-terminated partials byte for byte", () => {
    const texts = VIEWER_CSS_PARTIALS.map(read);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith("\n")).toBe(true);
    }
    expect(viewerCssSource()).toBe(texts.join(""));
  });
  // The panel, its peek and the tree's rows are panelCss and treeCss (packages/ui/src/panel-css.ts),
  // shared with the public reader; a partial that styled them again would fork the two.
  it("leaves the panel's states and peek to packages/ui", () => {
    const found = VIEWER_CSS_PARTIALS.filter((name) =>
      /\.peek-edge\b|\.shell\.closed\b/.test(read(name).replace(/\/\*[\s\S]*?\*\//g, "")),
    );
    expect(found).toEqual([]);
  });
  it("never brings back the monolithic viewer.css", () => {
    expect(existsSync(new URL("../src/viewer/viewer.css", import.meta.url))).toBe(false);
  });
});
