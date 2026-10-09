// FC1 (OW-05a): the writer's live rule, in SQL and JS, against the public reader itself.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveShareToken,
  hashShareToken,
  mintRevisionId,
  newId,
  parseId,
  publicIdFor,
} from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReaderApp, type ReaderEnv } from "../apps/reader/src/app.ts";
import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp, type HttpServices } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import {
  isLive,
  linkPage,
  liveLinkWhere,
  pausedLinkWhere,
  SHARE_COLUMNS,
  shareViews,
  trashedPendingIds,
  waitingLinkWhere,
  type ShareRow,
  type SqlWhere,
} from "../apps/writer/src/shares.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
import { getChrome } from "../apps/writer/src/viewer/chrome.ts";
import { trashLinks } from "../apps/writer/src/viewer/pages/trash.tsx";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
};
/** A fixed test key (never a real one). */
const shareTokenKey = new Uint8Array(32).fill(7);
const bindings: ReaderEnv = {
  TURSO_DATABASE_URL: "",
  TURSO_READONLY_TOKEN: "",
  R2_ACCOUNT_ID: "",
  R2_READER_ACCESS_KEY_ID: "",
  R2_READER_SECRET_ACCESS_KEY: "",
  R2_BUCKET: "",
  RAW_CAP_KEY: "A".repeat(43),
};
/** Fixture rows (a)–(j) of the brief, by letter. */
type Letter = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j";
const EXPECTED: Record<Letter, string> = {
  a: "active",
  b: "active",
  c: "revoked",
  d: "expired",
  e: "paused",
  f: "paused",
  g: "waiting",
  h: "waiting",
  i: "waiting",
  j: "active",
};
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let services: HttpServices;
let app: ReturnType<typeof createApp>;
let reader: ReturnType<typeof createReaderApp>;
let NOW: number;
let hash: string;
/** Link ID per letter, and the reader path that opens it. */
const links = new Map<Letter, string>();
const readerPaths = new Map<Letter, string>();
const collections: Record<"live" | "trashed" | "trashedPending" | "pending" | "unpushed", string> =
  { live: "", trashed: "", trashedPending: "", pending: "", unpushed: "" };

async function createCollection(title: string): Promise<{ id: string; revision: string }> {
  const created = await jsonBody(
    await app.request("/api/collections", json({ title, files: [{ path: "index.txt", hash }] })),
  );
  return { id: text(created.collection_id), revision: text(created.revision_id) };
}
async function createLink(collectionId: string, body: object = {}): Promise<string> {
  const response = await app.request(`/api/collections/${collectionId}/share-links`, json(body));
  if (response.status !== 201) throw new Error(`Link creation failed: ${response.status}`);
  const share = (await jsonBody(response)).share_link;
  if (!share || typeof share !== "object" || !("id" in share)) throw new Error("No link");
  return text(share.id);
}
/** A link the API would refuse, inserted with the token hash the reader looks up. */
async function insertLink(
  collectionId: string,
  fields: { revision_id?: string | null; expires_at?: number | null } = {},
): Promise<string> {
  const id = newId("shl");
  await waypoint.run(
    "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,NULL,?,NULL,?)",
    [
      id,
      await hashShareToken(await deriveShareToken(shareTokenKey, id)),
      collectionId,
      fields.revision_id ?? null,
      fields.expires_at ?? null,
      NOW - 1000,
    ],
  );
  return id;
}
async function insertPendingCollection(title: string, deletedAt: number | null): Promise<string> {
  const id = newId("col");
  await queue.run(
    "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,?)",
    [id, await publicIdFor(id), title, "{}", NOW - 1000, deletedAt],
  );
  return id;
}
async function shellPath(id: string, collectionId: string, revisionId?: string): Promise<string> {
  const token = await deriveShareToken(shareTokenKey, id);
  const pub = await publicIdFor(parseId(collectionId, "col"));
  return revisionId
    ? `/s/${token}/c/${pub}/r/${await publicIdFor(parseId(revisionId, "rev"))}/`
    : `/s/${token}/c/${pub}/`;
}
async function add(letter: Letter, id: string, collectionId: string, revisionId?: string) {
  links.set(letter, id);
  readerPaths.set(letter, await shellPath(id, collectionId, revisionId));
}
async function selectIds(where: SqlWhere): Promise<Set<string>> {
  const rows = await waypoint.all<{ id: string }>(
    `SELECT s.id FROM share_links s WHERE ${where.sql}`,
    where.args,
  );
  return new Set(rows.map((row) => row.id));
}
async function allViews() {
  const rows = await waypoint.all<ShareRow>(`SELECT ${SHARE_COLUMNS} FROM share_links`);
  return new Map((await shareViews(services, rows, { now: NOW })).map((view) => [view.id, view]));
}
const lettersOf = (ids: Set<string>): Letter[] =>
  [...links].flatMap(([letter, id]) => (ids.has(id) ? [letter] : [])).toSorted();
