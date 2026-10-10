import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHARD_WEIGHTS } from "./browser/shard-weights.ts";
import { assignShards, DEFAULT_WEIGHT_MS, parseShard } from "./browser/shards.ts";

/** The scenario stems runSuite finds for a suite. */
function stems(kind: "viewer" | "reader"): string[] {
  return readdirSync(new URL(`./browser/${kind}/`, import.meta.url))
    .filter((file) => file.endsWith(".ts") && !file.startsWith("_"))
    .map((file) => file.slice(0, -3))
    .toSorted();
}

describe("parseShard", () => {
  it("reads i/n and treats unset or empty as no shard", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, count: 4 });
    expect(parseShard("1/1")).toEqual({ index: 1, count: 1 });
    expect(parseShard(undefined)).toBeUndefined();
    expect(parseShard("")).toBeUndefined();
  });

  it.each(["0/4", "5/4", "1/0", "2", "2/4/1", " 2/4", "a/b", "-1/4"])("refuses %j", (value) => {
    expect(() => parseShard(value)).toThrow(/BROWSER_SHARD/);
  });
});

describe("assignShards", () => {
  for (const kind of ["viewer", "reader"] as const) {
    const all = stems(kind);
    const baseline = all.filter((stem) => /^\d\d-/.test(stem));
    // Both suites have baseline files; a suite without would need this test reworked.
    it(`has ${kind} baseline files`, () => expect(baseline.length).toBeGreaterThan(0));

    it(`puts every ${kind} scenario in exactly one shard, the baseline together and in order`, () => {
      for (let count = 1; count <= 8; count += 1) {
        const shards = assignShards(all, SHARD_WEIGHTS[kind], count);
        expect(shards).toHaveLength(count);
        expect(shards.flat().toSorted()).toEqual(all);
        const holder = shards.filter((shard) => shard.some((stem) => baseline.includes(stem)));
        expect(holder).toHaveLength(1);
        expect(holder[0]?.slice(0, baseline.length)).toEqual(baseline);
        for (const shard of shards) expect(shard).toEqual(shard.toSorted());
      }
    });
  }

  it("balances the viewer's four CI shards to within a quarter of an even split", () => {
    const weights = SHARD_WEIGHTS.viewer;
    const all = stems("viewer");
    const load = (shard: string[]) =>
      shard.reduce((sum, stem) => sum + (weights[stem] ?? DEFAULT_WEIGHT_MS), 0);
    const loads = assignShards(all, weights, 4).map(load);
    const even = loads.reduce((sum, value) => sum + value, 0) / 4;
    expect(Math.max(...loads)).toBeLessThanOrEqual(even * 1.25);
  });

  it("is deterministic and gives unknown scenarios the default weight", () => {
    const stemsIn = ["00-a", "01-b", "X-1", "X-2", "X-3"];
    const weights = { "00-a": 1000, "01-b": 1000, "X-1": 30_000 };
    expect(assignShards(stemsIn, weights, 2)).toEqual([["X-1"], ["00-a", "01-b", "X-2", "X-3"]]);
    expect(assignShards(stemsIn.toReversed(), weights, 2)).toEqual(
      assignShards(stemsIn, weights, 2),
    );
  });

  it("leaves extra shards empty rather than splitting the baseline", () => {
    expect(assignShards(["00-a", "01-b"], {}, 3)).toEqual([["00-a", "01-b"], [], []]);
  });
});
