// OW-06b: the sync-health words (pure), the revision lines strip, Home's Needs attention cards and
// the row chips, from hand-built FC2 CollectionHealth fixtures.
import type { SyncState } from "@waypoint/core";
import type { JSX } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";

import type {
  CollectionHealth,
  Health,
  HealthItem,
  HealthRevision,
  RevisionHealth,
} from "../src/health.ts";
import { LineStrip } from "../src/viewer/components.tsx";
import {
  causeLine,
  chipText,
  explainItem,
  itemWord,
  seesLine,
  stalledFor,
  stripModel,
  type ItemWord,
  type StripModel,
} from "../src/viewer/health-words.ts";
import { NeedsAttention, RowSyncChips } from "../src/viewer/pages/recent/attention.tsx";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const TITLE = "Postgres 17 upgrade runbook";

const rev = (n: number, parent: number | null, sync_state: SyncState): HealthRevision => ({
  id: `rev_${n}`,
  public_id: `pub${n}`,
  parent_revision_id: parent === null ? null : `rev_${parent}`,
  display_number: n,
  sync_state,
});
function queued(
  n: number,
  parent: number | null,
  sync: RevisionHealth,
  extra: Partial<HealthItem> = {},
): HealthItem {
  return {
    id: `rev_${n}`,
    public_id: `pub${n}`,
    collection_id: "col_pg",
    collection_public_id: "pgpub",
    collection_title: TITLE,
    display_number: n,
    message: `Revision ${n}`,
    created_at: NOW - 30 * MINUTE + n,
    last_error: null,
    error_kind: null,
    source_host: "devbox",
    state: sync === "failed" ? "failed" : "pending",
    first_attempt_at: null,
    attempts: 0,
    next_attempt_at: null,
    parent_revision_id: parent === null ? null : `rev_${parent}`,
    parent_state: null,
    sync,
    ...extra,
  };
}
const RANK: Record<RevisionHealth, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };
function group(
  rows: HealthRevision[],
  items: HealthItem[],
  extra: Partial<CollectionHealth> = {},
): CollectionHealth {
  const newest = items.toSorted((a, b) => b.created_at - a.created_at);
  const worst = newest.reduce<RevisionHealth>(
    (acc, item) => (RANK[item.sync] < RANK[acc] ? item.sync : acc),
    "waiting",
  );
  return {
    collection_id: items[0]?.collection_id ?? "col_pg",
    collection_public_id: items[0]?.collection_public_id ?? "pgpub",
    collection_title: items[0]?.collection_title ?? TITLE,
    items: newest,
    rows,
    worst,
    project: "infra",
    attention: worst === "failed" || worst === "stalled",
    liveLinks: 0,
    followsLatest: false,
    ...extra,
  };
}
/** The demo: #1–#5 synced, #6 failed on #4, #7 stalled on #5. */
const demoRows = (): HealthRevision[] => [
  rev(1, null, "synced"),
  rev(2, 1, "synced"),
  rev(3, 2, "synced"),
  rev(4, 3, "synced"),
  rev(5, 4, "synced"),
  rev(6, 4, "failed"),
  rev(7, 5, "pending"),
];
const failed6 = (extra: Partial<HealthItem> = {}) =>
  queued(6, 4, "failed", {
    attempts: 5,
    last_error: "R2 PUT blobs/sha256/9c/9c41… timed out",
    error_kind: "permanent",
    ...extra,
  });
const stalled7 = (extra: Partial<HealthItem> = {}) =>
  queued(7, 5, "stalled", { created_at: NOW - 24 * MINUTE, ...extra });
const demo = () => group(demoRows(), [failed6(), stalled7()]);
const numbers = (steps: { row: HealthRevision }[]) => steps.map((step) => step.row.display_number);