const idOf = (letter: Letter): string => {
  const id = links.get(letter);
  if (!id) throw new Error(`No link ${letter}`);
  return id;
};
async function apiStatuses(): Promise<Map<string, unknown>> {
  const listed = (await jsonBody(await app.request("/api/share-links?limit=200"))).share_links;
  if (!Array.isArray(listed)) throw new Error("No share_links");
  return new Map(
    listed.map((link: unknown): [string, unknown] => {
      if (!link || typeof link !== "object" || !("id" in link) || !("status" in link))
        throw new Error("Invalid link");
      return [String(link.id), link.status];
    }),
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-live-rule-"));
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
  services = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey,
  };
  app = createApp(services);
  const bytes = new TextEncoder().encode("hello public");
  hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  if ((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status !== 200)
    throw new Error("Blob upload failed");
  links.clear();
  readerPaths.clear();
  // Committed collections: one live, one to trash, one whose revision stays unpushed.
  const live = await createCollection("Alpha live");
  const trashed = await createCollection("Bravo trashed");
  const unpushed = await createCollection("Charlie unpushed");
  await worker.drain();
  collections.live = live.id;
  collections.trashed = trashed.id;
  collections.unpushed = unpushed.id;
  await queue.run("INSERT OR IGNORE INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
    unpushed.revision,
    Date.now(),
  ]);
  await add("a", await createLink(live.id), live.id);
  await add("b", await createLink(live.id, { revision_id: live.revision }), live.id, live.revision);
  const revoked = await createLink(live.id, { label: "revoked" });
  if ((await app.request(`/api/share-links/${revoked}/revoke`, json({}))).status !== 200)
    throw new Error("Revoke failed");
  await add("c", revoked, live.id);
  await add("e", await createLink(trashed.id), trashed.id);
  if ((await app.request(`/api/collections/${trashed.id}`, { method: "DELETE" })).status !== 200)
    throw new Error("Delete failed");
  await add("j", await createLink(unpushed.id), unpushed.id);
  NOW = Date.now();
  await add("d", await insertLink(live.id, { expires_at: NOW }), live.id);
  // Everything from here stays in queue.db: the committer is stopped, and #2 is still pending.
  worker.stop();
  await worker.drain();
  const pendingRevision = mintRevisionId({ now: NOW, parentId: live.revision });
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      pendingRevision,
      await publicIdFor(pendingRevision),
      live.id,
      live.revision,
      "index.txt",
      null,
      "{}",
      JSON.stringify({
        headPath: "index.txt",
        files: { "index.txt": { hash, mime: "text/plain", size: 12 } },
      }),
      NOW,
    ],
  );
  await add(
    "g",
    await createLink(live.id, { revision_id: pendingRevision }),
    live.id,
    pendingRevision,
  );
  collections.trashedPending = await insertPendingCollection("Trashed pending", NOW - 500);
  await add("f", await insertLink(collections.trashedPending), collections.trashedPending);
  collections.pending = await insertPendingCollection("Pending", null);
  await add("h", await insertLink(collections.pending), collections.pending);
  const nowhere = newId("col");
  await add("i", await insertLink(nowhere), nowhere);
  reader = createReaderApp({
    db: () => ({ all: (sql, args) => waypoint.all(sql, args ?? []) }),
    blob: () => ({
      fetch: () => Promise.resolve(new Response("x")),
      probe: () => Promise.resolve(new Response("ok")),
    }),
    now: () => NOW,
  });
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

