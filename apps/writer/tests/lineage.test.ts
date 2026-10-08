import { describe, expect, it } from "vitest";

import {
  endOfBranch,
  FIRST_REVISION,
  LATEST_REVISION,
  makeLineage,
  type LineageRow,
  type Relation,
} from "../src/viewer/lineage.ts";

/** Rows as plain fixtures: [display number, parent number, sync state]; id is "r<n>". */
const rowsOf = (spec: [number, number | null, string][]): LineageRow[] =>
  spec.map(([n, parent, sync_state]) => ({
    id: `r${n}`,
    parent_revision_id: parent === null ? null : `r${parent}`,
    display_number: n,
    sync_state,
  }));
const n = (row: LineageRow): string => `#${row.display_number}`;
const ns = (rows: readonly LineageRow[]): string => rows.map(n).join(" ");

// The demo's Postgres 17 upgrade runbook: #1 ← #2 ← #3 ← #4 ← #5 ← #7, #6 off #4.
const demo = rowsOf([
  [1, null, "synced"],
  [2, 1, "synced"],
  [3, 2, "synced"],
  [4, 3, "synced"],
  [5, 4, "synced"],
  [6, 4, "failed"],
  [7, 5, "pending"],
]);
// #6 off #2, #7 off #6 (a two-revision branch), #8 off #4 (a second, overlapping branch).
const synthetic = rowsOf([
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

/** The step target or end string, in lineage-verify.out's words. */
function stepped(lineage: ReturnType<typeof makeLineage>, id: string, dir: -1 | 1): string {
  const result = lineage.step(id, dir);
  return "to" in result ? n(result.to) : result.end;
}

/** lineage-verify.out's relation codes: = P A<k>−#x… D↺ B@#n. */
function code(rel: Relation<LineageRow>): string {
  if (rel.kind === "same") return "=";
  if (rel.kind === "parent") return "P";
  if (rel.kind === "ancestor") {
    return `A${rel.steps.length}${rel.excluded.length ? `−${rel.excluded.map(n).join("")}` : ""}`;
  }
  if (rel.kind === "descendant") return "D↺";
  if (rel.kind === "branches") return `B@${n(rel.common)}`;
  return rel.kind;
}

/** A relation with its rows, as lineage-verify.out prints its examples. */
function detail(rel: Relation<LineageRow>): string {
  if (rel.kind === "parent" || rel.kind === "ancestor") {
    return `${rel.kind} steps ${ns(rel.steps)} excluded ${ns(rel.excluded)}`;
  }
  if (rel.kind === "branches") return `branches common ${n(rel.common)}`;
  if (rel.kind === "descendant") return `descendant swap ${ns(rel.swap)}`;
  return rel.kind;
}

/** One line per row, as lineage-verify.out prints lanes. */
function laneTable(lineage: ReturnType<typeof makeLineage>): string[] {
  const { order, map } = lineage.lanes();
  return order.map((row) => {
    const info = map.get(row.id);
    if (!info) return `${n(row)} missing`;
    const pass = info.pass.size ? ` pass ${[...info.pass].join(",")}` : "";
    const join = info.join.size ? ` join ${[...info.join].join(",")}` : "";
    return `${n(row)} lane ${info.lane}${pass}${join}`;
  });
}

describe("the demo history", () => {
  const lineage = makeLineage(demo);

  it("finds the latest line", () => {
    expect(lineage.latest?.id).toBe("r7");
    expect(ns(lineage.line)).toBe("#7 #5 #4 #3 #2 #1");
    expect([...lineage.onLine].toSorted()).toEqual(["r1", "r2", "r3", "r4", "r5", "r7"]);
  });

  it("steps with [ and ]", () => {
    const table = demo.map((row) => [
      n(row),
      stepped(lineage, row.id, -1),
      stepped(lineage, row.id, 1),
    ]);
    expect(table).toEqual([
      ["#1", "This is the first revision.", "#2"],
      ["#2", "#1", "#3"],
      ["#3", "#2", "#4"],
      ["#4", "#3", "#5"],
      ["#5", "#4", "#7"],
      ["#6", "#4", "End of this branch. Latest is #7"],
      ["#7", "#5", "This is the latest revision."],
    ]);
    expect(lineage.step("r1", -1)).toEqual({ end: FIRST_REVISION });
    expect(lineage.step("r7", 1)).toEqual({ end: LATEST_REVISION });
    expect(lineage.step("r6", 1)).toEqual({ end: endOfBranch(7) });
  });

  it("finds branch points", () => {
    expect(lineage.branchPoint("r6")?.id).toBe("r4");
    expect(lineage.branchPoint("r7")?.id).toBe("r7");
    expect(lineage.branchPoint("rev_nope")).toBeNull();
  });

  it("relates every pair (base row, head column)", () => {
    const table = demo.map((base) => demo.map((head) => code(lineage.relation(base.id, head.id))));
    expect(table).toEqual([
      ["=", "P", "A2", "A3", "A4", "A4−#5", "A5−#6"],
      ["D↺", "=", "P", "A2", "A3", "A3−#5", "A4−#6"],
      ["D↺", "D↺", "=", "P", "A2", "A2−#5", "A3−#6"],
      ["D↺", "D↺", "D↺", "=", "P", "P", "A2−#6"],
      ["D↺", "D↺", "D↺", "D↺", "=", "B@#4", "P"],
      ["D↺", "D↺", "D↺", "D↺", "B@#4", "=", "B@#4"],
      ["D↺", "D↺", "D↺", "D↺", "D↺", "B@#4", "="],
    ]);
  });

  it("carries steps, excluded revisions, the common ancestor and the swap", () => {
    const examples = (
      [
        [2, 7],
        [1, 6],
        [4, 6],
        [5, 6],
        [6, 7],
        [7, 2],
        [3, 5],
      ] as const
    ).map(
      ([base, head]) => `#${base} → #${head}: ${detail(lineage.relation(`r${base}`, `r${head}`))}`,
    );
    expect(examples).toEqual([
      "#2 → #7: ancestor steps #3 #4 #5 #7 excluded #6",
      "#1 → #6: ancestor steps #2 #3 #4 #6 excluded #5",
      "#4 → #6: parent steps #6 excluded ",
      "#5 → #6: branches common #4",
      "#6 → #7: branches common #4",
      "#7 → #2: descendant swap #2 #7",
      "#3 → #5: ancestor steps #4 #5 excluded ",
    ]);
  });

  it("calls unknown ids and separate histories unknown", () => {
    expect(lineage.relation("rev_nope", "r7")).toEqual({ kind: "unknown" });
    expect(lineage.relation("r7", "rev_nope")).toEqual({ kind: "unknown" });
    const separate = makeLineage([
      ...demo,
      { id: "r9", parent_revision_id: null, display_number: 9, sync_state: "failed" },
    ]);
    expect(separate.relation("r9", "r7")).toEqual({ kind: "unknown" });
    expect(separate.byId.has("r9") && separate.byId.has("r7")).toBe(true);
  });

  it("draws lanes on display order", () => {
    expect(laneTable(lineage)).toEqual([
      "#7 lane 0",
      "#6 lane 1",
      "#5 lane 0 pass 1",
      "#4 lane 0 join 1",
      "#3 lane 0",
      "#2 lane 0",
      "#1 lane 0",
    ]);
    const { map } = lineage.lanes();
    expect(map.get("r5")?.pass).not.toBe(map.get("r4")?.pass);
  });
});

describe("two overlapping branches", () => {
  const lineage = makeLineage(synthetic);

  it("draws lanes 2/2/1", () => {
    expect(ns(lineage.line)).toBe("#9 #5 #4 #3 #2 #1");
    expect(laneTable(lineage)).toEqual([
      "#9 lane 0",
      "#8 lane 1",
      "#7 lane 2 pass 1",
      "#6 lane 2 pass 1",
      "#5 lane 0 pass 1,2",
      "#4 lane 0 pass 2 join 1",
      "#3 lane 0 pass 2",
      "#2 lane 0 join 2",
      "#1 lane 0",
    ]);
  });

  it("steps along a branch to its end", () => {
    expect(stepped(lineage, "r6", 1)).toBe("#7");
    expect(stepped(lineage, "r7", 1)).toBe("End of this branch. Latest is #9");
    expect(stepped(lineage, "r8", 1)).toBe("End of this branch. Latest is #9");
    expect(stepped(lineage, "r2", 1)).toBe("#3");
    expect(lineage.branchPoint("r7")?.id).toBe("r2");
  });
});

describe("edges", () => {
  it("handles no rows", () => {
    const lineage = makeLineage([]);
    expect(lineage.latest).toBeUndefined();
    expect(lineage.line).toEqual([]);
    expect(lineage.onLine.size).toBe(0);
    expect(lineage.lanes().order).toEqual([]);
    expect(lineage.step("x", 1)).toEqual({ end: "No revision in that direction" });
    expect(lineage.step("x", -1)).toEqual({ end: "No revision in that direction" });
    expect(lineage.ancestors("x")).toEqual([]);
    expect(lineage.relation("x", "y")).toEqual({ kind: "unknown" });
  });

  it("says no revision in that direction for an unknown id", () => {
    expect(makeLineage(demo).step("rev_nope", -1)).toEqual({
      end: "No revision in that direction",
    });
  });

  it("takes the newest row as latest when every row failed", () => {
    const lineage = makeLineage(
      rowsOf([
        [1, null, "failed"],
        [2, 1, "failed"],
        [3, 1, "failed"],
      ]),
    );
    expect(lineage.latest?.id).toBe("r3");
    expect(ns(lineage.line)).toBe("#3 #1");
  });

  it("stops at a dropped parent", () => {
    // #3's parent r9 isn't in rows: its history ends at #3, off the latest line.
    const rows = rowsOf([
      [1, null, "synced"],
      [2, 1, "synced"],
      [3, 9, "failed"],
      [4, 2, "synced"],
    ]);
    const lineage = makeLineage(rows);
    expect(ns(lineage.ancestors("r3"))).toBe("#3");
    expect(lineage.step("r3", -1)).toEqual({ end: FIRST_REVISION });
    expect(lineage.branchPoint("r3")).toBeNull();
    expect(laneTable(lineage)).toEqual([
      "#4 lane 0",
      "#3 lane 1",
      "#2 lane 0 pass 1",
      "#1 lane 0 join 1",
    ]);
  });

  it("stops at a cycle", () => {
    const lineage = makeLineage(
      rowsOf([
        [1, 2, "synced"],
        [2, 1, "synced"],
      ]),
    );
    expect(ns(lineage.ancestors("r2"))).toBe("#2 #1");
    expect(ns(lineage.line)).toBe("#2 #1");
  });

  it("doesn't depend on input order and doesn't mutate the input", () => {
    const newestFirst = demo.toReversed();
    const before = [...newestFirst];
    const a = makeLineage(demo);
    const b = makeLineage(newestFirst);
    expect(newestFirst).toEqual(before);
    expect(newestFirst.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(ns(b.line)).toBe(ns(a.line));
    expect(laneTable(b)).toEqual(laneTable(a));
    for (const row of demo) {
      for (const dir of [-1, 1] as const) {
        expect(stepped(b, row.id, dir)).toBe(stepped(a, row.id, dir));
      }
      for (const head of demo) {
        expect(code(b.relation(row.id, head.id))).toBe(code(a.relation(row.id, head.id)));
      }
    }
  });

  it("returns the caller's row objects", () => {
    const rows = demo.map((row) =>
      Object.assign({ message: `message ${row.display_number}` }, row),
    );
    const lineage = makeLineage(rows);
    expect(lineage.latest?.message).toBe("message 7");
    expect(lineage.latest).toBe(rows[6]);
  });
});
