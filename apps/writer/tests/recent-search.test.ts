// NAV-03: search results show the count as H1, one removable chip per active filter (built from
// FC3's parseSearch, each × a server-built link without that token), Clear all and one hint line;
// in:trash rows use the Trash variant; phones get an inline [data-search] field and the Browse row;
// the sidebar is Recent's, with "Show all N" past 12 projects.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CollectionSearchResult } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import type { Health } from "../src/health.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { parseSearch } from "../src/search-query.ts";
import type { Chrome } from "../src/viewer/layout.tsx";
import { BrowseAside, BrowseRow, type Facet } from "../src/viewer/pages/recent/home.tsx";
import { SearchBody } from "../src/viewer/pages/recent/search.tsx";

const NOW = Date.UTC(2026, 9, 13, 12);
const HOUR = 3_600_000;
const PUB = "w1h0m485bzm1";
const HINT =
  'Add a filter by typing <span class="mono">is:</span>, <span class="mono">project:</span> or <span class="mono">in:trash</span>.';

const health: Health = {
  state: "synced",
  label: "Synced",
  short: "Synced",
  aria: "Synced",
  failed: [],
  pending: [],
  stalled: [],
  waiting: [],
  collections: [],
  oldestPendingAt: null,
  lastPushAt: null,
  lastPullAt: null,
  cloudLastOkAt: null,
  cloudError: null,
  blockedReason: null,
  environment: "dev",
  syncEnabled: false,
};
const chrome: Chrome = {
  health,
  now: NOW,
  host: "writer.example.test",
  liveLinkCount: 0,
  pausedLinkCount: 0,
  trashCount: 0,
  trashedPending: [],
};

function result(overrides: Partial<CollectionSearchResult> = {}): CollectionSearchResult {
  return {
    id: "col_01jabcdefghjkmnpqrstvwxyz0",
    public_id: PUB,
    title: "HTTP API rate limiting plan",
    metadata: { project: "api" },
    created_at: NOW - 2 * HOUR,
    updated_at: NOW - HOUR,
    deleted: false,
    revision_count: 2,
    latest_revision: {
      id: "rev_01jabcdefghjkmnpqrstvwxyz0",
      display_number: 2,
      message: "Add staged rollout",
      created_at: NOW - HOUR,
      sync_state: "synced",
      head_path: "index.md",
      file_count: 1,
      changes: { added: 0, modified: 1, removed: 0 },
      source_host: "devbox",
    },
    latest_url: `/c/${PUB}/`,
    match: null,
    ...overrides,
  };
}

async function render(
  q: string,
  options: {
    items?: CollectionSearchResult[];
    nextCursor?: string | null;
    projects?: Facet[];
  } = {},
): Promise<string> {
  const parsed = parseSearch(q);
  return String(
    await SearchBody({
      chrome,
      q,
      parsed,
      items: options.items ?? [result()],
      nextCursor: options.nextCursor ?? null,
      freeText: parsed.text,
      trash: parsed.trash,
      projects: options.projects ?? [],
      publicNow: null,
    }),
  );
}

const decode = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ""));

interface Chip {
  cls: string;
  text: string;
  href: string;
  label: string;
}
function chips(markup: string): Chip[] {
  return [...markup.matchAll(/<li class="(fchip[^"]*)">([\s\S]*?)<\/li>/g)].map(
    ([, cls = "", body = ""]) => {
      const link = /<a href="([^"]*)" aria-label="([^"]*)">/.exec(body);
      return {
        cls,
        text: textOf(body),
        href: decode(link?.[1] ?? ""),
        label: decode(link?.[2] ?? ""),
      };
    },
  );
}
const without = (rest: string) => `/?${new URLSearchParams({ q: rest }).toString()}`;
/** The opening tag of the first element carrying `attr`. */
function tagWith(markup: string, attr: string): string {
  const at = markup.indexOf(attr);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}

