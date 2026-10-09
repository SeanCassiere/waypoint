import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveShareToken,
  hashShareToken,
  mintRevisionId,
  newId,
  newShareToken,
  publicIdFor,
} from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../apps/reader/src/app.ts";
import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { restore } from "../apps/writer/src/restore.ts";
import { URL_UNAVAILABLE } from "../apps/writer/src/shares.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";

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
/** A fixed test key (never a real one). */
const shareTokenKey = new Uint8Array(32).fill(42);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-share-"));
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
    expect(list).not.toContain(stored?.token_hash);
    expect(list).not.toContain("token_hash");
    await worker.drain();
    const chunks: Uint8Array[] = [];
    for await (const chunk of await bucket.get(`collections/${collectionId}.json`))
      if (chunk instanceof Uint8Array) chunks.push(chunk);
    const snapshot = Buffer.concat(chunks).toString("utf8");
    expect(snapshot).toContain(stored?.token_hash);
    expect(snapshot).not.toContain(data.token);
    // Snapshots carry the stored columns only: never the token or the derived URL.
    const parsed = z
      .object({ share_links: z.array(z.record(z.string(), z.unknown())) })
      .parse(JSON.parse(snapshot));
    expect(parsed.share_links).toHaveLength(1);
    for (const link of parsed.share_links) {
      expect(link).not.toHaveProperty("url");
      expect(link).not.toHaveProperty("token");
    }
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
      `https://reader-dev.example.test/s/${created.token}/c/${collectionPublicId}/`,
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
  it("merge keeps the later expiry from either side, never-expiring wins, and revoked stays revoked", async () => {
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
      // Never expiring (null) is final (D48): it wins on either side.
      expect(await expiry(forever)).toBeNull();
      await opened.waypoint.run("UPDATE share_links SET expires_at=NULL WHERE id=?", [id]);
      await opened.waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [soon, forever]);
      await restore(opened.waypoint, bucket, sync, "merge");
      expect(await expiry(id)).toBeNull();
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

describe("deterministic share-link tokens (D50)", () => {
  const base = "https://reader-dev.example.test";
  const links = z.object({
    share_links: z.array(z.object({ id: z.string(), url: z.string().nullable() })),
  });
  it("stores the hash of the token derived from the link ID", async () => {
    const created = z
      .object({
        share_link: z.object({ id: z.string(), url: z.string() }),
        url: z.string(),
        token: z.string(),
      })
      .parse(await jsonBody(await create()));
    const token = await deriveShareToken(shareTokenKey, created.share_link.id);
    expect(created.token).toBe(token);
    const stored = await waypoint.get<{ token_hash: string }>(
      "SELECT token_hash FROM share_links WHERE id=?",
      [created.share_link.id],
    );
    expect(stored?.token_hash).toBe(await hashShareToken(token));
    // A stable URL without a file path: the reader opens the head file.
    expect(created.url).toBe(`${base}/s/${token}/c/${collectionPublicId}/`);
    expect(created.share_link.url).toBe(created.url);
    const pinned = z
      .object({ share_link: z.object({ url: z.string() }), url: z.string(), token: z.string() })
      .parse(await jsonBody(await create({ revision_id: revisionId })));
    expect(pinned.url).toBe(
      `${base}/s/${pinned.token}/c/${collectionPublicId}/r/${revisionPublicId}/`,
    );
    expect(pinned.share_link.url).toBe(pinned.url);
  });
  it("reports the same URL on every share-link response, never the stored hash", async () => {
    const created = z
      .object({ share_link: z.object({ id: z.string() }), url: z.string() })
      .parse(await jsonBody(await create({ expires_at: Date.now() + 3_600_000 })));
    const { id } = created.share_link;
    const { url } = created;
    const single = z.object({ share_link: z.object({ url: z.string().nullable() }) });
    const responses = [
      await app.request(`/api/collections/${collectionId}/share-links`),
      await app.request("/api/share-links"),
      await app.request(`/api/share-links/${id}`),
      await app.request(`/api/share-links/${id}/url`),
      await app.request(
        `/api/share-links/${id}/extend`,
        json({ expires_at: Date.now() + 7_200_000 }),
      ),
      await app.request(`/api/share-links/${id}/revoke`, json({})),
    ];
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    for (const body of bodies) expect(body).not.toContain("token_hash");
    const [collection, all, get, direct, extended, revoked] = bodies.map((body): unknown =>
      JSON.parse(body ?? "null"),
    );
    expect(links.parse(collection).share_links[0]?.url).toBe(url);
    expect(links.parse(all).share_links[0]?.url).toBe(url);
    expect(single.parse(get).share_link.url).toBe(url);
    expect(direct).toEqual({ url });
    expect(single.parse(extended).share_link.url).toBe(url);
    // Revoke answers with the link itself, still carrying its URL.
    expect(z.object({ url: z.string().nullable() }).parse(revoked).url).toBe(url);
  });
  it("reports null and 409 for links created before deterministic tokens", async () => {
    const legacy = await legacyLink();
    const current = await createdId(await create());
    const list = links.parse(
      await jsonBody(await app.request(`/api/collections/${collectionId}/share-links`)),
    );
    expect(list.share_links.find((link) => link.id === legacy)?.url).toBeNull();
    expect(list.share_links.find((link) => link.id === current)?.url).toMatch(/^https:/);
    const get = await jsonBody(await app.request(`/api/share-links/${legacy}`));
    expect(get.share_link).toMatchObject({ url: null });
    const response = await app.request(`/api/share-links/${legacy}/url`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: URL_UNAVAILABLE,
      },
    });
    expect((await app.request("/api/share-links/shl_missing/url")).status).toBe(404);
    // A different key can't reproduce existing links' URLs.
    const rotated = createApp({
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
      publicBaseUrl: base,
      shareTokenKey: new Uint8Array(32).fill(7),
    });
    expect((await rotated.request(`/api/share-links/${current}/url`)).status).toBe(409);
  });
  it("needs the key only to create links and show URLs; the public URL for everything", async () => {
    const id = await createdId(await create());
    const services = {
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
    };
    // Without a public URL nothing about links works.
    for (const partial of [createApp({ ...services, shareTokenKey }), createApp(services)]) {
      for (const response of [
        await partial.request(`/api/collections/${collectionId}/share-links`, json({})),
        await partial.request(`/api/collections/${collectionId}/share-links`),
        await partial.request("/api/share-links"),
        await partial.request(`/api/share-links/${id}`),
        await partial.request(`/api/share-links/${id}/url`),
        await partial.request(`/api/share-links/${id}/revoke`, json({})),
      ]) {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: "conflict", message: "Sharing is not configured" },
        });
      }
    }
    // Without the key, existing links can still be listed, extended and revoked (with
    // url: null); only creating links and showing URLs need it.
    const keyless = createApp({ ...services, publicBaseUrl: base });
    for (const response of [
      await keyless.request(`/api/collections/${collectionId}/share-links`, json({})),
      await keyless.request(`/api/share-links/${id}/url`),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "conflict",
          message: "Sharing is not configured: WAYPOINT_SHARE_TOKEN_KEY is not set",
        },
      });
    }
    const listed = await jsonBody(
      await keyless.request(`/api/collections/${collectionId}/share-links`),
    );
    expect(listed.share_links).toEqual([expect.objectContaining({ id, url: null })]);
    expect((await keyless.request("/api/share-links")).status).toBe(200);
    expect(await jsonBody(await keyless.request(`/api/share-links/${id}`))).toMatchObject({
      share_link: { id, url: null },
    });
    const later = await create({ expires_at: Date.now() + 3_600_000 });
    const expiring = await createdId(later);
    expect(
      (
        await keyless.request(
          `/api/share-links/${expiring}/extend`,
          json({ expires_at: Date.now() + 7_200_000 }),
        )
      ).status,
    ).toBe(200);
    expect((await keyless.request(`/api/share-links/${id}/revoke`, json({}))).status).toBe(200);
    expect(
      (await keyless.request(`/api/collections/${collectionId}/share-links/revoke-all`, json({})))
        .status,
    ).toBe(200);
  });
});

