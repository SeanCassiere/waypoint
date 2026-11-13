import { describe, expect, it } from "vitest";

import { compareNames, sortByName } from "../src/tree-order.ts";

// D75: the public reader sorts with sort keys where they're exact, and with compareNames (the
// writer's order, D72) everywhere else. The two must never disagree.

/** A small deterministic generator (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const byCompareNames = (names: readonly string[]): string[] => names.toSorted(compareNames);
const byKeys = (names: readonly string[]): string[] =>
  sortByName(
    names.map((name) => ({ name })),
    (entry) => entry.name,
  ).map((entry) => entry.name);

describe("sortByName", () => {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
  const alphabets = [printable, "0000011112345678990aA.-_ ", "aA0123456789", "-_. ~'aAzZ()[]"];

  it("orders printable ASCII names exactly as compareNames", () => {
    const next = random(72);
    const pick = (text: string) => text[Math.floor(next() * text.length)]!;
    for (const alphabet of alphabets) {
      for (let round = 0; round < 3000; round++) {
        const names = Array.from({ length: 2 + Math.floor(next() * 10) }, () =>
          Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(alphabet)).join(""),
        );
        expect(byKeys(names)).toEqual(byCompareNames(names));
      }
    }
  });

  it("compares digit runs as numbers, leading zeros included, up to the padding limit", () => {
    const next = random(75);
    const digits = (length: number) =>
      Array.from({ length }, () => String(Math.floor(next() * 10))).join("");
    const parts = ["a", "B", "-", ".", "_", " ", "x.md", ""];
    for (let round = 0; round < 5000; round++) {
      const names = Array.from({ length: 2 + Math.floor(next() * 6) }, () => {
        let name = "";
        for (let part = Math.floor(next() * 4); part >= 0; part--)
          name +=
            parts[Math.floor(next() * parts.length)]! +
            "0".repeat(next() < 0.3 ? Math.floor(next() * 4) : 0) +
            digits(Math.floor(next() * 33));
        return name;
      });
      expect(byKeys(names)).toEqual(byCompareNames(names));
    }
  });

  it("falls back to compareNames for other scripts, other digits and very long numbers", () => {
    for (const names of [
      ["é10.md", "e9.md", "E2.md", "f.md"],
      ["ch١٢.md", "ch5.md", "ch٠٣.md"],
      ["１０.md", "9.md", "2.md"],
      [`x${"9".repeat(300)}`, `x${"1".repeat(301)}`, "x5"],
      ["Résumé.md", "resume.md", "RESUME.md", "rest.md"],
    ])
      expect(byKeys(names)).toEqual(byCompareNames(names));
  });

  it("is the writer's order on a typical folder", () => {
    expect(byKeys(["readme.md", "Zeta.md", "ch10.md", "ch2.md", "README.md", "api.md"])).toEqual([
      "api.md",
      "ch2.md",
      "ch10.md",
      "README.md",
      "readme.md",
      "Zeta.md",
    ]);
  });
});
