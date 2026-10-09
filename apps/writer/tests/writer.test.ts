import { mkdtemp, readdir, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { newId, mintRevisionId, publicIdFor } from "@waypoint/core";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  migrate,
  waypointMigrations,
  queueMigrations,
  guardEnvironment,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { writerRenderer } from "../src/renderer.ts";
import { SyncLoop } from "../src/sync-loop.ts";
function noop(): void {}
let dir: string;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let waypoint: Db;
let queue: Db;
let blobs: BlobStore;
let reads: ReadModel;
let ingest: IngestService;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-test-"));
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
  const syncClient = opened.syncClient;
  close = async () => {
    await waypoint.close();
    await queue.close();
  };
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  await guardEnvironment(waypoint, syncClient, "dev", false);
  blobs = new BlobStore(dir, config.maxBlobBytes);
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  ingest = new IngestService(waypoint, queue, blobs, reads, syncClient);
  app = createApp({ waypoint, queue, blobs, reads, ingest });
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
describe("writer", () => {
  it("migrations are additive and idempotent", async () => {
    for (const m of [...waypointMigrations, ...queueMigrations])
      expect(m.sql).not.toMatch(/\b(?:DROP|RENAME)\b/i);
    await migrate(waypoint, waypointMigrations);
    await migrate(queue, queueMigrations);
    expect(await waypoint.all("SELECT id FROM schema_migrations")).toHaveLength(
      waypointMigrations.length,
    );
    expect(await queue.all("SELECT id FROM schema_migrations")).toHaveLength(
      queueMigrations.length,
    );
    expect(
      await waypoint.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='renditions_by_output'",
      ),
    ).toBeTruthy();
    expect((await app.request("/healthz")).status).toBe(200);
  });
  it("rejects creating a collection ID with a queued purge", async () => {
    const id = newId("col");
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      id,
      Date.now(),
    ]);
    const response = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collection_id: id,
        title: "blocked",
        files: [{ path: "a.txt", hash: (await stored("a")).hash }],
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
  });
  it("uploads, creates, resolves, and serves content", async () => {
    const content = "hello waypoint";
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = "sha256:" + Buffer.from(digest).toString("hex");
    expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: content })).status).toBe(
      200,
    );
    const created = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello", files: [{ path: "index.md", hash }] }),
    });
    expect(created.status).toBe(200);
    const result: unknown = await created.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("url" in result) ||
      !("revision_id" in result) ||
      typeof result.url !== "string" ||
      typeof result.revision_id !== "string"
    )
      throw new Error("Invalid write result");
    expect(result.url).toContain("/c/");
    const raw = await app.request(`/api/revisions/${result.revision_id}/files/index.md`);
    expect(await raw.text()).toBe(content);
    expect(raw.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const details: unknown = await (
      await app.request(`/api/revisions/${result.revision_id}`)
    ).json();
    expect(details).toMatchObject({ id: result.revision_id });
    const publicId = result.url.split("/r/")[1]?.split("/")[0];
    expect(publicId).toBeTruthy();
    const publicRaw = await app.request(`/raw/r/${publicId}/index.md`);
    expect(publicRaw.status).toBe(200);
    expect(await publicRaw.text()).toBe(content);
    expect((await app.request("/api/collections")).status).toBe(200);

    const resolved = await app.request("/api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: result.url }),
    });
    const resolution: unknown = await resolved.json();
    expect(resolution).toMatchObject({ revision_id: result.revision_id });
  });
  it("supports multipart", async () => {
    const data = new FormData();
    data.set("meta", JSON.stringify({ title: "Multipart" }));
    data.set("file:index.txt", new File(["content"], "index.txt", { type: "text/plain" }));
    const response = await app.request("/api/collections", { method: "POST", body: data });
    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("collection_id" in result) ||
      typeof result.collection_id !== "string"
    )
      throw new Error("Invalid result");
    const revision = new FormData();
    revision.set("meta", JSON.stringify({ mode: "merge" }));
    revision.set("file:extra.txt", new File(["added"], "extra.txt", { type: "text/plain" }));
    expect(
      (
        await app.request(`/api/collections/${result.collection_id}/revisions`, {
          method: "POST",
          body: revision,
        })
      ).status,
    ).toBe(200);
  });
});

