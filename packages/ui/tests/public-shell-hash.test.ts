import { describe, expect, it } from "vitest";

import { hashScript, locationScript, publicShellScript } from "../src/public-shell/script.ts";

// RX-09: a section fragment the shell keeps in the address bar or hands to the frame always
// passes this exact pattern; the frame gets it with location.replace (no history entry).
const PATTERN = String.raw`/^#[\w.~%-]{1,256}$/`;
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);

describe("public shell section links", () => {
  it("emits a readable hash segment that parses, with short lines and no comments", () => {
    expect(() => parse(hashScript)).not.toThrow();
    expect(hashScript).toContain("location.replace(");
    expect(hashScript).toContain(PATTERN);
    for (const line of hashScript.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(hashScript).not.toContain("//");
    expect(hashScript).not.toContain("/*");
  });

  it("checks report fragments in locationScript against the same pattern", () => {
    expect(locationScript).toContain(PATTERN);
  });

  it("pins the shell's links immediately before every history.replaceState", () => {
    const calls = [...publicShellScript.matchAll(/history\.replaceState\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const preceded = [...publicShellScript.matchAll(/pinLinks\(\);\s*history\.replaceState\(/g)];
    expect(preceded.length).toBe(calls.length);
  });
});
