// Large-fixture guards: query counts stay constant as data grows, but one statement can still
// read every row (a self-join over all revision files took 100 ms per shell view). These tests
// time every statement and bound page sizes on a fixture big enough for that to show.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { mintRevisionId, publicIdFor, type RevisionId } from "@waypoint/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const REVISIONS = 300;
const FILES = 300;
/** Generous: the statements these guards exist for took 10–20× this on the fixture. */
const STATEMENT_MS = 60;
const LINKS = 400;
const FAILED = 300;
const docsPub = "dddddddddddd";
const docRevisions: RevisionId[] = [];

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
let blobs: BlobStore;
const collectionId = `col_${"b".repeat(26)}`;
const collectionPub = "bbbbbbbbbbbb";
const revisionIds: RevisionId[] = [];
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
  blobs = new BlobStore(dir, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
    publicBaseUrl: "https://reader.example.test",
    shareTokenKey: new Uint8Array(32).fill(42),
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
    // 400 share links: 300 live, 50 expired, 50 revoked.
    for (let link = 0; link < LINKS; link++)
      await tx.run(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [
          `shl_${String(link).padStart(26, "0")}`,
          `token-${link}`,
          collectionId,
          null,
          `link ${link}`,
          link % 8 === 1 ? 1_000 : null,
          link % 8 === 2 ? 2_000 : null,
          1_700_000_000_000 + link,
        ],
      );
  });
  // 300 failed queued revisions, in a collection of their own, for Status.
  const failing = `col_${"f".repeat(26)}`;
  await waypoint.run("INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)", [
    failing,
    "ffffffffffff",
    "Failing",
  ]);
  await queue.transaction(async (tx) => {
    for (let index = 0; index < FAILED; index++) {
      const id = mintRevisionId({ now: 1_800_000_000_000 + index });
      await tx.run(
        "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,last_error,error_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          await publicIdFor(id),
          failing,
          null,
          "dir0/f0.md",
          `failed ${index}`,
          "{}",
          JSON.stringify({ headPath: "dir0/f0.md", files: {} }),
          1_800_000_000_000 + index,
          "failed",
          "Bucket said no",
          "permanent",
        ],
      );
    }
  });
  // A 2,000-paragraph document, then the same with the first 5 of every 50 paragraphs edited.
  // The middle of each unchanged run (FOLDEDWORD) is folded; its edges show as context.
  const paragraphs = Array.from(
    { length: 2000 },
    (_, index) =>
      `Paragraph ${index} ${index % 50 >= 10 && index % 50 <= 40 ? "FOLDEDWORD" : "STEADYWORD"} ${"lorem ipsum dolor ".repeat(6)}`,
  );
  const before = paragraphs.join("\n\n");
  const after = paragraphs
    .map((text, index) => (index % 50 < 5 ? `${text} EDITEDWORD` : text))
    .join("\n\n");
  const docs = `col_${"d".repeat(26)}`;
  await waypoint.transaction(async (tx) => {
    await tx.run("INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)", [
      docs,
      docsPub,
      "Docs",
    ]);
    let parent: string | null = null;
    for (const [index, text] of [before, after].entries()) {
      const blob = await blobs.put(Readable.from([text]));
      await tx.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", [
        blob.hash,
        blob.size,
      ]);
      const id = mintRevisionId({
        now: 1_750_000_000_000 + index,
        ...(parent ? { parentId: parent } : {}),
      });
      await tx.run(
        "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,created_at) VALUES (?,?,?,?,?,?)",
        [id, await publicIdFor(id), docs, parent, "large.md", 1_750_000_000_000 + index],
      );
      await tx.run(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        [id, "large.md", blob.hash, "text/markdown", blob.size],
      );
      docRevisions.push(id);
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
    expect(listed.body.match(/"display_number"/g)).toHaveLength(REVISIONS);
    expect(joins(listed.statements)).toBe(0);
    expect(listed.slowest?.ms).toBeLessThan(STATEMENT_MS);
  });

  it("counts changes only for the revisions the shell shows, then from cache", async () => {
    const cold = await measure(`/c/${collectionPub}/`);
    expect(cold.status).toBe(200);
    // Rows, not time: the first view joins the files of the History page's 50 revisions (plus
    // the one being viewed), never the whole history.
    const joined = cold.statements.filter((statement) =>
      statement.sql.includes("LEFT JOIN revision_files p"),
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.sql.split("?").length - 1).toBeLessThanOrEqual(51);
    const others = cold.statements.filter((statement) => !joined.includes(statement));
    expect(Math.max(...others.map((statement) => statement.ms))).toBeLessThan(STATEMENT_MS);
    const warm = await measure(`/c/${collectionPub}/`);
    expect(joins(warm.statements)).toBe(0);
    expect(warm.slowest?.ms).toBeLessThan(STATEMENT_MS);
    // An old pinned revision adds only itself to the cached page.
    const old = await measure(`/c/${collectionPub}/r/${await publicIdFor(revisionIds[20]!)}/`);
    expect(old.status).toBe(200);
    const oldJoin = old.statements.find((statement) =>
      statement.sql.includes("LEFT JOIN revision_files p"),
    );
    expect(oldJoin?.sql.split("?").length).toBe(2);
    expect(old.body).toContain("#21");
  });

  it("pages /links in SQL and counts inactive links in their segments", async () => {
    const first = await measure("/links");
    expect(first.status).toBe(200);
    expect(first.body.match(/class="lrow( dead)?"/g)).toHaveLength(50);
    expect(first.body).toContain("Show 50 more of 250…");
    // Expired and revoked links are counted in their segments (OW-05b), not listed here.
    expect(first.body).toContain('<span class="n" data-count-of="expired">50</span>');
    expect(first.body).toContain('<span class="n" data-count-of="revoked">50</span>');
    expect(first.body.length).toBeLessThan(120_000);
    expect(first.slowest?.ms).toBeLessThan(STATEMENT_MS);
    const next = first.body.match(/href="(\/links\?state=active&amp;after=[^"]+)"/)?.[1];
    expect(next).toBeDefined();
    const second = await measure(next!.replaceAll("&amp;", "&"));
    expect(second.body.match(/class="lrow( dead)?"/g)).toHaveLength(50);
    expect(second.body).not.toContain("link 399 ");
    // Constant statements per page, however many links there are.
    expect(second.statements.length).toBeLessThanOrEqual(first.statements.length + 1);
    const inactive = await measure("/links?state=inactive");
    expect(inactive.body.match(/class="lrow dead"/g)).toHaveLength(50);
    expect(inactive.body).toContain("Show 50 more of 50…");
  });

  it("caps each Status list and links to the rest", async () => {
    const status = await measure("/status");
    expect(status.status).toBe(200);
    expect(status.body.match(/data-action="retry" data-ids="rev_/g)?.length).toBeLessThanOrEqual(
      51,
    );
    expect(status.body).toContain("and 250 more…");
    expect(status.body).toContain('href="/status?failed=50"');
    expect(status.body.length).toBeLessThan(150_000);
    const next = await measure("/status?failed=250");
    expect(next.body).toContain("Showing 251–300 of 300.");
    expect(next.body).not.toContain("and 0 more");
  });

  it("keeps folded text off the Changes page and caches its rendering", async () => {
    const path = `/c/${docsPub}/r/${await publicIdFor(docRevisions[1]!)}/changes`;
    const started = performance.now();
    const first = await measure(path);
    const firstMs = performance.now() - started;
    expect(first.status).toBe(200);
    // Changed blocks show; unchanged ones are folded without their text.
    expect(first.body).toContain("EDITEDWORD");
    expect(first.body).not.toContain("FOLDEDWORD");
    expect(first.body).toContain("Showing blocks 1–300 of 2,000.");
    expect(first.body.length).toBeLessThan(400_000);
    const again = performance.now();
    const second = await measure(path);
    const secondMs = performance.now() - again;
    expect(second.body).toBe(first.body);
    expect(secondMs).toBeLessThan(Math.max(100, firstMs / 3));
    // Opening a fold fetches its rendered blocks from the compare API.
    const fold = first.body.match(/data-fold="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    expect(fold).toMatch(/\/api\/revisions\/rev_[^/]+\/compare\/large\.md\?.*format=html/);
    const loaded = await app.request(fold!);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("content-type")).toContain("text/html");
    expect(await loaded.text()).toContain("FOLDEDWORD");
    // The focused file view pages through every window.
    const focused = await measure(`${path}?file=large.md&from=1800`);
    expect(focused.body).toContain("Showing blocks 1801–2000 of 2,000.");
    expect(focused.body).toContain("Previous blocks");
    expect((await app.request(fold!.replace(/to=\d+/, "to=999999"))).status).toBe(400);
  });
});