function healthOf(groups: CollectionHealth[], syncEnabled = true): Health {
  const items = groups.flatMap((entry) => entry.items);
  const pending = items.filter((item) => item.state === "pending");
  return {
    state: syncEnabled ? "failed" : "off",
    label: "",
    short: "",
    aria: "",
    failed: items.filter((item) => item.state === "failed"),
    pending,
    stalled: pending.filter((item) => item.sync === "stalled"),
    waiting: pending.filter((item) => item.sync === "waiting"),
    collections: groups,
    oldestPendingAt: null,
    lastPushAt: null,
    lastPullAt: null,
    cloudLastOkAt: null,
    cloudError: null,
    blockedReason: null,
    environment: "dev",
    syncEnabled,
  };
}
async function html(node: JSX.Element | null): Promise<string> {
  const value = await node;
  return value === null ? "" : value.toString();
}
const strip = (model: StripModel) => html(LineStrip({ model }));
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("stripModel and the words", () => {
  it("reads the demo: #5 synced → #7 stalled, a branch off #4 with #6 failed", async () => {
    const entry = demo();
    const model = stripModel(entry);
    expect(model.latest).toMatchObject({ latestN: 7, onN: 5, more: 0 });
    expect(model.latest?.synced?.row.display_number).toBe(5);
    expect(model.latest?.synced?.word).toBe("synced");
    expect(model.latest?.unsynced.map((step) => [step.row.display_number, step.word])).toEqual([
      [7, "stalled"],
    ]);
    expect(model.branches).toHaveLength(1);
    expect(model.branches[0]?.offN).toBe(4);
    expect(model.branches[0]?.steps.map((step) => [step.row.display_number, step.word])).toEqual([
      [6, "failed"],
    ]);
    expect(model.seesN).toBe(5);
    expect(model.syncing).toBe(true);
    expect(seesLine(model)).toBe("Other machines and public links see #5 (with a syncing note)");
    const cause = causeLine(entry, model, NOW);
    expect(cause).toContain("#6 stopped after 5 attempts: the bucket didn't accept a file.");
    expect(cause).toContain("#7 keeps retrying on its own.");
    expect(cause.indexOf("#6 stopped")).toBeLessThan(cause.indexOf("#7 keeps"));
    expect(
      cause.endsWith("No public links on this collection, so nothing public is affected."),
    ).toBe(true);

    const markup = await strip(model);
    expect(markup).toContain('<div class="lin2" role="group" aria-label="Revision lines">');
    expect(markup).toMatch(/<span class="sc ok"><svg[^>]*>.*?<\/svg>#5 synced<\/span>/);
    expect(markup).toMatch(/<span class="sc p"><svg[^>]*>.*?<\/svg>#7 stalled<\/span>/);
    expect(markup).toMatch(/<span class="sc f"><svg[^>]*>.*?<\/svg>#6 failed<\/span>/);
    expect(markup).toContain('<span class="q">latest, on #5</span>');
    expect(markup).toContain(
      '<span class="q2">Other machines and public links see #5 (with a syncing note)</span>',
    );
    expect(markup).toContain("Branch off #4");
    expect(markup).toContain('<span class="q">not in latest; nobody else sees it</span>');
    expect(markup).toContain('<span class="to" aria-hidden="true">');
    expect(markup).not.toContain("+");
  });

  it("calls a child of a pending revision waiting, never stalled", async () => {
    const entry = group(
      [...demoRows(), rev(8, 7, "pending")],
      [
        failed6(),
        stalled7(),
        queued(8, 7, "waiting", { created_at: NOW - 40 * MINUTE, parent_state: "pending" }),
      ],
    );
    const model = stripModel(entry);
    expect(model.latest?.unsynced.map((step) => [step.row.display_number, step.word])).toEqual([
      [7, "stalled"],
      [8, "waiting"],
    ]);
    expect(model.latest?.unsynced[1]?.waitingFor).toBe(7);
    const markup = await strip(model);
    expect(markup).toContain("#8 waiting for #7");
    expect(markup).not.toContain("#8 stalled");
    expect(markup).toMatch(/<span class="sc w">/);
    expect(causeLine(entry, model, NOW)).toContain("#8 waits for #7.");
  });

  it("words the public impact by the collection's live links", () => {
    // #7 removed: only #6, failed, is newer than #5.
    const rows = demoRows().filter((row) => row.display_number !== 7);
    const plain = group(rows, [failed6()]);
    const model = stripModel(plain);
    expect(model.syncing).toBe(false);
    expect(model.latest).toMatchObject({ latestN: 5, onN: 4, unsynced: [] });
    expect(seesLine(model)).toBe("Other machines and public links see #5");
    const following = group(rows, [failed6()], { liveLinks: 2, followsLatest: true });
    expect(
      causeLine(following, model, NOW).endsWith(
        "2 live links on this collection. Latest links show #5; #6 isn't public.",
      ),
    ).toBe(true);
    const syncing = group(demoRows(), [failed6(), stalled7()], {
      liveLinks: 2,
      followsLatest: true,
    });
    expect(
      causeLine(syncing, stripModel(syncing), NOW).endsWith(
        "2 live links on this collection. Latest links show #5 until #7 syncs.",
      ),
    ).toBe(true);
    const pinned = group(rows, [failed6()], { liveLinks: 1, followsLatest: false });
    expect(
      causeLine(pinned, model, NOW).endsWith(
        "1 live link on this collection, each pinned to one revision, so nothing public changes.",
      ),
    ).toBe(true);
  });

  it("says uploading for a revision just retried, and always the item's own word", () => {
    const retried = queued(6, 4, "uploading", {
      first_attempt_at: NOW,
      created_at: NOW - 3_600_000,
    });
    expect(itemWord(retried)).toBe("uploading");
    expect(chipText(retried.display_number, itemWord(retried))).toBe("#6 uploading");
    for (const sync of ["failed", "waiting", "stalled", "uploading"] as const)
      expect(itemWord(queued(9, null, sync))).toBe(sync);
    expect(chipText(8, "waiting", 7)).toBe("#8 waiting for #7");
    expect(chipText(8, "waiting")).toBe("#8 waiting");
    expect(chipText(7, "stalled")).toBe("#7 stalled");
  });

  it("has no latest line when every revision failed", async () => {
    const entry = group(
      [rev(1, null, "failed"), rev(2, 1, "failed")],
      [queued(1, null, "failed"), queued(2, 1, "failed")],
    );
    const model = stripModel(entry);
    expect(model.latest).toBeNull();
    expect(model.branches).toHaveLength(1);
    expect(model.branches[0]?.offN).toBeNull();
    expect(numbers(model.branches[0]?.steps ?? [])).toEqual([1, 2]);
    expect(seesLine(model)).toBe(
      "Nothing has synced yet, so other machines and public links see nothing",
    );
    const markup = await strip(model);
    expect(markup).not.toContain("Latest line");
    expect(markup).toContain('<span class="lk">Revisions</span>');
    expect(markup).toContain('<span class="q">nothing in this collection has synced</span>');
  });

  it("shows three fork points and counts the rest", async () => {
    // #1–#5 on the line; #6–#10 fork off #1–#5 one each and failed.
    const rows = [
      rev(1, null, "synced"),
      rev(2, 1, "synced"),
      rev(3, 2, "synced"),
      rev(4, 3, "synced"),
      rev(5, 4, "synced"),
      rev(11, 5, "synced"),
      ...[1, 2, 3, 4, 5].map((at) => rev(5 + at, at, "failed")),
    ].toSorted((a, b) => a.display_number - b.display_number);
    const entry = group(
      rows,
      [1, 2, 3, 4, 5].map((at) => queued(5 + at, at, "failed")),
    );
    const model = stripModel(entry);
    expect(model.branches.map((branch) => branch.offN)).toEqual([1, 2, 3]);
    expect(model.moreBranches).toBe(2);
    expect(await strip(model)).toContain("+2 more branches");
  });

  it("caps a branch at its three newest steps (the scale guard's shape)", async () => {
    const all = Array.from({ length: 300 }, (_, index) => index + 1);
    const entry = group(
      all.map((n) => rev(n, null, "failed")),
      all.map((n) => queued(n, null, "failed")),
    );
    const model = stripModel(entry);
    expect(model.latest).toBeNull();
    expect(model.branches).toHaveLength(1);
    expect(numbers(model.branches[0]?.steps ?? [])).toEqual([298, 299, 300]);
    expect(model.branches[0]?.more).toBe(297);
    const markup = await strip(model);
    expect(count(markup, 'class="sc ')).toBe(3);
    expect(markup).toContain("+297 more");
    expect(markup.indexOf("#298 failed")).toBeLessThan(markup.indexOf("#300 failed"));
    // A short branch has nothing more.
    const short = stripModel(demo());
    expect(short.branches[0]?.more).toBe(0);
    expect(await strip(short)).not.toContain("more");
  });

  it("keeps the newest unsynced steps on a long latest line, next to the latest label", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => rev(index + 1, index || null, "synced")),
      ...Array.from({ length: 5 }, (_, index) => rev(index + 6, index + 5, "pending")),
    ];
    const items = Array.from({ length: 5 }, (_, index) =>
      queued(index + 6, index + 5, index ? "waiting" : "uploading"),
    );
    const model = stripModel(group(rows, items));
    expect(numbers(model.latest?.synced ? [model.latest.synced] : [])).toEqual([5]);
    expect(numbers(model.latest?.unsynced ?? [])).toEqual([8, 9, 10]);
    expect(model.latest?.more).toBe(2);
    expect(model.latest?.latestN).toBe(10);
    expect(model.latest?.onN).toBe(9);
    const markup = await strip(model);
    const at = (needle: string) => markup.indexOf(needle);
    expect(at("#5 synced")).toBeLessThan(at("+2 more"));
    expect(at("+2 more")).toBeLessThan(at("#8 waiting for #7"));
    expect(at("#10 waiting for #9")).toBeLessThan(at("latest, on #9"));
    expect(markup).not.toContain("#6 uploading");
  });

  it("explains each revision without the word stuck", () => {
    const outputs: string[] = [];
    const bucket = explainItem(failed6(), "failed", NOW);
    expect(bucket).toEqual({
      what: "The bucket didn't accept a file after 5 attempts, so the writer stopped trying. #6 is readable on this writer only.",
      next: "Retry starts again from the first attempt. If it fails the same way, check the bucket credentials in the writer's env file.",
    });
    expect(explainItem(failed6({ attempts: 0 }), "failed", NOW).what).toBe(
      "The bucket didn't accept a file, so the writer stopped trying. #6 is readable on this writer only.",
    );
    const parent = explainItem(
      queued(8, 6, "failed", { last_error: "parent_failed" }),
      "failed",
      NOW,
    );
    expect(parent).toEqual({
      what: "Its parent failed, so it can't upload. #8 is readable on this writer only.",
      next: "Retry its parent; this revision is retried with it.",
    });
    const other = explainItem(queued(9, null, "failed", { last_error: "boom" }), "failed", NOW);
    expect(other.next).toBe("Retry starts again from the first attempt, or Drop removes it.");
    const stalled = stalled7({
      first_attempt_at: NOW - 65 * MINUTE,
      attempts: 3,
      next_attempt_at: NOW + 2 * MINUTE,
    });
    expect(stalledFor(stalled, NOW)).toBe("1 h 5 min");
    expect(stalledFor(stalled7(), NOW)).toBe("24 min");
    const explained = explainItem(stalled, "stalled", NOW);
    expect(explained).toEqual({
      what: "No upload progress for 1 h 5 min. The writer keeps trying on its own: attempt 3, next try in 2 min.",
      next: "Measured from the last attempt or Retry, not from when the agent published, so a revision you just retried is never “stalled”.",
    });
    expect(explainItem(stalled7(), "stalled", NOW).what).toBe(
      "No upload progress for 24 min. The writer keeps trying on its own.",
    );
    const waiting = explainItem(queued(8, 7, "waiting"), "waiting", NOW, 7);
    expect(waiting).toEqual({
      what: "Waits for #7, its parent, to upload first.",
      next: "Nothing to do: it uploads once #7 has.",
    });
    // A HealthItem doesn't carry its parent's number: the brief's three-argument call still
    // works and says "its parent" (standing ruling 4).
    // …and the function still has the brief's type: anything typed against it accepts it.
    const asBrief: (
      item: HealthItem,
      word: ItemWord,
      now: number,
    ) => { what: string; next: string } = explainItem;
    expect(asBrief(queued(8, 7, "waiting"), "waiting", NOW)).toEqual({
      what: "Waits for its parent to upload first.",
      next: "Nothing to do: it uploads once its parent has.",
    });
    outputs.push(
      ...Object.values(bucket),
      ...Object.values(parent),
      ...Object.values(other),
      ...Object.values(explained),
      ...Object.values(waiting),
      causeLine(demo(), stripModel(demo()), NOW),
      seesLine(stripModel(demo())),
    );
    for (const text of outputs) expect(text.toLowerCase()).not.toContain("stuck");
  });
});

