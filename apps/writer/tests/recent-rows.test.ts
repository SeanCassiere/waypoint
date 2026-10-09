// A11Y-04: one row contract for Recent, search and Trash. Rows render as <li> whose only link is
// the title, day groups as section > h2.day + ul.list, change markers as glyph plus hidden words.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CollectionSearchResult } from "@waypoint/core";
import { raw } from "hono/html";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import type { Health, HealthItem } from "../src/health.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { Chg } from "../src/viewer/components.tsx";
import { DayGroups, RecentRow, rowTitleId } from "../src/viewer/pages/recent/rows.tsx";
import { trashDayLabel } from "../src/viewer/timefmt.ts";

const NOW = Date.UTC(2026, 9, 13, 12); // Tuesday 13 Oct 2026, 12:00 UTC
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PUB = "w1h0m485bzm1";

function result(overrides: Partial<CollectionSearchResult> = {}): CollectionSearchResult {
  return {
    id: "col_01jabcdefghjkmnpqrstvwxyz0",
    public_id: PUB,
    title: "Webhook idempotency research",
    metadata: { project: "webhooks", tags: ["research"] },
    created_at: NOW - DAY,
    updated_at: NOW - HOUR,
    deleted: false,
    revision_count: 3,
    latest_revision: {
      id: "rev_01jabcdefghjkmnpqrstvwxyz0",
      display_number: 3,
      message: "Add implementation checklist",
      created_at: NOW - HOUR,
      sync_state: "synced",
      head_path: "index.md",
      file_count: 2,
      changes: { added: 1, modified: 0, removed: 0 },
      source_host: "devbox",
    },
    latest_url: `/c/${PUB}/`,
    match: null,
    ...overrides,
  };
}
async function html(node: unknown): Promise<string> {
  return String(await node);
}
/** The opening tag of the first element matching `tag` and containing `attr`. */
function openTag(markup: string, tag: string, attr = ""): string {
  return (
    [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))]
      .map(([match]) => match)
      .find((match) => match.includes(attr)) ?? ""
  );
}

