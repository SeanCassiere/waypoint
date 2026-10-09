// OW-10b: the scoped health pill (pillModel's table and its markup) and the scoped popover, from
// hand-built FC2/OW-06b Health fixtures. FC2's health.test.ts owns the scopeFor table.
import type { SyncState } from "@waypoint/core";
import type { JSX } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";

import type {
  CollectionHealth,
  Health,
  HealthItem,
  HealthRevision,
  HealthScope,
  HealthState,
  RevisionHealth,
} from "../src/health.ts";
import { HealthPill, HealthPopover } from "../src/viewer/components.tsx";
import { pillModel, withHealthScope } from "../src/viewer/health-scope.ts";
import type { Chrome } from "../src/viewer/layout.tsx";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const PG = { id: "col_pg", pub: "pgpub", title: "Postgres 17 upgrade runbook" };
const WH = { id: "col_wh", pub: "whpub", title: "Webhook idempotency research" };
const OPS = { id: "col_ops", pub: "opspub", title: "Ops notes" };
type Col = typeof PG;

const rev = (col: Col, n: number, parent: number | null, sync_state: SyncState) => ({
  id: `${col.id}_r${n}`,
  public_id: `${col.pub}r${n}`,
  parent_revision_id: parent === null ? null : `${col.id}_r${parent}`,
  display_number: n,
  sync_state,
});
function queued(
  col: Col,
  n: number,
  parent: number | null,
  sync: RevisionHealth,
  extra: Partial<HealthItem> = {},
): HealthItem {
  return {
    id: `${col.id}_r${n}`,
    public_id: `${col.pub}r${n}`,
    collection_id: col.id,
    collection_public_id: col.pub,
    collection_title: col.title,
    display_number: n,
    message: null,
    created_at: NOW - 30 * MINUTE + n,
    last_error: null,
    error_kind: null,
    source_host: "devbox",
    state: sync === "failed" ? "failed" : "pending",
    first_attempt_at: null,
    attempts: 0,
    next_attempt_at: null,
    parent_revision_id: parent === null ? null : `${col.id}_r${parent}`,
    parent_state: null,
    sync,
    ...extra,
  };
}
const failed = (col: Col, n: number, parent: number | null) =>
  queued(col, n, parent, "failed", {
    attempts: 5,
    last_error: "R2 PUT blobs/sha256/9c/9c41… timed out",
    error_kind: "permanent",
  });
const stalled = (col: Col, n: number, parent: number | null) =>
  queued(col, n, parent, "stalled", { created_at: NOW - 24 * MINUTE });
