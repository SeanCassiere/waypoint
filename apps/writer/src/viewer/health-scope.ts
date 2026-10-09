// OW-10b: the health pill and its popover, scoped to the collection a page shows. Pure, no JSX:
// the scope arrives on `Health.scope` through withHealthScope in loadCollection, where the words
// come from (FC2's scopeFor) is what's wrong here and elsewhere, and every revision line uses
// OW-06b's words.
import {
  collectionHealth,
  scopeFor,
  type CollectionHealth,
  type Health,
  type HealthItem,
  type HealthScope,
  type RevisionHealth,
} from "../health.ts";
import { plural } from "./format.ts";
import { chipText, explainItem, stalledFor } from "./health-words.ts";
import type { Chrome } from "./layout.tsx";
import { makeLineage } from "./lineage.ts";

/** The chrome with the health scoped to one collection (a copy; the original is untouched). */
export function withHealthScope(chrome: Chrome, scope: HealthScope): Chrome {
  return { ...chrome, health: { ...chrome.health, scope } };
}

export interface PillModel {
  scope: "here" | "elsewhere" | "mixed" | null;
  tone: "failed" | "pending" | "off" | "ok" | "away";
  icon: "alert" | "clock" | "okcircle" | "dot";
  /** From 1100 px. */
  label: string;
  /** 761–1099 px (elsewhere only). */
  mid: string | null;
  /** Up to 760 px. */
  short: string;
  /** The aria-label; starts with `label`. */
  name: string;
}

const WRITER = "writer status";
const BOTH = "this collection and writer status";
const num = (item: HealthItem | undefined) => `#${item?.display_number ?? "?"}`;
/** The revision's number for one, the count for several. */
const oneOr = (items: readonly HealthItem[]) =>
  items.length === 1 ? num(items[0]) : `${items.length}`;

/** What the pill says: writer-wide on global pages and for writer-wide states, else scoped. */
export function pillModel(health: Health): PillModel {
  const scope = health.scope ? scopeFor(health, health.scope.collectionPub) : null;
  if (!scope) {
    const [tone, icon]: [PillModel["tone"], PillModel["icon"]] =
      health.state === "failed" || health.state === "blocked"
        ? ["failed", "alert"]
        : health.state === "stalled" || health.state === "uploading" || health.state === "offline"
          ? ["pending", "clock"]
          : health.state === "off"
            ? ["off", "dot"]
            : ["ok", "okcircle"];
    const label = health.label;
    return {
      scope,
      tone,
      icon,
      label,
      mid: null,
      short: health.short,
      name: `${label}: ${WRITER}`,
    };
  }
  const pub = health.scope?.collectionPub;
  const isHere = (item: HealthItem) => item.collection_public_id === pub;
  const failedHere = health.failed.filter(isHere);
  const stalledHere = health.stalled.filter(isHere);
  const fh = failedHere.length;
  const sh = stalledHere.length;
  const fa = health.failed.length - fh;
  const sa = health.stalled.length - sh;
  const f = fh + fa;
  if (scope === "elsewhere") {
    const failed = fa > 0;
    const n = failed ? fa : sa;
    const word = failed ? "failed" : "stalled";
    const label = `${n} ${word} elsewhere`;
    return {
      scope,
      tone: "away",
      icon: failed ? "alert" : "clock",
      label,
      mid: `${n} ${word}`,
      short: `${n}`,
      name: `${label}: ${WRITER}`,
    };
  }
  let label: string;
  let short: string;
  let failed: boolean;
  if (scope === "here") {
    failed = fh > 0;
    const items = failed ? failedHere : stalledHere;
    const word = failed ? "failed" : "stalled";
    label = items.length === 1 ? `${num(items[0])} ${word}` : `${items.length} ${word} here`;
    short = oneOr(items);
  } else if (fh > 0 && fa > 0) {
    failed = true;
    label = `${f} failed · ${fh} here`;
    // Decision d-1: the phone label is the total, so the name starts with it (A11Y-04).
    short = `${f}`;
  } else if (fh > 0) {
    // Failures only here, so a stall elsewhere: name it rather than hide it behind "· 1 here".
    failed = true;
    label = `${fh === 1 ? `${num(failedHere[0])} failed` : `${fh} failed here`} · ${sa} stalled elsewhere`;
    short = oneOr(failedHere);
  } else if (fa > 0) {
    failed = false;
    label = `${sh === 1 ? `${num(stalledHere[0])} stalled` : `${sh} stalled here`} · ${f} failed elsewhere`;
    short = oneOr(stalledHere);
  } else {
    failed = false;
    label = `${sa + sh} stalled · ${sh} here`;
    short = `${sa + sh}`;
  }
  return {
    scope,
    tone: failed ? "failed" : "pending",
    icon: failed ? "alert" : "clock",
    label,
    mid: null,
    short,
    name: `${label}: ${BOTH}`,
  };
}

