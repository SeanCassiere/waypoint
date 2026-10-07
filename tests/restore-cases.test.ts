import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryBucket, R2Bucket } from "../apps/writer/src/bucket.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases } from "../apps/writer/src/db.js";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.js";
import { restore } from "../apps/writer/src/restore.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";
import { mintRevisionId, newId, parseId, publicIdFor } from "../packages/core/src/index.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const sourceHash = `sha256:${"a".repeat(64)}`;
const outputHash = `sha256:${"b".repeat(64)}`;
async function snapshot(bucket: MemoryBucket, id: string, deleted: boolean): Promise<void> {
  await bucket.put(
    `collections/${id}.json`,
    bytes({
      format_version: 1,
      updated_at: 100,
      collection: {
        id,
        public_id: await publicIdFor(parseId(id, "col")),
        title: "from bucket",
        metadata: "{}",
        created_at: 1,
      },
      tombstone: deleted ? { collection_id: id, deleted_at: 2, note: null } : null,
      share_links: [],
    }),
  );
}
async function manifest(
  bucket: MemoryBucket,
  collection: string,
  id: string,
  parent: string | null,
  rendition = false,
): Promise<void> {
  await bucket.put(
    `manifests/${id}.json`,
    bytes({
      format_version: 1,
      revision: {
        id,
        public_id: await publicIdFor(parseId(id, "rev")),
        collection_id: collection,
        parent_revision_id: parent,
        head_path: "a.txt",
        message: null,
        metadata: "{}",
        created_at: 3,
      },
      files: { "a.txt": { hash: sourceHash, mime: "text/plain", size: 1 } },
      renditions: rendition
        ? [
            {
              source_hash: sourceHash,
              renderer: "test",
              renderer_version: 1,
              output_hash: outputHash,
              output_mime: "text/html",
              created_at: 3,
              output_size: 2,
            },
          ]
        : [],
    }),
  );
}
describe("restore merge and pagination", () => {
  it("merges missing revisions, preserves an undelete, skips missing outputs and transitive orphans across pages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-restore-cases-"));
    const cfg: Config = {
      environment: "dev",
      dataDir: dir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024,
      sync: false,
    };
    const db = await openDatabases(cfg);
    const bucket = new MemoryBucket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fakeS3: Server | undefined;
    let listCalls = 0;
    const getCounts = new Map<string, number>();
    try {
      await migrate(db.waypoint, waypointMigrations);
      await migrate(db.queue, queueMigrations);
      const existing = newId("col");
      const root = mintRevisionId({ now: Date.now() });
      const child = mintRevisionId({ now: Date.now() + 1, parentId: root });
      await snapshot(bucket, existing, true);
      await manifest(bucket, existing, root, null, true);
      await manifest(bucket, existing, child, root);
      await db.waypoint.run(
        "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
        [existing, await publicIdFor(parseId(existing, "col")), "undeleted locally", "{}", 1],
      );
      await db.waypoint.run(
        "INSERT INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [root, await publicIdFor(parseId(root, "rev")), existing, null, "a.txt", null, "{}", 3],
      );
      const missingParent = mintRevisionId({ now: Date.now() + 2 });
      const orphan = mintRevisionId({ now: Date.now() + 3, parentId: missingParent });
      const grandchild = mintRevisionId({ now: Date.now() + 4, parentId: orphan });
      await manifest(bucket, existing, orphan, missingParent);
      await manifest(bucket, existing, grandchild, orphan);
      const dropped = mintRevisionId({ now: Date.now() + 5 });
      await manifest(bucket, existing, dropped, null);
      await bucket.delete(`manifests/${dropped}.json`);
      const extraIds = Array.from({ length: 1001 }, () => newId("col"));
      for (const id of extraIds) await snapshot(bucket, id, false);
      fakeS3 = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          if (prefix === "collections/") listCalls++;
          const start = Number(url.searchParams.get("continuation-token") ?? "0");
          const keys = [...bucket.objects.keys()]
            .filter((key) => key.startsWith(prefix))
            .toSorted();
          const page = keys.slice(start, start + 1000);
          const next = start + page.length;
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(
            `<ListBucketResult><IsTruncated>${next < keys.length}</IsTruncated>${page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}${next < keys.length ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
          );
          return;
        }
        const key = decodeURIComponent(url.pathname.slice("/test-bucket/".length));
        if (req.method === "GET") getCounts.set(key, (getCounts.get(key) ?? 0) + 1);
        const body = bucket.objects.get(key);
        if (!body) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        res.writeHead(200, { "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : Buffer.from(body));
      });
      await new Promise<void>((resolve) => fakeS3!.listen(0, "127.0.0.1", resolve));
      const address = fakeS3.address();
      if (!address || typeof address === "string") throw new Error("No fake S3 port");
      const remote = new R2Bucket(
        {
          ...cfg,
          r2Bucket: "test-bucket",
          r2AccountId: "test",
          r2AccessKeyId: "test",
          r2SecretAccessKey: "test",
        },
        { endpoint: `http://127.0.0.1:${address.port}` },
      );
      const sync = new SyncLoop(db.queue, db.syncClient, Date.now, db.waypoint);
      const result = await restore(db.waypoint, remote, sync, "merge");
      expect(listCalls).toBeGreaterThan(1);
      expect(result).toEqual({ collections: 1001, revisions: 1, ignored: 2 });
      expect(getCounts.get(`manifests/${orphan}.json`)).toBe(1);
      expect(getCounts.get(`manifests/${grandchild}.json`)).toBe(1);
      expect(await db.waypoint.all("SELECT id FROM collections")).toHaveLength(1002);
      expect(await db.waypoint.all("SELECT id FROM revisions")).toHaveLength(2);
      expect(
        await db.waypoint.get(
          "SELECT collection_id FROM collection_tombstones WHERE collection_id=?",
          [existing],
        ),
      ).toBeUndefined();
      expect(await db.waypoint.get("SELECT id FROM revisions WHERE id=?", [child])).toBeTruthy();
      expect(
        await db.waypoint.get("SELECT id FROM revisions WHERE id=?", [dropped]),
      ).toBeUndefined();
      expect(
        await db.waypoint.get("SELECT output_hash FROM renditions WHERE source_hash=?", [
          sourceHash,
        ]),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(`Restore skipped missing rendition output ${outputHash}`);
      expect((await restore(db.waypoint, remote, sync, "merge")).revisions).toBe(0);
    } finally {
      warn.mockRestore();
      if (fakeS3) {
        fakeS3.closeAllConnections();
        await new Promise<void>((resolve) => fakeS3!.close(() => resolve()));
      }
      await db.waypoint.close();
      await db.queue.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
