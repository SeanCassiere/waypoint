// Splits a browser suite's scenarios across CI jobs (BROWSER_SHARD=i/n). The numbered baseline
// files share state, so they stay together, in one shard; every item runs alone, so items go
// wherever the load is lowest. Weights are recent CI durations (shard-weights.ts): they only
// balance the shards, so a stale or missing weight costs time, never coverage.

/** One shard of n: index counts from 1. */
export interface Shard {
  index: number;
  count: number;
}

/** A weight for a scenario shard-weights.ts doesn't list yet (a new item), in ms. */
export const DEFAULT_WEIGHT_MS = 10_000;

const baseline = /^\d\d-/;

/** BROWSER_SHARD's value ("2/4"), or undefined when it's unset or empty. Throws on anything else. */
export function parseShard(value: string | undefined): Shard | undefined {
  if (value === undefined || value === "") return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index > count)
    throw new Error(`BROWSER_SHARD must be i/n with 1 <= i <= n, not ${JSON.stringify(value)}`);
  return { index, count };
}

/**
 * Every stem in exactly one of `count` shards, each shard's stems in sorted order (the baseline
 * first). Longest unit first onto the least-loaded shard (ties: the lower shard, then the lower
 * stem), so the result depends only on the stems, the weights and the count.
 */
export function assignShards(
  stems: readonly string[],
  weights: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  const weight = (stem: string): number => weights[stem] ?? DEFAULT_WEIGHT_MS;
  const sorted = stems.toSorted();
  const group = sorted.filter((stem) => baseline.test(stem));
  const units = [
    ...(group.length > 0 ? [group] : []),
    ...sorted.filter((stem) => !baseline.test(stem)).map((stem) => [stem]),
  ]
    .map((unit) => ({
      unit,
      first: unit[0] ?? "",
      weight: unit.reduce((sum, stem) => sum + weight(stem), 0),
    }))
    .toSorted((a, b) => b.weight - a.weight || (a.first < b.first ? -1 : 1));
  const shards = Array.from({ length: count }, () => ({ load: 0, stems: [] as string[] }));
  for (const { unit, weight: unitWeight } of units) {
    const target = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    target.load += unitWeight;
    target.stems.push(...unit);
  }
  return shards.map((shard) => shard.stems.toSorted());
}
