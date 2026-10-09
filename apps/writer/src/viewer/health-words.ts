// OW-06b: the words every sync-health surface uses (Home's Needs attention, Status, the row chips,
// the pill's popover). Pure, no JSX: the rule is FC2's `HealthItem.sync`, the lines are FD1's
// lineage, and everything here is computed per render, never stored.
import type { CollectionHealth, HealthItem, HealthRevision, RevisionHealth } from "../health.ts";
import { STALLED_AFTER_MS } from "../health.ts";
import { plural } from "./format.ts";
import { makeLineage } from "./lineage.ts";
import { formatTime } from "./timefmt.ts";

export type ItemWord = RevisionHealth;
export interface StripStep {
  row: HealthRevision;
  word: "synced" | ItemWord;
  /** The parent's number when `word` is waiting, else null. */
  waitingFor: number | null;
}
export interface StripModel {
  /** The latest line, or null when every revision failed (no latest). */
  latest: {
    /** The newest synced step on the line. */
    synced: StripStep | null;
    /**
     * Steps newer than `synced`, oldest first: the newest STRIP_STEPS of them, so the latest
     * revision is always shown next to its "latest" label.
     */
    unsynced: StripStep[];
    /** The older unsynced steps left out of `unsynced` (shown between `synced` and them). */
    more: number;
    latestN: number;
    onN: number | null;
  } | null;
  /** The newest synced revision: what Latest links serve. */
  seesN: number | null;
  /** RX-11's condition: a revision that isn't failed or synced is newer than `seesN`. */
  syncing: boolean;
  /** One per fork point (null: no fork point on the latest line), at most STRIP_BRANCHES. */
  branches: { offN: number | null; steps: StripStep[]; more: number }[];
  moreBranches: number;
}

/** Chips per line and lines per strip; the rest are counted as "+N more". */
const STRIP_STEPS = 3;
const STRIP_BRANCHES = 3;
const STALLED_MINUTES = STALLED_AFTER_MS / 60_000;

/** The word for one queued revision: FC2's rule (sync off already gives uploading). */
export function itemWord(item: HealthItem): ItemWord {
  return item.sync;
}

/** "#6 failed", "#7 stalled", "#8 waiting for #7" ("#8 waiting" without the parent's number). */
export function chipText(n: number | null, word: ItemWord, waitingFor?: number | null): string {
  const num = `#${n ?? "?"}`;
  if (word !== "waiting") return `${num} ${word}`;
  return waitingFor === null || waitingFor === undefined
    ? `${num} waiting`
    : `${num} waiting for #${waitingFor}`;
}

export function stripModel(group: CollectionHealth): StripModel {
  const l = makeLineage(group.rows);
  const queued = new Map(group.items.map((item) => [item.id, item]));
  const step = (row: HealthRevision): StripStep => {
    const word: StripStep["word"] =
      row.sync_state === "synced"
        ? "synced"
        : row.sync_state === "failed"
          ? "failed"
          : row.sync_state === "committed"
            ? "uploading"
            : (queued.get(row.id)?.sync ?? "uploading");
    const parent = row.parent_revision_id ? l.byId.get(row.parent_revision_id) : undefined;
    return { row, word, waitingFor: word === "waiting" ? (parent?.display_number ?? null) : null };
  };
  /** A branch line: its newest STRIP_STEPS rows in display order, the rest counted. */
  const branch = (offN: number | null, rows: readonly HealthRevision[]) => {
    const newest = rows.toSorted((a, b) => a.display_number - b.display_number).slice(-STRIP_STEPS);
    return { offN, steps: newest.map(step), more: rows.length - newest.length };
  };

  const seesN = group.rows.reduce<number | null>(
    (newest, row) =>
      row.sync_state === "synced" && (newest === null || row.display_number > newest)
        ? row.display_number
        : newest,
    null,
  );
  const syncing = group.rows.some(
    (row) =>
      row.sync_state !== "failed" &&
      row.sync_state !== "synced" &&
      (seesN === null || row.display_number > seesN),
  );

  const latestRow = l.latest;
  if (!latestRow || latestRow.sync_state === "failed") {
    // No latest: FD1 returned the newest failed row, so every row failed.
    return {
      latest: null,
      seesN,
      syncing,
      branches: group.rows.length ? [branch(null, group.rows)] : [],
      moreBranches: 0,
    };
  }

  const line = l.line.toReversed().map(step);
  const syncedAt = line.findLastIndex((entry) => entry.word === "synced");
  const newer = line.slice(syncedAt + 1);
  const unsynced = newer.slice(-STRIP_STEPS);
  const parent = latestRow.parent_revision_id
    ? l.byId.get(latestRow.parent_revision_id)
    : undefined;

  const forks = new Map<number | null, HealthRevision[]>();
  for (const row of group.rows) {
    if (l.onLine.has(row.id) || row.sync_state === "synced") continue;
    const offN = l.branchPoint(row.id)?.display_number ?? null;
    const list = forks.get(offN) ?? [];
    list.push(row);
    forks.set(offN, list);
  }
  const branches = [...forks]
    .toSorted(([a], [b]) => (a ?? -1) - (b ?? -1))
    .map(([offN, rows]) => branch(offN, rows));
  return {
    latest: {
      synced: syncedAt >= 0 ? (line[syncedAt] ?? null) : null,
      unsynced,
      more: newer.length - unsynced.length,
      latestN: latestRow.display_number,
      onN: parent?.display_number ?? null,
    },
    seesN,
    syncing,
    branches: branches.slice(0, STRIP_BRANCHES),
    moreBranches: Math.max(0, branches.length - STRIP_BRANCHES),
  };
}