/** Postgres: #1–#5 synced, #6 failed on #4, #7 pending on #5. */
const pgRows = (): HealthRevision[] => [
  rev(PG, 1, null, "synced"),
  rev(PG, 2, 1, "synced"),
  rev(PG, 3, 2, "synced"),
  rev(PG, 4, 3, "synced"),
  rev(PG, 5, 4, "synced"),
  rev(PG, 6, 4, "failed"),
  rev(PG, 7, 5, "pending"),
];
const RANK: Record<RevisionHealth, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };
function group(rows: HealthRevision[], items: HealthItem[]): CollectionHealth {
  const newest = items.toSorted((a, b) => b.created_at - a.created_at);
  const worst = newest.reduce<RevisionHealth>(
    (acc, item) => (RANK[item.sync] < RANK[acc] ? item.sync : acc),
    "waiting",
  );
  const first = newest[0];
  return {
    collection_id: first?.collection_id ?? "",
    collection_public_id: first?.collection_public_id ?? null,
    collection_title: first?.collection_title ?? null,
    items: newest,
    rows,
    worst,
    project: null,
    attention: worst === "failed" || worst === "stalled",
    liveLinks: 0,
    followsLatest: false,
  };
}
/** A Health whose lists agree with its groups; `state` defaults to what getHealth would say. */
function healthOf(
  groups: CollectionHealth[],
  scope?: Partial<HealthScope> & { collectionPub: string },
  state?: HealthState,
): Health {
  const items = groups
    .flatMap((entry) => entry.items)
    .toSorted((a, b) => b.created_at - a.created_at);
  const pending = items.filter((item) => item.state === "pending");
  const failedItems = items.filter((item) => item.state === "failed");
  const stalledItems = pending.filter((item) => item.sync === "stalled");
  const resolved: HealthState =
    state ??
    (failedItems.length
      ? "failed"
      : stalledItems.length
        ? "stalled"
        : pending.length
          ? "uploading"
          : "synced");
  const label =
    resolved === "failed"
      ? `${failedItems.length} failed`
      : resolved === "stalled"
        ? `${stalledItems.length} stalled`
        : resolved === "uploading"
          ? "Uploading"
          : resolved === "offline"
            ? "Offline · writes queued"
            : resolved === "blocked"
              ? "Sync blocked"
              : resolved === "off"
                ? "Sync off"
                : "Synced";
  return {
    state: resolved,
    label,
    short: label.split(" · ")[0] ?? label,
    aria: "",
    failed: failedItems,
    pending,
    stalled: stalledItems,
    waiting: pending.filter((item) => item.sync === "waiting"),
    collections: groups,
    oldestPendingAt: null,
    lastPushAt: null,
    lastPullAt: null,
    cloudLastOkAt: NOW - 2 * MINUTE,
    cloudError: null,
    blockedReason: resolved === "blocked" ? "Environment mismatch" : null,
    environment: "dev",
    syncEnabled: resolved !== "off",
    ...(scope
      ? {
          scope: {
            revisions: 3,
            newestSyncedN: 3,
            latestN: 3,
            liveLinks: 1,
            ...scope,
          },
        }
      : {}),
  };
}
async function html(node: JSX.Element | null): Promise<string> {
  const value = await node;
  return value === null ? "" : value.toString();
}
/** The text of the markup with tags dropped and whitespace collapsed. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();

const pgDemo = () => group(pgRows(), [failed(PG, 6, 4), stalled(PG, 7, 5)]);
const pgOnlyFailed = () => group(pgRows(), [failed(PG, 6, 4)]);
const PG_SCOPE = {
  collectionPub: PG.pub,
  revisions: 7,
  newestSyncedN: 5,
  latestN: 7,
  liveLinks: 0,
};

describe("pillModel (OW-10b)", () => {
  const cases: [string, Health, Partial<ReturnType<typeof pillModel>>][] = [
    [
      "unscoped, one failed",
      healthOf([pgOnlyFailed()]),
      {
        scope: null,
        label: "1 failed",
        tone: "failed",
        icon: "alert",
        name: "1 failed: writer status",
      },
    ],
    [
      "here, one failed",
      healthOf([pgOnlyFailed()], { collectionPub: PG.pub }),
      {
        scope: "here",
        label: "#6 failed",
        short: "#6",
        mid: null,
        tone: "failed",
        icon: "alert",
        name: "#6 failed: this collection and writer status",
      },
    ],
    [
      "here, two failed",
      healthOf([group(pgRows(), [failed(PG, 6, 4), failed(PG, 7, 5)])], { collectionPub: PG.pub }),
      { scope: "here", label: "2 failed here", short: "2", tone: "failed" },
    ],
    [
      "here, one stalled only",
      healthOf([group(pgRows(), [stalled(PG, 7, 5)])], { collectionPub: PG.pub }),
      { scope: "here", label: "#7 stalled", short: "#7", tone: "pending", icon: "clock" },
    ],
    [
      "elsewhere, one failed",
      healthOf([pgOnlyFailed()], { collectionPub: WH.pub }),
      {
        scope: "elsewhere",
        label: "1 failed elsewhere",
        mid: "1 failed",
        short: "1",
        tone: "away",
        icon: "alert",
        name: "1 failed elsewhere: writer status",
      },
    ],
    [
      "elsewhere, a stall only",
      healthOf([group(pgRows(), [stalled(PG, 7, 5)])], { collectionPub: WH.pub }),
      { scope: "elsewhere", label: "1 stalled elsewhere", mid: "1 stalled", icon: "clock" },
    ],
    [
      "mixed, a failure here and one elsewhere",
      healthOf([pgOnlyFailed(), group([], [failed(OPS, 2, null)])], { collectionPub: PG.pub }),
      { scope: "mixed", label: "2 failed · 1 here", short: "2", tone: "failed", icon: "alert" },
    ],
    [
      "mixed, one failure here only and a stall elsewhere",
      healthOf([pgOnlyFailed(), group([], [stalled(OPS, 2, null)])], { collectionPub: PG.pub }),
      { scope: "mixed", label: "#6 failed · 1 stalled elsewhere", short: "#6", tone: "failed" },
    ],
    [
      "mixed, two failures here only and two stalls elsewhere",
      healthOf(
        [
          group(pgRows(), [failed(PG, 6, 4), failed(PG, 7, 5)]),
          group([], [stalled(OPS, 2, null), stalled(OPS, 3, null)]),
        ],
        { collectionPub: PG.pub },
      ),
      { scope: "mixed", label: "2 failed here · 2 stalled elsewhere", short: "2", tone: "failed" },
    ],
    [
      "mixed, a stall here and a failure elsewhere",
      healthOf([group(pgRows(), [stalled(PG, 7, 5)]), group([], [failed(OPS, 2, null)])], {
        collectionPub: PG.pub,
      }),
      {
        scope: "mixed",
        label: "#7 stalled · 1 failed elsewhere",
        short: "#7",
        tone: "pending",
        icon: "clock",
      },
    ],
    [
      "mixed, stalls only",
      healthOf([group(pgRows(), [stalled(PG, 7, 5)]), group([], [stalled(OPS, 2, null)])], {
        collectionPub: PG.pub,
      }),
      { scope: "mixed", label: "2 stalled · 1 here", short: "2", tone: "pending" },
    ],
    [
      "offline with a scope",
      healthOf([pgOnlyFailed()], { collectionPub: PG.pub }, "offline"),
      { scope: null, label: "Offline · writes queued", short: "Offline", tone: "pending" },
    ],
    [
      "blocked with a scope",
      healthOf([pgOnlyFailed()], { collectionPub: PG.pub }, "blocked"),
      { scope: null, label: "Sync blocked", tone: "failed", icon: "alert" },
    ],
    [
      "sync off with a scope",
      healthOf([pgOnlyFailed()], { collectionPub: PG.pub }, "off"),
      { scope: null, label: "Sync off", tone: "off", icon: "dot", name: "Sync off: writer status" },
    ],
    [
      "synced with a scope",
      healthOf([], { collectionPub: PG.pub }),
      { scope: null, label: "Synced", tone: "ok", icon: "okcircle", name: "Synced: writer status" },
    ],
  ];
  it.each(cases)("%s", (_name, health, expected) => {
    const model = pillModel(health);
    expect(model).toMatchObject(expected);
    expect(model.name.startsWith(`${model.label}: `)).toBe(true);
  });

  // Decision d-1 (A11Y-04, WCAG 2.5.3): the accessible name starts with whatever text is visible,
  // the phone label at ≤ 760 px and the long label (or the elsewhere pill's mid) above it.
  it.each(cases)("%s: the name starts with the visible text at every width", (_n, health) => {
    const model = pillModel(health);
    expect(model.name.startsWith(model.short)).toBe(true);
    expect(model.name.startsWith(model.label)).toBe(true);
    expect(model.name.startsWith(model.mid ?? model.label)).toBe(true);
  });
});

describe("withHealthScope", () => {
  it("copies the chrome and its health, never mutating them", () => {
    const health = healthOf([pgOnlyFailed()]);
    const chrome: Chrome = {
      health,
      now: NOW,
      host: "127.0.0.1",
      liveLinkCount: 0,
      pausedLinkCount: 0,
      trashCount: 0,
      trashedPending: [],
    };
    const scoped = withHealthScope(chrome, { ...PG_SCOPE });
    expect(scoped).not.toBe(chrome);
    expect(scoped.health).not.toBe(health);
    expect(scoped.health.scope).toEqual(PG_SCOPE);
    expect(health.scope).toBeUndefined();
    expect(scoped.health.failed).toBe(health.failed);
  });
});

describe("HealthPill (OW-10b)", () => {
  it("names the revision here, with a VS-03 icon and no dot", async () => {
    const pill = await html(HealthPill({ health: healthOf([pgOnlyFailed()], PG_SCOPE) }));
    expect(pill).toContain('class="health failed"');
    expect(pill).toContain('data-scope="here"');
    expect(pill).toContain('aria-label="#6 failed: this collection and writer status"');
    expect(pill).toContain('<span class="lbl">#6 failed</span>');
    expect(pill).toContain('<span class="short" aria-hidden="true">#6</span>');
    expect(pill).toContain("<svg");
    expect(pill).not.toContain('class="d"');
    expect(pill).not.toContain('class="d ring"');
  });
  it("is neutral with a ring elsewhere", async () => {
    const pill = await html(
      HealthPill({ health: healthOf([pgOnlyFailed()], { collectionPub: WH.pub }) }),
    );
    expect(pill).toContain('class="health away"');
    expect(pill).toContain('data-scope="elsewhere"');
    expect(pill).toContain('aria-label="1 failed elsewhere: writer status"');
    expect(pill).toContain('<span class="d ring" aria-hidden="true"></span>');
    expect(pill).toContain('<span class="lbl">1 failed elsewhere</span>');
    expect(pill).toContain('<span class="mid" aria-hidden="true">1 failed</span>');
    expect(pill).toContain('<span class="short" aria-hidden="true">1</span>');
  });
  it("is unscoped on global pages, named by its words", async () => {
    const pill = await html(HealthPill({ health: healthOf([pgOnlyFailed()]) }));
    expect(pill).not.toContain("data-scope");
    expect(pill).toContain('aria-label="1 failed: writer status"');
    expect(pill).not.toContain('class="short"');
    const mixed = await html(
      HealthPill({
        health: healthOf([pgOnlyFailed(), group([], [failed(OPS, 2, null)])], PG_SCOPE),
      }),
    );
    expect(mixed).toContain('data-scope="mixed"');
    expect(mixed).toContain('<span class="lbl">2 failed · 1 here</span>');
  });
});

const popover = (health: Health) => html(HealthPopover({ health, now: NOW, host: "127.0.0.1" }));
describe("HealthPopover (OW-10b)", () => {
  it("puts this collection's revisions first, then elsewhere, then the writer", async () => {
    const markup = await popover(healthOf([pgDemo()], PG_SCOPE));
    const here = markup.indexOf('<h3 id="hp-here">This collection</h3>');
    const away = markup.indexOf('<h3 id="hp-else">Elsewhere on this writer</h3>');
    expect(here).toBeGreaterThan(-1);
    expect(away).toBeGreaterThan(here);
    const words = text(markup);
    expect(words).toContain(
      "#6 failed to sync Branch off #4. The bucket didn't accept a file after 5 attempts, so the writer stopped trying.",
    );
    expect(words).toContain("#7 stalled No upload progress for 24 min");
    expect(words).toContain("#5 synced Other machines see #5. No public links.");
    expect(words.indexOf("#6 failed")).toBeLessThan(words.indexOf("#7 stalled"));
    expect(words.indexOf("#7 stalled")).toBeLessThan(words.indexOf("#5 synced"));
    expect(words).toContain("Everything else is synced");
    expect(markup).toMatch(
      new RegExp(
        `<button type="button" class="btn sm" popovertarget="health-pop" popovertargetaction="hide" data-action="retry" data-ids="col_pg_r6" data-n="6" data-title="${PG.title}">Retry #6</button>`,
      ),
    );
    expect(markup).toContain(
      '<a class="btn sm ghost" href="?panel=history" data-action="panel-tab" data-tab="history">History</a>',
    );
    // Nothing is in trouble elsewhere: no Open Status there.
    expect(markup.slice(away)).not.toContain(">Open Status<");
    expect(words).toContain("Last cloud sync 2 min ago · 127.0.0.1 · dev · Status");
    expect(words).not.toMatch(/stuck/i);
  });
  it("says this collection is synced and links the trouble elsewhere", async () => {
    const markup = await popover(healthOf([pgDemo()], { collectionPub: WH.pub }));
    const words = text(markup);
    expect(words).toContain("All 3 revisions synced Public links see #3, the latest.");
    expect(markup).toContain(`<a href="/c/${PG.pub}/r/${PG.pub}r6/">${PG.title}</a> #6 failed`);
    expect(words).toContain(`${PG.title} #6 failed Branch off #4 · readable here only`);
    expect(words).toContain(`${PG.title} #7 stalled No upload progress for 24 min`);
    expect(markup).toContain('<a class="btn sm" href="/status">Open Status</a>');
    expect(markup).toContain(`data-ids="col_pg_r6" data-n="6" data-title="${PG.title}">Retry #6<`);
    // Nothing failed here, so no Retry before the elsewhere section.
    expect(markup.slice(0, markup.indexOf('id="hp-else"'))).not.toContain('data-action="retry"');
  });
  it("retries several failures elsewhere without naming one revision or collection", async () => {
    const markup = await popover(
      healthOf([pgOnlyFailed(), group([], [failed(OPS, 2, null)])], { collectionPub: WH.pub }),
    );
    const retry = markup.slice(markup.indexOf('data-action="retry"') - 120);
    expect(retry).toMatch(/data-ids="[^"]+"\s*>Retry 2 failed</);
    const tag = retry.slice(0, retry.indexOf(">Retry 2 failed"));
    expect(tag).not.toContain("data-n=");
    expect(tag).not.toContain("data-title=");
  });
  it("names the collection for several failures elsewhere in one collection", async () => {
    const markup = await popover(
      healthOf([group(pgRows(), [failed(PG, 6, 4), failed(PG, 7, 5)])], { collectionPub: WH.pub }),
    );
    expect(markup).toContain(`data-title="${PG.title}">Retry 2 failed<`);
    expect(markup).not.toContain("data-n=");
  });
  it("shows at most three rows elsewhere, then a link to Status", async () => {
    const markup = await popover(
      healthOf(
        [
          group(
            [],
            [1, 2, 3, 4, 5].map((n) => failed(OPS, n, null)),
          ),
        ],
        { collectionPub: WH.pub },
      ),
    );
    expect(markup.split(`>${OPS.title}</a>`).length - 1).toBe(3);
    expect(markup).toContain('<a href="/status">+2 more on Status</a>');
  });
  it("says what uploads elsewhere when nothing there needs you", async () => {
    const markup = await popover(
      healthOf([group(pgRows(), [queued(PG, 7, 5, "uploading")])], { collectionPub: WH.pub }),
    );
    expect(text(markup)).toContain("1 revision uploading elsewhere");
  });
  it("on the in-Trash page, says nothing waits and has no History link", async () => {
    const markup = await popover(
      healthOf([pgOnlyFailed()], {
        collectionPub: WH.pub,
        revisions: null,
        newestSyncedN: null,
        latestN: null,
        liveLinks: null,
      }),
    );
    expect(text(markup)).toContain("In Trash. Nothing of it is waiting to sync.");
    expect(markup).not.toContain("?panel=history");
    const here = markup.slice(0, markup.indexOf('id="hp-else"'));
    expect(here).not.toContain('class="acts"');
  });
  it("names a waiting revision's parent and the uploading revision's start", async () => {
    const markup = await popover(
      healthOf(
        [
          group(
            [...pgRows(), rev(PG, 8, 7, "pending")],
            [
              queued(PG, 7, 5, "uploading", { first_attempt_at: NOW - 3 * MINUTE }),
              queued(PG, 8, 7, "waiting", { parent_state: "pending" }),
            ],
          ),
        ],
        PG_SCOPE,
      ),
    );
    const words = text(markup);
    expect(words).toContain("#7 uploading Started 3 min ago");
    expect(words).toContain("#8 waiting for #7 Waits for #7, its parent, to upload first.");
  });
  it("is OW-06b's popover on global pages", async () => {
    const markup = await popover(healthOf([pgDemo()]));
    expect(markup).not.toContain('class="hp"');
    expect(markup).toContain("Retry failed");
    expect(markup).toContain('<dl class="kv">');
  });
});
