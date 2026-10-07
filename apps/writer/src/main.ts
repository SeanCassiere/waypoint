import { serve } from "@hono/node-server";

import { BlobStore } from "./blob-store.js";
import { R2Bucket } from "./bucket.js";
import { WriterCommitter } from "./committer.js";
import { loadConfig } from "./config.js";
import { ownDataDirectory } from "./data-dir.js";
import { openDatabases } from "./db.js";
import { createApp } from "./http.js";
import { IngestService } from "./ingest.js";
import { migrate, waypointMigrations, queueMigrations, guardEnvironment } from "./migrations.js";
import { ReadModel } from "./read-model.js";
import { writerRenderer } from "./renderer.js";
import {
  formatRerenderSummary,
  parseRerenderArgs,
  RERENDER_USAGE,
  rerender,
  type RerenderOptions,
} from "./rerender.js";
import { restore } from "./restore.js";
import { SyncLoop } from "./sync-loop.js";

const command = process.argv[2] ?? "serve";
const restoreMode = process.argv[3];
if (command === "--help" || command === "help") {
  console.log(
    `Usage: waypoint-writer serve | restore --from-bucket | restore --merge | rerender …\nA fresh writer normally bootstraps from the cloud DB; restore rebuilds missing cloud data from the bucket.\n${RERENDER_USAGE}\nrerender queues current-version renditions for existing markdown; run it with the server stopped.`,
  );
  process.exit(0);
}
let rerenderOptions: RerenderOptions | undefined;
if (command === "rerender") {
  try {
    rerenderOptions = parseRerenderArgs(process.argv.slice(3), writerRenderer);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n${RERENDER_USAGE}`,
    );
    process.exit(2);
  }
} else if (
  command !== "serve" &&
  !(command === "restore" && (restoreMode === "--from-bucket" || restoreMode === "--merge"))
) {
  console.error(
    "Usage: waypoint-writer serve | restore --from-bucket | restore --merge | rerender …",
  );
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
  if (command === "restore") {
    if (!config.sync) throw new Error("Restore requires cloud sync");
    const bucket = new R2Bucket(config);
    const summary = await restore(
      waypoint,
      bucket,
      new SyncLoop(queue, syncClient, Date.now, waypoint, { pushMs: 300_000 }),
      restoreMode === "--merge" ? "merge" : "from-bucket",
    );
    console.log(JSON.stringify(summary));
    await waypoint.close();
    await queue.close();
    await releaseDirectory();
    process.exit(0);
  }
  const blobs = new BlobStore(config.dataDir, config.maxBlobBytes);
  await blobs.sweepTemps();
  if (rerenderOptions) {
    const bucket = config.sync ? new R2Bucket(config) : undefined;
    console.log(
      formatRerenderSummary(
        await rerender(waypoint, queue, blobs, writerRenderer, rerenderOptions, bucket),
      ),
    );
    await waypoint.close();
    await queue.close();
    await releaseDirectory();
    process.exit(0);
  }
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
  const bucket = config.sync ? new R2Bucket(config) : undefined;
  const syncLoop = new SyncLoop(queue, syncClient, Date.now, waypoint);
  const committer = bucket
    ? new WriterCommitter(
        waypoint,
        queue,
        blobs,
        bucket,
        syncLoop,
        ingest,
        Date.now,
        Math.random,
        config.queueGiveUpHours,
        undefined,
        (collectionId) => reads.notifyRevision(collectionId),
      )
    : undefined;
  if (committer) {
    ingest.committer = committer;
    syncLoop.start();
    committer.wake();
  }
  if (Boolean(config.publicBaseUrl) !== Boolean(config.shareTokenKey))
    console.error(
      config.publicBaseUrl
        ? "WAYPOINT_SHARE_TOKEN_KEY is not set: existing links can be listed and revoked, but new links can't be created and URLs can't be shown"
        : "Sharing is off: WAYPOINT_PUBLIC_BASE_URL is not set",
    );
  const shutdownController = new AbortController();
  const server = serve({
    fetch: createApp({
      ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
      ...(config.shareTokenKey ? { shareTokenKey: config.shareTokenKey } : {}),
      waypoint,
      queue,
      blobs,
      reads,
      ingest,
      bucket,
      committer,
      // With sync off nothing reaches a cloud: no push times, so links stay "activating" or
      // "revoking" (not yet pushed) instead of pretending the local no-op push published them.
      ...(config.sync ? { syncLoop } : {}),
      environment: config.environment,
      port: config.port,
      shutdownSignal: shutdownController.signal,
      ...(config.mcpTarballPath ? { mcpTarballPath: config.mcpTarballPath } : {}),
      ...(config.mcpLauncherPath ? { mcpLauncherPath: config.mcpLauncherPath } : {}),
      ...(config.mcpServerPath ? { mcpServerPath: config.mcpServerPath } : {}),
      ...(config.mcpSkillPath ? { mcpSkillPath: config.mcpSkillPath } : {}),
    }).fetch,
    hostname: "127.0.0.1",
    port: config.port,
  });
  console.log(`Waypoint writer listening on 127.0.0.1:${config.port}`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort();
    committer?.stop();
    syncLoop.stop();
    const timeout = setTimeout(() => process.exit(1), 10_000);
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    server.close(() => {
      void blobs
        .waitForIdle()
        .then(() => committer?.drain())
        .then(() => syncLoop.drain())
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
