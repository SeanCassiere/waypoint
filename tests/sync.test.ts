import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { describe, it, expect } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.js";
import { MemoryBucket } from "../apps/writer/src/bucket.js";
import { WriterCommitter } from "../apps/writer/src/committer.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases } from "../apps/writer/src/db.js";
import { createApp } from "../apps/writer/src/http.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import {
  migrate,
  waypointMigrations,
  queueMigrations,
  guardEnvironment,
} from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";

async function waitForServer(url: string, attempts: number): Promise<boolean> {
  if (attempts === 0) return false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(200) });
    return true;
  } catch {
    await delay(50);
    return waitForServer(url, attempts - 1);
  }
}
describe("production SyncClient", () => {
  it.skipIf(!process.env.TURSODB_BIN)(
    "pulls, pushes, and checkpoints through a local sync server",
    async () => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-sync-test-"));
      const socket = createServer();
      await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const port = address.port;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const server = spawn(bin, [join(dir, "server.db"), "--sync-server", `127.0.0.1:${port}`], {
        stdio: "ignore",
      });
      const url = `http://127.0.0.1:${port}`;
      try {
        const ready = await waitForServer(url, 80);
        expect(ready).toBe(true);
        const config: Config = {
          environment: "dev",
          dataDir: join(dir, "a"),
          baseUrl: url,
          port,
          queueGiveUpHours: 72,
          maxBlobBytes: 1024,
          sync: true,
          tursoUrl: url,
          tursoAuthToken: "test",
          r2AccountId: "test",
          r2AccessKeyId: "test",
          r2SecretAccessKey: "test",
          r2Bucket: "test",
        };
        const first = await openDatabases(config);
        try {
          await guardEnvironment(first.waypoint, first.syncClient, "dev");
          await migrate(first.waypoint, waypointMigrations);
          await first.waypoint.run(
            "INSERT INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
            ["col_01j9qz7x2bm4d8vk3np6rt9hcs", "apwyysc2zcj6", "roundtrip", "{}", Date.now()],
          );
          await first.syncClient.push();
          await first.syncClient.checkpoint();
          const second = await openDatabases({ ...config, dataDir: join(dir, "b") });
          try {
            await guardEnvironment(second.waypoint, second.syncClient, "dev");
            await migrate(second.waypoint, waypointMigrations);
            expect(
              (
                await second.waypoint.get<{ title: string }>(
                  "SELECT title FROM collections WHERE id=?",
                  ["col_01j9qz7x2bm4d8vk3np6rt9hcs"],
                )
              )?.title,
            ).toBe("roundtrip");
            expect(
              (
                await second.waypoint.get<{ value: string }>(
                  "SELECT value FROM meta WHERE key='environment'",
                )
              )?.value,
            ).toBe("dev");
          } finally {
            await second.waypoint.close();
            await second.queue.close();
          }
        } finally {
          await first.waypoint.close();
          await first.queue.close();
        }
        server.kill("SIGTERM");
        await new Promise<void>((resolve) => server.once("exit", () => resolve()));
        const offline = await openDatabases(config);
        try {
          await guardEnvironment(offline.waypoint, offline.syncClient, "dev");
          expect(offline.syncClient.verified).toBe(false);
          await migrate(offline.waypoint, waypointMigrations);
          await migrate(offline.queue, queueMigrations);
          expect(
            (
              await offline.waypoint.get<{ title: string }>(
                "SELECT title FROM collections WHERE id=?",
                ["col_01j9qz7x2bm4d8vk3np6rt9hcs"],
              )
            )?.title,
          ).toBe("roundtrip");
          const blobs = new BlobStore(config.dataDir, config.maxBlobBytes);
          const uploaded = await blobs.put(Readable.from(["offline bytes"]));
          const reads = new ReadModel(offline.waypoint, offline.queue, config.baseUrl);
          const ingest = new IngestService(
            offline.waypoint,
            offline.queue,
            blobs,
            reads,
            offline.syncClient,
          );
          const bucket = new MemoryBucket();
          const syncLoop = new SyncLoop(offline.queue, offline.syncClient);
          const committer = new WriterCommitter(
            offline.waypoint,
            offline.queue,
            blobs,
            bucket,
            syncLoop,
            ingest,
          );
          ingest.committer = committer;
          const app = createApp({
            waypoint: offline.waypoint,
            queue: offline.queue,
            blobs,
            reads,
            ingest,
            port,
          });
          expect((await app.request("/healthz")).status).toBe(200);
          const created = await app.request("/api/collections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "offline write",
              files: [{ path: "index.txt", hash: uploaded.hash }],
            }),
          });
          expect(created.status).toBe(200);
          const result: unknown = await created.json();
          if (
            !result ||
            typeof result !== "object" ||
            !("collection_id" in result) ||
            typeof result.collection_id !== "string"
          )
            throw new Error("Invalid offline write result");
          expect((await app.request(`/api/collections/${result.collection_id}`)).status).toBe(200);
          if (!("revision_id" in result) || typeof result.revision_id !== "string")
            throw new Error("Invalid revision ID");
          expect((await reads.revision(result.revision_id))?.sync_state).toBe("committed");
          const restarted = spawn(
            bin,
            [join(dir, "server.db"), "--sync-server", `127.0.0.1:${port}`],
            { stdio: "ignore" },
          );
          try {
            expect(await waitForServer(url, 80)).toBe(true);
            await delay(5);
            await syncLoop.push();
            expect((await reads.revision(result.revision_id))?.sync_state).toBe("synced");
          } finally {
            restarted.kill("SIGTERM");
            await new Promise<void>((resolve) => restarted.once("exit", () => resolve()));
          }
          committer.stop();
          await committer.drain();
        } finally {
          await offline.waypoint.close();
          await offline.queue.close();
        }
      } finally {
        if (server.exitCode === null && server.signalCode === null) {
          server.kill("SIGTERM");
          await new Promise<void>((resolve) => server.once("exit", () => resolve()));
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
  it.skipIf(!process.env.TURSODB_BIN)(
    "drops cached statements when a pull brings data and schema changes",
    async () => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-sync-statements-"));
      const socket = createServer();
      await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const port = address.port;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const server = spawn(bin, [join(dir, "server.db"), "--sync-server", `127.0.0.1:${port}`], {
        stdio: "ignore",
      });
      const url = `http://127.0.0.1:${port}`;
      try {
        expect(await waitForServer(url, 80)).toBe(true);
        const config: Config = {
          environment: "dev",
          dataDir: join(dir, "a"),
          baseUrl: url,
          port,
          queueGiveUpHours: 72,
          maxBlobBytes: 1024,
          sync: true,
          tursoUrl: url,
          tursoAuthToken: "test",
          r2AccountId: "test",
          r2AccessKeyId: "test",
          r2SecretAccessKey: "test",
          r2Bucket: "test",
        };
        const first = await openDatabases(config);
        const second = await openDatabases({ ...config, dataDir: join(dir, "b") });
        try {
          await first.waypoint.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
          await first.waypoint.run("INSERT INTO notes (id,body) VALUES (1,'one')");
          await first.syncClient.push();
          expect(await second.syncClient.pull()).toBe(true);
          // Cache the statement on the second replica, then change data and schema remotely.
          expect(await second.waypoint.all("SELECT * FROM notes ORDER BY id")).toEqual([
            { id: 1, body: "one" },
          ]);
          await first.waypoint.exec("ALTER TABLE notes ADD COLUMN tag TEXT DEFAULT 't'");
          await first.waypoint.run("INSERT INTO notes (id,body) VALUES (2,'two')");
          await first.syncClient.push();
          expect(await second.syncClient.pull()).toBe(true);
          expect(await second.waypoint.all("SELECT * FROM notes ORDER BY id")).toEqual([
            { id: 1, body: "one", tag: "t" },
            { id: 2, body: "two", tag: "t" },
          ]);
        } finally {
          await second.waypoint.close();
          await second.queue.close();
          await first.waypoint.close();
          await first.queue.close();
        }
      } finally {
        server.kill("SIGTERM");
        await new Promise<void>((resolve) => server.once("exit", () => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
