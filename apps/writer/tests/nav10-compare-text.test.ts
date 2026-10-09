import { describe, expect, it } from "vitest";

import {
  belowRows,
  belowText,
  excludedLabel,
  lineageBelow,
  orderPair,
  pickSummary,
} from "../src/viewer/compare-text.ts";
import { makeLineage, type LineageRow } from "../src/viewer/lineage.ts";

// NAV-10: the compare mode's words, over the same lineage the server and the client build.

/** Rows as plain fixtures: [display number, parent number, sync state]; id is "r<n>". */
const rowsOf = (spec: [number, number | null, string][]): LineageRow[] =>
  spec.map(([n, parent, sync_state]) => ({
    id: `r${n}`,
    parent_revision_id: parent === null ? null : `r${parent}`,
    display_number: n,
    sync_state,
  }));
// The demo's shape: #1..#5 linear, #6 on #4 (failed), #7 on #5 (uploading).
const DEMO: [number, number | null, string][] = [
  [1, null, "synced"],
  [2, 1, "synced"],
  [3, 2, "synced"],
  [4, 3, "synced"],
  [5, 4, "synced"],
  [6, 4, "failed"],
  [7, 5, "pending"],
];
const demo = makeLineage(rowsOf(DEMO));
// The demo plus #8, a second root (failed, so the latest line is unchanged).
const unrelated = makeLineage(rowsOf([...DEMO, [8, null, "failed"]]));
// #3..#6 all branch off #1; #7 on #2, #8 on #7: four revisions between #2 and #8 aren't under #8.
const wide = makeLineage(
  rowsOf([
    [1, null, "synced"],
    [2, 1, "synced"],
    [3, 1, "synced"],
    [4, 1, "synced"],
    [5, 1, "synced"],
    [6, 1, "synced"],
    [7, 2, "synced"],
    [8, 7, "synced"],
  ]),
);
const row = (lin: ReturnType<typeof makeLineage>, n: number): LineageRow => {
  const found = lin.byId.get(`r${n}`);
  if (!found) throw new Error(`no #${n}`);
  return found;
};
const picks = (lin: ReturnType<typeof makeLineage>, ...ns: number[]) => ns.map((n) => row(lin, n));
const ids = (set: ReadonlySet<string>) => [...set].toSorted();
/** History's first page: the 50 newest rows. */
const page = (lin: ReturnType<typeof makeLineage>) =>
  [...lin.byId.values()].toReversed().slice(0, 50);
/** The client's lineage: the rendered rows plus what the server sends from below them. */
const client = (lin: ReturnType<typeof makeLineage>) => {
  const shown = page(lin);
  return makeLineage([...shown, ...belowRows(belowText(lineageBelow(lin, shown)))]);
};