describe("filter chips", () => {
  it("builds one chip per token from parseSearch, each removing only itself", async () => {
    const q = 'rate project:"api team" is:shared in:trash';
    expect(parseSearch(q).list.map((token) => token.raw)).toEqual([
      'project:"api team"',
      "is:shared",
      "in:trash",
    ]);
    const list = chips(await render(q));
    expect(list.map((chip) => chip.text)).toEqual([
      "“rate”",
      "Project api team",
      "Only Public",
      "Only In Trash",
    ]);
    expect(list.map((chip) => chip.href)).toEqual([
      without('project:"api team" is:shared in:trash'),
      without("rate is:shared in:trash"),
      without('rate project:"api team" in:trash'),
      without('rate project:"api team" is:shared'),
    ]);
    expect(list.map((chip) => chip.cls)).toEqual(["fchip", "fchip", "fchip pub", "fchip trash"]);
    expect(list.some((chip) => chip.text.includes("is:shared"))).toBe(false);
  });

  it("treats an unknown token as free text", async () => {
    expect(chips(await render("color:red"))).toEqual([
      { cls: "fchip", text: "“color:red”", href: "/", label: "Remove “color:red”" },
    ]);
  });

  it("names each × link and adds Clear all", async () => {
    const markup = await render("plan is:shared");
    expect(chips(markup)).toEqual([
      { cls: "fchip", text: "“plan”", href: "/?q=is%3Ashared", label: "Remove “plan”" },
      { cls: "fchip pub", text: "Only Public", href: "/?q=plan", label: "Remove Only Public" },
    ]);
    expect(markup).toContain('<ul class="list fchips" aria-label="Active filters">');
    expect(markup).toContain(
      '<li class="fchip pub"><span title="Only Public"><span class="k">Only</span> Public',
    );
    expect(markup).toContain('<a class="clear" href="/">Clear all</a>');
  });

  it.each([
    ["is:pending", "Only Uploading"],
    ["is:uploading", "Only Uploading"],
    ["is:failed", "Only Failed"],
    ["is:unsynced", "Only Not synced yet"],
    ["tag:x", "Tag x"],
    ["host:y", "Host y"],
    ['project:"api team"', "Project api team"],
  ])("labels %s as %s, and removing it goes to Recent", async (q, label) => {
    expect(chips(await render(q))).toEqual([
      { cls: "fchip", text: label, href: "/", label: `Remove ${label}` },
    ]);
  });
});

describe("the results header", () => {
  it.each([
    ["plan", [result(), result({ public_id: "p2p2p2p2p2p2" })], null, "2 collections"],
    ["plan", [result()], null, "1 collection"],
    ["plan", Array.from({ length: 50 }, () => result()), "next", "50+ collections"],
    ["in:trash", [result(), result({ public_id: "p2p2p2p2p2p2" })], null, "2 collections in Trash"],
    ["plan", [], null, "No collections match"],
  ])("%s with %#: %s", async (q, items, nextCursor, title) => {
    const markup = await render(q, { items, nextCursor });
    expect(markup).toContain(`<h1 class="page" id="results-title">${title}</h1>`);
    expect(markup).toContain('<main id="main" aria-labelledby="results-title">');
  });

  it("has one hint line and no token hint or old lede", async () => {
    const markup = await render("plan");
    expect(markup).not.toContain("data-token-hint");
    expect(markup).not.toContain("Narrow it down");
    expect(markup).not.toContain("Matched in titles");
    expect(markup).toContain(`<p class="hint">${HINT}</p>`);
    expect(textOf(HINT)).toBe("Add a filter by typing is:, project: or in:trash.");
  });

  it("still shows the chips, Clear all and the hint with no results, and no list", async () => {
    const markup = await render("zzzz", { items: [] });
    expect(chips(markup).map((chip) => chip.text)).toEqual(["“zzzz”"]);
    expect(markup).toContain(">Clear all</a>");
    expect(markup).toContain(HINT);
    expect(markup).not.toContain("data-groups");
    expect(markup).not.toContain("Clear filter");
  });

  it("highlights only the free text, not the tokens", async () => {
    const markup = await render("plan is:shared");
    expect(markup).toContain("<mark>plan</mark>");
    expect(markup).not.toContain("<mark>is:shared</mark>");
  });
});

