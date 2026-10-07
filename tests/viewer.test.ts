import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.js";
import { MemoryBucket } from "../apps/writer/src/bucket.js";
import { WriterCommitter } from "../apps/writer/src/committer.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, type Db } from "../apps/writer/src/db.js";
import { getHealth } from "../apps/writer/src/health.js";
import { createApp, type HttpServices } from "../apps/writer/src/http.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";
import { pathFromRaw, rawPath, shellPath } from "../apps/writer/src/viewer-paths.js";
import { newId, mintRevisionId, publicIdFor } from "../packages/core/src/index.js";

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
let services: HttpServices;
let first: { collection_id: string; revision_id: string; url: string; latest_url: string };
let second: typeof first;
function writeResult(value: unknown): typeof first {
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("revision_id" in value) ||
    !("url" in value) ||
    !("latest_url" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.revision_id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.latest_url !== "string"
  )
    throw new Error("Invalid write result");
  return {
    collection_id: value.collection_id,
    revision_id: value.revision_id,
    url: value.url,
    latest_url: value.latest_url,
  };
}
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string): Promise<{ path: string; hash: string }> {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return { path, hash };
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-viewer-test-"));
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
  services = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  };
  app = createApp(services);
  first = writeResult(
    await (
      await app.request(
        "/api/collections",
        json({
          title: "<script>alert(1)</script> Alpha",
          files: [
            await upload("index.md", "Hello"),
            await upload("notes/b.md", "[Home](../index.md)"),
          ],
        }),
      )
    ).json(),
  );
  second = writeResult(
    await (
      await app.request(
        `/api/collections/${first.collection_id}/revisions`,
        json({
          message: "Second",
          parent_revision_id: first.revision_id,
          files: [await upload("notes/b.md", "Updated")],
        }),
      )
    ).json(),
  );
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