describe("one live rule for share links (FC1, OW-05a)", () => {
  it("agrees with the public reader for every row of the status table", async () => {
    // The fixture's premises: #2 is pending, (j)'s only revision committed but unpushed.
    const index = await services.reads.revisionIndex([collections.live, collections.unpushed]);
    expect(index.get(collections.unpushed)?.map((row) => row.sync_state)).toEqual(["committed"]);
    expect(index.get(collections.live)?.at(-1)?.sync_state).toBe("pending");
    const pending = await trashedPendingIds(services);
    expect(pending).toEqual([collections.trashedPending]);
    const live = await selectIds(liveLinkWhere(NOW, pending));
    const views = await allViews();
    const rows = await Promise.all(
      [...links].map(async ([letter, id]) => {
        const view = views.get(id);
        const served = await reader.request(readerPaths.get(letter) ?? "", {}, bindings);
        return {
          letter,
          status: view?.status,
          sql: live.has(id),
          js: view?.status === "active",
          isLive: view ? isLive(view) : undefined,
          reader: served.status,
        };
      }),
    );
    // SQL ⇔ JS status ⇔ isLive ⇔ the reader's 200, for every row.
    expect(rows).toEqual(
      [...links.keys()].map((letter) => {
        const served = EXPECTED[letter] === "active";
        return {
          letter,
          status: EXPECTED[letter],
          sql: served,
          js: served,
          isLive: served,
          reader: served ? 200 : 404,
        };
      }),
    );
    expect(lettersOf(await selectIds(pausedLinkWhere(NOW, pending)))).toEqual(["e", "f"]);
    expect(lettersOf(await selectIds(waitingLinkWhere(NOW, pending)))).toEqual(["g", "h", "i"]);
    // With nothing trashed while pending, the clause is omitted rather than `IN ()`.
    expect(liveLinkWhere(NOW, []).sql).not.toContain("IN (");
    expect(lettersOf(await selectIds(pausedLinkWhere(NOW, [])))).toEqual(["e"]);
  });

  it("keeps a tombstone paused while a leftover pending row says restored", async () => {
    // A crash between commit and queue cleanup leaves the tombstoned collection's pending row;
    // a restore then clears only that row's deleted_at. The reader still sees the tombstone.
    await queue.run(
      "INSERT INTO pending_collections (id,public_id,title,metadata,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
      [
        collections.trashed,
        await publicIdFor(parseId(collections.trashed, "col")),
        "Bravo trashed",
        "{}",
        NOW,
      ],
    );
    const pending = await trashedPendingIds(services);
    expect(lettersOf(await selectIds(pausedLinkWhere(NOW, pending)))).toEqual(["e", "f"]);
    const views = await allViews();
    expect(views.get(idOf("e"))?.status).toBe("paused");
    const served = await reader.request(readerPaths.get("e") ?? "", {}, bindings);
    expect(served.status).toBe(404);
    // A link whose collection exists nowhere is waiting, and its collection isn't in Trash.
    expect(views.get(idOf("i"))?.collection.deleted).toBe(false);
  });

  it("revokes only live links in global revoke-all", async () => {
    const live = await selectIds(liveLinkWhere(Date.now(), await trashedPendingIds(services)));
    const response = await app.request("/api/share-links/revoke-all?state=active", json({}));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ revoked: live.size });
    const statuses = await apiStatuses();
    expect(statuses.get(idOf("a"))).toBe("revoked");
    expect(statuses.get(idOf("d"))).toBe("expired");
    expect(statuses.get(idOf("e"))).toBe("paused");
    expect(statuses.get(idOf("g"))).toBe("waiting");
    const untouched = await waypoint.all<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM share_links WHERE id IN (?,?,?)",
      [idOf("d"), idOf("e"), idOf("g")],
    );
    expect(untouched).toEqual([{ revoked_at: null }, { revoked_at: null }, { revoked_at: null }]);
    expect((await app.request("/api/share-links/revoke-all?state=expired", json({}))).status).toBe(
      400,
    );
  });

  it("counts the bar the way /links counts, and Trash once per collection", async () => {
    // A purge of an already tombstoned collection doesn't count twice; one of a third does.
    await Promise.all(
      [collections.trashed, newId("col")].map((id) =>
        queue.run("INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)", [
          id,
          NOW,
        ]),
      ),
    );
    const chrome = await getChrome(services, NOW);
    const page = await linkPage(services, "active", undefined, NOW);
    expect(chrome.liveLinkCount).toBe(page.counts.active);
    expect(chrome.pausedLinkCount).toBe(page.counts.paused);
    expect(page.counts).toEqual({ active: 3, paused: 2, waiting: 3, expired: 1, revoked: 1 });
    expect(chrome.trashCount).toBe(3);
    expect(chrome.trashedPending).toEqual([collections.trashedPending]);
    // The Active listing shows live and waiting links; its count is live only.
    expect(lettersOf(new Set(page.views.map((view) => view.id)))).toEqual([
      "a",
      "b",
      "g",
      "h",
      "i",
      "j",
    ]);
  });

  it("summarizes, searches and filters by the same rule", async () => {
    const summary = await services.reads.shareSummary();
    expect(summary.get(collections.trashed)).toEqual({
      active: 0,
      follows_latest: false,
      paused: 1,
    });
    expect(summary.get(collections.live)).toEqual({ active: 2, follows_latest: true, paused: 0 });
    const search = async (q: string) =>
      (await app.request(`/?${new URLSearchParams({ q }).toString()}`)).text();
    const [shared, sharedTrash, trash] = await Promise.all([
      search("is:shared"),
      search("is:shared in:trash"),
      search("in:trash"),
    ]);
    expect(shared).toContain("Alpha live");
    expect(shared).toContain("Charlie unpushed");
    expect(shared).not.toContain("Bravo trashed");
    // Only the shared filter keeps it out of in:trash: its one link is paused, not live.
    expect(trash).toContain("Bravo trashed");
    expect(sharedTrash).not.toContain("Bravo trashed");
    const listed = (await jsonBody(await app.request("/api/collections?include_deleted=true")))
      .collections;
    if (!Array.isArray(listed)) throw new Error("No collections");
    const trashed: unknown = listed.find(
      (item: unknown) =>
        item && typeof item === "object" && "id" in item && item.id === collections.trashed,
    );
    expect(trashed).toMatchObject({ share: { active: 0, paused: 1 } });
    const filtered = async (state: string) => {
      const response = await app.request(`/api/share-links?state=${state}`);
      const body = await jsonBody(response);
      if (!Array.isArray(body.share_links)) throw new Error("No share_links");
      return lettersOf(
        new Set(
          body.share_links.map((link: unknown) =>
            link && typeof link === "object" && "id" in link ? String(link.id) : "",
          ),
        ),
      );
    };
    expect(await filtered("paused")).toEqual(["e", "f"]);
    expect(await filtered("waiting")).toEqual(["g", "h", "i"]);
    expect(await filtered("active")).toEqual(["a", "b", "j"]);
    expect((await app.request("/api/share-links?state=bogus")).status).toBe(400);
  });

  it("lists a trashed collection's paused links for restore", async () => {
    const found = await trashLinks(services, [collections.trashed]);
    expect(found.get(collections.trashed)).toEqual({
      paused: [{ id: idOf("e"), label: null, revision_display_number: null }],
      total: 1,
    });
  });
});
