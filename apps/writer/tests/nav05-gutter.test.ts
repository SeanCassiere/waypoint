import { describe, expect, it } from "vitest";

import { gutterFor, type GutterCell } from "../src/viewer/gutter.ts";
import { makeLineage, type LineageRow } from "../src/viewer/lineage.ts";

/** Rows as plain fixtures: [display number, parent number, sync state]; id is "r<n>". */
const rowsOf = (spec: [number, number | null, string][]): LineageRow[] =>
  spec.map(([n, parent, sync_state]) => ({
    id: `r${n}`,
    parent_revision_id: parent === null ? null : `r${parent}`,
    display_number: n,
    sync_state,
  }));
const newestFirst = (rows: readonly LineageRow[]) =>
  rows.toSorted((a, b) => b.display_number - a.display_number);
/** #1..#n linear (each on the one before), synced. */
const linear = (n: number): [number, number | null, string][] =>
  Array.from({ length: n }, (_, i) => [i + 1, i === 0 ? null : i, "synced"]);
const cellOf = (gutter: ReturnType<typeof gutterFor>, n: number): GutterCell => {
  const cell = gutter.cells.get(`r${n}`);
  if (!cell) throw new Error(`no cell for #${n}`);
  return cell;
};

/** A cell as the brief's table row: lane, pass, join, ownUp, ownDown, line0. */
function row(
  lane: number,
  pass: number[],
  join: number[],
  ownUp: boolean,
  ownDown: boolean,
  line0: boolean,
): GutterCell {
  return { lane, pass, join, ownUp, ownDown, line0 };
}

