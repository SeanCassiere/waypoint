// OW-04: the Links tab's cards (fixed two rows, Extend… on every open expiring link, a URL
// fingerprint, "No label"), its refresh keys, the within-a-day expiry in ink, and the status
// line's public segment naming a remaining pinned link.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashShareToken, mintRevisionId, newId, newShareToken, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import type { ShareView } from "../apps/writer/src/shares.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
import { viewerCssSource } from "../apps/writer/src/viewer/css.ts";
import { fingerprint, publicSegment } from "../apps/writer/src/viewer/pages/share.tsx";

const DAY = 86_400_000;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let collectionId: string;
let collectionPublicId: string;
let revisionId: string;
let hash: string;
/** A fixed test key (never a real one). */
const shareTokenKey = new Uint8Array(32).fill(42);

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
async function create(payload: object = {}): Promise<{ id: string; url: string }> {
  const response = await app.request(`/api/collections/${collectionId}/share-links`, json(payload));
  if (response.status !== 201) throw new Error(`Link failed: ${await response.text()}`);
  const value = await jsonOf(response);
  const link = value.share_link;
  const id = link && typeof link === "object" && "id" in link ? link.id : undefined;
  if (typeof id !== "string" || typeof value.url !== "string") throw new Error("No link");
  return { id, url: value.url };
}
/** Inserts a link the way writers did before D50: a random token's hash (no URL). */
async function legacyLink(): Promise<string> {
  const id = newId("shl");
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, await hashShareToken(newShareToken()), collectionId, null, "old", null, null, Date.now()],
  );
  return id;
}
/** The Links tab's panel HTML. */
async function linksTab(): Promise<{ page: string; tab: string }> {
  const page = await (await app.request(`/c/${collectionPublicId}/?panel=links`)).text();
  const start = page.indexOf('id="tp-links"');
  return { page, tab: page.slice(start, page.indexOf('class="pfoot"', start)) };
}
/** One card's HTML: from its opening tag to the next card, keyed node or the end of the tab. */
function card(tab: string, id: string): string {
  const at = tab.indexOf(`data-link="${id}"`);
  if (at < 0) throw new Error(`No card for ${id}`);
  const start = tab.lastIndexOf('<div class="lnk', at);
  const ends = ['<div class="lnk', "data-refresh="]
    .map((marker) => tab.indexOf(marker, at))
    .filter((index) => index > at);
  return tab.slice(start, ends.length ? Math.min(...ends) : undefined);
}
const tabCount = (page: string) =>
  /id="tab-links"[^>]*>Links<span class="n">(\d+)</.exec(page)?.[1];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-ow04-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://reader-dev.example.test",
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
  const blobs = new BlobStore(directory, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  const sync = new SyncLoop(queue, opened.syncClient, Date.now, waypoint);
  worker = new WriterCommitter(waypoint, queue, blobs, new MemoryBucket(), sync, ingest);
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey,
  });
  const bytes = new TextEncoder().encode("hello public");
  hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  if ((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status !== 200)
    throw new Error("Blob upload failed");
  const created = await app.request(
    "/api/collections",
    json({ title: "Shared test", files: [{ path: "index.txt", hash }] }),
  );
  if (created.status !== 200) throw new Error("Collection creation failed");
  const value = await jsonOf(created);
  if (typeof value.collection_id !== "string" || typeof value.revision_id !== "string")
    throw new Error("Invalid writer response");
  collectionId = value.collection_id;
  revisionId = value.revision_id;
  await worker.drain();
  const col = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [collectionId],
  );
  if (!col) throw new Error("Commit missing");
  collectionPublicId = col.public_id;
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

/**
 * A link that waits: pinned to a revision still in the queue. The committer is stopped first, so
 * the revision stays pending (a later revoke would otherwise wake it).
 */
async function waitingLink(label: string): Promise<{ id: string; url: string }> {
  worker.stop();
  await worker.drain();
  const id = mintRevisionId({ now: Date.now() });
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      id,
      await publicIdFor(id),
      collectionId,
      revisionId,
      "index.txt",
      null,
      "{}",
      JSON.stringify({
        headPath: "index.txt",
        files: { "index.txt": { hash, mime: "text/plain", size: 12 } },
      }),
      Date.now(),
    ],
  );
  return create({ label, revision_id: id, expires_at: Date.now() + 7 * DAY });
}

