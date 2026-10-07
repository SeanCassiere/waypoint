import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../apps/reader/src/app.js";
import { BlobStore } from "../apps/writer/src/blob-store.js";
import { MemoryBucket } from "../apps/writer/src/bucket.js";
import { WriterCommitter } from "../apps/writer/src/committer.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, type Db } from "../apps/writer/src/db.js";
import { createApp } from "../apps/writer/src/http.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { restore } from "../apps/writer/src/restore.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";
import { hashShareToken, mintRevisionId, newId, publicIdFor } from "../packages/core/src/index.js";

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let bucket: MemoryBucket;
let app: ReturnType<typeof createApp>;
let ingest: IngestService;
let reads: ReadModel;
let collectionId: string;
let revisionId: string;
let collectionPublicId: string;
let revisionPublicId: string;
let hash: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-share-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://waypoint-dev.pingstash.com",
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
  reads = new ReadModel(waypoint, queue, config.baseUrl);
  ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  const sync = new SyncLoop(queue, opened.syncClient, Date.now, waypoint);
  bucket = new MemoryBucket();
  worker = new WriterCommitter(waypoint, queue, blobs, bucket, sync, ingest);
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://waypoint-dev.pingstash.com",
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
  const value: unknown = await created.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    typeof value.collection_id !== "string" ||
    !("revision_id" in value) ||
    typeof value.revision_id !== "string"
  )
    throw new Error("Invalid writer response");
  collectionId = value.collection_id;
  revisionId = value.revision_id;
  await worker.drain();
  const col = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [collectionId],
  );
  const rev = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM revisions WHERE id=?",
    [revisionId],
  );
  if (!col || !rev) throw new Error("Commit missing");
  collectionPublicId = col.public_id;
  revisionPublicId = rev.public_id;
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});
async function create(body: object = {}, headers: Record<string, string> = {}) {
  return app.request(`/api/collections/${collectionId}/share-links`, json(body, headers));
}
describe("writer share links", () => {
  it("creates, lists and revokes while storing and snapshotting only a hash", async () => {
    const created = await create({ label: "review", revision_id: revisionId });
    expect(created.status).toBe(201);
    const data: unknown = await created.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("token" in data) ||
      typeof data.token !== "string" ||
      !("share_link" in data) ||
      !data.share_link ||
      typeof data.share_link !== "object" ||
      !("id" in data.share_link) ||
      typeof data.share_link.id !== "string"
    )
      throw new Error("Invalid share result");
    const id = data.share_link.id;
    expect(data).toMatchObject({
      share_link: { mode: "pinned", status: "active", publicly_available: true },
    });
    const stored = await waypoint.get<{ token_hash: string }>(
      "SELECT token_hash FROM share_links WHERE id=?",
      [id],
    );
    expect(stored?.token_hash).toBe(await hashShareToken(data.token));
    const list = await (await app.request(`/api/collections/${collectionId}/share-links`)).text();
    expect(list).toContain(id);
    expect(list).not.toContain(data.token);
    expect(list).not.toContain(stored?.token_hash);
    await worker.drain();
    const chunks: Uint8Array[] = [];
    for await (const chunk of await bucket.get(`collections/${collectionId}.json`))
      if (chunk instanceof Uint8Array) chunks.push(chunk);
    const snapshot = Buffer.concat(chunks).toString("utf8");
    expect(snapshot).toContain(stored?.token_hash);
    expect(snapshot).not.toContain(data.token);
    const revoked = await app.request(`/api/share-links/${id}/revoke`, json({}));
    expect(revoked.status).toBe(200);
    const first: unknown = await revoked.json();
    const second: unknown = await (
      await app.request(`/api/share-links/${id}/revoke`, json({}))
    ).json();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "revoked" });
  });
  it("enforces configuration, origin, and revision validity", async () => {
    expect((await create({}, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await create({}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await create({ revision_id: "rev_invalid" })).status).toBe(400);
    const other = await app.request(
      "/api/collections",
      json({ title: "Other", files: [{ path: "index.txt", hash }] }),
    );
    const otherValue: unknown = await other.json();
    if (
      !otherValue ||
      typeof otherValue !== "object" ||
      !("revision_id" in otherValue) ||
      typeof otherValue.revision_id !== "string"
    )
      throw new Error("Invalid other collection");
    await worker.drain();
    expect((await create({ revision_id: otherValue.revision_id })).status).toBe(400);
    const failedId = mintRevisionId({ now: Date.now(), parentId: revisionId });
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'failed',0)",
      [
        failedId,
        await publicIdFor(failedId),
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
    expect((await create({ revision_id: failedId })).status).toBe(400);
    const without = createApp({
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
    });
    expect(
      (await without.request(`/api/collections/${collectionId}/share-links`, json({}))).status,
    ).toBe(409);
    expect(
      (await app.request(`/api/collections/${collectionId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await create()).status).toBe(410);
  });
  it("reports unsynced targets and rejects a queued purge", async () => {
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      revisionId,
      Date.now(),
    ]);
    const response = await create();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      share_link: { mode: "latest", publicly_available: false },
    });
    await queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
      collectionId,
      Date.now(),
    ]);
    expect((await create()).status).toBe(410);
  });
  it("renders the share dialog on collection routes", async () => {
    const page = await app.request(`/c/${collectionPublicId}/`);
    const html = await page.text();
    expect(html).toContain("data-share-dialog");
    expect(html).toContain('commandfor="share" command="show-modal"');
    expect(html).toContain("data-share-form");
    expect(html).toContain("Create a public link");
  });
  it("reader accepts a writer-created link against copied cloud rows", async () => {
    const response = await create();
    const created: unknown = await response.json();
    if (
      !created ||
      typeof created !== "object" ||
      !("token" in created) ||
      typeof created.token !== "string"
    )
      throw new Error("Invalid share result");
    const linkRows = await waypoint.all<{
      id: string;
      token_hash: string;
      collection_id: string;
      revision_id: string | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>("SELECT * FROM share_links");
    const db: ReaderDb = {
      all<T>(sql: string, args: (string | number)[] = []) {
        let rows: unknown[] = [];
        if (sql.includes("FROM share_links"))
          rows = linkRows
            .filter((row) => row.token_hash === args[0] || row.id === args[0])
            .map((row) => ({
              ...row,
              public_id: collectionPublicId,
              title: "Shared test",
              deleted_at: null,
            }));
        else if (sql.includes("FROM revisions"))
          rows = [
            { id: revisionId, public_id: revisionPublicId, head_path: "index.txt", created_at: 1 },
          ];
        else if (sql.includes("FROM revision_files"))
          rows = [{ path: "index.txt", blob_hash: hash, mime: "text/plain" }];
        // Typed SQL row boundary in this fake adapter.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return Promise.resolve(rows.map((row) => row as T));
      },
    };
    const reader = createReaderApp({
      db: () => db,
      blob: () => ({
        fetch: () => Promise.resolve(new Response("hello public")),
        probe: () => Promise.resolve(new Response("ok")),
      }),
    });
    const bindings: ReaderEnv = {
      TURSO_DATABASE_URL: "",
      TURSO_READONLY_TOKEN: "",
      R2_ACCOUNT_ID: "",
      R2_READER_ACCESS_KEY_ID: "",
      R2_READER_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const shell = await reader.request(
      `https://waypoint-dev.pingstash.com/s/${created.token}/c/${collectionPublicId}/`,
      {},
      bindings,
    );
    const frame = (await shell.text()).match(/<iframe[^>]+src="([^"]+)"/)?.[1];
    expect(frame).toBeTruthy();
    const raw = await reader.request(frame!, {}, bindings);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("hello public");
  });
  it("restores links from bucket and merge never un-revokes", async () => {
    const created: unknown = await (await create()).json();
    if (
      !created ||
      typeof created !== "object" ||
      !("share_link" in created) ||
      !created.share_link ||
      typeof created.share_link !== "object" ||
      !("id" in created.share_link) ||
      typeof created.share_link.id !== "string"
    )
      throw new Error("Invalid share result");
    await worker.drain();
    const restoreDir = await mkdtemp(join(tmpdir(), "waypoint-share-restore-"));
    const cfg: Config = {
      environment: "dev",
      dataDir: restoreDir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    };
    const opened = await openDatabases(cfg);
    try {
      await migrate(opened.waypoint, waypointMigrations);
      await migrate(opened.queue, queueMigrations);
      const sync = new SyncLoop(opened.queue, opened.syncClient, Date.now, opened.waypoint);
      await restore(opened.waypoint, bucket, sync, "from-bucket");
      expect(
        await opened.waypoint.get("SELECT id FROM share_links WHERE id=?", [created.share_link.id]),
      ).toBeTruthy();
      await opened.waypoint.run("UPDATE share_links SET revoked_at=? WHERE id=?", [
        123,
        created.share_link.id,
      ]);
      await restore(opened.waypoint, bucket, sync, "merge");
      expect(
        await opened.waypoint.get("SELECT revoked_at FROM share_links WHERE id=?", [
          created.share_link.id,
        ]),
      ).toEqual({ revoked_at: 123 });
    } finally {
      await opened.waypoint.close();
      await opened.queue.close();
      await rm(restoreDir, { recursive: true, force: true });
    }
  });
  it("merge keeps the later expiry from either side, and revoked stays revoked", async () => {
    const soon = Date.now() + 3_600_000;
    const id = await createdId(await create({ expires_at: soon }));
    const other = await createdId(await create({ expires_at: soon }));
    const forever = await createdId(await create({}));
    await worker.drain();
    const restoreDir = await mkdtemp(join(tmpdir(), "waypoint-share-restore-"));
    const opened = await openDatabases({
      environment: "dev",
      dataDir: restoreDir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    });
    const expiry = async (link: string) =>
      (
        await opened.waypoint.get<{ expires_at: number | null; revoked_at: number | null }>(
          "SELECT expires_at,revoked_at FROM share_links WHERE id=?",
          [link],
        )
      )?.expires_at;
    try {
      await migrate(opened.waypoint, waypointMigrations);
      await migrate(opened.queue, queueMigrations);
      const sync = new SyncLoop(opened.queue, opened.syncClient, Date.now, opened.waypoint);
      await restore(opened.waypoint, bucket, sync, "from-bucket");
      expect(await expiry(id)).toBe(soon);
      // The writer extends one link; the restored copy extends the other further and revokes it.
      const extended = soon + 86_400_000;
      expect(
        (await app.request(`/api/share-links/${id}/extend`, json({ expires_at: extended }))).status,
      ).toBe(200);
      await worker.drain();
      await opened.waypoint.run("UPDATE share_links SET expires_at=?, revoked_at=? WHERE id=?", [
        soon + 2 * 86_400_000,
        123,
        other,
      ]);
      await restore(opened.waypoint, bucket, sync, "merge");
      expect(await expiry(id)).toBe(extended);
      expect(await expiry(other)).toBe(soon + 2 * 86_400_000);
      expect(
        await opened.waypoint.get("SELECT revoked_at FROM share_links WHERE id=?", [other]),
      ).toEqual({ revoked_at: 123 });
      // Null (never expires) survives only when both sides are null.
      expect(await expiry(forever)).toBeNull();
      await opened.waypoint.run("UPDATE share_links SET expires_at=NULL WHERE id=?", [id]);
      await restore(opened.waypoint, bucket, sync, "merge");
      expect(await expiry(id)).toBe(extended);
      expect(await expiry(forever)).toBeNull();
    } finally {
      await opened.waypoint.close();
      await opened.queue.close();
      await rm(restoreDir, { recursive: true, force: true });
    }
  });
  it("purge removes local links", async () => {
    expect((await create()).status).toBe(201);
    expect(
      (await app.request(`/api/collections/${collectionId}/purge`, json({ confirm: collectionId })))
        .status,
    ).toBe(202);
    await worker.drain();
    expect(
      await waypoint.get("SELECT id FROM share_links WHERE collection_id=?", [collectionId]),
    ).toBeUndefined();
  });
  it("revokes links when purge is accepted even if bucket deletion keeps failing", async () => {
    const created: unknown = await (await create()).json();
    if (
      !created ||
      typeof created !== "object" ||
      !("share_link" in created) ||
      !created.share_link ||
      typeof created.share_link !== "object" ||
      !("id" in created.share_link) ||
      typeof created.share_link.id !== "string"
    )
      throw new Error("Missing share link");
    bucket.delete = () => Promise.reject(new Error("bucket unavailable"));
    const response = await app.request(
      `/api/collections/${collectionId}/purge`,
      json({ confirm: collectionId }),
    );
    expect(response.status).toBe(202);
    expect(
      typeof (
        await waypoint.get<{ revoked_at: number }>(
          "SELECT revoked_at FROM share_links WHERE id=?",
          [created.share_link.id],
        )
      )?.revoked_at,
    ).toBe("number");
    await worker.drain();
    expect(
      typeof (
        await waypoint.get<{ revoked_at: number }>(
          "SELECT revoked_at FROM share_links WHERE id=?",
          [created.share_link.id],
        )
      )?.revoked_at,
    ).toBe("number");
    expect(
      await queue.get("SELECT step FROM pending_purges WHERE collection_id=?", [collectionId]),
    ).toBeTruthy();
  });
  it("allows links to queued targets and removes them on pending purge", async () => {
    worker.stop();
    await worker.drain();
    const pendingCollection = newId("col");
    const pendingRevision = mintRevisionId({ now: Date.now() });
    await queue.run(
      "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
      [pendingCollection, await publicIdFor(pendingCollection), "Pending share", "{}", Date.now()],
    );
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
      [
        pendingRevision,
        await publicIdFor(pendingRevision),
        pendingCollection,
        null,
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
    const response = await app.request(
      `/api/collections/${pendingCollection}/share-links`,
      json({ revision_id: pendingRevision }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      share_link: { mode: "pinned", publicly_available: false },
    });
    expect(
      await waypoint.get("SELECT id FROM share_links WHERE collection_id=?", [pendingCollection]),
    ).toBeTruthy();
    expect(
      (
        await app.request(
          `/api/collections/${pendingCollection}/purge`,
          json({ confirm: pendingCollection }),
        )
      ).status,
    ).toBe(202);
    expect(
      await waypoint.get("SELECT id FROM share_links WHERE collection_id=?", [pendingCollection]),
    ).toBeUndefined();
  });
});

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
async function createdId(response: Response): Promise<string> {
  const link = (await jsonBody(response)).share_link;
  const id = link && typeof link === "object" && "id" in link ? link.id : undefined;
  if (typeof id !== "string") throw new Error("No link id");
  return id;
}
async function queryCount(path: string): Promise<number> {
  // Let background committer passes (e.g. the standalone-rendition step) finish so
  // their queries aren't attributed to the page being measured.
  await worker.drain();
  await worker.drain();
  const spies = [
    vi.spyOn(queue, "all"),
    vi.spyOn(queue, "get"),
    vi.spyOn(waypoint, "all"),
    vi.spyOn(waypoint, "get"),
  ];
  await app.request(path);
  const total = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  for (const spy of spies) spy.mockRestore();
  return total;
}
describe("share links for the Folio UI (B3, B4)", () => {
  it("derives state and public_sees from pushes, revocation and expiry", async () => {
    const loop = new SyncLoop(queue, ingest.sync, Date.now, waypoint);
    const live = createApp({
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
      syncLoop: loop,
      publicBaseUrl: "https://waypoint-dev.pingstash.com",
    });
    const pinned = await createdId(await create({ revision_id: revisionId, label: "pinned" }));
    const latest = await createdId(await create({ expires_at: Date.now() + 3_600_000 }));
    const get = async (id: string) =>
      (await jsonBody(await live.request(`/api/share-links/${id}`))).share_link;
    expect(await get(pinned)).toMatchObject({
      state: "activating",
      revision_display_number: 1,
      public_sees: { revision_id: revisionId, display_number: 1 },
    });
    loop.lastPushAt = Date.now() + 1;
    expect(await get(latest)).toMatchObject({
      state: "active",
      revision_display_number: null,
      public_sees: { display_number: 1 },
    });
    // A newer, unpushed revision: Latest keeps showing #1 until it syncs.
    const next = await app.request(
      `/api/collections/${collectionId}/revisions`,
      json({ files: [{ path: "two.txt", hash }] }),
    );
    expect(next.status).toBe(200);
    const nextId = (await jsonBody(next)).revision_id;
    await worker.drain();
    await queue.run("INSERT OR IGNORE INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      String(nextId),
      Date.now(),
    ]);
    expect(await get(latest)).toMatchObject({ public_sees: { display_number: 1 } });
    await queue.run("DELETE FROM unpushed");
    expect(await get(latest)).toMatchObject({ public_sees: { display_number: 2 } });
    expect((await live.request(`/api/share-links/${pinned}/revoke`, json({}))).status).toBe(200);
    expect(await get(pinned)).toMatchObject({ state: "revoking", public_sees: null });
    await waypoint.run("UPDATE share_links SET revoked_at=? WHERE id=?", [
      Date.now() - 120_000,
      pinned,
    ]);
    expect(await get(pinned)).toMatchObject({ state: "revoked" });
    await waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [Date.now() - 1, latest]);
    expect(await get(latest)).toMatchObject({ state: "expired", public_sees: null });
    expect((await live.request("/api/share-links/shl_missing")).status).toBe(404);
  });
  it("lists every link with its collection, filters by state, and revokes in bulk", async () => {
    const a = await createdId(await create({ label: "a" }));
    await createdId(await create({ label: "b", revision_id: revisionId }));
    await app.request(`/api/share-links/${a}/revoke`, json({}));
    const all = await jsonBody(await app.request("/api/share-links"));
    expect(Array.isArray(all.share_links) && all.share_links.length).toBe(2);
    expect(JSON.stringify(all)).toContain(`"public_id":"${collectionPublicId}"`);
    const active = await jsonBody(await app.request("/api/share-links?state=active"));
    expect(Array.isArray(active.share_links) && active.share_links.length).toBe(1);
    expect((await app.request("/api/share-links?state=bogus")).status).toBe(400);
    expect(
      await jsonBody(
        await app.request(`/api/collections/${collectionId}/share-links/revoke-all`, json({})),
      ),
    ).toEqual({ revoked: 1 });
    await create({ label: "c" });
    expect(
      await jsonBody(await app.request("/api/share-links/revoke-all?state=active", json({}))),
    ).toEqual({ revoked: 1 });
    expect(
      (
        await app.request(
          "/api/share-links/revoke-all",
          json({}, { origin: "https://attacker.example" }),
        )
      ).status,
    ).toBe(403);
    const page = await (await app.request("/links?state=revoked")).text();
    expect(page).toContain("Public links");
    expect(page).toContain("Shared test");
  });
  it("extends expiry only later, and never for revoked or open-ended links", async () => {
    const soon = Date.now() + 3_600_000;
    const id = await createdId(await create({ expires_at: soon }));
    const extend = (expires: number, target = id) =>
      app.request(`/api/share-links/${target}/extend`, json({ expires_at: expires }));
    expect((await extend(soon - 1000)).status).toBe(400);
    const later = await extend(soon + 7 * 86_400_000);
    expect(later.status).toBe(200);
    expect(await jsonBody(later)).toMatchObject({
      share_link: { expires_at: soon + 7 * 86_400_000 },
    });
    // Retrying the same extension succeeds and changes nothing (no write, no snapshot).
    await worker.drain();
    const writes = [vi.spyOn(waypoint, "run"), vi.spyOn(queue, "run")];
    const again = await extend(soon + 7 * 86_400_000);
    const calls = writes.flatMap((spy) => spy.mock.calls.map((call) => call[0]));
    writes.forEach((spy) => spy.mockRestore());
    expect(again.status).toBe(200);
    expect(await jsonBody(again)).toMatchObject({
      share_link: { expires_at: soon + 7 * 86_400_000 },
    });
    expect(calls.filter((sql) => /share_links|pending_snapshots/.test(sql))).toEqual([]);
    expect((await extend(soon + 7 * 86_400_000 - 1)).status).toBe(400);
    const forever = await createdId(await create({}));
    expect((await extend(soon, forever)).status).toBe(409);
    await app.request(`/api/share-links/${id}/revoke`, json({}));
    expect((await extend(soon + 30 * 86_400_000)).status).toBe(409);
  });
  it("summarizes live links on search results and renders the Links tab, chip and status segment", async () => {
    await create({ label: "Design review — Sam" });
    await create({ revision_id: revisionId });
    const search = await reads.searchCollections({});
    expect(search.collections[0]?.share).toEqual({ active: 2, follows_latest: true });
    const html = await (await app.request(`/c/${collectionPublicId}/?panel=links`)).text();
    expect(html).toContain('class="chip public hide-sm"');
    expect(html).toContain("follows latest");
    expect(html).toContain("Revoke all 2…");
    expect(html).toContain('aria-selected="true"');
    expect(html).toMatch(/id="tab-links"[^>]*aria-selected="true"/);
    const recent = await (await app.request("/")).text();
    expect(recent).toContain("Public · follows latest");
    expect(recent).toContain("Public now");
    const preview = await app.request(`/c/${collectionPublicId}/?as=public`);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain("Read-only · shared with you");
    expect(previewHtml).toContain(
      'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"',
    );
    expect(previewHtml).toContain(`/raw/r/${revisionPublicId}/index.txt`);
  });
  it("previews what the public sees, including files only the public revision has", async () => {
    // #1 (synced) has index.txt; #2 replaces it with two.txt and hasn't synced.
    const next = await app.request(
      `/api/collections/${collectionId}/revisions`,
      json({ mode: "replace", head_path: "two.txt", files: [{ path: "two.txt", hash }] }),
    );
    expect(next.status).toBe(200);
    const nextId = String((await jsonBody(next)).revision_id);
    await worker.drain();
    await queue.run("INSERT OR IGNORE INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      nextId,
      Date.now(),
    ]);
    const nextPub = (
      await waypoint.get<{ public_id: string }>("SELECT public_id FROM revisions WHERE id=?", [
        nextId,
      ])
    )?.public_id;
    const only = await app.request(`/c/${collectionPublicId}/index.txt?as=public`);
    expect(only.status).toBe(200);
    const onlyHtml = await only.text();
    expect(onlyHtml).toContain("Read-only · shared with you");
    expect(onlyHtml).toContain(`/raw/r/${revisionPublicId}/index.txt`);
    expect(onlyHtml).not.toContain("two.txt");
    // A pinned preview of the unsynced revision explains instead of showing it.
    const pinned = await app.request(`/c/${collectionPublicId}/r/${nextPub}/?as=public`);
    expect(pinned.status).toBe(200);
    const pinnedHtml = await pinned.text();
    expect(pinnedHtml).toContain("#2 isn&#39;t public yet.");
    expect(pinnedHtml).not.toContain(`/raw/r/${nextPub}/`);
    // Nothing synced at all: no revision is presented as public.
    await queue.run("INSERT OR IGNORE INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      revisionId,
      Date.now(),
    ]);
    const none = await app.request(`/c/${collectionPublicId}/?as=public`);
    expect(none.status).toBe(200);
    const noneHtml = await none.text();
    expect(noneHtml).toContain("Nothing is public yet.");
    expect(noneHtml).toContain('data-preview="not-public"');
    expect(noneHtml).not.toContain("/raw/r/");
    expect(noneHtml).not.toContain("Read-only · shared with you");
  });
  it("keeps query counts constant as links grow on the shell, Recent and /links", async () => {
    await create({ label: "first" });
    // Warm the change-count cache, so both measurements are of a warm shell.
    await app.request(`/c/${collectionPublicId}/`);
    const before = [
      await queryCount(`/c/${collectionPublicId}/`),
      await queryCount("/"),
      await queryCount("/links"),
    ];
    for (let i = 0; i < 20; i++) await create({ label: `link ${i}` });
    const after = [
      await queryCount(`/c/${collectionPublicId}/`),
      await queryCount("/"),
      await queryCount("/links"),
    ];
    expect(after).toEqual(before);
    expect(after[0]).toBeLessThan(30);
    expect(after[1]).toBeLessThan(25);
  });
  it("keeps Recent and /links query counts constant as shared collections grow", async () => {
    const shared = async (title: string) => {
      const response = await app.request(
        "/api/collections",
        json({ title, files: [{ path: "index.txt", hash }] }),
      );
      const id = String((await jsonBody(response)).collection_id);
      await worker.drain();
      for (const label of ["a", "b"])
        expect(
          (await app.request(`/api/collections/${id}/share-links`, json({ label }))).status,
        ).toBe(201);
    };
    await create({ label: "first" });
    await shared("Second");
    const before = [await queryCount("/"), await queryCount("/links")];
    for (let i = 0; i < 8; i++) await shared(`Shared ${i}`);
    const after = [await queryCount("/"), await queryCount("/links")];
    expect(after).toEqual(before);
    expect(after[0]).toBeLessThan(25);
    expect(after[1]).toBeLessThan(25);
    const links = await (await app.request("/links")).text();
    expect(links).toContain("Shared 7");
    expect(links).toContain("Second");
  });
});