describe("pickSummary", () => {
  it("asks for two ticks until there are two", () => {
    expect(pickSummary(demo, [])).toEqual({
      status: "Tick two revisions to compare.",
      button: "Compare",
      ready: false,
      inRange: new Set(),
      notes: new Map(),
    });
    expect(pickSummary(demo, picks(demo, 5))).toMatchObject({
      status: "Tick one more revision.",
      button: "Compare",
      ready: false,
    });
    expect(pickSummary(demo, picks(demo, 2, 5, 7))).toMatchObject({
      status: "Pick two revisions.",
      button: "Compare",
      ready: false,
    });
  });

  it("describes a range on the latest line and the branch it skips, in either tick order", () => {
    const summary = pickSummary(demo, picks(demo, 2, 7));
    expect(summary.status).toBe(
      "#2 → #7 · 4 steps on the latest line. #6 is a branch off #4, so it isn't included.",
    );
    expect(summary.button).toBe("Compare #2 → #7");
    expect(summary.ready).toBe(true);
    expect(summary.from?.id).toBe("r2");
    expect(summary.to?.id).toBe("r7");
    expect(ids(summary.inRange)).toEqual(["r3", "r4", "r5"]);
    expect([...summary.notes]).toEqual([["r6", "Not included: a branch"]]);
    expect(pickSummary(demo, picks(demo, 7, 2))).toEqual(summary);
  });

  it("says when a step is off the latest line and a skipped revision is on it", () => {
    const summary = pickSummary(demo, picks(demo, 1, 6));
    expect(summary.status).toBe(
      "#1 → #6 · 4 steps. #5 is on the latest line, not under #6, so it isn't included.",
    );
    expect(summary.button).toBe("Compare #1 → #6");
    expect([...summary.notes]).toEqual([["r5", "Not included: not under #6"]]);
  });

  it("counts one step", () => {
    const summary = pickSummary(demo, picks(demo, 4, 5));
    expect(summary.status).toBe("#4 → #5 · 1 step on the latest line.");
    expect(summary.button).toBe("Compare #4 → #5");
    expect(summary.inRange.size).toBe(0);
    expect(summary.notes.size).toBe(0);
  });

  it("names two branches and their common revision, lower number first", () => {
    for (const pair of [picks(demo, 5, 6), picks(demo, 6, 5)]) {
      const summary = pickSummary(demo, pair);
      expect(summary.status).toBe("#5 and #6 are on different branches. Both build on #4.");
      expect(summary.button).toBe("Compare #5 → #6");
      expect(summary.ready).toBe(true);
      expect(summary.inRange.size).toBe(0);
    }
  });

  it("skips a revision numbered between a parent and its child", () => {
    // lineage.ts reports no excluded revisions for a parent pair; #3 (off #1) still isn't under #4.
    const lin = makeLineage(
      rowsOf([
        [1, null, "synced"],
        [2, 1, "synced"],
        [3, 1, "synced"],
        [4, 2, "synced"],
      ]),
    );
    expect(lin.relation("r2", "r4")).toEqual({
      kind: "parent",
      steps: [row(lin, 4)],
      excluded: [],
    });
    const summary = pickSummary(lin, picks(lin, 4, 2));
    expect(summary.status).toBe(
      "#2 → #4 · 1 step on the latest line. #3 is a branch off #1, so it isn't included.",
    );
    expect([...summary.notes]).toEqual([["r3", "Not included: a branch"]]);
    expect(summary.inRange.size).toBe(0);
  });

  it("lists two skipped revisions and counts the rest", () => {
    const summary = pickSummary(wide, picks(wide, 2, 8));
    expect(summary.status).toBe(
      "#2 → #8 · 2 steps on the latest line. #3 is a branch off #1, so it isn't included. #4 is a branch off #1, so it isn't included. 2 more revisions aren't included.",
    );
    expect(summary.notes.size).toBe(4);
  });

  it("says two separate histories share nothing", () => {
    const summary = pickSummary(unrelated, picks(unrelated, 5, 8));
    expect(summary.status).toBe("#5 and #8 share no earlier revision.");
    expect(summary.button).toBe("Compare #5 → #8");
    expect(summary.ready).toBe(true);
  });
});

describe("orderPair", () => {
  it("puts the ancestor first", () => {
    const pair = orderPair(demo, row(demo, 7), row(demo, 2));
    expect([pair.from.id, pair.to.id, pair.kind]).toEqual(["r2", "r7", "ancestor"]);
    const parent = orderPair(demo, row(demo, 5), row(demo, 4));
    expect([parent.from.id, parent.to.id, parent.kind]).toEqual(["r4", "r5", "parent"]);
    const forward = orderPair(demo, row(demo, 1), row(demo, 6));
    expect([forward.from.id, forward.to.id, forward.kind]).toEqual(["r1", "r6", "ancestor"]);
  });

  it("orders branches and unrelated histories by number", () => {
    const branches = orderPair(demo, row(demo, 6), row(demo, 5));
    expect([branches.from.id, branches.to.id, branches.kind]).toEqual(["r5", "r6", "branches"]);
    // lineage.ts says "unknown" for two rows with no common ancestor.
    expect(unrelated.relation("r8", "r5").kind).toBe("unknown");
    const apart = orderPair(unrelated, row(unrelated, 8), row(unrelated, 5));
    expect(apart).toEqual({ from: row(unrelated, 5), to: row(unrelated, 8), kind: "unrelated" });
  });

  it("refuses the same revision twice", () => {
    expect(() => orderPair(demo, row(demo, 3), row(demo, 3))).toThrow(
      "orderPair needs two different revisions",
    );
  });
});