/** A part of a popover row's second line: words, or a time the client keeps current. */
export type NotePart = string | { at: number; fmt: "ago" | "until" };
export interface PopRow {
  tone: "f" | "p" | "ok";
  icon: "alert" | "clock" | "okcircle";
  /** Elsewhere rows: the revision the collection title links to. */
  item?: HealthItem;
  /** The bold first line (after the linked title, when there is one). */
  head: string;
  note: NotePart[];
}

const TONE: Record<RevisionHealth, PopRow["tone"]> = {
  failed: "f",
  stalled: "p",
  uploading: "p",
  waiting: "p",
};
/** OW-06b's chip order: failed, stalled, uploading, waiting (newest first within each). */
const ORDER: Record<RevisionHealth, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };

/**
 * The line a queued revision is on, as Home's strip names it: "Latest line", "Branch off #4", or
 * "Separate branch"; null when nothing in the collection has a latest line (every revision
 * failed) or the revision isn't among its rows. The lineage rule is stripModel's.
 */
export function lineLabel(group: CollectionHealth | undefined, item: HealthItem): string | null {
  if (!group) return null;
  const l = makeLineage(group.rows);
  if (!l.latest || l.latest.sync_state === "failed" || !l.byId.has(item.id)) return null;
  if (l.onLine.has(item.id)) return "Latest line";
  const point = l.branchPoint(item.id);
  return point ? `Branch off #${point.display_number}` : "Separate branch";
}

const linksNote = (liveLinks: number | null): string =>
  liveLinks === null
    ? ""
    : liveLinks === 0
      ? "No public links."
      : `${plural(liveLinks, "live link")}.`;

/** This collection: each queued revision, then what other machines see; or that all is synced. */
export function hereRows(health: Health, now: number): PopRow[] {
  const scope = health.scope;
  if (!scope) return [];
  const group = collectionHealth(health, scope.collectionPub);
  const items = (group?.items ?? []).toSorted((a, b) => ORDER[a.sync] - ORDER[b.sync]);
  const numbers = new Map(group?.rows.map((row) => [row.id, row.display_number]));
  const rows = items.map((item): PopRow => {
    const parentN = item.parent_revision_id ? numbers.get(item.parent_revision_id) : undefined;
    const tone = TONE[item.sync];
    const icon = item.sync === "failed" ? "alert" : "clock";
    if (item.sync === "failed") {
      const what = explainItem(item, "failed", now).what;
      const first = what.slice(0, what.indexOf(". ") + 1) || what;
      const line = lineLabel(group, item);
      return {
        tone,
        icon,
        head: `${chipText(item.display_number, "failed")} to sync`,
        note: [line ? `${line}. ${first}` : first],
      };
    }
    if (item.sync === "stalled") {
      const next =
        item.next_attempt_at !== null && item.next_attempt_at > now ? item.next_attempt_at : null;
      return {
        tone,
        icon,
        head: chipText(item.display_number, "stalled"),
        note: [
          `No upload progress for ${stalledFor(item, now)}`,
          ...(next === null ? [] : [" · next try ", { at: next, fmt: "until" as const }]),
        ],
      };
    }
    if (item.sync === "waiting")
      return {
        tone,
        icon,
        head: chipText(item.display_number, "waiting", parentN),
        note: [explainItem(item, "waiting", now, parentN).what],
      };
    return {
      tone,
      icon,
      head: chipText(item.display_number, "uploading"),
      note: ["Started ", { at: item.first_attempt_at ?? item.created_at, fmt: "ago" }],
    };
  });
  const links = linksNote(scope.liveLinks);
  if (rows.length) {
    if (scope.newestSyncedN !== null)
      rows.push({
        tone: "ok",
        icon: "okcircle",
        head: `#${scope.newestSyncedN} synced`,
        note: [`Other machines see #${scope.newestSyncedN}.${links ? ` ${links}` : ""}`],
      });
    return rows;
  }
  if (scope.revisions === null)
    return [
      {
        tone: "ok",
        icon: "okcircle",
        head: "In Trash. Nothing of it is waiting to sync.",
        note: [],
      },
    ];
  const sees =
    scope.liveLinks !== null &&
    scope.liveLinks > 0 &&
    scope.newestSyncedN !== null &&
    scope.newestSyncedN === scope.latestN
      ? `Public links see #${scope.newestSyncedN}, the latest.`
      : scope.liveLinks === 0
        ? links
        : "";
  return [
    {
      tone: "ok",
      icon: "okcircle",
      head: `All ${plural(scope.revisions, "revision")} synced`,
      note: sees ? [sees] : [],
    },
  ];
}

