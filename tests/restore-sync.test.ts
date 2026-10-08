import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { writerRenderer } from "../apps/writer/src/renderer.ts";
import { restore } from "../apps/writer/src/restore.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
async function server(bin: string, db: string, portNumber: number): Promise<ChildProcess> {
  const child = spawn(bin, [db, "--sync-server", `127.0.0.1:${portNumber}`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${portNumber}`, { signal: AbortSignal.timeout(200) });
      return child;
    } catch {
      await delay(50);
    }
  }
  throw new Error("Sync server did not start");
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function hash(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}
function config(dataDir: string, portNumber: number): Config {
  return {
    environment: "dev",
    dataDir,
    baseUrl: `http://127.0.0.1:${portNumber}`,
    port: portNumber,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024 * 1024,
    sync: true,
    tursoUrl: `http://127.0.0.1:${portNumber}`,
    tursoAuthToken: "test",
    r2AccountId: "test",
    r2AccessKeyId: "test",
    r2SecretAccessKey: "test",
    r2Bucket: "test",
  };
}

describe("bucket disaster recovery", () => {
  it.skipIf(!process.env.TURSODB_BIN)(
    "restores HTTP writes into a fresh sync server",
    async () => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-dr-sync-"));
      const firstPort = await port();
      const firstServer = await server(bin, join(dir, "first-cloud.db"), firstPort);
      let secondServer: ChildProcess | undefined;
      const bucket = new MemoryBucket();
      try {
        const first = await openDatabases(config(join(dir, "writer"), firstPort));
        try {
          await guardEnvironment(first.waypoint, first.syncClient, "dev");
          await migrate(first.waypoint, waypointMigrations);
          await migrate(first.queue, queueMigrations);
          const blobs = new BlobStore(join(dir, "writer"), 1024 * 1024);
          const reads = new ReadModel(first.waypoint, first.queue, `http://127.0.0.1:${firstPort}`);
          const ingest = new IngestService(
            first.waypoint,
            first.queue,
            blobs,
            reads,
            first.syncClient,
            undefined,
            writerRenderer,
          );
          const sync = new SyncLoop(first.queue, first.syncClient, Date.now, first.waypoint);
          const committer = new WriterCommitter(
            first.waypoint,
            first.queue,
            blobs,
            bucket,
            sync,
            ingest,
          );
          ingest.committer = committer;
          const app = createApp({
            waypoint: first.waypoint,
            queue: first.queue,
            blobs,
            reads,
            ingest,
            bucket,
            committer,
            syncLoop: sync,
          });
          const markdown = bytes("# Restore me\n");
          const image = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
            "base64",
          );
          const md = await blobs.put(Readable.from([markdown]));
          const png = await blobs.put(Readable.from([image]));
          expect(md.hash).toBe(hash(markdown));
          expect(png.hash).toBe(hash(image));
          const create = await app.request("/api/collections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Restore me",
              head_path: "index.md",
              files: [
                { path: "index.md", hash: md.hash },
                { path: "pixel.png", hash: png.hash },
              ],
            }),
          });
          expect(create.status).toBe(200);
          const created: unknown = await create.json();
          if (
            !created ||
            typeof created !== "object" ||
            !("collection_id" in created) ||
            typeof created.collection_id !== "string" ||
            !("revision_id" in created) ||
            typeof created.revision_id !== "string"
          )
            throw new Error("Invalid create response");
          const collectionId = created.collection_id;
          const firstRevision = created.revision_id;
          const note = await blobs.put(Readable.from(["second revision"]));
          const second = await app.request(`/api/collections/${collectionId}/revisions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              files: [{ path: "note.txt", hash: note.hash }],
              message: "second",
            }),
          });
          expect(second.status).toBe(200);
          const secondBody: unknown = await second.json();
          if (
            !secondBody ||
            typeof secondBody !== "object" ||
            !("revision_id" in secondBody) ||
            typeof secondBody.revision_id !== "string"
          )
            throw new Error("Invalid second revision");
          const secondRevision = secondBody.revision_id;
          expect(secondRevision).not.toBe(firstRevision);
          expect(
            (
              await app.request(`/api/collections/${collectionId}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "Edited title" }),
              })
            ).status,
          ).toBe(200);
          expect(
            (await app.request(`/api/collections/${collectionId}`, { method: "DELETE" })).status,
          ).toBe(200);
          await committer.drain();
          await delay(10);
          await sync.push();
          const before = await reads.getCollection(collectionId);
          const revisionsBefore = await reads.listRevisions(collectionId);
          expect(before.deleted).toBe(true);
          expect(revisionsBefore.revisions).toHaveLength(2);
          const renditionsBefore = await first.waypoint.all(
            "SELECT source_hash,output_hash FROM renditions",
          );
          expect(renditionsBefore).not.toHaveLength(0);
          committer.stop();
          await committer.drain();
          sync.stop();
          await sync.drain();
          await first.waypoint.close();
          await first.queue.close();
          await stop(firstServer);
          const secondPort = await port();
          secondServer = await server(bin, join(dir, "second-cloud.db"), secondPort);
          const fresh = await openDatabases(config(join(dir, "fresh"), secondPort));
          try {
            await guardEnvironment(fresh.waypoint, fresh.syncClient, "dev");
            await migrate(fresh.waypoint, waypointMigrations);
            await migrate(fresh.queue, queueMigrations);
            const result = await restore(
              fresh.waypoint,
              bucket,
              new SyncLoop(fresh.queue, fresh.syncClient, Date.now, fresh.waypoint),
              "from-bucket",
            );
            expect(result).toEqual({ collections: 1, revisions: 2, ignored: 0 });
            const restored = new ReadModel(
              fresh.waypoint,
              fresh.queue,
              `http://127.0.0.1:${secondPort}`,
            );
            const after = await restored.getCollection(collectionId);
            const revisionsAfter = await restored.listRevisions(collectionId);
            expect(after.title).toBe(before.title);
            expect(after.deleted).toBe(before.deleted);
            expect(
              revisionsAfter.revisions.map((row) => ({
                id: row.id,
                display_number: row.display_number,
              })),
            ).toEqual(
              revisionsBefore.revisions.map((row) => ({
                id: row.id,
                display_number: row.display_number,
              })),
            );
            expect(
              await fresh.waypoint.all("SELECT source_hash,output_hash FROM renditions"),
            ).toEqual(renditionsBefore);
            expect(
              (
                await restore(
                  fresh.waypoint,
                  bucket,
                  new SyncLoop(fresh.queue, fresh.syncClient, Date.now, fresh.waypoint),
                  "merge",
                )
              ).revisions,
            ).toBe(0);
          } finally {
            await fresh.waypoint.close();
            await fresh.queue.close();
          }
        } catch (error) {
          await first.waypoint.close().catch(() => undefined);
          await first.queue.close().catch(() => undefined);
          throw error;
        }
      } finally {
        await stop(firstServer);
        if (secondServer) await stop(secondServer);
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