describe("gutterFor", () => {
  it("draws the demo: #6 off #4 in lane 1, curving into #4", () => {
    const rows = rowsOf([
      [1, null, "synced"],
      [2, 1, "synced"],
      [3, 2, "synced"],
      [4, 3, "synced"],
      [5, 4, "synced"],
      [6, 4, "failed"],
      [7, 5, "pending"],
    ]);
    const gutter = gutterFor(makeLineage(rows), newestFirst(rows));
    expect(cellOf(gutter, 7)).toEqual(row(0, [], [], false, true, false));
    expect(cellOf(gutter, 6)).toEqual(row(1, [], [], false, true, true));
    expect(cellOf(gutter, 5)).toEqual(row(0, [1], [], true, true, false));
    expect(cellOf(gutter, 4)).toEqual(row(0, [], [1], true, true, false));
    expect(cellOf(gutter, 3)).toEqual(row(0, [], [], true, true, false));
    expect(cellOf(gutter, 2)).toEqual(row(0, [], [], true, true, false));
    expect(cellOf(gutter, 1)).toEqual(row(0, [], [], true, false, false));
    expect(gutter.width).toBe(1);
    expect(gutter.joinsBelow).toEqual([]);
  });

  it("stacks overlapping branches and continues a two-revision branch in its lane", () => {
    // #6 off #2, #7 off #6, #8 off #4, latest #9.
    const rows = rowsOf([
      [1, null, "synced"],
      [2, 1, "synced"],
      [3, 2, "synced"],
      [4, 3, "synced"],
      [5, 4, "synced"],
      [6, 2, "failed"],
      [7, 6, "failed"],
      [8, 4, "failed"],
      [9, 5, "synced"],
    ]);
    const gutter = gutterFor(makeLineage(rows), newestFirst(rows));
    expect(cellOf(gutter, 8)).toMatchObject({ lane: 1, pass: [], ownUp: false });
    expect(cellOf(gutter, 7)).toMatchObject({ lane: 2, pass: [1], ownUp: false });
    expect(cellOf(gutter, 6)).toMatchObject({ lane: 2, pass: [1], ownUp: true });
    expect(cellOf(gutter, 5)).toMatchObject({ lane: 0, pass: [1, 2], join: [] });
    expect(cellOf(gutter, 4)).toMatchObject({ lane: 0, pass: [2], join: [1] });
    expect(cellOf(gutter, 3)).toMatchObject({ lane: 0, pass: [2], join: [] });
    expect(cellOf(gutter, 2)).toMatchObject({ lane: 0, pass: [], join: [2] });
    expect(gutter.width).toBe(2);
  });

  it("keeps lane 0 off a failed revision above the latest", () => {
    // #8 failed on #7 = latest.
    const rows = rowsOf([...linear(7), [8, 7, "failed"]]);
    const gutter = gutterFor(makeLineage(rows), newestFirst(rows));
    expect(cellOf(gutter, 8)).toMatchObject({ lane: 1, line0: false, ownDown: true });
    expect(cellOf(gutter, 7)).toMatchObject({ lane: 0, join: [1], ownUp: false });
  });

  it("draws lanes for the shown page and says where they join below", () => {
    // #1..#59 linear, #60 failed off #5, #61 on #59; History's first page is #61..#12.
    const rows = rowsOf([...linear(59), [60, 5, "failed"], [61, 59, "synced"]]);
    const shown = newestFirst(rows).slice(0, 50);
    expect(shown.at(-1)?.display_number).toBe(12);
    const gutter = gutterFor(makeLineage(rows), shown);
    expect(gutter.cells.size).toBe(50);
    expect(cellOf(gutter, 60).lane).toBe(1);
    for (let n = 59; n >= 12; n--) expect(cellOf(gutter, n).pass).toEqual([1]);
    expect(gutter.joinsBelow).toEqual([{ lane: 1, at: 5 }]);
    // The whole history has nothing below.
    expect(gutterFor(makeLineage(rows), newestFirst(rows)).joinsBelow).toEqual([]);
  });

  it("clamps lanes above 3", () => {
    // Five concurrent branches off #1, all above the latest line's later revisions.
    const rows = rowsOf([
      [1, null, "synced"],
      [2, 1, "failed"],
      [3, 1, "failed"],
      [4, 1, "failed"],
      [5, 1, "failed"],
      [6, 1, "failed"],
      [7, 1, "synced"],
    ]);
    const lineage = makeLineage(rows);
    expect(Math.max(...[...lineage.lanes().map.values()].map((info) => info.lane))).toBe(5);
    const gutter = gutterFor(lineage, newestFirst(rows));
    for (const cell of gutter.cells.values()) {
      expect(cell.lane).toBeLessThanOrEqual(3);
      expect(cell.pass.every((k) => k <= 3 && k !== cell.lane)).toBe(true);
      expect(cell.join.every((k) => k <= 3)).toBe(true);
      expect(new Set(cell.pass).size).toBe(cell.pass.length);
    }
    expect(gutter.width).toBe(3);
    // #4 is the first node in lane 3: nothing above it in that column.
    expect(cellOf(gutter, 4)).toMatchObject({ lane: 3, pass: [1, 2], ownUp: false });
    // #3 (lane 4) and #2 (lane 5) are drawn in lane 3 under #4's lane: the column stays unbroken.
    expect(cellOf(gutter, 3)).toMatchObject({ lane: 3, pass: [1, 2], ownUp: true });
    expect(cellOf(gutter, 2)).toMatchObject({ lane: 3, pass: [1, 2], ownUp: true });
  });

  it("keeps a sibling fork's lane through the shared off-line parent", () => {
    // #5 failed off #2; #6 and #7 failed off #5; latest #8 on #4.
    const rows = rowsOf([
      ...linear(4),
      [5, 2, "failed"],
      [6, 5, "failed"],
      [7, 5, "failed"],
      [8, 4, "synced"],
    ]);
    const lineage = makeLineage(rows);
    const gutter = gutterFor(lineage, newestFirst(rows));
    expect(cellOf(gutter, 7)).toMatchObject({ lane: 1, pass: [], ownUp: false });
    expect(cellOf(gutter, 6)).toMatchObject({ lane: 2, pass: [1], ownUp: false });
    // #5 is drawn in lane 1 (continuing #7); #6's lane 2 passes it on its way to #2.
    expect(cellOf(gutter, 5)).toMatchObject({ lane: 1, pass: [2], ownUp: true });
    expect(cellOf(gutter, 4)).toMatchObject({ lane: 0, pass: [1, 2] });
    expect(cellOf(gutter, 3)).toMatchObject({ lane: 0, pass: [1, 2] });
    expect(cellOf(gutter, 2)).toMatchObject({ lane: 0, join: [1, 2] });
    // Cut the page at #5: both lanes run off it and join #2 below.
    const page = gutterFor(lineage, newestFirst(rows).slice(0, 4));
    expect(page.joinsBelow).toEqual([
      { lane: 1, at: 2 },
      { lane: 2, at: 2 },
    ]);
  });
});