/** Elsewhere rows shown before "+N more on Status". */
export const ELSEWHERE_ROWS = 3;

export interface ElsewhereModel {
  /** The failed, then the stalled revisions of other collections, newest first in each. */
  trouble: HealthItem[];
  /** Their failed ones: what the section's Retry acts on. */
  failed: HealthItem[];
  /** The rows: the first ELSEWHERE_ROWS of `trouble`, or one row saying what else is going on. */
  rows: PopRow[];
  /** Trouble items not shown. */
  more: number;
}

/** Elsewhere on this writer: one linked row per failed or stalled revision of another collection. */
export function elsewhereModel(health: Health, now: number): ElsewhereModel {
  const pub = health.scope?.collectionPub;
  const away = (item: HealthItem) => item.collection_public_id !== pub;
  const failed = health.failed.filter(away);
  const trouble = [...failed, ...health.stalled.filter(away)];
  const rows = trouble.slice(0, ELSEWHERE_ROWS).map((item): PopRow => {
    if (item.sync === "failed") {
      const group = health.collections.find((entry) => entry.collection_id === item.collection_id);
      const line = lineLabel(group, item);
      return {
        tone: "f",
        icon: "alert",
        item,
        head: chipText(item.display_number, "failed"),
        note: [line ? `${line} · readable here only` : "Readable here only"],
      };
    }
    return {
      tone: "p",
      icon: "clock",
      item,
      head: chipText(item.display_number, "stalled"),
      note: [`No upload progress for ${stalledFor(item, now)}`],
    };
  });
  if (!trouble.length) {
    const moving = health.pending.filter((item) => away(item) && item.sync !== "stalled").length;
    rows.push(
      moving
        ? {
            tone: "p",
            icon: "clock",
            head: `${plural(moving, "revision")} uploading elsewhere`,
            note: [],
          }
        : { tone: "ok", icon: "okcircle", head: "Everything else is synced", note: [] },
    );
  }
  return { trouble, failed, rows, more: Math.max(0, trouble.length - ELSEWHERE_ROWS) };
}

/** A Retry button's FD3 attributes: data-n for one revision, data-title for one collection. */
export function retryTarget(items: readonly HealthItem[]): {
  text: string;
  ids: string;
  n: number | undefined;
  title: string | undefined;
} {
  const first = items[0];
  const oneCollection = items.every((item) => item.collection_id === first?.collection_id);
  return {
    text: items.length === 1 ? `Retry ${num(first)}` : `Retry ${items.length} failed`,
    ids: items.map((item) => item.id).join(","),
    n: items.length === 1 ? (first?.display_number ?? undefined) : undefined,
    title: oneCollection ? (first?.collection_title ?? undefined) : undefined,
  };
}
