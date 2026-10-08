import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttp, request } from "node:http";
import { createServer as createTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { Config } from "../src/config.ts";
import { openDatabases } from "../src/db.ts";
import { guardEnvironment, migrate, waypointMigrations } from "../src/migrations.ts";

async function freePort(): Promise<number> {
  const socket = createTcp();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
async function ready(port: number, remaining = 100): Promise<void> {
  if (!remaining) throw new Error("Sync server did not start");
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) });
  } catch {
    await delay(50);
    await ready(port, remaining - 1);
  }
}
describe("sync network I/O", () => {
  it.skipIf(!process.env.TURSODB_BIN)(
    "does not hold the statement mutex across a slow push",
    async () => {
      const bin = process.env.TURSODB_BIN;
      if (!bin) throw new Error("TURSODB_BIN required");
      const dir = await mkdtemp(join(tmpdir(), "waypoint-sync-mutex-"));
      const upstream = await freePort();
      const server = spawn(bin, [join(dir, "cloud.db"), "--sync-server", `127.0.0.1:${upstream}`], {
        stdio: "ignore",
      });
      let proxy: ReturnType<typeof createHttp> | undefined;
      try {
        await ready(upstream);
        let delayPost = false;
        let delayed = 0;
        proxy = createHttp((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const forward = () => {
              const remote = request(
                {
                  host: "127.0.0.1",
                  port: upstream,
                  method: req.method,
                  path: req.url,
                  headers: req.headers,
                },
                (response) => {
                  res.writeHead(response.statusCode ?? 502, response.headers);
                  response.pipe(res);
                },
              );
              remote.end(Buffer.concat(chunks));
            };
            if (delayPost && req.method === "POST") {
              delayed++;
              setTimeout(forward, 1200);
            } else forward();
          });
        });
        const port = await freePort();
        await new Promise<void>((resolve) => proxy!.listen(port, "127.0.0.1", resolve));
        const config: Config = {
          environment: "dev",
          dataDir: join(dir, "writer"),
          baseUrl: `http://127.0.0.1:${port}`,
          port,
          queueGiveUpHours: 72,
          maxBlobBytes: 1024,
          sync: true,
          tursoUrl: `http://127.0.0.1:${port}`,
          tursoAuthToken: "test",
        };
        const db = await openDatabases(config);
        try {
          await guardEnvironment(db.waypoint, db.syncClient, "dev");
          await migrate(db.waypoint, waypointMigrations);
          await db.syncClient.push();
          await db.waypoint.run("INSERT INTO meta (key,value) VALUES ('mutex_probe','1')");
          delayPost = true;
          let finished = false;
          const pushing = db.syncClient.push().finally(() => {
            finished = true;
          });
          let maxLatency = 0;
          for (;;) {
            if (finished) break;
            const start = Date.now();
            await db.waypoint.get("SELECT 1");
            maxLatency = Math.max(maxLatency, Date.now() - start);
            await delay(20);
          }
          await pushing;
          expect(delayed).toBeGreaterThan(0);
          expect(maxLatency).toBeLessThan(800);
        } finally {
          await db.waypoint.close();
          await db.queue.close();
        }
      } finally {
        await new Promise<void>((resolve) => proxy?.close(() => resolve()) ?? resolve());
        server.kill("SIGTERM");
        await new Promise<void>((resolve) => server.once("exit", () => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
