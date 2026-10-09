// The History gutter: per-row segments for lineage.ts's lanes, for the rows a page shows. Pure,
// so the extents are unit-testable; components.tsx draws them (LineGutter) with static CSS.
import type { Lineage, LineageRow } from "./lineage.ts";

export interface GutterCell {
  /** 0..3, clamped. */
  lane: number;
  /** Side lanes passing straight through this row (ascending, no duplicates, never `lane`). */
  pass: number[];
  /** Side lanes curving into this row's node. */
  join: number[];
  /** This row's own lane continues above its node (lane 0: not the latest; side lane: its child
   *  in the same lane is above). */
  ownUp: boolean;
  /** This row's own lane continues below its node (lane 0: not the root; side lane: always). */
  ownDown: boolean;
  /** A side-lane row that the lane-0 line passes straight through. */
  line0: boolean;
}
export interface Gutter {
  /** Keyed by revision id, for the shown rows. */
  cells: ReadonlyMap<string, GutterCell>;
  /** Widest lane drawn. */
  width: 0 | 1 | 2 | 3;
  /** Lanes running off the page; `at` = the branch point's display number. */
  joinsBelow: { lane: number; at: number }[];
}

const MAX_LANE = 3;
const WIDTHS = [0, 1, 2, 3] as const;
const clamp = (lane: number): number => Math.min(lane, MAX_LANE);
const ascending = (a: number, b: number): number => a - b;

/** lanes() is pure per lineage; History and the Timeline both draw from it in one request. */
const lanesOf = new WeakMap<object, ReturnType<Lineage<LineageRow>["lanes"]>>();

/** Lanes are computed over the whole lineage and drawn for `shown` (newest first). */
export function gutterFor<R extends LineageRow>(lineage: Lineage<R>, shown: readonly R[]): Gutter {
  let lanes = lanesOf.get(lineage);
  if (!lanes) {
    lanes = lineage.lanes();
    lanesOf.set(lineage, lanes);
  }
  const { order, map } = lanes;
  const index = new Map(order.map((row, i) => [row.id, i]));
  const at = (id: string): number => index.get(id) ?? -1;
  const latestAt = lineage.latest ? at(lineage.latest.id) : -1;
  const root = lineage.line.at(-1);
  const rootAt = root ? at(root.id) : -1;
  const side = (row: LineageRow): boolean => !lineage.onLine.has(row.id);
  // Side-lane rows whose lane continues above them: a child off the line, in the same lane, above.
  const continued = new Set<string>();
  for (const row of order) {
    const parent = row.parent_revision_id;
    if (parent === null || !side(row) || lineage.onLine.has(parent)) continue;
    const own = map.get(row.id);
    const up = map.get(parent);
    if (own && up && own.lane === up.lane && at(parent) > at(row.id)) continued.add(parent);
  }
  // Each side lane's extent, from the row that starts it (a side row not continued from above)
  // down to the row it joins (lanes()'s end: the branch point, or the oldest row). The lane passes
  // every row in between except its own nodes; this also covers a sibling fork inside a branch,
  // whose shared off-line parent sits in another lane (lanes() leaves that row out of `pass`).
  const passes = order.map(() => new Set<number>());
  const extents: { lane: number; from: number; to: number }[] = [];
  order.forEach((row, from) => {
    const info = map.get(row.id);
    if (!info || !side(row) || continued.has(row.id)) return;
    const point = lineage.branchPoint(row.id);
    const to = point ? at(point.id) : order.length - 1;
    if (to <= from) return;
    extents.push({ lane: info.lane, from, to });
    for (let i = from + 1; i < to; i++) {
      const passed = order[i];
      if (!passed) continue;
      if (side(passed) && map.get(passed.id)?.lane === info.lane) continue;
      passes[i]?.add(info.lane);
    }
  });
  const cells = new Map<string, GutterCell>();
  let width = 0;
  let last = -1;
  for (const row of shown) {
    const info = map.get(row.id);
    const i = index.get(row.id);
    if (!info || i === undefined) continue;
    last = Math.max(last, i);
    const isSide = side(row);
    const lane = clamp(info.lane);
    const passing = [...(passes[i] ?? [])].map(clamp);
    const cell: GutterCell = {
      lane,
      pass: [...new Set(passing)].filter((k) => k !== lane).toSorted(ascending),
      join: [...new Set([...info.join].map(clamp))].toSorted(ascending),
      // Beyond lane 3 lanes share the last column: a lane passing through that column keeps the
      // line above this row's node unbroken.
      ownUp: isSide
        ? continued.has(row.id) || passing.includes(lane)
        : row.id !== lineage.latest?.id,
      ownDown: isSide || row.id !== root?.id,
      line0: isSide && latestAt < i && i < rootAt,
    };
    width = Math.max(width, lane, ...cell.pass, ...cell.join);
    cells.set(row.id, cell);
  }
  // Lanes still open at the last shown row end below it, at their branch point.
  const joinsBelow: { lane: number; at: number }[] = [];
  const seen = new Set<string>();
  for (const extent of extents.toSorted((a, b) => a.lane - b.lane || b.to - a.to)) {
    const end = order[extent.to];
    if (last < 0 || extent.from > last || extent.to <= last || !end) continue;
    const join = { lane: clamp(extent.lane), at: end.display_number };
    const key = `${join.lane}:${join.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    joinsBelow.push(join);
  }
  return { cells, width: WIDTHS[clamp(width)] ?? MAX_LANE, joinsBelow };
}