describe("RecentRow, recent and search variants", () => {
  it("is an li whose only link is the title, named by its text", async () => {
    const row = await html(RecentRow({ variant: "recent", item: result(), now: NOW }));
    expect(row.startsWith('<li class="item"')).toBe(true);
    const links = [...row.matchAll(/<a\b[^>]*\bhref=/g)];
    expect(links).toHaveLength(1);
    const link = openTag(row, "a");
    expect(link).toContain('class="tlink"');
    expect(link).toContain(`id="it-${PUB}"`);
    expect(link).toContain(`href="/c/${PUB}/"`);
    expect(row).not.toContain("aria-labelledby");
    expect(row).not.toContain("aria-describedby");
    expect(openTag(row, "li")).toContain(`data-at="${NOW - HOUR}"`);
    expect(openTag(row, "li")).toContain('data-n="3"');
    expect(row).not.toContain("data-updated");
    expect(row).toContain('<p class="msg">Add implementation checklist</p>');
    expect(rowTitleId(PUB)).toBe(`it-${PUB}`);
  });
  it("ends the meta line with the hidden, href-less unread link slot (OW-08)", async () => {
    const row = await html(RecentRow({ variant: "recent", item: result(), now: NOW }));
    const slot = `<a class="rv-link" id="new-${PUB}" data-new="true" hidden=""></a>`;
    expect(row).toContain(`${slot}</p></li>`);
    expect(openTag(row, "a", "rv-link")).not.toContain("href");
    expect(row).not.toContain("more-new");
    const search = await html(
      RecentRow({ variant: "search", item: result(), now: NOW, query: "idempotency" }),
    );
    expect(search).not.toContain("rv-link");
    expect(search).not.toContain("more-new");
  });
  it("carries the latest revision's IDs only when its public ID is given (OW-08)", async () => {
    const withPub = await html(
      RecentRow({ variant: "recent", item: result(), now: NOW, latestPub: "r7kq2m9x4b1c" }),
    );
    expect(openTag(withPub, "li")).toContain('data-latest-id="rev_01jabcdefghjkmnpqrstvwxyz0"');
    expect(openTag(withPub, "li")).toContain('data-latest-pub="r7kq2m9x4b1c"');
    const without = await html(RecentRow({ variant: "recent", item: result(), now: NOW }));
    expect(openTag(without, "li")).not.toContain("data-latest-id");
    expect(openTag(without, "li")).not.toContain("data-latest-pub");
  });
  it("omits data-n when there is no revision yet", async () => {
    const row = await html(
      RecentRow({ variant: "recent", item: result({ latest_revision: null }), now: NOW }),
    );
    expect(openTag(row, "li")).not.toContain("data-n");
    expect(row).toContain('<p class="msg">No revision yet</p>');
  });
  it("marks the query inside the title link on search", async () => {
    const row = await html(
      RecentRow({ variant: "search", item: result(), now: NOW, query: "idempotency" }),
    );
    const link = row.slice(row.indexOf('<a class="tlink"'), row.indexOf("</a>") + 4);
    expect(link).toContain("<mark>idempotency</mark>");
  });
  it("names the queued revisions in its sync chips (OW-06b)", async () => {
    const item = result({ queue: { failed: 1, pending: 1 } });
    const queued = (n: number, sync: "failed" | "uploading"): HealthItem => ({
      id: `rev_${n}`,
      public_id: `pub${n}`,
      collection_id: item.id,
      collection_public_id: PUB,
      collection_title: item.title,
      display_number: n,
      message: null,
      created_at: NOW - n,
      last_error: null,
      error_kind: null,
      source_host: null,
      state: sync === "failed" ? "failed" : "pending",
      first_attempt_at: null,
      attempts: 0,
      next_attempt_at: null,
      parent_revision_id: null,
      parent_state: null,
      sync,
    });
    const items = [queued(5, "uploading"), queued(4, "failed")];
    const health: Health = {
      state: "failed",
      label: "1 failed",
      short: "1 failed",
      aria: "",
      failed: items.filter((entry) => entry.state === "failed"),
      pending: items.filter((entry) => entry.state === "pending"),
      stalled: [],
      waiting: [],
      collections: [
        {
          collection_id: item.id,
          collection_public_id: PUB,
          collection_title: item.title,
          items,
          rows: [],
          worst: "failed",
          project: null,
          attention: true,
          liveLinks: 0,
          followsLatest: false,
        },
      ],
      oldestPendingAt: null,
      lastPushAt: null,
      lastPullAt: null,
      cloudLastOkAt: null,
      cloudError: null,
      blockedReason: null,
      environment: "dev",
      syncEnabled: true,
    };
    const row = await html(RecentRow({ variant: "recent", item, now: NOW, health }));
    expect(row).toMatch(/<span class="chip xs failed">.*?#4 failed<\/span>/);
    expect(row).toMatch(/<span class="chip xs pending">.*?#5 uploading<\/span>/);
    expect(row).not.toContain("1 failed");
  });
});

describe("RecentRow, Trash variant", () => {
  const buttons = raw(
    `<button type="button" aria-describedby="${rowTitleId(PUB)}">Restore</button><button type="button" aria-describedby="${rowTitleId(PUB)}">Purge…</button>`,
  );
  it("links to the in-Trash page, with the actions in span.acts and no time", async () => {
    const row = await html(
      RecentRow({
        variant: "trash",
        pub: PUB,
        title: "Leaked .env",
        at: NOW - HOUR,
        flashTarget: "col_x",
        now: NOW,
        msg: "deleted 1 h ago",
        actions: buttons,
      }),
    );
    expect(openTag(row, "li")).toContain('class="item trash"');
    expect(openTag(row, "li")).toContain('data-flash-target="col_x"');
    expect(openTag(row, "a")).toContain(`href="/c/${PUB}/"`);
    expect(row).toMatch(/<span class="acts"><button[^>]*>Restore<\/button><button/);
    expect(row).not.toContain('class="when"');
    expect(row).not.toContain('class="rn"');
    expect(row).not.toContain('class="meta"');
  });
  it("shows the time and #n when asked, and no flash target unless given", async () => {
    const row = await html(
      RecentRow({
        variant: "trash",
        pub: PUB,
        title: "Leaked .env",
        at: NOW - HOUR,
        now: NOW,
        showWhen: true,
        n: 4,
        msg: "In Trash.",
        meta: "1 link",
      }),
    );
    expect(row).toContain('<span class="when"><time');
    expect(row).toContain('<span class="rn">#4</span>');
    expect(row).toContain('<p class="meta">1 link</p>');
    expect(row).not.toContain("data-flash-target");
    expect(row).not.toContain('class="acts"');
  });
});

const renderName = (item: { name: string }) => raw(`<li class="item">${item.name}</li>`);
describe("DayGroups", () => {
  const items = [
    { name: "a", at: NOW - HOUR },
    { name: "b", at: NOW - 2 * HOUR },
    { name: "c", at: NOW - DAY },
  ];
  it("renders one section per UTC day, in input order", async () => {
    const out = await html(
      DayGroups({ kind: "recent", items, at: (item) => item.at, now: NOW, render: renderName }),
    );
    expect(out.startsWith('<div class="groups" data-groups="recent">')).toBe(true);
    const sections = [...out.matchAll(/<section aria-labelledby="([^"]+)">/g)].map((m) => m[1]);
    expect(sections).toEqual(["recent-day-0", "recent-day-1"]);
    expect(out).toContain('<h2 class="day" id="recent-day-0">Today</h2><ul class="list">');
    expect(out).toContain('<h2 class="day" id="recent-day-1">Yesterday</h2><ul class="list">');
    expect(out.match(/<ul class="list">/g)).toHaveLength(2);
    expect([...out.matchAll(/<li class="item">(\w)<\/li>/g)].map((m) => m[1])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("labels Trash groups by the day they moved", async () => {
    const out = await html(
      DayGroups({ kind: "trash", items, at: (item) => item.at, now: NOW, render: renderName }),
    );
    expect(out).toContain('<h2 class="day" id="trash-day-0">In Trash · moved today</h2>');
    expect(out).toContain('<h2 class="day" id="trash-day-1">In Trash · moved yesterday</h2>');
  });
});

describe("trashDayLabel", () => {
  it.each([
    [NOW - HOUR, "In Trash · moved today"],
    [NOW - DAY, "In Trash · moved yesterday"],
    [NOW - 3 * DAY, "In Trash · moved Saturday"],
    [NOW - 10 * DAY, "In Trash · moved 3 Oct"],
  ])("%i → %s", (time, label) => {
    expect(trashDayLabel(time, NOW, true)).toBe(label);
  });
});

describe("Chg", () => {
  it("hides the glyphs and speaks the words", async () => {
    const out = await html(Chg({ changes: { added: 1, modified: 3, removed: 1 } }));
    expect(out).toContain('<span class="m" aria-hidden="true">~3</span>');
    expect(out).toContain('<span class="a" aria-hidden="true">+1</span>');
    expect(out).toContain('<span class="rm" aria-hidden="true">−1</span>');
    expect(out).toContain('<span class="vh">3 files changed</span>');
    expect(out).toContain('<span class="vh">1 file added</span>');
    expect(out).toContain('<span class="vh">1 file removed</span>');
    expect(out).toContain('title="1 added, 3 modified, 1 removed"');
  });
  it("uses the singular for one file", async () => {
    const out = await html(Chg({ changes: { added: 1, modified: 0, removed: 0 } }));
    expect(out).toContain('<span class="vh">1 file added</span>');
    expect(out).not.toContain('class="m"');
  });
});

describe("the Trash page", () => {
  let dir: string;
  let waypoint: Db;
  let queue: Db;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "waypoint-recent-rows-test-"));
    const config: Config = {
      environment: "dev",
      dataDir: dir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024 * 1024,
      sync: false,
    };
    const opened = await openDatabases(config);
    waypoint = opened.waypoint;
    queue = opened.queue;
    await migrate(waypoint, waypointMigrations);
    await migrate(queue, queueMigrations);
    await guardEnvironment(waypoint, opened.syncClient, "dev", false);
    const blobs = new BlobStore(dir, config.maxBlobBytes);
    const reads = new ReadModel(waypoint, queue, config.baseUrl);
    app = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
    });
  });
  afterEach(async () => {
    await waypoint.close();
    await queue.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("renders deleted collections on the Trash row variant", async () => {
    const bytes = new TextEncoder().encode("Hello");
    const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
    expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
      200,
    );
    const created = z.object({ collection_id: z.string(), latest_url: z.string() }).parse(
      await (
        await app.request("/api/collections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Trash me", files: [{ path: "index.md", hash }] }),
        })
      ).json(),
    );
    const pub = new URL(created.latest_url).pathname.split("/")[2] ?? "";
    expect(
      (await app.request(`/api/collections/${created.collection_id}`, { method: "DELETE" })).status,
    ).toBe(200);
    const page = await (await app.request("/trash")).text();
    const row = page.slice(page.indexOf('<li class="item trash"'), page.indexOf("</li>") + 5);
    expect(row).not.toBe("");
    expect(openTag(row, "li")).toContain(`data-pub="${pub}"`);
    expect(openTag(row, "li")).toContain(`data-flash-target="${created.collection_id}"`);
    expect(openTag(row, "a")).toContain(`href="/c/${pub}/"`);
    const restore = openTag(row, "button", 'data-action="restore"');
    const purge = openTag(row, "button", 'data-action="purge"');
    expect(restore).toContain(`aria-describedby="it-${pub}"`);
    expect(purge).toContain(`aria-describedby="it-${pub}"`);
    expect(restore).toContain('data-links="[]"');
    expect(row).toMatch(/>Restore…<\/button>/);
    expect(row).toMatch(/>Purge…<\/button>/);
    expect(row).not.toContain('<a class="chip');
    expect(row).not.toContain('class="chip');
    expect(page).toContain('<section aria-labelledby="trash-day-0">');
    expect(page).toContain(">In Trash · moved today</h2>");
  });
});