describe("the inline search field", () => {
  it("is a [data-search] form with its own combobox, listbox and status", async () => {
    const markup = await render("plan");
    const start = markup.indexOf('<form class="qfield"');
    const form = markup.slice(start, markup.indexOf("</form>", start));
    expect(start).toBeGreaterThanOrEqual(0);
    const open = tagWith(form, 'class="qfield"');
    expect(open).toMatch(/\sdata-search[=\s>]/);
    expect(open).toMatch(/\sdata-search-inline[=\s>]/);
    expect(open).toContain('role="search"');
    expect(open).toContain('action="/"');
    const input = tagWith(form, "<input");
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-controls="suggest-inline"');
    expect(input).toContain('name="q"');
    expect(input).toContain('value="plan"');
    const list = tagWith(form, 'id="suggest-inline"');
    expect(list).toContain('role="listbox"');
    expect(list).toMatch(/\shidden[=\s>/]/);
    expect(form).toContain('role="status" data-search-status');
    expect(form).not.toContain('id="suggest"');
    // Field first, then the H1 (the phone mockup's order).
    expect(start).toBeLessThan(markup.indexOf("<h1"));
  });
});

describe("in:trash results", () => {
  it("use the Trash variant, opening the in-Trash page", async () => {
    const paused = await render("in:trash", {
      items: [result({ share: { active: 0, follows_latest: false, paused: 1 } })],
    });
    expect(paused).toContain(`<li class="item trash" data-pub="${PUB}"`);
    expect(paused).toContain('<p class="msg">In Trash. Open it in Trash to restore or purge.</p>');
    expect(tagWith(paused, 'class="tlink"')).toContain(`href="/c/${PUB}/"`);
    expect(paused).toContain('<span class="chip xs paused">In Trash · 1 link paused</span>');
    expect(paused).toContain('<span class="host">devbox</span>');

    const two = await render("in:trash", {
      items: [result({ share: { active: 0, follows_latest: false, paused: 2 } })],
    });
    expect(two).toContain(">In Trash · 2 links paused</span>");

    const active = await render("in:trash", {
      items: [result({ share: { active: 1, follows_latest: true } })],
    });
    const at = active.indexOf('<li class="item trash"');
    const row = active.slice(at, active.indexOf("</li>", at));
    expect(row).not.toBe("");
    expect(row).not.toContain("Public");
    expect(row).not.toContain("chip");
    expect(row).not.toContain("<button");
  });
});

const projects = (count: number): Facet[] =>
  Array.from({ length: count }, (_, index) => ({ value: `p${index}`, count: count - index }));

describe("BrowseAside", () => {
  it("lists 12 projects, then Show all N with the rest", async () => {
    const markup = String(await BrowseAside({ projects: projects(15), publicNow: null }));
    expect(markup.startsWith('<aside class="side hide-sm" aria-label="Browse">')).toBe(true);
    const start = markup.indexOf('<details class="more">');
    expect(start).toBeGreaterThan(0);
    const before = markup.slice(0, start);
    const inside = markup.slice(start, markup.indexOf("</details>"));
    expect([...before.matchAll(/<li><a class="facet"/g)]).toHaveLength(12);
    expect(inside).toContain("<summary>Show all 15</summary>");
    expect([...inside.matchAll(/<li><a class="facet" href="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "/?q=project%3Ap12",
      "/?q=project%3Ap13",
      "/?q=project%3Ap14",
    ]);
  });
  it("has no disclosure for 12 or fewer", async () => {
    const markup = String(await BrowseAside({ projects: projects(12), publicNow: null }));
    expect(markup).not.toContain("<details");
    expect([...markup.matchAll(/<li><a class="facet"/g)]).toHaveLength(12);
  });
});

/** Decoded hrefs of the project links (Browse chips and sidebar facets) in a rendered block. */
async function projectLinks(markup: unknown): Promise<string[]> {
  return [...String(await markup).matchAll(/<a class="(?:bchip|facet)" href="([^"]*)"/g)].map((m) =>
    decode(m[1] ?? ""),
  );
}

