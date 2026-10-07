// Large-fixture guards: query counts stay constant as data grows, but one statement can still
// read every row (a self-join over all revision files took 100 ms per shell view). These tests
// time every statement and bound page sizes on a fixture big enough for that to show.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, type Db } from "../apps/writer/src/db.js";
import { createApp } from "../apps/writer/src/http.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { mintRevisionId, publicIdFor } from "../packages/core/src/index.js";

const REVISIONS = 300;
const FILES = 300;
/** Generous: the statements these guards exist for took 10–20× this on the fixture. */
const STATEMENT_MS = 60;

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
const collectionId = `col_${"b".repeat(26)}`;
const collectionPub = "bbbbbbbbbbbb";
const revisionIds: string[] = [];
const hash = (text: string) =>
  `sha256:${Buffer.from(text).toString("hex").padEnd(64, "0").slice(0, 64)}`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-scale-"));
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
  // One collection, 300 revisions of 300 files, each changing three files of its parent.
  await waypoint.transaction(async (tx) => {
    await tx.run("INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)", [
      collectionId,
      collectionPub,
      "Scale",
    ]);
    const files = new Map<string, string>();
    for (let file = 0; file < FILES; file++)
      files.set(`dir${file % 9}/f${file}.md`, hash(`0-${file}`));
    let parent: string | null = null;
    for (let revision = 0; revision < REVISIONS; revision++) {
      const at = 1_700_000_000_000 + revision * 1000;
      const id = mintRevisionId({ now: at, ...(parent ? { parentId: parent } : {}) });
      if (revision > 0)
        for (let k = 0; k < 3; k++)
          files.set(
            `dir${(revision * 3 + k) % 9}/f${(revision * 7 + k * 13) % FILES}.md`,
            hash(`${revision}-${k}`),
          );
      await tx.run(
        "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,created_at) VALUES (?,?,?,?,?,?,?)",
        [id, await publicIdFor(id), collectionId, parent, "dir0/f0.md", `rev ${revision}`, at],
      );
      for (const [path, blob] of files)
        await tx.run(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
          [id, path, blob, "text/markdown"],
        );
      revisionIds.push(id);
      parent = id;
    }
  });
}, 120_000);
afterAll(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

/** Requests a path and reports its slowest statement, statement count and body size. */
async function measure(path: string) {
  const statements: { sql: string; ms: number }[] = [];
  const record = (sql: string, ms: number) => statements.push({ sql, ms });
  waypoint.onStatement = record;
  queue.onStatement = record;
  try {
    const response = await app.request(path);
    const body = await response.text();
    const slowest = statements.toSorted((a, b) => b.ms - a.ms)[0];
    return { status: response.status, body, statements, slowest };
  } finally {
    waypoint.onStatement = undefined;
    queue.onStatement = undefined;
  }
}
const joins = (statements: { sql: string }[]) =>
  statements.filter((statement) => statement.sql.includes("LEFT JOIN revision_files p")).length;

describe("large-fixture guards", () => {
  it("lists revisions without reading every revision's files", async () => {
    const listed = await measure(`/api/collections/${collectionId}/revisions`);
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).revisions).toHaveLength(REVISIONS);
    expect(joins(listed.statements)).toBe(0);
    expect(listed.slowest?.ms).toBeLessThan(STATEMENT_MS);
  });

  it("counts changes only for the revisions the shell shows, then from cache", async () => {
    const cold = await measure(`/c/${collectionPub}/`);
    expect(cold.status).toBe(200);
    // Rows, not time: the first view joins the files of the History page's 50 revisions (plus
    // the one being viewed), never the whole history.
    const join = cold.statements.filter((statement) =>
      statement.sql.includes("LEFT JOIN revision_files p"),
    );
    expect(join).toHaveLength(1);
    expect(join[0]!.sql.split("?").length - 1).toBeLessThanOrEqual(51);
    const others = cold.statements.filter((statement) => !join.includes(statement));
    expect(Math.max(...others.map((statement) => statement.ms))).toBeLessThan(STATEMENT_MS);
    const warm = await measure(`/c/${collectionPub}/`);
    expect(joins(warm.statements)).toBe(0);
    expect(warm.slowest?.ms, warm.slowest?.sql).toBeLessThan(STATEMENT_MS);
    // An old pinned revision adds only itself to the cached page.
    const old = await measure(`/c/${collectionPub}/r/${await publicIdFor(revisionIds[20]!)}/`);
    expect(old.status).toBe(200);
    const oldJoin = old.statements.find((statement) =>
      statement.sql.includes("LEFT JOIN revision_files p"),
    );
    expect(oldJoin?.sql.split("?").length).toBe(2);
    expect(old.body).toContain("#21");
  });
});