/** Inserts a link the way writers did before D50: a random token's hash. */
async function legacyLink(): Promise<string> {
  const id = newId("shl");
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, await hashShareToken(newShareToken()), collectionId, null, "old", null, null, Date.now()],
  );
  return id;
}
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
      publicBaseUrl: "https://reader-dev.example.test",
      shareTokenKey,
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
    loop.recordPush(Date.now() + 1, Date.now() + 2);
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
    // Pushes are recorded by hand from here on, so the test decides when the cloud has it.
    vi.spyOn(loop, "triggerPush").mockImplementation(() => undefined);
    expect((await live.request(`/api/share-links/${pinned}/revoke`, json({}))).status).toBe(200);
    // Not pushed yet: revoking, and the reader still serves it.
    expect(await get(pinned)).toMatchObject({
      state: "revoking",
      revocation_pushed: false,
      public_sees: null,
    });
    const revoked = await waypoint.get<{ revoked_at: number }>(
      "SELECT revoked_at FROM share_links WHERE id=?",
      [pinned],
    );
    const revokedAt = revoked?.revoked_at ?? 0;
    // A push that started before the revocation doesn't carry it, even if it finishes after.
    loop.recordPush(revokedAt - 5, revokedAt + 5);
    expect(await get(pinned)).toMatchObject({ state: "revoking", revocation_pushed: false });
    // Pushed long after the revocation, but only just: the settle window runs from the push.
    loop.recordPush(revokedAt + 60_000, Date.now() - 1_000);
    expect(await get(pinned)).toMatchObject({ state: "revoking", revocation_pushed: true });
    // 10 s (SETTLE_MS) after the push that carried it: revoked.
    await waypoint.run("UPDATE share_links SET revoked_at=? WHERE id=?", [
      Date.now() - 60_000,
      pinned,
    ]);
    loop.recordPush(Date.now() - 59_000, Date.now() - 11_000);
    expect(await get(pinned)).toMatchObject({ state: "revoked", revocation_pushed: true });
    await waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [Date.now() - 1, latest]);
    expect(await get(latest)).toMatchObject({ state: "expired", public_sees: null });
    expect((await live.request("/api/share-links/shl_missing")).status).toBe(404);
  });
  it("chunks the token-hash lookup and skips it where URLs aren't shown", async () => {
    const made = await createdId(await create({ label: "derived" }));
    const now = Date.now();
    await waypoint.transaction(async (tx) => {
      for (let index = 0; index < 1_200; index++)
        await tx.run(
          "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            newId("shl"),
            `sha256:${index.toString(16).padStart(64, "0")}`,
            collectionId,
            null,
            null,
            null,
            null,
            now,
          ],
        );
    });
    const spy = vi.spyOn(waypoint, "all");
    const listed = await jsonBody(
      await app.request(`/api/collections/${collectionId}/share-links`),
    );
    const lookups = spy.mock.calls.filter(([sql]) =>
      sql.startsWith("SELECT id,token_hash FROM share_links WHERE id IN"),
    );
    expect(lookups).toHaveLength(3);
    expect(lookups.every(([, args]) => Array.isArray(args) && args.length <= 500)).toBe(true);
    const links = z
      .array(z.object({ id: z.string(), url: z.string().nullable() }))
      .parse(listed.share_links);
    expect(links).toHaveLength(1_201);
    expect(links.find((link) => link.id === made)?.url).toMatch(/^https:/);
    spy.mockClear();
    expect((await app.request(`/api/share-links/revoke-all?state=active`, json({}))).status).toBe(
      200,
    );
    expect((await app.request("/trash")).status).toBe(200);
    expect(
      spy.mock.calls.some(([sql]) =>
        sql.startsWith("SELECT id,token_hash FROM share_links WHERE id IN"),
      ),
    ).toBe(false);
    spy.mockRestore();
  });
  it("after a restart, a revocation pushed before it reads as pushed and settled", async () => {
    const id = await createdId(await create({ label: "before restart" }));
    expect((await app.request(`/api/share-links/${id}/revoke`, json({}))).status).toBe(200);
    const now = Date.now();
    await waypoint.run("UPDATE share_links SET revoked_at=? WHERE id=?", [now - 60_000, id]);
    // The previous process pushed it (queue.db keeps the last successful push).
    await queue.run("INSERT OR REPLACE INTO last_push (id,started_at,finished_at) VALUES (1,?,?)", [
      now - 50_000,
      now - 30_000,
    ]);
    const restarted = new SyncLoop(queue, ingest.sync, Date.now, waypoint);
    await restarted.load();
    const after = createApp({
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
      syncLoop: restarted,
      publicBaseUrl: "https://reader-dev.example.test",
      shareTokenKey,
    });
    expect(
      (await jsonBody(await after.request(`/api/share-links/${id}`))).share_link,
    ).toMatchObject({ state: "revoked", revocation_pushed: true });
    const card = await viewerHtml(`/c/${collectionPublicId}/?panel=links`, after);
    expect(card).not.toContain("not yet pushed");
    // Without the persisted push it would have read "not yet pushed".
    const cold = new SyncLoop(queue, ingest.sync, Date.now, waypoint);
    expect(cold.pushedAt(now - 60_000)).toBeNull();
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
    expect(all.next_cursor).toBeNull();
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
  it("pages GET /api/share-links with limit and cursor", async () => {
    const ids: string[] = [];
    for (const label of ["one", "two", "three", "four", "five"])
      ids.push(await createdId(await create({ label })));
    await app.request(`/api/share-links/${ids[1]}/revoke`, json({}));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = await jsonBody(await app.request(`/api/share-links?limit=2${query}`));
      const links = z.array(z.object({ id: z.string() })).parse(page.share_links);
      expect(links.length).toBeLessThanOrEqual(2);
      seen.push(...links.map((link) => link.id));
      cursor = z.string().nullable().parse(page.next_cursor);
      pages++;
    } while (cursor && pages < 10);
    // Each link exactly once, across three pages.
    expect(pages).toBe(3);
    expect(seen.toSorted()).toEqual(ids.toSorted());
    const active = await jsonBody(await app.request("/api/share-links?state=active&limit=3"));
    const activeIds = z.array(z.object({ id: z.string() })).parse(active.share_links);
    expect(activeIds).toHaveLength(3);
    expect(activeIds.map((link) => link.id)).not.toContain(ids[1]);
    expect(active.next_cursor).toEqual(expect.any(String));
    for (const bad of ["limit=0", "limit=201", "limit=1.5", "limit=x", "cursor=nope"])
      expect((await app.request(`/api/share-links?${bad}`)).status).toBe(400);
    expect((await app.request("/api/share-links?limit=200")).status).toBe(200);
  });
  it("won't revive a link that expires between the check and the update", async () => {
    const soon = Date.now() + 3_600_000;
    const id = await createdId(await create({ expires_at: soon }));
    const past = Date.now() - 1;
    // The link passes the expiry check, then expires just before the UPDATE runs.
    const run = waypoint.run.bind(waypoint);
    const spy = vi.spyOn(waypoint, "run").mockImplementation(async (sql, args) => {
      if (sql.startsWith("UPDATE share_links SET expires_at=?"))
        await run("UPDATE share_links SET expires_at=? WHERE id=?", [past, id]);
      return run(sql, args);
    });
    const response = await app.request(
      `/api/share-links/${id}/extend`,
      json({ expires_at: soon + 86_400_000 }),
    );
    spy.mockRestore();
    expect(response.status).toBe(409);
    expect(await jsonBody(response)).toMatchObject({
      error: { code: "conflict", message: "Share link has expired" },
    });
    expect(await waypoint.get("SELECT expires_at FROM share_links WHERE id=?", [id])).toEqual({
      expires_at: past,
    });
  });
  it("summarizes live links on search results and renders the Links tab, chip and status segment", async () => {
    await create({ label: "Design review — Sam" });
    await create({ revision_id: revisionId });
    const search = await reads.searchCollections({});
    expect(search.collections[0]?.share).toEqual({ active: 2, follows_latest: true, paused: 0 });
    const html = await (await app.request(`/c/${collectionPublicId}/?panel=links`)).text();
    // NAV-04 removed the bar's duplicate Public chip; the Links tab and the status line say it.
    expect(html).not.toContain('class="chip public hide-sm"');
    expect(html).toContain("follows latest");
    expect(html).toContain("Revoke all 2 links…");
    expect(html).toContain('aria-selected="true"');
    expect(html).toMatch(/id="tab-links"[^>]*aria-selected="true"/);
    const recent = await (await app.request("/")).text();
    expect(recent).toContain("Public · follows latest");
    expect(recent).toContain("Public now");
    const preview = await app.request(`/c/${collectionPublicId}/?as=public`);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('popovertarget="about"');
    // The owner's band: a region right after the skip link that says what a Latest link shows.
    expect(previewHtml).toContain('role="region" aria-label="Public preview"');
    expect(previewHtml).toContain("data-preview-banner");
    expect(previewHtml.indexOf('class="skip"')).toBeLessThan(
      previewHtml.indexOf("data-preview-banner"),
    );
    expect(previewHtml).not.toContain('role="note"');
    expect(previewHtml).toContain("A Latest link shows <b>#1</b>, the latest.");
    expect(previewHtml.replace(/<\/?b>/g, "")).toContain("A Latest link shows #1, the latest.");
    // The band's own <style> uses the public tokens (which follow the colour scheme), isn't
    // sticky, and the writer's CSP doesn't block it.
    const bandStyle = /<style>([^<]*\.wp-pv\{[^<]*)<\/style>/.exec(previewHtml)?.[1] ?? "";
    expect(bandStyle).toContain("var(--public-bg)");
    expect(bandStyle).not.toContain("sticky");
    expect(bandStyle).not.toContain("system-ui");
    expect(preview.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
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
    expect(onlyHtml).toContain('popovertarget="about"');
    expect(onlyHtml).toContain(`/raw/r/${revisionPublicId}/index.txt`);
    expect(onlyHtml).not.toContain("two.txt");
    // A pinned preview of the unsynced revision explains instead of showing it, and offers what
    // Latest links show.
    const pinned = await app.request(`/c/${collectionPublicId}/r/${nextPub}/?as=public`);
    expect(pinned.status).toBe(200);
    const pinnedHtml = await pinned.text();
    expect(pinnedHtml).toContain("#2 isn&#39;t public yet.");
    expect(pinnedHtml).toContain('data-preview="uploading"');
    expect(pinnedHtml).toMatch(
      new RegExp(
        `<a class="btn primary" href="/c/${collectionPublicId}/\\?as=public">.*Preview #1, what the public sees</a>`,
      ),
    );
    expect(pinnedHtml).not.toContain(`/raw/r/${nextPub}/`);
    // A failed revision: says no public link can show it, offers Retry and the Latest preview.
    const failedId = mintRevisionId({ now: Date.now(), parentId: revisionId });
    const failedPub = await publicIdFor(failedId);
    await queue.run(
      "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts,last_error) VALUES (?,?,?,?,?,?,?,?,?,'failed',1,?)",
      [
        failedId,
        failedPub,
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
        "R2 PUT timed out",
      ],
    );
    const failed = await app.request(`/c/${collectionPublicId}/r/${failedPub}/?as=public`);
    expect(failed.status).toBe(200);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain('data-preview="failed"');
    expect(failedHtml).toContain("#3 failed to upload, so no public link can show it.");
    expect(failedHtml).toMatch(
      new RegExp(`<button[^>]*data-action="retry"[^>]*data-ids="${failedId}"[^>]*>Retry #3<`),
    );
    expect(failedHtml).toContain("failed · R2 PUT timed out");
    expect(failedHtml).toContain(`href="/c/${collectionPublicId}/?as=public"`);
    expect(failedHtml).toContain("Preview #1, what the public sees");
    expect(failedHtml).not.toContain(`/raw/r/${failedPub}/`);
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
    expect(noneHtml).not.toContain('popovertarget="about"');
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

async function viewerHtml(path: string, client = app): Promise<string> {
  return (await client.request(path)).text();
}
describe("owner feedback 1: copyable links, calm Links tab, History state", () => {
  it("offers Copy URL and Open on active links, and explains links whose URL is gone", async () => {
    const response = await create({ label: "Priya" });
    const created = await jsonBody(response.clone());
    const url = String(created.url);
    const id = await createdId(response);
    const legacy = await legacyLink();
    const tab = await viewerHtml(`/c/${collectionPublicId}/?panel=links`);
    const card = (linkId: string) =>
      tab.slice(tab.indexOf(`data-link="${linkId}"`)).split("</details>")[0];
    const fresh = card(id);
    expect(fresh).toContain(`data-text="${url}"`);
    expect(fresh).toContain("Copy URL");
    expect(fresh).toMatch(new RegExp(`href="${url.replace(/[.?/]/g, "\\$&")}"[^>]*data-open-url`));
    const old = card(legacy);
    expect(old).toContain("URL unavailable");
    expect(old).toContain("or under a different share token key");
    expect(old).not.toContain("Copy URL");
    // The same on /links.
    const linksHtml = await viewerHtml("/links");
    expect(linksHtml).toContain(`data-text="${url}"`);
    expect(linksHtml).toContain("URL unavailable");
    expect(tab).not.toContain("token_hash");
  });
  it("keeps the Links tab calm: one primary action, Revoke all only for two or more", async () => {
    const one = await createdId(await create({ label: "one" }));
    let tab = await viewerHtml(`/c/${collectionPublicId}/?panel=links`);
    expect(tab).toContain("New public link");
    expect(tab).toMatch(/class="txtbtn"[^>]*>Preview as public ↗/);
    expect(tab).not.toContain("Revoke all");
    // Revoke… is a quiet text action, not a red button.
    expect(tab).toContain('<summary class="txtbtn danger">Revoke…</summary>');
    expect(tab).not.toContain('<summary class="btn sm danger">');
    await create({ label: "two" });
    tab = await viewerHtml(`/c/${collectionPublicId}/?panel=links`);
    expect(tab).toMatch(/class="txtbtn danger"[^>]*data-action="revoke-all"/);
    expect(tab).toContain("Revoke all 2 links…");
    expect(await viewerHtml("/links")).toContain("Revoke all 2 active links…");
    // A revocation reads Revoked at once, with a note while the reader catches up.
    expect((await app.request(`/api/share-links/${one}/revoke`, json({}))).status).toBe(200);
    tab = await viewerHtml(`/c/${collectionPublicId}/?panel=links`);
    const card = tab.slice(tab.indexOf(`data-link="${one}"`));
    expect(card).toMatch(/data-link-state="revoking">Revoked</);
    // Sync is off in this harness, so the revocation hasn't been pushed: say so.
    expect(card).toContain("Revoked, not yet pushed. Public access continues until it syncs.");
    expect(card).not.toContain("Public access stops within seconds.");
    expect(tab).not.toContain("Revoking");
  });
  it("without the token key, shows and revokes links but can't create or copy them", async () => {
    await create({ label: "made with a key" });
    const keyless = createApp({
      waypoint,
      queue,
      blobs: new BlobStore(directory, 1024 * 1024),
      reads,
      ingest,
      publicBaseUrl: "https://reader-dev.example.test",
    });
    const shell = await viewerHtml(`/c/${collectionPublicId}/?panel=links`, keyless);
    expect(shell).not.toContain('commandfor="share"');
    expect(shell).not.toContain('id="share"');
    expect(shell).toContain('id="tab-links"');
    expect(shell).toContain('data-action="revoke-link"');
    expect(shell).not.toContain("Copy URL");
    expect(shell).not.toContain("URL unavailable");
    const links = await viewerHtml("/links", keyless);
    expect(links).toContain("WAYPOINT_SHARE_TOKEN_KEY isn&#39;t set on this writer");
    expect(links).not.toContain("Copy URL");
    expect(links).not.toContain("URL unavailable");
    expect((await keyless.request(`/api/collections/${collectionId}/share-links`)).status).toBe(
      200,
    );
  });
  it("keeps the History tab when picking a revision", async () => {
    const shell = await viewerHtml(`/c/${collectionPublicId}/?panel=history`);
    const history = shell.slice(shell.indexOf('id="tp-history"'));
    expect(history).toMatch(/href="[^"]*\/r\/[^"]*\?fallback=head&amp;panel=history"/);
    expect(shell).toMatch(/id="tab-history"[^>]*aria-selected="true"/);
    // Stepping keeps it: the revision page renders History selected.
    const pinned = await viewerHtml(
      `/c/${collectionPublicId}/r/${revisionPublicId}/index.txt?panel=history`,
    );
    expect(pinned).toMatch(/id="tab-history"[^>]*aria-selected="true"/);
    expect(pinned).toMatch(/id="tp-history"[^>]*>/);
    expect(pinned).not.toMatch(/id="tp-history"[^>]*hidden/);
  });
});