async function seedPendingCollection(
  title: string,
  createdAt: number,
  deleted = false,
): Promise<{ id: string; publicId: string; revisionId: string }> {
  const id = newId("col");
  const publicId = await publicIdFor(id);
  const revisionId = mintRevisionId({ now: createdAt });
  const revisionPublicId = await publicIdFor(revisionId);
  await queue.run(
    "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,?)",
    [id, publicId, title, "{}", createdAt, deleted ? createdAt : null],
  );
  const manifest = JSON.stringify({
    headPath: "index.md",
    files: { "index.md": { hash: "sha256:" + "0".repeat(64), mime: "text/markdown", size: 1 } },
  });
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      revisionId,
      revisionPublicId,
      id,
      null,
      "index.md",
      null,
      "{}",
      manifest,
      createdAt,
      "pending",
    ],
  );
  return { id, publicId, revisionId };
}
describe("viewer routes", () => {
  it("shows a More link with the next search cursor", async () => {
    const search = vi
      .spyOn(services.reads, "searchCollections")
      .mockResolvedValue({ collections: [], next_cursor: "next-page" });
    const html = await (await app.request("/?q=plan")).text();
    expect(html).toContain("More");
    expect(html).toContain("q=plan&amp;cursor=next-page");
    search.mockRestore();
  });
  it("lists newest collections, searches titles, and escapes title markup", async () => {
    await app.request(
      "/api/collections",
      json({ title: "Newest", files: [await upload("index.md", "New")] }),
    );
    const list = await app.request("/");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const html = await list.text();
    expect(html).toContain("#2");
    const stylesheet = /<link rel="stylesheet" href="(\/assets\/viewer\/[0-9a-f]{16}\.css)"/.exec(
      html,
    )?.[1];
    expect(stylesheet).toBeTruthy();
    const css = await app.request(stylesheet ?? "");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toContain("immutable");
    expect(await css.text()).toContain("prefers-color-scheme");
    expect(html).toContain('rel="icon"');
    expect(html).toContain('<span class="m">~1</span>');
    expect(html.indexOf("Newest")).toBeLessThan(html.indexOf("Alpha"));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(await (await app.request("/?q=absent")).text()).toContain("No collections match");
    expect(await (await app.request("/?q=alpha")).text()).toContain("<mark>Alpha</mark>");
  });
  it("shows latest and pinned shells with pinned raw frames and nested paths", async () => {
    const latest = new URL(first.latest_url).pathname;
    const pinned = new URL(first.url).pathname;
    const rpub = pinned.split("/r/")[1]?.split("/")[0];
    expect(rpub).toBeTruthy();
    const latestHtml = await (await app.request(latest)).text();
    expect(latestHtml).toContain(
      `/raw/r/${new URL(second.url).pathname.split("/r/")[1]?.split("/")[0]}/index.md`,
    );
    expect(latestHtml).toContain("#1");
    expect(latestHtml).toContain("#2");
    expect(latestHtml).toContain("Second");
    expect(latestHtml).toContain("pending");
    expect(latestHtml).not.toContain("failed to sync");
    const pinnedHtml = await (await app.request(`${pinned}notes/b.md`)).text();
    expect(pinnedHtml).toContain(`/raw/r/${rpub}/notes/b.md`);
    expect(pinnedHtml).toContain('data-file="notes/b.md"');
    expect((await app.request(`${latest}missing.md`)).status).toBe(404);
    expect((await app.request("/c/doesnotexist/")).status).toBe(404);
    expect((await app.request(`${latest}r/doesnotexist/`)).status).toBe(404);
  });
  it("shows trash and failure status including kind and fork marker", async () => {
    const fork = writeResult(
      await (
        await app.request(
          `/api/collections/${first.collection_id}/revisions`,
          json({
            message: "Fork",
            parent_revision_id: first.revision_id,
            files: [await upload("fork.md", "Forked")],
          }),
        )
      ).json(),
    );
    await queue.run(
      "UPDATE pending_revisions SET state='failed',last_error='Upload failed',error_kind='permanent' WHERE id=?",
      [fork.revision_id],
    );
    const shell = await (await app.request(new URL(first.latest_url).pathname)).text();
    expect(shell).toContain("fork");
    expect(shell).toContain("failed");
    const status = await app.request("/status");
    const statusHtml = await status.text();
    expect(statusHtml).toContain("Upload failed");
    expect(statusHtml).toContain("permanent");
    expect(statusHtml).toContain("Sync off");
    expect((await app.request("/status")).headers.get("cache-control")).toBe("no-store");
    await app.request(`/api/collections/${first.collection_id}`, { method: "DELETE" });
    expect(await (await app.request("/trash")).text()).toContain("Purge");
    expect(await (await app.request("/")).text()).toContain("Nothing here yet");
  });
  it("shares live committer and sync status between the API and status page", async () => {
    await queue.run(
      "INSERT INTO pending_snapshots (collection_id,requested_at,last_error) VALUES (?,?,?)",
      [first.collection_id, Date.now(), "snapshot unavailable"],
    );
    const syncLoop = new SyncLoop(queue, services.ingest.sync, Date.now, waypoint);
    syncLoop.lastPushAt = 123456;
    const committer = new WriterCommitter(
      waypoint,
      queue,
      services.blobs,
      new MemoryBucket(),
      syncLoop,
      services.ingest,
    );
    committer.accountError = "Bucket access denied";
    const liveApp = createApp({ ...services, committer, syncLoop, environment: "dev" });
    const status = await (await liveApp.request("/api/status")).json();
    expect(status).toMatchObject({
      environment: "dev",
      account_paused: true,
      account_error: "Bucket access denied",
      last_error: "Bucket access denied",
      last_push_at: 123456,
      queue_errors: [
        { kind: "snapshot", id: first.collection_id, last_error: "snapshot unavailable" },
      ],
    });
    const page = await (await liveApp.request("/status")).text();
    expect(page).toContain("Bucket account paused: Bucket access denied");
    expect(page).toContain("snapshot unavailable");
    expect(page).toContain("1970-01-01T00:02:03.456Z");
  });
  it("resolves old collections and lists old deleted collections beyond 200", async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        seedPendingCollection(`Later ${i}`, Date.now() + i + 1000, true),
      ),
    );
    expect((await app.request(new URL(first.latest_url).pathname)).status).toBe(200);
    await app.request(`/api/collections/${first.collection_id}`, { method: "DELETE" });
    const trash = await (await app.request("/trash")).text();
    expect(trash).toContain("Alpha");
    expect(trash).toContain("Later 204");
    const deleted = await app.request(new URL(first.latest_url).pathname);
    expect(deleted.status).toBe(410);
    expect(await deleted.text()).toContain("is in Trash");
  });
  it("keeps list and shell query counts constant as history grows", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        seedPendingCollection(`Collection ${i}`, Date.now() + i + 1000),
      ),
    );
    const spies = [
      vi.spyOn(queue, "all"),
      vi.spyOn(queue, "get"),
      vi.spyOn(waypoint, "all"),
      vi.spyOn(waypoint, "get"),
    ];
    await app.request("/");
    expect(spies.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBeLessThan(20);
    spies.forEach((spy) => spy.mockRestore());
    const collectionId = first.collection_id;
    const fileEntries = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `notes/file-${i}.md`,
        { hash: "sha256:" + "0".repeat(64), mime: "text/markdown", size: 1 },
      ]),
    );
    fileEntries["index.md"] = { hash: "sha256:" + "0".repeat(64), mime: "text/markdown", size: 1 };
    await Array.from({ length: 38 }, (_, i) => i).reduce<Promise<string>>(async (previous, i) => {
      const parent = await previous;
      const id = mintRevisionId({ now: Date.now() + i + 1000, parentId: parent });
      const pub = await publicIdFor(id);
      const files = i === 37 ? fileEntries : { "index.md": fileEntries["index.md"] };
      await queue.run(
        "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          pub,
          collectionId,
          parent,
          "index.md",
          `Revision ${i}`,
          "{}",
          JSON.stringify({ headPath: "index.md", files }),
          Date.now() + i + 1000,
          "pending",
        ],
      );
      return id;
    }, Promise.resolve(second.revision_id));
    const shellSpies = [
      vi.spyOn(queue, "all"),
      vi.spyOn(queue, "get"),
      vi.spyOn(waypoint, "all"),
      vi.spyOn(waypoint, "get"),
    ];
    const html = await (await app.request(new URL(first.latest_url).pathname)).text();
    expect(shellSpies.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBeLessThan(25);
    expect(html.length).toBeLessThan(350_000);
    expect(html).not.toContain("data-paths");
    shellSpies.forEach((spy) => spy.mockRestore());
  });
  it("renders failed-only collections and validates shell paths", async () => {
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE collection_id=?", [
      first.collection_id,
    ]);
    const path = new URL(first.latest_url).pathname;
    const html = await (await app.request(path)).text();
    expect(html).toContain("Nothing in this collection has synced");
    expect(html).toContain("failed");
    expect((await app.request(`${path}notes%2Fb.md`)).status).toBe(404);
    expect(
      (
        await app.request(
          path.replace(/\/c\/([^/]+)/, (_, pub: string) => `/c/${pub.toUpperCase()}`),
        )
      ).status,
    ).toBe(200);
  });
  it("uses JSON API mutations with browser headers and shows errors safely", async () => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "http://localhost:7410",
      "Sec-Fetch-Site": "same-origin",
    };
    const request = (path: string, method: string, body: object = {}) =>
      app.request(path, { method, headers, body: JSON.stringify(body) });
    expect(
      (await request(`/api/collections/${first.collection_id}`, "PATCH", { title: "Renamed" }))
        .status,
    ).toBe(200);
    await queue.run(
      "UPDATE pending_revisions SET state='failed',last_error='<script>alert(1)</script>',error_kind='permanent' WHERE id=?",
      [second.revision_id],
    );
    const status = await (await app.request("/status")).text();
    expect(status).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(status).not.toContain("<script>alert(1)</script>");
    expect((await request(`/api/queue/${second.revision_id}/retry`, "POST")).status).toBe(200);
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [second.revision_id]);
    expect((await request(`/api/queue/${second.revision_id}`, "DELETE")).status).toBe(200);
    expect((await request(`/api/collections/${first.collection_id}`, "DELETE")).status).toBe(200);
    expect((await request(`/api/collections/${first.collection_id}/undelete`, "POST")).status).toBe(
      200,
    );
    expect((await request(`/api/collections/${first.collection_id}`, "DELETE")).status).toBe(200);
    expect(
      (await request(`/api/collections/${first.collection_id}/purge`, "POST", { confirm: "wrong" }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(`/api/collections/${first.collection_id}/purge`, "POST", {
          confirm: first.collection_id,
        })
      ).status,
    ).toBe(202);
  });
  it("handles special paths, uppercase IDs, and unknown routes", async () => {
    const files = [
      await upload("hash#file.md", "hash"),
      await upload("query?file.md", "query"),
      await upload("percent%file.md", "percent"),
      await upload("cafe\u0301.md", "accent"),
    ];
    const written = writeResult(
      await (
        await app.request(`/api/collections/${first.collection_id}/revisions`, json({ files }))
      ).json(),
    );
    const base = new URL(written.url).pathname;
    const specialResponses = await Promise.all(
      ["hash%23file.md", "query%3Ffile.md", "percent%25file.md", "caf%C3%A9.md"].map(async (path) =>
        app.request(`${base}${path}`),
      ),
    );
    expect(specialResponses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect((await app.request(`${base}hash%2Ffile.md`)).status).toBe(404);
    const latest = new URL(first.latest_url).pathname;
    expect((await app.request(latest.toUpperCase().replace("/C/", "/c/"))).status).toBe(200);
    const unknown = await app.request("/totally-unknown");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("Not found");
  });
  it("shows a download page for binary files", async () => {
    const binary = writeResult(
      await (
        await app.request(
          "/api/collections",
          json({
            title: "Binary",
            head_path: "data.bin",
            files: [await upload("data.bin", "binary content")],
          }),
        )
      ).json(),
    );
    const html = await (await app.request(new URL(binary.url).pathname)).text();
    expect(html).toContain("Download file");
    expect(html).not.toContain("<iframe");
  });
});