describe("BrowseRow", () => {
  const publicNow = [1, 2, 3].map((n) => ({ public_id: `pub${n}`, title: `T${n}`, links: n }));
  it("puts Public now first, then every project", async () => {
    const markup = String(await BrowseRow({ projects: projects(15), publicNow }));
    expect(markup.startsWith('<nav class="browse" aria-labelledby="browse-h">')).toBe(true);
    expect(markup).toContain('<h2 id="browse-h">Browse</h2>');
    const links = [...markup.matchAll(/<a class="([^"]*)" href="([^"]*)">([\s\S]*?)<\/a>/g)];
    expect(links[0]?.slice(1).map((part) => textOf(part ?? ""))).toEqual([
      "bchip pub",
      "/links",
      "Public now 3",
    ]);
    expect(links).toHaveLength(16);
    expect(textOf(links[1]?.[3] ?? "")).toBe("p0 15");
  });
  it("has no Public chip without Public now, and nothing at all without either", async () => {
    const markup = String(await BrowseRow({ projects: projects(2), publicNow: null }));
    expect(markup).not.toContain("/links");
    expect(markup).not.toContain("Public now");
    expect(String(await BrowseRow({ projects: projects(2), publicNow: [] }))).not.toContain(
      "Public now",
    );
    expect(await BrowseRow({ projects: [], publicNow: null })).toBeNull();
  });
  it("quotes a project name with whitespace, so the link searches the whole name", async () => {
    const spaced: Facet[] = [
      { value: "api team", count: 2 },
      { value: "web", count: 1 },
    ];
    const row = await projectLinks(BrowseRow({ projects: spaced, publicNow: null }));
    const side = await projectLinks(BrowseAside({ projects: spaced, publicNow: null }));
    expect(row).toEqual(["/?q=project%3A%22api+team%22", "/?q=project%3Aweb"]);
    expect(side).toEqual(row);
    const q = new URLSearchParams(row[0]?.slice(2)).get("q") ?? "";
    const parsed = parseSearch(q);
    expect(parsed.project).toBe("api team");
    expect(parsed.text).toBe("");
  });
});

describe("search pages", () => {
  let dir: string;
  let waypoint: Db;
  let queue: Db;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "waypoint-recent-search-test-"));
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
  async function create(title: string, project: string) {
    const bytes = new TextEncoder().encode(title);
    const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
    expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
      200,
    );
    const created = z.object({ collection_id: z.string(), latest_url: z.string() }).parse(
      await (
        await app.request("/api/collections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title,
            metadata: { project },
            files: [{ path: "index.md", hash }],
          }),
        })
      ).json(),
    );
    return { id: created.collection_id, pub: new URL(created.latest_url).pathname.split("/")[2] };
  }

  it("render the inline field and Recent's sidebar", async () => {
    await create("Quillwort plan", "botany");
    const html = await (await app.request("/?q=quillwort")).text();
    expect(html).toContain('<form class="qfield"');
    expect(html).toContain("<h2>Projects</h2>");
    expect(html).toContain('href="/?q=project%3Abotany"');
    expect(html).toContain('<h1 class="page" id="results-title">1 collection</h1>');
  });

  it("list collections in Trash on the Trash variant, linking to the in-Trash page", async () => {
    const trashed = await create("Leaked env", "ops");
    expect((await app.request(`/api/collections/${trashed.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    const html = await (await app.request(`/?q=${encodeURIComponent("in:trash")}`)).text();
    expect(html).toContain("1 collection in Trash");
    expect(html).toContain(`href="/c/${trashed.pub}/"`);
    expect(html).toContain('<li class="item trash"');
    expect(html).toContain(
      '<li class="fchip trash"><span title="Only In Trash"><span class="k">Only</span> In Trash',
    );
  });
});