/** What other machines and public links see (RX-11's syncing note when it applies). */
export function seesLine(model: StripModel): string {
  if (model.seesN === null)
    return "Nothing has synced yet, so other machines and public links see nothing";
  return model.syncing
    ? `Other machines and public links see #${model.seesN} (with a syncing note)`
    : `Other machines and public links see #${model.seesN}`;
}

type Cause = "bucket" | "parent" | "other";
function causeOf(item: HealthItem): Cause {
  const error = item.last_error ?? "";
  if (/parent_failed/.test(error)) return "parent";
  if (/bucket|R2|S3|PUT blobs|blob/i.test(error)) return "bucket";
  return "other";
}
const CAUSE_WORDS: Record<Cause, string> = {
  bucket: "the bucket didn't accept a file",
  parent: "its parent failed",
  other: "the upload failed",
};
const num = (item: HealthItem) => `#${item.display_number ?? "?"}`;
const nextTry = (item: HealthItem, now: number): string | null =>
  item.next_attempt_at !== null && item.next_attempt_at > now
    ? formatTime(item.next_attempt_at, "until", now, false)
    : null;
/** "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  return parts.length < 2
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}
const WORD_ORDER: Record<ItemWord, number> = { failed: 0, stalled: 1, waiting: 2, uploading: 3 };

/** Why the card is there and what it means publicly, as one paragraph (revisions in bold). */
export function causeLine(group: CollectionHealth, model: StripModel, now: number): string {
  const numbers = new Map(group.rows.map((row) => [row.id, row.display_number]));
  const affected = group.items
    .filter((item) => item.sync !== "uploading")
    .toSorted((a, b) => WORD_ORDER[a.sync] - WORD_ORDER[b.sync] || b.created_at - a.created_at);
  const sentences = affected.map((item) => {
    if (item.sync === "failed")
      return item.attempts > 0
        ? `${num(item)} stopped after ${plural(item.attempts, "attempt")}: ${CAUSE_WORDS[causeOf(item)]}.`
        : `${num(item)} failed: ${CAUSE_WORDS[causeOf(item)]}.`;
    if (item.sync === "stalled") {
      const next = nextTry(item, now);
      return `${num(item)} keeps retrying on its own.${next ? ` Next try ${next}.` : ""}`;
    }
    const parent = item.parent_revision_id ? numbers.get(item.parent_revision_id) : undefined;
    return `${num(item)} waits for ${parent === undefined ? "its parent" : `#${parent}`}.`;
  });
  const links = plural(group.liveLinks, "live link");
  const shows = model.seesN === null ? "nothing" : `#${model.seesN}`;
  let impact: string;
  if (group.liveLinks === 0)
    impact = "No public links on this collection, so nothing public is affected.";
  else if (!group.followsLatest)
    impact = `${links} on this collection, each pinned to one revision, so nothing public changes.`;
  else if (model.syncing)
    impact = `${links} on this collection. Latest links show ${shows} until #${model.latest?.latestN ?? "?"} syncs.`;
  else {
    const hidden = affected
      .filter((item) => item.sync === "failed" || item.sync === "stalled")
      .map(num);
    impact = `${links} on this collection. Latest links show ${shows}${
      hidden.length ? `; ${joinAnd(hidden)} ${hidden.length === 1 ? "isn't" : "aren't"} public` : ""
    }.`;
  }
  return [...sentences, impact].join(" ");
}

/** No progress for: "24 min", "1 h 5 min" (from the last attempt or Retry, else creation). */
export function stalledFor(item: HealthItem, now: number): string {
  const minutes = Math.max(
    1,
    Math.floor((now - (item.first_attempt_at ?? item.created_at)) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/**
 * One revision's explanation and next step, for Status. `parentN` names a waiting revision's
 * parent (the item doesn't carry its number); without it the words say "its parent".
 */
export function explainItem(
  item: HealthItem,
  word: ItemWord,
  now: number,
  parentN?: number | null,
): { what: string; next: string } {
  const n = num(item);
  if (word === "failed") {
    const cause = causeOf(item);
    if (cause === "parent")
      return {
        what: `Its parent failed, so it can't upload. ${n} is readable on this writer only.`,
        next: "Retry its parent; this revision is retried with it.",
      };
    const words = CAUSE_WORDS[cause];
    const attempts = item.attempts > 0 ? ` after ${plural(item.attempts, "attempt")}` : "";
    return {
      what: `${words.charAt(0).toUpperCase()}${words.slice(1)}${attempts}, so the writer stopped trying. ${n} is readable on this writer only.`,
      next:
        cause === "bucket"
          ? "Retry starts again from the first attempt. If it fails the same way, check the bucket credentials in the writer's env file."
          : "Retry starts again from the first attempt, or Drop removes it.",
    };
  }
  if (word === "stalled") {
    const next = nextTry(item, now);
    return {
      what: `No upload progress for ${stalledFor(item, now)}. The writer keeps trying on its own${
        item.attempts > 0 ? `: attempt ${item.attempts}` : ""
      }${next ? `, next try ${next}` : ""}.`,
      next: "Measured from the last attempt or Retry, not from when the agent published, so a revision you just retried is never “stalled”.",
    };
  }
  if (word === "waiting") {
    const parent = parentN === null || parentN === undefined ? null : `#${parentN}`;
    return parent
      ? {
          what: `Waits for ${parent}, its parent, to upload first.`,
          next: `Nothing to do: it uploads once ${parent} has.`,
        }
      : {
          what: "Waits for its parent to upload first.",
          next: "Nothing to do: it uploads once its parent has.",
        };
  }
  return {
    what: `Upload in progress${item.attempts > 0 ? `: attempt ${item.attempts}` : ""}.`,
    next: `Nothing to do: it counts as stalled only after ${STALLED_MINUTES} minutes without upload progress.`,
  };
}
