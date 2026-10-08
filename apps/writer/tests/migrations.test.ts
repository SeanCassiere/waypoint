import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { newId } from "@waypoint/core";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
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

// The purge statement the current (and previous) writer runs at POST /api/collections/:id/purge.
const PURGE_INSERT =
  "INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0) ON CONFLICT(collection_id) DO UPDATE SET next_attempt_at=NULL,last_error=NULL";
const previousWaypoint = waypointMigrations.slice(0, -1);
const previousQueue = queueMigrations.slice(0, -1);
interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
let dir: string;
let config: Config;
let waypoint: Db;
let queue: Db;
let syncClient: Awaited<ReturnType<typeof openDatabases>>["syncClient"];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-migrations-"));
  config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024 * 1024,
    sync: false,
  };
  ({ waypoint, queue, syncClient } = await openDatabases(config));
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});
async function migrateAll(
  waypointList = waypointMigrations,
  queueList = queueMigrations,
): Promise<void> {
  await migrate(waypoint, waypointList);
  await migrate(queue, queueList);
}
async function applied(db: Db): Promise<string[]> {
  return (await db.all<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).map(
    (row) => row.id,
  );
}
function column(columns: Column[], name: string): Column | undefined {
  return columns.find((c) => c.name === name);
}
describe("FD4 migrations", () => {
  it("creates collection_syncing and the pending_purges name columns on fresh databases", async () => {
    await migrateAll();
    const syncing = await waypoint.all<Column>("PRAGMA table_info(collection_syncing)");
    expect(syncing.map((c) => c.name)).toEqual(["collection_id", "since", "until"]);
    expect(column(syncing, "collection_id")).toMatchObject({ type: "TEXT", pk: 1 });
    expect(column(syncing, "since")).toMatchObject({ type: "INTEGER", notnull: 1 });
    expect(column(syncing, "until")).toMatchObject({ type: "INTEGER", notnull: 1 });
    const keys = await waypoint.all<{ table: string; from: string; to: string }>(
      "PRAGMA foreign_key_list(collection_syncing)",
    );
    expect(keys).toEqual([
      expect.objectContaining({ table: "collections", from: "collection_id", to: "id" }),
    ]);
    const purges = await queue.all<Column>("PRAGMA table_info(pending_purges)");
    expect(column(purges, "title")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(column(purges, "public_id")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(purges.slice(-2).map((c) => c.name)).toEqual(["title", "public_id"]);
    expect(await applied(waypoint)).toContain("0004_collection_syncing");
    expect(await applied(queue)).toContain("0005_pending_purges_title");
  });
  it("is idempotent", async () => {
    await migrateAll();
    const before = {
      waypoint: await waypoint.all("SELECT sql FROM sqlite_master ORDER BY name"),
      queue: await queue.all("SELECT sql FROM sqlite_master ORDER BY name"),
    };
    await migrateAll();
    await migrateAll();
    expect(await waypoint.all("SELECT sql FROM sqlite_master ORDER BY name")).toEqual(
      before.waypoint,
    );
    expect(await queue.all("SELECT sql FROM sqlite_master ORDER BY name")).toEqual(before.queue);
    expect(await applied(waypoint)).toHaveLength(waypointMigrations.length);
    expect(await applied(queue)).toHaveLength(queueMigrations.length);
  });
  it("upgrades the previous schema and keeps existing rows", async () => {
    await migrateAll(previousWaypoint, previousQueue);
    const id = newId("col");
    await waypoint.run("INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,?)", [
      id,
      "pubupgrade",
      "Before FD4",
      1000,
    ]);
    await queue.run(PURGE_INSERT, [id, 2000]);
    await migrateAll();
    expect(await waypoint.get("SELECT id,title FROM collections")).toEqual({
      id,
      title: "Before FD4",
    });
    expect(
      await queue.get("SELECT collection_id,requested_at,step,title,public_id FROM pending_purges"),
    ).toEqual({ collection_id: id, requested_at: 2000, step: 0, title: null, public_id: null });
  });
  it("lets the previous build boot on migrated databases", async () => {
    await migrateAll();
    const counts = [(await applied(waypoint)).length, (await applied(queue)).length];
    // (a) The previous build's migrate ignores the IDs it doesn't know.
    await migrateAll(previousWaypoint, previousQueue);
    expect([(await applied(waypoint)).length, (await applied(queue)).length]).toEqual(counts);
    // (b) Its purge insert names its columns, so the new nullable ones stay NULL.
    const id = newId("col");
    await queue.run(PURGE_INSERT, [id, 3000]);
    await queue.run(PURGE_INSERT, [id, 4000]);
    expect(await queue.all("SELECT * FROM pending_purges")).toEqual([
      expect.objectContaining({ collection_id: id, step: 0, title: null, public_id: null }),
    ]);
    await queue.run("DELETE FROM pending_purges");
    // (c) The app serves and writes over these databases.
    await guardEnvironment(waypoint, syncClient, "dev", false);
    const blobs = new BlobStore(dir, config.maxBlobBytes);
    const reads = new ReadModel(waypoint, queue, config.baseUrl);
    const ingest = new IngestService(waypoint, queue, blobs, reads, syncClient);
    const app = createApp({ waypoint, queue, blobs, reads, ingest });
    expect((await app.request("/healthz")).status).toBe(200);
    const saved = await blobs.put(Readable.from([new TextEncoder().encode("rollback")]));
    const created = await app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Rollback", files: [{ path: "index.md", hash: saved.hash }] }),
    });
    expect(created.status).toBe(200);
    const result: unknown = await created.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("collection_id" in result) ||
      typeof result.collection_id !== "string"
    )
      throw new Error("Invalid write result");
    const listed = await app.request("/api/collections");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      collections: [expect.objectContaining({ id: result.collection_id, title: "Rollback" })],
    });
  });
  it("leaves the reader's collection_syncing lookup failing without 0004", async () => {
    const lookup = "SELECT since,until FROM collection_syncing WHERE collection_id=?";
    await migrate(waypoint, previousWaypoint);
    await expect(waypoint.all(lookup, [newId("col")])).rejects.toThrow(/collection_syncing/);
    await migrate(waypoint, waypointMigrations);
    expect(await waypoint.all(lookup, [newId("col")])).toEqual([]);
  });
});