/** A collection with one failed revision #n, named and numbered by `key`. */
const failing = (key: string, n = 6, extra: HealthItem[] = []) =>
  group(
    [rev(n - 1, null, "synced"), rev(n, n - 1, "failed")],
    [
      queued(n, n - 1, "failed", {
        collection_id: `col_${key}`,
        collection_public_id: `${key}pub`,
        collection_title: `Collection ${key}`,
      }),
      ...extra,
    ],
  );

describe("Home's Needs attention and the row chips", () => {
  it("shows three cards and sends the rest to Status", async () => {
    const markup = await html(
      NeedsAttention({
        health: healthOf(["a", "b", "c", "d"].map((key) => failing(key))),
        now: NOW,
      }),
    );
    expect(count(markup, '<div class="ag"')).toBe(3);
    expect(markup).toContain('<a href="/status">+1 more on Status</a>');
    expect(markup).toContain('Needs attention <span class="n">4 collections</span>');
  });

  it("names the one failed revision on Retry, and counts several", async () => {
    const one = await html(NeedsAttention({ health: healthOf([demo()]), now: NOW }));
    expect(one).toContain('data-attn-collection="pgpub"');
    expect(one).toContain(
      `data-action="retry" data-ids="rev_6" data-n="6" data-title="${TITLE}">Retry #6</button>`,
    );
    expect(one).toContain('href="/status#attn-pgpub"');
    expect(one).toContain('<span class="proj">infra</span>');
    expect(one).toContain('<div class="lin2" role="group" aria-label="Revision lines">');
    expect(one).toContain(
      '<p class="cause"><b>#6</b> stopped after 5 attempts: the bucket didn&#39;t accept a file.',
    );
    expect(one).not.toContain("stuck");
    const two = await html(
      NeedsAttention({
        health: healthOf([group(demoRows(), [failed6(), queued(7, 5, "failed")])]),
        now: NOW,
      }),
    );
    const button = /<button[^>]*data-action="retry"[^>]*>Retry 2 failed<\/button>/.exec(two)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('data-ids="rev_7,rev_6"');
    expect(button).toContain(`data-title="${TITLE}"`);
    expect(button).not.toContain("data-n");
  });

  it("shows a neutral note instead with sync off, and only when something is queued", async () => {
    const off = await html(NeedsAttention({ health: healthOf([demo()], false), now: NOW }));
    expect(off).toContain('<p class="attn off" role="note">');
    expect(off.replace(/<[^>]+>/g, "")).toBe(
      "Sync is off on this writer. Nothing is backed up or reaches other machines or public links. Revisions stay here. Status",
    );
    expect(off).not.toContain('class="ag"');
    expect(off).not.toContain("chip");
    expect(await html(NeedsAttention({ health: healthOf([], false), now: NOW }))).toBe("");
    expect(await html(NeedsAttention({ health: healthOf([]), now: NOW }))).toBe("");
  });

  it("chips name the revisions, worst first, two then +N", async () => {
    const entry = group(
      [],
      [
        queued(5, null, "failed", { created_at: NOW - 3 }),
        queued(6, null, "failed", { created_at: NOW - 2 }),
        queued(7, null, "stalled", { created_at: NOW - 1 }),
      ],
    );
    const chips = await html(RowSyncChips({ collectionId: "col_pg", health: healthOf([entry]) }));
    expect(count(chips, '<span class="chip xs failed">')).toBe(2);
    expect(chips).toMatch(/#6 failed<\/span>.*#5 failed<\/span>/);
    expect(chips).toContain('<span class="chip xs">+1</span>');
    expect(chips).not.toContain("#7 stalled");
    const stalled = await html(
      RowSyncChips({
        collectionId: "col_pg",
        health: healthOf([group([], [stalled7(), queued(8, 7, "waiting")])]),
      }),
    );
    expect(stalled).toMatch(/<span class="chip xs pending"><svg[^>]*>.*?<\/svg>#7 stalled<\/span>/);
    expect(stalled).toMatch(/<span class="chip xs waiting"><svg[^>]*>.*?<\/svg>#8 waiting<\/span>/);
    expect(
      await html(RowSyncChips({ collectionId: "col_pg", health: healthOf([entry], false) })),
    ).toBe("");
    expect(await html(RowSyncChips({ collectionId: "col_pg" }))).toBe("");
  });
});
