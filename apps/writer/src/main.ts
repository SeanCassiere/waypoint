import { serve } from "@hono/node-server";

import { BlobStore } from "./blob-store.js";
import { loadConfig } from "./config.js";
import { ownDataDirectory } from "./data-dir.js";
import { openDatabases } from "./db.js";
import { createApp } from "./http.js";
import { IngestService } from "./ingest.js";
import { migrate, waypointMigrations, queueMigrations, guardEnvironment } from "./migrations.js";
import { ReadModel } from "./read-model.js";
import { writerRenderer } from "./renderer.js";

const command = process.argv[2] ?? "serve";
if (command === "restore") {
  console.log("not implemented yet");
  process.exit(0);
}
if (command !== "serve") {
  console.error("Usage: waypoint-writer serve|restore");
  process.exit(2);
}
let releaseDirectory: (() => Promise<void>) | undefined;
try {
  const config = loadConfig();
  releaseDirectory = await ownDataDirectory(config.dataDir);
  const { waypoint, queue, syncClient } = await openDatabases(config);
  await guardEnvironment(waypoint, syncClient, config.environment, config.sync);
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  const blobs = new BlobStore(config.dataDir, config.maxBlobBytes);
  await blobs.sweepTemps();
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(
    waypoint,
    queue,
    blobs,
    reads,
    syncClient,
    undefined,
    writerRenderer,
    config.maxFiles,
    config.maxRevisionBytes,
  );
  const server = serve({
    fetch: createApp({ waypoint, queue, blobs, reads, ingest, port: config.port }).fetch,
    hostname: "127.0.0.1",
    port: config.port,
  });
  console.log(`Waypoint writer listening on 127.0.0.1:${config.port}`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    server.close(() => {
      void blobs
        .waitForIdle()
        .then(() => blobs.sweepTemps())
        .then(() => Promise.all([waypoint.close(), queue.close()]))
        .then(async () => releaseDirectory?.())
        .then(() => {
          clearTimeout(timeout);
          process.exit(0);
        })
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.stack : "Shutdown failed");
          process.exit(1);
        });
    });
    if ("closeAllConnections" in server) server.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  await releaseDirectory?.();
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
}