async function queryCount(path: string): Promise<number> {
  const spies = [
    vi.spyOn(queue, "all"),
    vi.spyOn(queue, "get"),
    vi.spyOn(waypoint, "all"),
    vi.spyOn(waypoint, "get"),
  ];
  await app.request(path);
  const total = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  spies.forEach((spy) => spy.mockRestore());
  return total;
}
describe("Folio shell", () => {
  it("renders landmarks, the skip link and the health pill on every page", async () => {
    for (const path of ["/", "/status", "/trash", new URL(first.latest_url).pathname]) {
      const html = await (await app.request(path)).text();
      expect(html).toContain('class="skip" href="#main"');
      expect(html).toMatch(/<header class="bar/);
      expect(html).toContain('id="main"');
      expect(html).toContain('popovertarget="health-pop"');
      expect(html).toContain('id="health-pop"');
    }
    const shell = await (await app.request(new URL(first.latest_url).pathname)).text();
    expect(shell).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
    expect(shell).toContain('<aside class="panel" id="panel" aria-label="Collection panel">');
    expect(shell).toContain('role="tablist"');
    expect(shell).toContain('id="copy-menu"');
    expect(shell).toContain("Watch: wait_for_revision");
    expect(shell).toContain('<nav class="tabbar" aria-label="Collection">');
  });
  it("orders the health pill blocked > failed > offline > off > uploading > synced", async () => {
    const syncLoop = new SyncLoop(queue, services.ingest.sync, Date.now, waypoint);
    const cloud = {
      lastPullAt: 0,
      verified: true,
      pull: () => Promise.resolve(false),
      push: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    };
    const live = {
      ...services,
      syncLoop,
      ingest: new IngestService(waypoint, queue, services.blobs, services.reads, cloud),
    };
    expect((await getHealth(services)).state).toBe("off");
    const now = Date.now();
    expect((await getHealth(live, now)).state).toBe("uploading");
    syncLoop.lastAttemptFailed = true;
    syncLoop.lastOkAt = now - 3 * 60_000;
    expect((await getHealth(live, now)).state).toBe("offline");
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [second.revision_id]);
    const failed = await getHealth(live, now);
    expect(failed.state).toBe("failed");
    expect(failed.label).toBe("1 failed");
    expect(failed.failed[0]?.display_number).toBe(2);
    expect(failed.failed[0]?.collection_public_id).toBeTruthy();
    syncLoop.blocked = true;
    syncLoop.lastError = "Environment mismatch";
    expect((await getHealth(live, now)).label).toBe("Sync blocked");
    await queue.run("DELETE FROM pending_revisions");
    syncLoop.blocked = false;
    syncLoop.lastAttemptFailed = false;
    expect((await getHealth(live, now)).state).toBe("synced");
  });
  it("names a dropped revision's descendants (B7)", async () => {
    const third = writeResult(
      await (
        await app.request(
          `/api/collections/${first.collection_id}/revisions`,
          json({ message: "Third", files: [await upload("c.md", "C")] }),
        )
      ).json(),
    );
    const response = await app.request(`/api/queue/${second.revision_id}/descendants`);
    expect(await response.json()).toEqual({
      ids: [second.revision_id, third.revision_id],
      display_numbers: [2, 3],
    });
    expect((await app.request("/api/queue/rev_missing/descendants")).status).toBe(404);
  });
  it("keeps Status and Trash query counts constant", async () => {
    await seedPendingCollection("Gone", Date.now() + 500, true);
    const status = await queryCount("/status");
    const trash = await queryCount("/trash");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        seedPendingCollection(`Gone ${i}`, Date.now() + i + 1000, true),
      ),
    );
    expect(await queryCount("/status")).toBe(status);
    expect(await queryCount("/trash")).toBe(trash);
    expect(trash).toBeLessThan(20);
  });
});

describe("viewer path mapping", () => {
  it("maps raw navigation to latest and pinned shell paths", () => {
    expect(rawPath("revision", "notes/a b.md")).toBe("/raw/r/revision/notes/a%20b.md");
    expect(pathFromRaw("/raw/r/revision/notes/a%20b.md", "revision")).toBe("notes/a b.md");
    expect(pathFromRaw("/raw/r/other/notes/a.md", "revision")).toBeNull();
    expect(pathFromRaw("/raw/r/revision/../bad", "revision")).toBeNull();
    expect(shellPath("collection", "revision", "notes/a b.md", false)).toBe(
      "/c/collection/notes/a%20b.md",
    );
    expect(shellPath("collection", "revision", "notes/a b.md", true)).toBe(
      "/c/collection/r/revision/notes/a%20b.md",
    );
  });
});