async function stored(text: string, path = "index.md") {
  const bytes = new TextEncoder().encode(text);
  const saved = await blobs.put(Readable.from([bytes]));
  return { path, hash: saved.hash };
}
describe("ingest and read model", () => {
  it("chains concurrent default parents and retries the original result", async () => {
    const file = await stored("one");
    const first = await ingest.create({ title: "Chain", files: [file] });
    const changed = await stored("two");
    const third = await stored("three");
    const [a, b] = await Promise.all([
      ingest.add(first.collection_id, { files: [changed] }),
      ingest.add(first.collection_id, { files: [third] }),
    ]);
    const revisions = await reads.revisions(first.collection_id);
    expect(revisions).toHaveLength(3);
    expect(revisions[1]?.parent_revision_id).toBe(first.revision_id);
    expect(revisions[2]?.parent_revision_id).toBe(revisions[1]?.id);
    expect([a.revision_id, b.revision_id]).toContain(revisions[1]?.id);
    const retried = await ingest.add(first.collection_id, {
      revision_id: a.revision_id,
      files: [changed],
    });
    expect(retried.revision_id).toBe(a.revision_id);
  });
  it("merges, replaces, and skips no-op", async () => {
    const one = await stored("one");
    const first = await ingest.create({ title: "Modes", files: [one] });
    const two = await stored("two", "more.txt");
    const merged = await ingest.add(first.collection_id, { files: [two] });
    expect(Object.keys((await reads.revision(merged.revision_id))!.manifest.files)).toHaveLength(2);
    const noOp = await ingest.add(first.collection_id, { files: [] });
    expect(noOp).toMatchObject({ unchanged: true, revision_id: merged.revision_id });
    const replaced = await ingest.add(first.collection_id, { mode: "replace", files: [two] });
    expect(Object.keys((await reads.revision(replaced.revision_id))!.manifest.files)).toEqual([
      "more.txt",
    ]);
  });
  it("merges from a pending parent with removals and inherited head", async () => {
    const first = await ingest.create({
      title: "Merge pending",
      files: [await stored("head", "index.md"), await stored("old", "old.txt")],
    });
    const merged = await ingest.add(first.collection_id, {
      parent_revision_id: first.revision_id,
      remove: ["old.txt"],
      files: [await stored("new", "new.txt")],
    });
    const revision = await reads.revision(merged.revision_id);
    expect(revision?.manifest.headPath).toBe("index.md");
    expect(Object.keys(revision?.manifest.files ?? {}).toSorted()).toEqual(["index.md", "new.txt"]);
    const noOp = await ingest.add(first.collection_id, {
      parent_revision_id: merged.revision_id,
      files: [],
    });
    expect(noOp).toMatchObject({ unchanged: true, revision_id: merged.revision_id });
  });
  it("shows failed revisions but excludes them from latest and rejects a failed default parent", async () => {
    const first = await ingest.create({ title: "Failure", files: [await stored("one")] });
    const second = await ingest.add(first.collection_id, { files: [await stored("two")] });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [second.revision_id]);
    expect((await reads.latest(first.collection_id))?.id).toBe(first.revision_id);
    await expect(
      ingest.add(first.collection_id, { files: [await stored("three")] }),
    ).rejects.toMatchObject({ code: "parent_failed" });
  });
  it("soft deletes pending collections and allows undelete", async () => {
    const first = await ingest.create({ title: "Delete me", files: [await stored("one")] });
    expect((await reads.searchCollections()).collections).toHaveLength(1);
    expect(
      (await app.request(`/api/collections/${first.collection_id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await reads.searchCollections()).collections).toHaveLength(0);
    expect((await reads.searchCollections({ include_deleted: true })).collections).toHaveLength(1);
    expect(
      (await app.request(`/api/collections/${first.collection_id}/undelete`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect((await reads.searchCollections()).collections).toHaveLength(1);
  });
  it("answers collection_purged to undelete while a purge is queued (OW-14)", async () => {
    const first = await ingest.create({ title: "Purging", files: [await stored("one")] });
    expect(
      (await app.request(`/api/collections/${first.collection_id}`, { method: "DELETE" })).status,
    ).toBe(200);
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      first.collection_id,
      Date.now(),
    ]);
    const response = await app.request(`/api/collections/${first.collection_id}/undelete`, {
      method: "POST",
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "collection_purged" } });
  });
  it("stores the title and public ID with a queued purge (OW-14)", async () => {
    const first = await ingest.create({ title: "Named purge", files: [await stored("one")] });
    const committer = new WriterCommitter(
      waypoint,
      queue,
      blobs,
      new MemoryBucket(),
      new SyncLoop(queue, ingest.sync, Date.now, waypoint),
      ingest,
    );
    for (let pass = 0; pass < 20; pass++) {
      committer.wake();
      await committer.drain();
      if (!(await queue.get("SELECT 1 FROM pending_collections WHERE id=?", [first.collection_id])))
        break;
    }
    committer.stop();
    await committer.drain();
    const collection = await waypoint.get<{ title: string; public_id: string }>(
      "SELECT title,public_id FROM collections WHERE id=?",
      [first.collection_id],
    );
    expect(collection?.title).toBe("Named purge");
    expect(
      (await app.request(`/api/collections/${first.collection_id}`, { method: "DELETE" })).status,
    ).toBe(200);
    const response = await app.request(`/api/collections/${first.collection_id}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: first.collection_id }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(await queue.get("SELECT title,public_id FROM pending_purges")).toEqual(collection);
  });
  it("searches titles and nested metadata, filters, identifiers, and paginates", async () => {
    const file = await stored("head");
    const a = await ingest.create({
      title: "Atlas plan",
      metadata: { project: "waypoint", tags: ["research"], nested: { label: "deep value" } },
      files: [file],
    });
    const b = await ingest.create({ title: "Other", metadata: { tags: ["atlas"] }, files: [file] });
    const c = await ingest.create({ title: "Third", files: [file] });
    const search = async (query: string) => (await reads.searchCollections({ query })).collections;
    expect((await search("atlas")).map((item) => [item.id, item.match])).toEqual(
      expect.arrayContaining([
        [a.collection_id, "title"],
        [b.collection_id, "metadata"],
      ]),
    );
    expect((await search("research"))[0]?.id).toBe(a.collection_id);
    expect((await search("deep value"))[0]?.id).toBe(a.collection_id);
    expect(await search("nested")).toHaveLength(0);
    const detail = await reads.getCollection(a.collection_id);
    for (const query of [
      a.collection_id,
      detail.public_id,
      detail.public_id.toUpperCase(),
      a.latest_url,
      a.url,
      detail.revision?.files[0]?.url ?? "",
    ])
      expect((await search(query))[0]).toMatchObject({ id: a.collection_id, match: "id" });
    expect(
      (
        await reads.searchCollections({ metadata: { tags: "research", project: "waypoint" } })
      ).collections.map((item) => item.id),
    ).toEqual([a.collection_id]);
    expect(
      (await reads.searchCollections({ metadata: { project: "wrong" } })).collections,
    ).toHaveLength(0);
    expect(
      (await reads.searchCollections({ updated_after: Date.now() + 1000 })).collections,
    ).toHaveLength(0);
    const committedQueries = vi.spyOn(waypoint, "all");
    const queueQueries = vi.spyOn(queue, "all");
    await reads.searchCollections({ limit: 1 });
    const onePageQueries = committedQueries.mock.calls.length + queueQueries.mock.calls.length;
    committedQueries.mockClear();
    queueQueries.mockClear();
    await reads.searchCollections({ limit: 3 });
    expect(committedQueries.mock.calls.length + queueQueries.mock.calls.length).toBe(
      onePageQueries,
    );
    committedQueries.mockRestore();
    queueQueries.mockRestore();
    expect((await reads.searchCollections({ sort: "created" })).collections[0]?.id).toBe(
      c.collection_id,
    );
    const first = await reads.searchCollections({ limit: 2 });
    const inserted = await ingest.create({ title: "Concurrent", files: [file] });
    const remainingId = [a.collection_id, b.collection_id, c.collection_id].find(
      (id) => !first.collections.some((item) => item.id === id),
    );
    if (!remainingId) throw new Error("Missing second-page collection");
    const originalTitle = (await reads.getCollection(remainingId)).title;
    const edited = await app.request(`/api/collections/${remainingId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Changed during scan" }),
    });
    expect(edited.status).toBe(200);
    const second = await reads.searchCollections({ limit: 2, cursor: first.next_cursor ?? "" });
    expect([...first.collections, ...second.collections].map((item) => item.id).toSorted()).toEqual(
      [a.collection_id, b.collection_id, c.collection_id].toSorted(),
    );
    expect(second.collections.some((item) => item.id === inserted.collection_id)).toBe(false);
    expect(second.collections.find((item) => item.id === remainingId)?.title).toBe(originalTitle);
    const unicode = await ingest.create({
      title: "Café",
      metadata: { label: "Résumé" },
      files: [file],
    });
    expect((await search("CAFÉ"))[0]?.id).toBe(unicode.collection_id);
    expect((await search("résumé"))[0]?.id).toBe(unicode.collection_id);
    const boolean = await ingest.create({
      title: "Flags",
      metadata: { active: true, archived: false },
      files: [file],
    });
    expect((await search("true"))[0]?.id).toBe(boolean.collection_id);
    expect((await search("false"))[0]?.id).toBe(boolean.collection_id);
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [a.revision_id]);
    const failed = (await reads.searchCollections({ query: a.collection_id })).collections[0];
    expect(failed).toMatchObject({
      revision_count: 1,
      latest_revision: null,
      updated_at: detail.created_at,
    });
    await app.request(`/api/collections/${b.collection_id}`, { method: "DELETE" });
    expect(await search(b.collection_id)).toHaveLength(0);
    expect(
      (await reads.searchCollections({ query: b.collection_id, include_deleted: true }))
        .collections[0]?.deleted,
    ).toBe(true);
  });
  it("validates search filters and returns text and binary heads", async () => {
    const markdown = await ingest.create({
      title: "Head",
      files: [await stored("VERSION ONE", "index.md")],
    });
    const response = await app.request(
      `/api/collections/${(await reads.getCollection(markdown.collection_id)).public_id.toUpperCase()}?include_head=1`,
    );
    expect(await response.json()).toMatchObject({
      head: { path: "index.md", text: "VERSION ONE", truncated: false },
    });
    const binary = await ingest.create({
      title: "Binary",
      files: [await stored("\u0000\u0001", "image.png")],
    });
    expect(
      await (await app.request(`/api/collections/${binary.collection_id}?include_head=1`)).json(),
    ).toMatchObject({ head: { text: null } });
    const html = await ingest.create({
      title: "HTML",
      files: [await stored("<h1>Hi</h1>", "index.html")],
    });
    expect(
      await (await app.request(`/api/collections/${html.collection_id}?include_head=1`)).json(),
    ).toMatchObject({ head: { mime: "text/html", text: "<h1>Hi</h1>" } });
    const long = await ingest.create({
      title: "Long",
      files: [await stored("a".repeat(64 * 1024 - 1) + "💡tail")],
    });
    const longDetail: unknown = await (
      await app.request(`/api/collections/${long.collection_id}?include_head=1`)
    ).json();
    if (
      !longDetail ||
      typeof longDetail !== "object" ||
      !("head" in longDetail) ||
      !longDetail.head ||
      typeof longDetail.head !== "object" ||
      !("text" in longDetail.head) ||
      !("truncated" in longDetail.head)
    )
      throw new Error("Invalid head response");
    expect(longDetail.head.truncated).toBe(true);
    expect(longDetail.head.text).toBe("a".repeat(64 * 1024 - 1));
    expect((await app.request("/api/collections?metadata=%5B%5D")).status).toBe(400);
    expect((await app.request("/api/collections?metadata=%7Bbad")).status).toBe(400);
    expect((await app.request("/api/collections?updated_after=2026-10-07")).status).toBe(200);
    expect(
      (await app.request("/api/collections?updated_after=2026-10-07T12%3A00%3A00%2B12%3A00"))
        .status,
    ).toBe(200);
    const secondHead = await ingest.add(markdown.collection_id, {
      files: [await stored("VERSION TWO", "index.md")],
    });
    const selected = await app.request(
      `/api/collections/${markdown.collection_id}?revision_id=${markdown.revision_id}&include_head=1`,
    );
    expect(await selected.json()).toMatchObject({
      revision: { id: markdown.revision_id },
      head: { text: "VERSION ONE" },
      latest_revision: { id: secondHead.revision_id },
    });
    const original = await reads.getRevision(markdown.revision_id);
    const originalHead = original.files.find((entry) => entry.path === "index.md");
    if (!originalHead) throw new Error("Missing head");
    await unlink(blobs.path(originalHead.hash));
    expect(
      await (
        await app.request(
          `/api/collections/${markdown.collection_id}?revision_id=${markdown.revision_id}&include_head=1`,
        )
      ).json(),
    ).toMatchObject({ head: { text: null, unavailable: true } });
  });
  it("imports the HTTP module without installing signal handlers", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    vi.resetModules();
    await import("../src/http.ts");
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
  it("long polls, times out, and rejects a revision from another collection", async () => {
    const file = await stored("one");
    const a = await ingest.create({ title: "Watch", files: [file] });
    const b = await ingest.create({ title: "Other", files: [file] });
    const path = `/api/collections/${a.collection_id}/revisions?after=${a.revision_id}&wait=0.1`;
    expect(await (await app.request(path)).json()).toMatchObject({ changed: false, revisions: [] });
    expect(
      (await app.request(`/api/collections/${a.collection_id}/revisions?after=${b.revision_id}`))
        .status,
    ).toBe(404);
    const waiting = app.request(
      `/api/collections/${a.collection_id}/revisions?after=${a.revision_id}&wait=2`,
    );
    const next = await ingest.add(a.collection_id, { files: [await stored("two")] });
    expect(await (await waiting).json()).toMatchObject({
      changed: true,
      revisions: [{ id: next.revision_id }],
    });
  });
  it("does not miss a revision emitted during the first long-poll read", async () => {
    const first = await ingest.create({ title: "Race", files: [await stored("one")] });
    const snapshot = await reads.listRevisions(first.collection_id);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi.spyOn(reads, "listRevisions").mockImplementationOnce(async () => {
      await gate;
      return snapshot;
    });
    const waiting = app.request(
      `/api/collections/${first.collection_id}/revisions?after=${first.revision_id}&wait=2`,
    );
    while (reads.revisionEvents.listenerCount("revision") === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const added = await app.request(`/api/collections/${first.collection_id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [await stored("two")] }),
    });
    expect(added.status).toBe(200);
    release?.();
    expect(await (await waiting).json()).toMatchObject({ changed: true, revisions: [{}] });
    list.mockRestore();
  });
  it("sees a revision inserted directly into the committed database while waiting", async () => {
    const first = await ingest.create({ title: "Pulled", files: [await stored("one")] });
    const row = await queue.get<{
      public_id: string;
      title: string;
      metadata: string;
      created_at: number;
    }>("SELECT public_id,title,metadata,created_at FROM pending_collections WHERE id=?", [
      first.collection_id,
    ]);
    if (!row) throw new Error("Missing pending collection");
    await waypoint.run(
      "INSERT INTO collections(id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [first.collection_id, row.public_id, row.title, row.metadata, row.created_at],
    );
    const waiting = app.request(
      `/api/collections/${first.collection_id}/revisions?after=${first.revision_id}&wait=3`,
    );
    const id = mintRevisionId({ now: Date.now() + 10, parentId: first.revision_id });
    await waypoint.run(
      "INSERT INTO revisions(id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        id,
        await publicIdFor(id),
        first.collection_id,
        null,
        "index.md",
        "pulled",
        "{}",
        Date.now() + 10,
      ],
    );
    expect(await (await waiting).json()).toMatchObject({ changed: true, revisions: [{ id }] });
    const found = (await reads.searchCollections({ query: first.collection_id })).collections[0];
    expect(found).toMatchObject({ revision_count: 2, latest_revision: { id } });
    expect(typeof found?.updated_at).toBe("number");
  });
  it("releases a long poll when its request is aborted", async () => {
    const first = await ingest.create({ title: "Abort", files: [await stored("one")] });
    const controller = new AbortController();
    const request = new Request(
      `http://localhost/api/collections/${first.collection_id}/revisions?after=${first.revision_id}&wait=30`,
      { signal: controller.signal },
    );
    const waiting = app.fetch(request);
    controller.abort();
    expect(await (await waiting).json()).toMatchObject({ changed: false });
  });
  it("caps concurrent waiters and clears them after abort", async () => {
    const first = await ingest.create({ title: "Cap", files: [await stored("one")] });
    const url = `http://localhost/api/collections/${first.collection_id}/revisions?after=${first.revision_id}&wait=10`;
    const controllers = Array.from({ length: 200 }, () => new AbortController());
    const waits = controllers.map((controller) =>
      Promise.resolve(app.fetch(new Request(url, { signal: controller.signal }))),
    );
    for (
      let attempt = 0;
      attempt < 200 && reads.revisionEvents.listenerCount("revision") < 200;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads.revisionEvents.listenerCount("revision")).toBe(200);
    const overCap = await app.request(url);
    expect(overCap.status).toBe(503);
    expect(overCap.headers.get("retry-after")).toBe("2");
    controllers.forEach((controller) => controller.abort());
    await Promise.all(waits);
    expect(reads.revisionEvents.listenerCount("revision")).toBe(0);
  }, 10_000);
  it("releases waiters on writer shutdown", async () => {
    const first = await ingest.create({ title: "Shutdown", files: [await stored("one")] });
    const controller = new AbortController();
    const shuttingApp = createApp({
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      shutdownSignal: controller.signal,
    });
    const waiting = shuttingApp.request(
      `/api/collections/${first.collection_id}/revisions?after=${first.revision_id}&wait=30`,
    );
    while (reads.revisionEvents.listenerCount("revision") === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await (await waiting).json()).toMatchObject({ changed: false, revisions: [] });
    expect(reads.revisionEvents.listenerCount("revision")).toBe(0);
  });
  it("returns error envelopes for path case conflicts and conflicting IDs", async () => {
    const a = await stored("a", "A.txt");
    const b = await stored("b", "a.txt");
    const response = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Conflict", files: [a, b] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "path_case_conflict" } });
    const collectionId = newId("col");
    const revisionId = mintRevisionId({ now: Date.now() });
    const first = await ingest.create({
      collection_id: collectionId,
      revision_id: revisionId,
      title: "One",
      files: [a],
    });
    expect(
      (
        await ingest.create({
          collection_id: collectionId,
          revision_id: revisionId,
          title: "One",
          files: [a],
        })
      ).revision_id,
    ).toBe(first.revision_id);
    await expect(
      ingest.create({
        collection_id: collectionId,
        revision_id: mintRevisionId({ now: Date.now() }),
        title: "Other",
        files: [a],
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("guards environment and rejects hash and size errors", async () => {
    await expect(
      guardEnvironment(
        waypoint,
        {
          lastPullAt: null,
          pull: () => Promise.resolve(false),
          push: () => Promise.resolve(),
          checkpoint: () => Promise.resolve(),
        },
        "prod",
        false,
      ),
    ).rejects.toThrow("Environment mismatch");
    await expect(
      blobs.put(Readable.from(["wrong"]), "sha256:" + "0".repeat(64)),
    ).rejects.toMatchObject({ code: "blob_hash_mismatch" });
    const small = new BlobStore(dir, 2);
    await expect(small.put(Readable.from(["larger"]))).rejects.toMatchObject({
      code: "blob_too_large",
    });
  });
});
describe("queue and guard", () => {
  it("refuses a remote environment mismatch after pull", async () => {
    const fake = {
      lastPullAt: null,
      pull: async () => {
        await waypoint.run("UPDATE meta SET value='prod' WHERE key='environment'");
        return true;
      },
      push: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    };
    await expect(guardEnvironment(waypoint, fake, "dev", true)).rejects.toThrow(
      "Environment mismatch",
    );
  });
  it("retries and drops failed descendants", async () => {
    const first = await ingest.create({ title: "Queue", files: [await stored("first")] });
    const second = await ingest.add(first.collection_id, { files: [await stored("second")] });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id IN (?,?)", [
      first.revision_id,
      second.revision_id,
    ]);
    const retry = await app.request(`/api/queue/${first.revision_id}/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect(
      (await reads.revisions(first.collection_id)).every((row) => row.sync_state === "pending"),
    ).toBe(true);
    const drop = await app.request(`/api/queue/${first.revision_id}`, { method: "DELETE" });
    expect(drop.status).toBe(200);
    expect(await reads.revisions(first.collection_id)).toHaveLength(0);
    expect(await reads.collection(first.collection_id)).toBeUndefined();
    expect(await queue.all("SELECT hash FROM pending_blobs")).toHaveLength(0);
    expect(await queue.all("SELECT key FROM pending_r2_deletes")).toHaveLength(4);
  });
  it("refuses to drop a revision already present in waypoint.db", async () => {
    const first = await ingest.create({ title: "Committed drop", files: [await stored("one")] });
    const col = await queue.get<{
      public_id: string;
      title: string;
      metadata: string;
      created_at: number;
    }>("SELECT public_id,title,metadata,created_at FROM pending_collections WHERE id=?", [
      first.collection_id,
    ]);
    const rev = await queue.get<{
      public_id: string;
      collection_id: string;
      parent_revision_id: string | null;
      head_path: string;
      message: string | null;
      metadata: string;
      created_at: number;
    }>(
      "SELECT public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at FROM pending_revisions WHERE id=?",
      [first.revision_id],
    );
    if (!col || !rev) throw new Error("Missing pending rows");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [first.collection_id, col.public_id, col.title, col.metadata, col.created_at],
    );
    await waypoint.run(
      "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        first.revision_id,
        rev.public_id,
        rev.collection_id,
        rev.parent_revision_id,
        rev.head_path,
        rev.message,
        rev.metadata,
        rev.created_at,
      ],
    );
    const inheritedNames = await Promise.all(
      ["constructor", "toString", "__proto__"].map(async (name) =>
        app.request(`/api/revisions/${first.revision_id}/files/${name}`),
      ),
    );
    expect(inheritedNames.map((response) => response.status)).toEqual([404, 404, 404]);
    const drop = await app.request(`/api/queue/${first.revision_id}`, { method: "DELETE" });
    expect(drop.status).toBe(409);
    expect(await drop.json()).toMatchObject({ error: { code: "conflict" } });
  });
  it("records committed collection edits in the snapshot queue", async () => {
    const first = await ingest.create({ title: "Committed", files: [await stored("hello")] });
    const pending = await queue.get<{ public_id: string; metadata: string; created_at: number }>(
      "SELECT public_id,metadata,created_at FROM pending_collections WHERE id=?",
      [first.collection_id],
    );
    if (!pending) throw new Error("Missing pending collection");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [first.collection_id, pending.public_id, "Committed", pending.metadata, pending.created_at],
    );
    await queue.run("DELETE FROM pending_collections WHERE id=?", [first.collection_id]);
    const patch = await app.request(`/api/collections/${first.collection_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(patch.status).toBe(200);
    expect(
      await queue.get("SELECT collection_id FROM pending_snapshots WHERE collection_id=?", [
        first.collection_id,
      ]),
    ).toBeTruthy();
  });
  it("reports the newest recorded queue error deterministically", async () => {
    const first = await ingest.create({ title: "Errors", files: [await stored("one")] });
    const second = await ingest.add(first.collection_id, { files: [await stored("two")] });
    await queue.run("UPDATE pending_revisions SET created_at=?,last_error=? WHERE id=?", [
      200,
      "older",
      second.revision_id,
    ]);
    await queue.run("UPDATE pending_revisions SET created_at=?,last_error=? WHERE id=?", [
      300,
      "newer",
      first.revision_id,
    ]);
    await queue.run(
      "INSERT INTO pending_snapshots (collection_id,requested_at,last_error) VALUES (?,?,?)",
      [first.collection_id, 400, "snapshot outage"],
    );
    const status = await app.request("/api/status");
    expect(await status.json()).toMatchObject({
      last_error: "newer",
      queue_errors: [{ kind: "snapshot", id: first.collection_id, last_error: "snapshot outage" }],
    });
  });
});
describe("HTTP validation", () => {
  it("uses the configured revision size in the Content-Length precheck", async () => {
    const limited = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      undefined,
      2000,
      1,
    );
    const limitedApp = createApp({ waypoint, queue, blobs, reads, ingest: limited });
    const response = await limitedApp.request("/api/collections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024 + 2),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "revision_too_large" } });
  });
  it("returns JSON envelopes for malformed bodies and missing revisions", async () => {
    const malformed = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "validation_failed" } });
    const missing = await app.request("/api/revisions/rev_missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("rejects duplicate file paths", async () => {
    const file = await stored("same");
    await expect(ingest.create({ title: "Duplicate", files: [file, file] })).rejects.toMatchObject({
      code: "path_case_conflict",
    });
  });
});

describe("reviewer regressions", () => {
  it("does not serialize commit waits for three concurrent adds", async () => {
    const slow = new IngestService(waypoint, queue, blobs, reads, ingest.sync, {
      wake() {},
      async waitForCommit() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "pending";
      },
    });
    const first = await ingest.create({ title: "Waits", files: [await stored("start")] });
    const files = await Promise.all([stored("one"), stored("two"), stored("three")]);
    const start = performance.now();
    await Promise.all(files.map((file) => slow.add(first.collection_id, { files: [file] })));
    expect(performance.now() - start).toBeLessThan(350);
    const rows = await reads.revisions(first.collection_id);
    expect(rows).toHaveLength(4);
    expect(rows[3]?.parent_revision_id).toBe(rows[2]?.id);
  });
  it("keeps local reads and writes responsive during a slow pull", async () => {
    const first = await ingest.create({ title: "Slow pull", files: [await stored("head")] });
    let entered: () => void = noop;
    let release: () => void = noop;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowSync = {
      lastPullAt: null,
      pull: async () => {
        entered();
        await gate;
        return false;
      },
      push: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    };
    const pulling = new IngestService(waypoint, queue, blobs, reads, slowSync);
    const adding = pulling.add(first.collection_id, { files: [await stored("change")] });
    await started;
    const local = Promise.all([
      reads.collection(first.collection_id),
      queue.run("INSERT INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)", [
        first.collection_id,
        Date.now(),
      ]),
    ]);
    expect(
      await Promise.race([
        local.then(() => "done"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 200)),
      ]),
    ).toBe("done");
    release();
    await adding;
  });
  it("rejects sequential and concurrent reuse of a revision ID across collections", async () => {
    const a = await ingest.create({ title: "A", files: [await stored("a")] });
    const b = await ingest.create({ title: "B", files: [await stored("b")] });
    const id = mintRevisionId({ now: Date.now() });
    const file = await stored("next");
    await ingest.add(a.collection_id, { revision_id: id, files: [file] });
    await expect(
      ingest.add(b.collection_id, { revision_id: id, files: [file] }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const raceId = mintRevisionId({ now: Date.now() });
    const results = await Promise.allSettled([
      ingest.add(a.collection_id, { revision_id: raceId, files: [await stored("race-a")] }),
      ingest.add(b.collection_id, { revision_id: raceId, files: [await stored("race-b")] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "revision_conflict" } },
    ]);
  });
  it("preserves a __proto__ file through a pending merge and raw read", async () => {
    const file = await stored("prototype bytes", "__proto__");
    const first = await ingest.create({
      title: "Prototype",
      head_path: "__proto__",
      files: [file],
    });
    const child = await ingest.add(first.collection_id, {
      files: [await stored("other", "other.txt")],
    });
    const revision = await reads.revision(child.revision_id);
    expect(Object.hasOwn(revision?.manifest.files ?? {}, "__proto__")).toBe(true);
    const raw = await app.request(`/api/revisions/${child.revision_id}/files/__proto__`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("prototype bytes");
  });
  it("enforces write origin policy and JSON media types", async () => {
    const url = "/api/blobs/check";
    const body = JSON.stringify({ hashes: [] });
    const blockedSites = await Promise.all(
      ["cross-site", "same-site"].map(
        async (site) =>
          await app.request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "sec-fetch-site": site },
            body,
          }),
      ),
    );
    expect(blockedSites.map((response) => response.status)).toEqual([403, 403]);
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { origin: "https://evil.test", "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(403);
    const allowedOrigins = await Promise.all(
      ["http://localhost:7410", "http://127.0.0.1:7410"].map(
        async (origin) =>
          await app.request(url, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body,
          }),
      ),
    );
    expect(allowedOrigins.map((response) => response.status)).toEqual([200, 200]);
    expect(
      (await app.request(url, { method: "POST", headers: { "content-type": "text/plain" }, body }))
        .status,
    ).toBe(415);
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(200);
  });
  it("requires multipart meta first and infers octet-stream markdown MIME", async () => {
    const late = new FormData();
    late.append("file:index.md", new File(["# Late"], "index.md"));
    late.append("meta", JSON.stringify({ title: "Late" }));
    const lateResponse = await app.request("/api/collections", { method: "POST", body: late });
    expect(lateResponse.status).toBe(400);
    expect((await readdir(dir)).some((name) => name === "blobs")).toBe(false);
    const invalid = new FormData();
    invalid.append("meta", JSON.stringify({ title: "Invalid" }));
    invalid.append("file:../bad.md", new File(["bad"], "bad.md"));
    expect((await app.request("/api/collections", { method: "POST", body: invalid })).status).toBe(
      400,
    );
    const good = new FormData();
    good.append("meta", JSON.stringify({ title: "Markdown" }));
    good.append(
      "file:plan.md",
      new File(["# Plan"], "plan.md", { type: "application/octet-stream" }),
    );
    ingest = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      writerRenderer,
    );
    app = createApp({ waypoint, queue, blobs, reads, ingest });
    const created = await app.request("/api/collections", { method: "POST", body: good });
    expect(created.status).toBe(200);
    const result: unknown = await created.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("revision_id" in result) ||
      typeof result.revision_id !== "string"
    )
      throw new Error("Invalid write result");
    const detail = await reads.getRevision(result.revision_id);
    expect(detail.files[0]?.mime).toBe("text/markdown");
    const html = await app.request(`/api/revisions/${result.revision_id}/files/plan.md`);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const etag = html.headers.get("etag");
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    expect(await html.text()).toContain("<h1");
    const conditional = await app.request(`/api/revisions/${result.revision_id}/files/plan.md`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
    const source = await app.request(`/api/revisions/${result.revision_id}/files/plan.md?source`);
    expect(await source.text()).toBe("# Plan");
    expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    expect(source.headers.get("cache-control")).toContain("immutable");
    const rendition = await reads.rendition(detail.files[0]!.hash);
    if (!rendition) throw new Error("Missing rendition");
    await blobs.delete(rendition.hash);
    const fallback = await app.request(`/api/revisions/${result.revision_id}/files/plan.md`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("cache-control")).toBe("no-cache");
    expect(await fallback.text()).toBe("# Plan");
  });
  it("validates multipart metadata and collection state before storing files", async () => {
    const malformed = new FormData();
    malformed.append("meta", JSON.stringify({ title: 42 }));
    malformed.append("file:index.txt", new File(["never stored"], "index.txt"));
    const invalid = await app.request("/api/collections", { method: "POST", body: malformed });
    expect(invalid.status).toBe(400);
    expect((await readdir(dir)).includes("blobs")).toBe(false);
    const missing = new FormData();
    missing.append("meta", JSON.stringify({ mode: "merge" }));
    missing.append("file:index.txt", new File(["still not stored"], "index.txt"));
    const absent = await app.request(`/api/collections/${newId("col")}/revisions`, {
      method: "POST",
      body: missing,
    });
    expect(absent.status).toBe(404);
    expect((await readdir(dir)).includes("blobs")).toBe(false);
    const noFilename = new FormData();
    noFilename.append("meta", JSON.stringify({ title: "No filename" }));
    noFilename.append("file:x", "field content");
    const field = await app.request("/api/collections", { method: "POST", body: noFilename });
    expect(field.status).toBe(400);
    expect(await field.json()).toMatchObject({
      error: { code: "validation_failed", message: "File part requires a filename" },
    });
  });
  it("logs unknown errors and hides their details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await waypoint.close();
      const response = await app.request("/api/collections");
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("Database is closed");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      close = async () => {
        await queue.close();
      };
    }
  });
  it("returns ID validation errors and parent timestamps over HTTP", async () => {
    const first = await ingest.create({ title: "IDs", files: [await stored("root")] });
    const file = await stored("changed");
    const endpoint = `/api/collections/${first.collection_id}/revisions`;
    async function post(id: string): Promise<Response> {
      return app.request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision_id: id,
          parent_revision_id: first.revision_id,
          files: [file],
        }),
      });
    }
    const before = await post(mintRevisionId({ now: Date.now() - 1000 }));
    expect(before.status).toBe(400);
    const beforeBody: unknown = await before.json();
    expect(beforeBody).toMatchObject({ error: { code: "id_before_parent" } });
    if (
      !beforeBody ||
      typeof beforeBody !== "object" ||
      !("error" in beforeBody) ||
      !beforeBody.error ||
      typeof beforeBody.error !== "object" ||
      !("details" in beforeBody.error) ||
      !beforeBody.error.details ||
      typeof beforeBody.error.details !== "object" ||
      !("parent_timestamp" in beforeBody.error.details)
    )
      throw new Error("Missing parent timestamp");
    expect(typeof beforeBody.error.details.parent_timestamp).toBe("number");
    const future = await post(mintRevisionId({ now: Date.now() + 6 * 60_000 }));
    expect(await future.json()).toMatchObject({ error: { code: "clock_skew" } });
    const stale = await post(mintRevisionId({ now: Date.now() - 8 * 24 * 60 * 60_000 }));
    expect(await stale.json()).toMatchObject({ error: { code: "stale_id" } });
  });
  it("accepts an older explicit parent when newest failed and rejects bad parents", async () => {
    const first = await ingest.create({ title: "Parents", files: [await stored("one")] });
    const second = await ingest.add(first.collection_id, { files: [await stored("two")] });
    const other = await ingest.create({ title: "Other", files: [await stored("other")] });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [second.revision_id]);
    const file = await stored("three");
    const branch = await ingest.add(first.collection_id, {
      parent_revision_id: first.revision_id,
      files: [file],
    });
    expect((await reads.revision(branch.revision_id))?.parent_revision_id).toBe(first.revision_id);
    await expect(
      ingest.add(first.collection_id, { parent_revision_id: second.revision_id, files: [file] }),
    ).rejects.toMatchObject({ code: "parent_failed" });
    await expect(
      ingest.add(first.collection_id, { parent_revision_id: other.revision_id, files: [file] }),
    ).rejects.toMatchObject({
      code: "parent_not_found",
      details: { revision_id: other.revision_id },
    });
    await expect(
      ingest.add(first.collection_id, {
        parent_revision_id: mintRevisionId({ now: Date.now() + 1000 }),
        files: [file],
      }),
    ).rejects.toMatchObject({ code: "parent_not_found" });
    const rows = await reads.revisions(first.collection_id);
    expect(rows.map((row) => row.display_number)).toEqual([1, 2, 3]);
  });
  it("shows committed during the queue crash window, then synced after cleanup", async () => {
    const first = await ingest.create({ title: "States", files: [await stored("one")] });
    const collection = await queue.get<{
      public_id: string;
      title: string;
      metadata: string;
      created_at: number;
    }>("SELECT public_id,title,metadata,created_at FROM pending_collections WHERE id=?", [
      first.collection_id,
    ]);
    const revision = await queue.get<{
      public_id: string;
      collection_id: string;
      parent_revision_id: string | null;
      head_path: string;
      message: string | null;
      metadata: string;
      created_at: number;
    }>(
      "SELECT public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at FROM pending_revisions WHERE id=?",
      [first.revision_id],
    );
    if (!collection || !revision) throw new Error("Missing queue rows");
    await waypoint.run(
      "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
      [
        first.collection_id,
        collection.public_id,
        collection.title,
        collection.metadata,
        collection.created_at,
      ],
    );
    await waypoint.run(
      "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        first.revision_id,
        revision.public_id,
        revision.collection_id,
        revision.parent_revision_id,
        revision.head_path,
        revision.message,
        revision.metadata,
        revision.created_at,
      ],
    );
    expect((await reads.revision(first.revision_id))?.sync_state).toBe("committed");
    expect((await reads.revisions(first.collection_id))[0]?.sync_state).toBe("committed");
    await queue.run("DELETE FROM pending_revisions WHERE id=?", [first.revision_id]);
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      first.revision_id,
      Date.now(),
    ]);
    expect((await reads.revision(first.revision_id))?.sync_state).toBe("committed");
    await queue.run("DELETE FROM unpushed WHERE revision_id=?", [first.revision_id]);
    expect((await reads.revision(first.revision_id))?.sync_state).toBe("synced");
  });
  it("purges a pending collection and its unreferenced local blobs", async () => {
    const file = await stored("purge me");
    const first = await ingest.create({ title: "Purge", files: [file] });
    expect(await blobs.has(file.hash)).toBe(true);
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(file.hash), old, old);
    const response = await app.request(`/api/collections/${first.collection_id}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: first.collection_id }),
    });
    expect(response.status).toBe(202);
    expect(await reads.collection(first.collection_id)).toBeUndefined();
    expect(await blobs.has(file.hash)).toBe(false);
  });
  it("keeps a fresh blob after its pending collection is purged", async () => {
    const file = await stored("fresh upload", "index.txt");
    const first = await ingest.create({ title: "Fresh", files: [file] });
    const response = await app.request(`/api/collections/${first.collection_id}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: first.collection_id }),
    });
    expect(response.status).toBe(202);
    expect(await blobs.has(file.hash)).toBe(true);
    expect(await queue.all("SELECT hash FROM pending_blobs")).toHaveLength(0);
  });
  it("keeps a blob used by another collection's in-flight ingest during purge", async () => {
    const shared = await stored("# Shared", "shared.md");
    const x = await ingest.create({ title: "X", files: [shared] });
    const y = await ingest.create({ title: "Y", files: [await stored("Y head", "index.txt")] });
    let entered: () => void = noop;
    let release: () => void = noop;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRenderer = {
      rendererName: "race-renderer",
      rendererVersion: 1,
      async render() {
        entered();
        await gate;
        return null;
      },
    };
    const racing = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      slowRenderer,
    );
    const racingApp = createApp({ waypoint, queue, blobs, reads, ingest: racing });
    const adding = racing.add(y.collection_id, { files: [shared] });
    await started;
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(blobs.path(shared.hash), old, old);
    const purgePending = racingApp.request(`/api/collections/${x.collection_id}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: x.collection_id }),
    });
    expect(await blobs.has(shared.hash)).toBe(true);
    release();
    const purge = await purgePending;
    expect(purge.status).toBe(202);
    const written = await adding;
    expect(
      (await racingApp.request(`/api/revisions/${written.revision_id}/files/shared.md?source`))
        .status,
    ).toBe(200);
  });
  it("cleans temporary blob files when a client disconnects mid-upload", async () => {
    let sent = false;
    const interrupted = new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(Buffer.alloc(64 * 1024));
        this.destroy(new Error("client disconnected"));
      },
    });
    await expect(blobs.put(interrupted)).rejects.toThrow("client disconnected");
    expect((await readdir(dir)).filter((name) => name.startsWith(".blob-"))).toEqual([]);
  });
  it("serves normalized encoded raw paths and rejects encoded separators", async () => {
    const first = await ingest.create({
      title: "Paths",
      files: [await stored("accent", "café.txt")],
    });
    const detail = await reads.getRevision(first.revision_id);
    const normalizedPaths = await Promise.all(
      ["caf%C3%A9.txt", "cafe%CC%81.txt"].map(async (path) => {
        const response = await app.request(`/api/revisions/${first.revision_id}/files/${path}`);
        expect(response.status).toBe(200);
        return response.text();
      }),
    );
    expect(normalizedPaths).toEqual(["accent", "accent"]);
    const encodedSlash = await app.request(
      `/api/revisions/${first.revision_id}/files/caf%C3%A9%2Fbad.txt`,
    );
    expect(encodedSlash.status).toBe(400);
    expect(await encodedSlash.json()).toMatchObject({ error: { code: "path_invalid" } });
    const publicId = detail.public_id;
    expect((await app.request(`/raw/r/${publicId}/cafe%CC%81.txt`)).status).toBe(200);
    expect((await app.request("/raw/r/doesnotexist/caf%C3%A9.txt")).status).toBe(404);
  });
  it("reuses renditions and renders carried-over markdown when a version is missing", async () => {
    let calls = 0;
    const renderer = {
      rendererName: "test-renderer",
      rendererVersion: 7,
      render() {
        calls++;
        return Promise.resolve({
          bytes: new TextEncoder().encode("<p>rendered</p>"),
          mime: "text/html",
        });
      },
    };
    const markdown = await stored("# Reuse", "index.md");
    const first = await ingest.create({ title: "Rendition", files: [markdown] });
    const renderingIngest = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      renderer,
    );
    await renderingIngest.add(first.collection_id, { files: [await stored("one", "one.txt")] });
    expect(calls).toBe(1);
    await renderingIngest.add(first.collection_id, { files: [await stored("two", "two.txt")] });
    expect(calls).toBe(1);
    expect(await queue.all("SELECT source_hash FROM pending_renditions")).toHaveLength(1);
  });
  it("serves markdown source when rendering fails", async () => {
    const broken = {
      rendererName: "broken",
      rendererVersion: 1,
      render: () => Promise.reject(new Error("renderer crashed")),
    };
    ingest = new IngestService(waypoint, queue, blobs, reads, ingest.sync, undefined, broken);
    app = createApp({ waypoint, queue, blobs, reads, ingest });
    const first = await ingest.create({ title: "Fallback", files: [await stored("# Original")] });
    const raw = await app.request(`/api/revisions/${first.revision_id}/files/index.md`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await raw.text()).toBe("# Original");
  });
  it("returns not_found when a referenced blob is absent locally", async () => {
    const file = await stored("missing", "index.txt");
    const first = await ingest.create({ title: "Missing local blob", files: [file] });
    await blobs.delete(file.hash);
    const response = await app.request(`/api/revisions/${first.revision_id}/files/index.txt`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("refuses to drop a revision being used as an in-flight parent", async () => {
    const first = await ingest.create({
      title: "Drop lock",
      files: [await stored("root", "index.txt")],
    });
    let entered: () => void = noop;
    let release: () => void = noop;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRenderer = {
      rendererName: "slow",
      rendererVersion: 1,
      async render() {
        entered();
        await gate;
        return null;
      },
    };
    const slow = new IngestService(
      waypoint,
      queue,
      blobs,
      reads,
      ingest.sync,
      undefined,
      slowRenderer,
    );
    const slowApp = createApp({ waypoint, queue, blobs, reads, ingest: slow });
    const adding = slow.add(first.collection_id, { files: [await stored("# Child", "child.md")] });
    await started;
    const drop = await slowApp.request(`/api/queue/${first.revision_id}`, { method: "DELETE" });
    expect(drop.status).toBe(409);
    release();
    await adding;
  });
});
