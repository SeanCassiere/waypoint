import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(html).toContain('data-action="share"');
    expect(html).toContain("data-share-form");
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
