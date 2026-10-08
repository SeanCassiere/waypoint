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
  it("never brings back the monolithic viewer.css", () => {
    expect(existsSync(new URL("../src/viewer/viewer.css", import.meta.url))).toBe(false);
  });
});
