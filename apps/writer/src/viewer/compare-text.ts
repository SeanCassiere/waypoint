// Compare's words (NAV-10): how two revisions are ordered, and the History compare mode's status,
// button and row notes. Pure (no Node, DOM or app imports): the server renders it and the client
// recomputes it on every tick, over the same lineage.ts.
import type { Lineage, LineageRow } from "./lineage.ts";

/** NAV-10's own pair kinds; "unrelated" is lineage.ts's `unknown` for two rows it has. */
export type PairKind = "parent" | "ancestor" | "branches" | "unrelated";

const num = (row: LineageRow): string => `#${row.display_number}`;
const ascending = <R extends LineageRow>(a: R, b: R): [R, R] =>
  a.display_number <= b.display_number ? [a, b] : [b, a];

/** Orders two different revisions: an ancestor is the base; otherwise the lower number is. */
export function orderPair<R extends LineageRow>(
  lin: Lineage<R>,
  a: R,
  b: R,
): { from: R; to: R; kind: PairKind } {
  const relation = lin.relation(a.id, b.id);
  switch (relation.kind) {
    case "same":
      throw new Error("orderPair needs two different revisions");
    case "parent":
    case "ancestor":
      return { from: a, to: b, kind: relation.kind };
    case "descendant":
      // The same pair reversed: b is an ancestor of a.
      return { from: b, to: a, kind: a.parent_revision_id === b.id ? "parent" : "ancestor" };
    case "branches":
    case "unknown": {
      const [from, to] = ascending(a, b);
      return { from, to, kind: relation.kind === "branches" ? "branches" : "unrelated" };
    }
    default: {
      const never: never = relation;
      throw new Error(`Unknown relation ${JSON.stringify(never)}`);
    }
  }
}

/** The parent a branch revision builds on, or null for a separate history (no branch point). */
function branchParent<R extends LineageRow>(lin: Lineage<R>, row: R): R | null {
  if (!lin.branchPoint(row.id) || row.parent_revision_id === null) return null;
  return lin.byId.get(row.parent_revision_id) ?? null;
}

/** An excluded revision in the Changes range header: "#6 (branch off #4, failed)". */
export function excludedLabel<R extends LineageRow>(lin: Lineage<R>, row: R, to: R): string {
  if (lin.onLine.has(row.id)) return `${num(row)} (on the latest line, not under ${num(to)})`;
  const state =
    row.sync_state === "failed" ? ", failed" : row.sync_state === "pending" ? ", uploading" : "";
  const parent = branchParent(lin, row);
  return parent
    ? `${num(row)} (branch off ${num(parent)}${state})`
    : `${num(row)} (separate history${state})`;
}

export interface PickSummary<R> {
  status: string;
  button: string;
  ready: boolean;
  from?: R;
  to?: R;
  /** Row ids strictly inside the range (its steps minus `to`). */
  inRange: ReadonlySet<string>;
  /** Row id → "Not included: …" for each revision the range skips. */
  notes: ReadonlyMap<string, string>;
}

const NONE: ReadonlySet<string> = new Set();
const NO_NOTES: ReadonlyMap<string, string> = new Map();