describe("OW-04 fingerprint", () => {
  it("shortens a share URL to its token and collection prefixes", () => {
    expect(fingerprint("https://r.example/s/wps_LfqvABCDEF/c/w1h0m485bzm1/r/e2kq…/")).toBe(
      "…/s/wps_Lfqv…/c/w1h0…",
    );
    expect(fingerprint("https://r.example/c/w1h0m485bzm1/")).toBeNull();
    expect(fingerprint("https://example.com/")).toBeNull();
  });
});

describe("OW-04 Links tab cards", () => {
  it("fingerprints every open card with a URL and offers Revoke…; a legacy link has none", async () => {
    const live = await create({ label: "Live one", expires_at: Date.now() + 7 * DAY });
    const legacy = await legacyLink();
    const waiting = await waitingLink("Waiting one");
    const { tab } = await linksTab();
    for (const link of [live, waiting]) {
      const html = card(tab, link.id);
      const fp = fingerprint(link.url);
      expect(fp).toMatch(/^…\/s\/wps_.{4}…\/c\/.{4}…$/);
      // hono writes boolean attributes as ="true".
      expect(html).toContain(`<code class="fp" data-fp="true">${fp}</code>`);
      expect(html).toContain('<summary class="txtbtn danger">Revoke…</summary>');
    }
    expect(card(tab, waiting.id)).toContain('data-link-status="waiting"');
    const old = card(tab, legacy);
    expect(old).not.toContain('class="fp"');
    expect(old).toContain("URL unavailable");
    // Row 1 (Copy URL · Open, or the missing-URL chip), then row 2 (Extend…, Revoke…).
    const html = card(tab, live.id);
    expect(html.indexOf('class="row r1"')).toBeLessThan(html.indexOf("Copy URL"));
    expect(html.indexOf("Copy URL")).toBeLessThan(html.indexOf('class="row r2"'));
    expect(html.indexOf('class="row r2"')).toBeLessThan(html.indexOf("Extend…"));
    expect(html.indexOf("Extend…")).toBeLessThan(html.indexOf("Revoke…"));
  });
  it("offers Extend… on every open expiring link, never on a never-expiring or dead one", async () => {
    const week = await create({ label: "Week", expires_at: Date.now() + 7 * DAY });
    const never = await create({ label: "Never", expires_at: null });
    const revoked = await create({ label: "Revoked", expires_at: Date.now() + 7 * DAY });
    expect((await app.request(`/api/share-links/${revoked.id}/revoke`, json({}))).status).toBe(200);
    const expired = await create({ label: "Expired", expires_at: Date.now() + 7 * DAY });
    await waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [
      Date.now() - DAY,
      expired.id,
    ]);
    const waiting = await waitingLink("Waiting");
    const { tab } = await linksTab();
    expect(card(tab, week.id)).toContain('data-action="extend-link"');
    expect(card(tab, waiting.id)).toContain('data-action="extend-link"');
    expect(card(tab, never.id)).not.toContain('data-action="extend-link"');
    expect(card(tab, never.id)).toContain('data-action="revoke-link"');
    for (const dead of [revoked, expired]) {
      expect(card(tab, dead.id)).toContain('class="lnk dead"');
      expect(card(tab, dead.id)).not.toContain('data-action="extend-link"');
      expect(card(tab, dead.id)).not.toContain('data-action="revoke-link"');
    }
  });
  it("names unlabelled cards No label", async () => {
    const unlabelled = await create({ expires_at: Date.now() + 7 * DAY });
    const { tab } = await linksTab();
    expect(card(tab, unlabelled.id)).toContain('<i data-link-label="true">No label</i>');
    expect(tab).not.toContain("(no label)");
  });
  it("shows an expiry within a day in ink at 600, never amber", async () => {
    const soon = await create({ label: "Soon", expires_at: Date.now() + 2 * 3_600_000 });
    const week = await create({ label: "Week", expires_at: Date.now() + 7 * DAY });
    const { tab } = await linksTab();
    expect(card(tab, soon.id)).toContain('<dd class="soon">');
    expect(card(tab, week.id)).not.toContain('class="soon"');
    const rules = [...viewerCssSource().matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
      ([, selector]) => selector?.includes(".lnk .soon") || selector?.includes(".r .soon"),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , declarations] of rules) {
      expect(declarations).toContain("var(--ink)");
      expect(declarations).not.toContain("--pending");
    }
  });
});