describe("excludedLabel", () => {
  it("labels a skipped revision by where it is, and a branch by its state", () => {
    expect(excludedLabel(demo, row(demo, 6), row(demo, 7))).toBe("#6 (branch off #4, failed)");
    expect(excludedLabel(demo, row(demo, 5), row(demo, 6))).toBe(
      "#5 (on the latest line, not under #6)",
    );
    const states = makeLineage(
      rowsOf([
        [1, null, "synced"],
        [2, 1, "pending"],
        [3, 1, "synced"],
        [4, 1, "synced"],
      ]),
    );
    expect(excludedLabel(states, row(states, 2), row(states, 4))).toBe(
      "#2 (branch off #1, uploading)",
    );
    expect(excludedLabel(states, row(states, 3), row(states, 4))).toBe("#3 (branch off #1)");
  });
});

describe("lineageBelow", () => {
  // #1..#59 linear and #60 on #1: History's first page (50) runs #60..#11, so #59 and #60 meet
  // only at #1, below it.
  const spec: [number, number | null, string][] = [[1, null, "synced"]];
  for (let n = 2; n <= 59; n += 1) spec.push([n, n - 1, "synced"]);
  spec.push([60, 1, "synced"]);
  const full = makeLineage(rowsOf(spec));

  it("keeps where two shown branches meet below the page", () => {
    const shown = page(full);
    expect(shown.at(-1)?.display_number).toBe(11);
    // Without it, #59 and #60 read as separate histories.
    expect(pickSummary(makeLineage(shown), picks(full, 59, 60)).status).toBe(
      "#59 and #60 share no earlier revision.",
    );
    const lin = client(full);
    expect(pickSummary(lin, picks(lin, 59, 60)).status).toBe(
      "#59 and #60 are on different branches. Both build on #1.",
    );
    // Only the exit parent (#10) and the meeting point (#1, also #60's parent) are sent.
    expect(
      lineageBelow(full, shown).map((r) => [r.id, r.parent_revision_id, r.display_number]),
    ).toEqual(
      expect.arrayContaining([
        ["r10", "r1", 10],
        ["r1", null, 1],
      ]),
    );
    expect(lineageBelow(full, shown)).toHaveLength(2);
    // A range on the page is unchanged.
    expect(pickSummary(lin, picks(lin, 40, 50)).status).toBe(
      pickSummary(full, picks(full, 40, 50)).status,
    );
  });

  it("matches the full lineage for every pair of shown rows", () => {
    // Plus #61 on #5 and #62 on #6 (failed), and #63 on #61: the latest line now runs through #5,
    // and the page (#63..#14) meets below it at #1, #5 and #6.
    const more = makeLineage(
      rowsOf([...spec, [61, 5, "failed"], [62, 6, "failed"], [63, 61, "synced"]]),
    );
    const lin = client(more);
    const shown = page(more);
    // #60's parent #1 is below the page too, so the tree is #13 → #6 → #5 → #1.
    expect(
      lineageBelow(more, shown)
        .map((r) => [r.id, r.parent_revision_id])
        .toSorted(([x], [y]) => String(x).localeCompare(String(y))),
    ).toEqual([
      ["r1", null],
      ["r13", "r6"],
      ["r5", "r1"],
      ["r6", "r5"],
    ]);
    for (const a of shown)
      for (const b of shown) {
        if (a.id === b.id) continue;
        expect(pickSummary(lin, picks(lin, a.display_number, b.display_number)).status).toBe(
          pickSummary(more, [a, b]).status,
        );
      }
  });

  it("sends nothing when the whole history is shown", () => {
    expect(lineageBelow(demo, [...demo.byId.values()])).toEqual([]);
    expect(belowText([])).toBe("");
    expect(belowRows("")).toEqual([]);
  });
});