/** The compare mode's footer and row notes for the ticked revisions (in tick order). */
export function pickSummary<R extends LineageRow>(
  lin: Lineage<R>,
  picked: readonly R[],
): PickSummary<R> {
  const idle = (status: string): PickSummary<R> => ({
    status,
    button: "Compare",
    ready: false,
    inRange: NONE,
    notes: NO_NOTES,
  });
  if (picked.length === 0) return idle("Tick two revisions to compare.");
  if (picked.length === 1) return idle("Tick one more revision.");
  const [a, b] = picked;
  if (picked.length > 2 || !a || !b) return idle("Pick two revisions.");
  const { from, to, kind } = orderPair(lin, a, b);
  const button = `Compare ${num(from)} → ${num(to)}`;
  if (kind === "branches") {
    const common = lin.relation(from.id, to.id);
    const point = common.kind === "branches" ? ` Both build on ${num(common.common)}.` : "";
    return {
      status: `${num(from)} and ${num(to)} are on different branches.${point}`,
      button,
      ready: true,
      from,
      to,
      inRange: NONE,
      notes: NO_NOTES,
    };
  }
  if (kind === "unrelated")
    return {
      status: `${num(from)} and ${num(to)} share no earlier revision.`,
      button,
      ready: true,
      from,
      to,
      inRange: NONE,
      notes: NO_NOTES,
    };
  const relation = lin.relation(from.id, to.id);
  const steps = relation.kind === "parent" || relation.kind === "ancestor" ? relation.steps : [to];
  // lineage.ts lists no skipped revisions for a parent pair; a revision numbered between the two
  // still isn't under `to`, so it's skipped by the same rule as for an ancestor.
  const excluded =
    relation.kind === "ancestor"
      ? relation.excluded
      : [...lin.byId.values()]
          .filter(
            (row) =>
              row.display_number > from.display_number &&
              row.display_number < to.display_number &&
              row.id !== to.id,
          )
          .toSorted((x, y) => x.display_number - y.display_number);
  const onLine = steps.every((row) => lin.onLine.has(row.id));
  let status = `${num(from)} → ${num(to)} · ${steps.length} step${steps.length === 1 ? "" : "s"}${onLine ? " on the latest line" : ""}.`;
  const notes = new Map<string, string>();
  for (const [i, row] of excluded.entries()) {
    const parent = branchParent(lin, row);
    const line = lin.onLine.has(row.id);
    notes.set(
      row.id,
      line
        ? `Not included: not under ${num(to)}`
        : parent
          ? "Not included: a branch"
          : "Not included: a separate history",
    );
    if (i >= 2) continue;
    status += line
      ? ` ${num(row)} is on the latest line, not under ${num(to)}, so it isn't included.`
      : parent
        ? ` ${num(row)} is a branch off ${num(parent)}, so it isn't included.`
        : ` ${num(row)} is a separate history, so it isn't included.`;
  }
  const more = excluded.length - 2;
  if (more > 0)
    status +=
      more === 1 ? " 1 more revision isn't included." : ` ${more} more revisions aren't included.`;
  return {
    status,
    button,
    ready: true,
    from,
    to,
    inRange: new Set(steps.filter((row) => row.id !== to.id).map((row) => row.id)),
    notes,
  };
}

/**
 * The revisions below a History page that the client's lineage needs (NAV-10). The client builds
 * its lineage from the rendered rows; two of them can still build on a revision below the page
 * (a branch off an old revision), and without it they would read as separate histories. This is
 * the smallest tree that keeps every such answer: the shown rows' parents below the page, the
 * latest revision if it is below, and every revision where their histories meet, each with its
 * parent rewritten to the nearest kept ancestor. Steps, skipped revisions and row notes come from
 * the shown rows only (a range's revisions are numbered between its ends), so nothing else is
 * needed. Empty when nothing on the page builds on a revision below it.
 */
export function lineageBelow<R extends LineageRow>(
  lin: Lineage<R>,
  shown: readonly R[],
): LineageRow[] {
  const onPage = new Set(shown.map((row) => row.id));
  const seeds = new Set<string>();
  for (const row of shown) {
    const parent = row.parent_revision_id;
    if (parent !== null && !onPage.has(parent) && lin.byId.has(parent)) seeds.add(parent);
  }
  if (lin.latest && !onPage.has(lin.latest.id)) seeds.add(lin.latest.id);
  // Every revision below the page that a seed builds on, and which of them build on each.
  const below = new Set<string>();
  const kids = new Map<string, Set<string>>();
  for (const seed of seeds) {
    let child: string | null = null;
    for (const row of lin.ancestors(seed)) {
      if (onPage.has(row.id)) break;
      if (child !== null) kids.set(row.id, (kids.get(row.id) ?? new Set()).add(child));
      if (below.has(row.id)) break;
      below.add(row.id);
      child = row.id;
    }
  }
  const kept = new Set([...below].filter((id) => seeds.has(id) || (kids.get(id)?.size ?? 0) > 1));
  return [...kept].flatMap((id) => {
    const row = lin.byId.get(id);
    if (!row) return [];
    const parent = lin.ancestors(id).find((up) => up.id !== id && kept.has(up.id));
    return [
      {
        id,
        parent_revision_id: parent?.id ?? null,
        display_number: row.display_number,
        sync_state: row.sync_state,
      },
    ];
  });
}
/** `lineageBelow`'s rows as History's `data-below` attribute: `id:parent:n:state`, spaced. */
export function belowText(rows: readonly LineageRow[]): string {
  return rows
    .map((row) =>
      [row.id, row.parent_revision_id ?? "", row.display_number, row.sync_state].join(":"),
    )
    .join(" ");
}
/** Reads `belowText` back (the client adds these rows to the rendered ones). */
export function belowRows(text: string): LineageRow[] {
  return text.split(" ").flatMap((entry) => {
    const [id, parent, n, state] = entry.split(":");
    if (!id || parent === undefined || !n || !state) return [];
    return [
      {
        id,
        parent_revision_id: parent || null,
        display_number: Number(n),
        sync_state: state,
      },
    ];
  });
}