describe("OW-04 refresh keys and counts", () => {
  it("keys the footer, inactive list and empty note, and counts live links only", async () => {
    const first = await create({ label: "First", expires_at: Date.now() + 7 * DAY });
    let { page, tab } = await linksTab();
    expect(tab).not.toContain("data-refresh=");
    expect(tabCount(page)).toBe("1");
    const second = await waitingLink("Second");
    ({ page, tab } = await linksTab());
    // Two open cards (one live, one waiting): Revoke all counts both; the tab counts the live one.
    expect(tab).toContain('<div class="lnk-foot" data-refresh="links-foot">');
    expect(tab).toContain("Revoke all 2 links…");
    expect(tabCount(page)).toBe("1");
    expect(tab).not.toContain('data-refresh="links-inactive"');
    expect(tab).not.toContain('data-refresh="links-empty"');
    expect((await app.request(`/api/share-links/${first.id}/revoke`, json({}))).status).toBe(200);
    ({ page, tab } = await linksTab());
    expect(tab).toContain('<details class="inactive" data-refresh="links-inactive">');
    expect(tab).toContain("Show 1 inactive");
    expect(tab).not.toContain('data-refresh="links-foot"');
    expect(tab).not.toContain('data-refresh="links-empty"');
    expect(tabCount(page)).toBe("0");
    // No open card left: the empty note, keyed.
    expect((await app.request(`/api/share-links/${second.id}/revoke`, json({}))).status).toBe(200);
    ({ page, tab } = await linksTab());
    expect(tab).toContain(
      '<p class="legend" data-refresh="links-empty">No live links. Create one with Share.</p>',
    );
    expect(tab).toContain("Show 2 inactive");
    expect(tab).not.toContain('data-refresh="links-foot"');
    expect(tabCount(page)).toBe("0");
  });
});

/** A hand-built view: live ("active") unless told otherwise; pinned to #pinned, or Latest. */
const view = (
  id: string,
  label: string | null,
  pinned: number | null,
  status: ShareView["status"] = "active",
): ShareView => ({
  id,
  collection_id: "col",
  revision_id: pinned === null ? null : `rev${pinned}`,
  label,
  expires_at: null,
  revoked_at: status === "revoked" ? 1 : null,
  created_at: 1,
  mode: pinned === null ? "latest" : "pinned",
  status,
  publicly_available: status === "active",
  state: status === "revoked" ? "revoked" : "active",
  revocation_pushed: status === "revoked" ? true : null,
  revision_display_number: pinned,
  public_sees: null,
  url: null,
  collection: { id: "col", public_id: "pub", title: "Shared", deleted: false },
});
/** The segment's body as HTML: hono's JSX nodes render through toString() (sync here). */
function bodyHtml(segment: ReturnType<typeof publicSegment>): string {
  const body: unknown = segment?.body;
  return String(body);
}

describe("OW-04 publicSegment", () => {
  it("names the one pinned link when nothing follows latest", () => {
    const segment = publicSegment([view("a", "Priya", 1)]);
    expect(segment?.text).toBe(
      "Public: 1 live link. “Priya” shows only #1; new revisions stay private.",
    );
    expect(segment?.brief).toBe("Public: “Priya” shows only #1");
    expect(bodyHtml(segment)).toContain("<b>“Priya” shows only #1</b>");
    expect(publicSegment([view("a", null, 4)])?.text).toBe(
      "Public: 1 live link. A link shows only #4; new revisions stay private.",
    );
  });
  it("says which link follows latest, counting live links", () => {
    const segment = publicSegment([view("a", "Sam", null), view("b", "Priya", 1)]);
    expect(segment?.text).toContain("2 live links. ");
    expect(segment?.text).toContain("“Sam” follows latest");
    expect(bodyHtml(segment)).toContain("<b>“Sam” follows latest</b>");
  });
  it("counts several pinned links", () => {
    const segment = publicSegment([view("a", "Priya", 1), view("b", "Ana", 2)]);
    expect(segment?.text).toBe(
      "Public: 2 live links, each pinned to one revision; new revisions stay private.",
    );
    expect(segment?.brief).toBe("Public: 2 pinned links");
  });
  it("follows the remaining links once the following one is revoked, and ignores waiting ones", () => {
    const segment = publicSegment([view("a", "Sam", null, "revoked"), view("b", "Priya", 3)]);
    expect(segment?.text).toBe(
      "Public: 1 live link. “Priya” shows only #3; new revisions stay private.",
    );
    expect(
      publicSegment([view("a", "Sam", null, "waiting"), view("b", "Priya", 3, "waiting")]),
    ).toBeNull();
  });
});
