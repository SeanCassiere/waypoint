import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RECURSIVE_SHA256 } from "../src/font-data.ts";
import { CHROME_FONT_PATH, chromeFontBytes, chromeFontHeaders, fontFaceCss } from "../src/font.ts";
import { sharedTokensCss } from "../src/tokens.ts";

// The chrome's font (D76): the committed subset, its generated module (scripts/subset-recursive.sh)
// and the URL both apps serve it from must agree, and its license ships beside it.
const woff2 = readFileSync(new URL("../fonts/recursive-ui.woff2", import.meta.url));

describe("the chrome's font", () => {
  it("embeds exactly the committed subset", () => {
    expect(createHash("sha256").update(woff2).digest("hex")).toBe(RECURSIVE_SHA256);
    expect(Buffer.from(chromeFontBytes()).equals(woff2)).toBe(true);
    expect(woff2.subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  it("stays a subset (roughly 60–90 KB, not the 300 KB family)", () => {
    expect(woff2.length).toBeGreaterThan(40_000);
    expect(woff2.length).toBeLessThan(90_000);
  });

  it("is served from a content-hashed path, immutably", () => {
    expect(CHROME_FONT_PATH).toBe(`/assets/font/recursive-${RECURSIVE_SHA256.slice(0, 16)}.woff2`);
    expect(chromeFontHeaders["Content-Type"]).toBe("font/woff2");
    expect(chromeFontHeaders["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("declares the sans and the mono cut over the one file, at the head of the shared tokens", () => {
    expect(fontFaceCss.split(`url(${CHROME_FONT_PATH})`)).toHaveLength(3);
    expect(fontFaceCss).toContain('font-family:"Recursive Mono"');
    expect(fontFaceCss).toContain('font-variation-settings:"MONO" 1');
    expect(sharedTokensCss.startsWith(fontFaceCss)).toBe(true);
  });

  it("keeps the SIL Open Font License beside it", () => {
    const license = readFileSync(new URL("../fonts/OFL.txt", import.meta.url), "utf8");
    expect(license).toContain("The Recursive Project Authors");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
