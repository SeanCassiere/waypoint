// A collection's revision lineage: the latest line, stepping with [ and ], how two revisions
// relate, and side lanes for the History view. Pure (no Node, DOM or app imports), so pages and,
// if ever needed, client code can share it. Lanes are an owner-side view of history; nothing here
// says what share links show.

/** The fields a timeline row already carries; nothing else is read. */
export interface LineageRow {
  id: string;
  parent_revision_id: string | null;
  display_number: number;
  sync_state: string;
}
export interface LaneInfo {
  lane: number;
  pass: ReadonlySet<number>;
  join: ReadonlySet<number>;
}
export type Relation<R extends LineageRow> =
  | { kind: "same" }
  // An id not in rows, OR two known rows with no common ancestor; callers tell them apart with
  // byId.has(baseId) && byId.has(headId).
  | { kind: "unknown" }
  // [head, base]: the same pair, older first.
  | { kind: "descendant"; swap: [R, R] }
  | { kind: "parent"; steps: R[]; excluded: R[] }
  | { kind: "ancestor"; steps: R[]; excluded: R[] }
  | { kind: "branches"; common: R };
export type Step<R extends LineageRow> = { to: R } | { end: string };
export interface Lineage<R extends LineageRow> {
  latest: R | undefined;
  /** The latest line, newest first. */
  line: readonly R[];
  /** Ids on the latest line. */
  onLine: ReadonlySet<string>;
  byId: ReadonlyMap<string, R>;
  /** Self first, root last; stops at a dropped parent or a cycle. */
  ancestors(id: string): R[];
  branchPoint(id: string): R | null;
  step(id: string, dir: -1 | 1): Step<R>;
  relation(baseId: string, headId: string): Relation<R>;
  lanes(): { order: readonly R[]; map: ReadonlyMap<string, LaneInfo> };
}

export const FIRST_REVISION = "This is the first revision." as const;
export const LATEST_REVISION = "This is the latest revision." as const;
export function endOfBranch(latestNumber: number): string {
  return `End of this branch. Latest is #${latestNumber}`;
}
const NO_REVISION = "No revision in that direction";

export function makeLineage<R extends LineageRow>(rows: readonly R[]): Lineage<R> {
  const sorted = rows.toSorted((a, b) => a.display_number - b.display_number);
  const byId = new Map(sorted.map((r) => [r.id, r]));
  const children = new Map<string, R[]>();
  for (const r of sorted) {
    if (r.parent_revision_id === null) continue;
    const kids = children.get(r.parent_revision_id) ?? [];
    kids.push(r); // ascending by number
    children.set(r.parent_revision_id, kids);
  }
  // Same rule as the collection page: latest = newest revision that hasn't failed.
  const latest = sorted.findLast((r) => r.sync_state !== "failed") ?? sorted.at(-1);
  const parentOf = (r: R): R | undefined =>
    r.parent_revision_id === null ? undefined : byId.get(r.parent_revision_id);
  const ancestors = (id: string): R[] => {
    const out: R[] = [];
    const seen = new Set<string>();
    for (let r = byId.get(id); r && !seen.has(r.id); r = parentOf(r)) {
      seen.add(r.id);
      out.push(r);
    }
    return out;
  };
  const line = latest ? ancestors(latest.id) : [];
  const onLine = new Set(line.map((r) => r.id));
  const branchPoint = (id: string): R | null => ancestors(id).find((r) => onLine.has(r.id)) ?? null;

  /** [ is the parent; ] is the child on the same line (the lowest-numbered one off it). */
  const step = (id: string, dir: -1 | 1): Step<R> => {
    const r = byId.get(id);
    if (!r || !latest) return { end: NO_REVISION };
    if (dir < 0) {
      const parent = parentOf(r);
      return parent ? { to: parent } : { end: FIRST_REVISION };
    }
    const kids = children.get(id) ?? [];
    const next = onLine.has(id)
      ? kids.find((k) => onLine.has(k.id))
      : kids.find((k) => !onLine.has(k.id));
    if (next) return { to: next };
    return { end: id === latest.id ? LATEST_REVISION : endOfBranch(latest.display_number) };
  };

  const relation = (baseId: string, headId: string): Relation<R> => {
    const base = byId.get(baseId);
    const head = byId.get(headId);
    if (!base || !head) return { kind: "unknown" };
    if (base.id === head.id) return { kind: "same" };
    if (head.parent_revision_id === base.id) return { kind: "parent", steps: [head], excluded: [] };
    const ha = ancestors(head.id);
    const i = ha.indexOf(base);
    if (i > 0) {
      const steps = ha.slice(0, i).toReversed();
      const inSteps = new Set(steps.map((r) => r.id));
      const excluded = sorted.filter(
        (r) =>
          r.display_number > base.display_number &&
          r.display_number < head.display_number &&
          !inSteps.has(r.id),
      );
      return { kind: "ancestor", steps, excluded };
    }
    const ba = new Set(ancestors(base.id).map((r) => r.id));
    if (ba.has(head.id)) return { kind: "descendant", swap: [head, base] };
    const common = ha.find((r) => ba.has(r.id));
    return common ? { kind: "branches", common } : { kind: "unknown" };
  };

  /** Lanes without reordering: rows stay newest first; a revision off the latest line takes a
   *  side lane from its own row down to the row of its branch point. Lanes are reused once free. */
  const lanes = (): { order: readonly R[]; map: ReadonlyMap<string, LaneInfo> } => {
    const order = sorted.toReversed();
    const cells = order.map((row, i) => ({
      row,
      i,
      info: { lane: 0, pass: new Set<number>(), join: new Set<number>() },
    }));
    const cellOf = new Map(cells.map((cell) => [cell.row.id, cell]));
    const map = new Map(cells.map((cell) => [cell.row.id, cell.info]));
    const oldest = cells.at(-1);
    const busy: number[] = []; // busy[lane] = index of the row where that lane ends
    for (const { row, i, info } of cells) {
      if (!oldest || onLine.has(row.id)) continue;
      // A branch revision whose child is already drawn in a side lane continues that lane.
      const drawn = (children.get(row.id) ?? [])
        .map((child) => cellOf.get(child.id))
        .findLast((child) => child !== undefined && !onLine.has(child.row.id) && child.i < i);
      if (drawn) {
        info.lane = drawn.info.lane;
        continue;
      }
      const point = branchPoint(row.id);
      const end = (point && cellOf.get(point.id)) ?? oldest;
      let lane = 1;
      while ((busy[lane] ?? -1) > i) lane++;
      busy[lane] = end.i;
      info.lane = lane;
      const own = new Set(
        ancestors(row.id)
          .filter((a) => !onLine.has(a.id))
          .map((a) => a.id),
      );
      for (const cell of cells.slice(i + 1, end.i)) {
        if (!own.has(cell.row.id)) cell.info.pass.add(lane);
      }
      end.info.join.add(lane);
    }
    return { order, map };
  };

  return { latest, line, onLine, byId, ancestors, branchPoint, step, relation, lanes };
}
