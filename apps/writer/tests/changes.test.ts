import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintRevisionId, publicIdFor } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db } from "../src/db.ts";
import { createApp } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";

let dir: string;
let waypoint: Db;
let queue: Db;
let reads: ReadModel;
let app: ReturnType<typeof createApp>;
const h = (c: string) => `sha256:${c.repeat(64)}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-changes-"));
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
  reads = new ReadModel(waypoint, queue, config.baseUrl);
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

async function committed(
  collection: string,
  files: Record<string, string>,
  parent: string | null,
  at: number,
): Promise<string> {
  const id = mintRevisionId({ now: at, ...(parent ? { parentId: parent } : {}) });
  await waypoint.run(
    "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,created_at) VALUES (?,?,?,?,?,?)",
    [id, await publicIdFor(id), collection, parent, "index.md", at],
  );
  for (const [path, hash] of Object.entries(files)) {
    await waypoint.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", [
      hash,
    ]);
    await waypoint.run(
      "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
      [id, path, hash, "text/markdown"],
    );
  }
  return id;
}
async function queued(
  collection: string,
  files: Record<string, string>,
  parent: string | null,
  at: number,
  state: "pending" | "failed" = "pending",
): Promise<string> {
  const id = mintRevisionId({ now: at, ...(parent ? { parentId: parent } : {}) });
  const manifest = {
    headPath: "index.md",
    files: Object.fromEntries(
      Object.entries(files).map(([path, hash]) => [path, { hash, mime: "text/markdown", size: 1 }]),
    ),
  };
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      id,
      await publicIdFor(id),
      collection,
      parent,
      "index.md",
      null,
      "{}",
      JSON.stringify(manifest),
      at,
      state,
    ],
  );
  return id;
}

describe("revision change counts (B2)", () => {
  it("counts added, modified and removed files for committed and queued revisions", async () => {
    const collection = "col_" + "a".repeat(26);
    await waypoint.run("INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)", [
      collection,
      "aaaaaaaaaaaa",
      "Changes",
    ]);
    const now = Date.now();
    const one = await committed(collection, { "index.md": h("1"), "a.md": h("2") }, null, now);
    const two = await committed(
      collection,
      { "index.md": h("3"), "b.md": h("4"), "c.md": h("5") },
      one,
      now + 1,
    );
    const three = await queued(collection, { "index.md": h("3"), "c.md": h("6") }, two, now + 2);
    const four = await queued(
      collection,
      { "index.md": h("7"), "c.md": h("6"), "d.md": h("8") },
      three,
      now + 3,
      "failed",
    );
    const changes = await reads.changesFor(await reads.revisions(collection));
    expect(changes.get(one)).toEqual({ added: 2, modified: 0, removed: 0 });
    expect(changes.get(two)).toEqual({ added: 2, modified: 1, removed: 1 });
    expect(changes.get(three)).toEqual({ added: 0, modified: 1, removed: 1 });
    expect(changes.get(four)).toEqual({ added: 1, modified: 1, removed: 0 });
    // Committed counts are cached: the second call returns the same counts without the join.
    const all = vi.spyOn(waypoint, "all");
    const again = await reads.changesFor(await reads.revisions(collection));
    expect(again.get(two)).toEqual({ added: 2, modified: 1, removed: 1 });
    expect(again.get(three)).toEqual({ added: 0, modified: 1, removed: 1 });
    expect(all.mock.calls.filter(([sql]) => sql.includes("SUM(CASE"))).toHaveLength(0);
    all.mockRestore();
    // The API leaves them out unless asked: they cost a join over every revision's files.
    const plain: unknown = await (
      await app.request(`/api/collections/${collection}/revisions`)
    ).json();
    expect(JSON.stringify(plain)).not.toContain('"changes"');
    const api: unknown = await (
      await app.request(`/api/collections/${collection}/revisions?changes=1`)
    ).json();
    const listed =
      api && typeof api === "object" && "revisions" in api && Array.isArray(api.revisions)
        ? api.revisions
        : [];
    expect(
      listed.find(
        (revision: unknown) =>
          revision && typeof revision === "object" && "id" in revision && revision.id === two,
      ),
    ).toMatchObject({ changes: { added: 2, modified: 1, removed: 1 } });
    const search = await reads.searchCollections({});
    expect(search.collections[0]?.latest_revision?.changes).toEqual({
      added: 0,
      modified: 1,
      removed: 1,
    });
    expect(search.collections[0]?.queue).toEqual({ pending: 1, failed: 1 });
  });
});
