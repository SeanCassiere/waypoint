// A byte-for-byte HTML snapshot of the writer's pages over one seeded demo data directory, to prove
// that a refactor changes no markup: run it before and after with the same --data and diff -r the
// two output directories.
// Usage: pnpm snapshot:pages <out-dir> [--data <seeded-data-dir>] [--now <epoch-ms>]
// (tsx runs the writer from source; the viewer assets must be built:
// pnpm turbo run build:viewer --filter=@waypoint/writer).
// Without --data it seeds a fresh directory with scripts/demo-writer.ts and prints its path. It
// never modifies a --data directory: it opens a copy, with the clock frozen and nothing running in
// the background, and only reads through app.request.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import { openDatabases, type SyncClient } from "../apps/writer/src/db.ts";
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
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";

// Set after the static imports have been evaluated: no writer module builds a date formatter or
// reads the time zone at module scope, so every date is formatted in UTC.
process.env.TZ = "UTC";

const USAGE = "Usage: pnpm snapshot:pages <out-dir> [--data <seeded-data-dir>] [--now <epoch-ms>]";
// 32 bytes of 0x2a, as WAYPOINT_SHARE_TOKEN_KEY's 43 base64url characters and as bytes.
const SHARE_TOKEN_KEY = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio";
const shareTokenKey = new Uint8Array(32).fill(0x2a);
const port = 7421;
const base = `http://127.0.0.1:${port}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let out: string | undefined;
let data: string | undefined;
let nowArg: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--data") data = args[++i];
  else if (arg === "--now") nowArg = Number(args[++i]);
  else if (!arg.startsWith("--") && out === undefined) out = arg;
  else throw new Error(USAGE);
}
if (!out || (args.includes("--data") && !data)) throw new Error(USAGE);
if (nowArg !== undefined && !Number.isSafeInteger(nowArg)) throw new Error(USAGE);

/** The real path of `path`, which may not exist yet (resolves its nearest existing ancestor). */
async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await realTarget(parent), basename(absolute));
  }
}
// The --data directory is never modified, so the output may not be it or lie inside it.
if (data) {
  const inside = relative(await realpath(resolve(data)), await realTarget(out));
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw new Error(`The output directory must be outside the --data directory\n${USAGE}`);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? done(address.port) : fail(new Error("No port")),
      );
    });
  });
}

/** Runs scripts/demo-writer.ts on a fresh directory until it has seeded, then stops it. */
async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-snapshot-seed-"));
  const tsx = createRequire(join(root, "package.json")).resolve("tsx/cli");
  const child = spawn(
    process.execPath,
    [
      tsx,
      "--tsconfig",
      "apps/writer/tsconfig.json",
      "--conditions=@waypoint/source",
      "scripts/demo-writer.ts",
      String(await freePort()),
      dir,
    ],
    {
      cwd: root,
      env: { ...process.env, WAYPOINT_SHARE_TOKEN_KEY: SHARE_TOKEN_KEY },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  await new Promise<void>((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.split("\n").some((line) => line.startsWith("Demo writer on"))) done();
    });
    child.once("exit", (code) => fail(new Error(`Demo writer exited (${code}) before seeding`)));
  });
  child.kill("SIGTERM");
  await exited;
  console.error(`Seeded data dir: ${dir} (reuse it with --data ${dir})`);
  return dir;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const source = data ?? (await seed());
const dir = await mkdtemp(join(tmpdir(), "waypoint-snapshot-"));
// The temp copy is removed even when wiring or a request throws.
let count: number;
try {
  await cp(source, dir, { recursive: true });

  const { waypoint, queue } = await openDatabases({
    environment: "dev",
    dataDir: dir,
    baseUrl: base,
    port,
    queueGiveUpHours: 72,
    maxBlobBytes: 64 * 1024 * 1024,
    sync: false,
  });
  await migrate(waypoint, waypointMigrations);
  await migrate(queue, queueMigrations);
  const latestAt = async (db: typeof waypoint, table: string) =>
    (await db.get<{ at: number | null }>(`SELECT MAX(created_at) AS at FROM ${table}`))?.at ?? 0;
  const now =
    nowArg ??
    Math.max(await latestAt(waypoint, "revisions"), await latestAt(queue, "pending_revisions")) +
      600_000;
  // Every clock reads the frozen time from here on; constructors get () => now, never Date.now.
  const clock = () => now;
  Date.now = clock;

  const cloud: SyncClient = {
    lastPullAt: now,
    verified: true,
    pull: () => Promise.resolve(false),
    push: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
  await guardEnvironment(waypoint, cloud, "dev", false);
  const blobs = new BlobStore(dir, 64 * 1024 * 1024);
  const reads = new ReadModel(waypoint, queue, base);
  const ingest = new IngestService(waypoint, queue, blobs, reads, cloud, undefined, writerRenderer);
  const syncLoop = new SyncLoop(queue, cloud, clock, waypoint);
  const committer = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    new MemoryBucket(),
    syncLoop,
    ingest,
    clock,
    Math.random,
    72,
    undefined,
    (id) => reads.notifyRevision(id),
  );
  ingest.committer = committer;
  // No syncLoop.start(), committer.wake() or serve(): nothing may change the seeded state.
  const app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    committer,
    syncLoop,
    environment: "dev",
    port,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey,
  });

  const pages = [
    "/",
    "/?q=webhook",
    "/?q=project:infra",
    "/?q=in:trash",
    "/?q=is:pending",
    "/status",
    "/trash",
    "/links",
    "/mcp",
    "/nope",
    "/c/zzzzzzzzzzzz/",
  ];
  const collections = await waypoint.all<{ id: string; public_id: string; title: string }>(
    "SELECT id,public_id,title FROM collections",
  );
  collections.sort((a, b) =>
    a.title < b.title
      ? -1
      : a.title > b.title
        ? 1
        : a.public_id < b.public_id
          ? -1
          : a.public_id > b.public_id
            ? 1
            : 0,
  );
  for (const { id, public_id: pub } of collections) {
    const c = `/c/${pub}/`;
    pages.push(
      c,
      `${c}?panel=history`,
      `${c}?panel=history&history=all`,
      `${c}?panel=links`,
      `${c}?as=public`,
    );
    if ((await reads.collection(id))?.deleted_at != null) continue;
    const revisions = await reads.revisions(id);
    for (const { public_id: r } of revisions)
      pages.push(`${c}r/${r}/`, `${c}r/${r}/changes`, `${c}r/${r}/changes?view=source`);
    const latest = await reads.latest(id);
    if (!latest) continue;
    if (revisions.length > 1)
      pages.push(`${c}r/${latest.public_id}/changes?base=${revisions[0]!.public_id}`);
    const manifest = await reads.manifestOf(latest);
    const galleries = new Set<string>();
    for (const [path, file] of Object.entries(manifest.files)) {
      pages.push(`${c}${encodePath(path)}`);
      const slash = path.lastIndexOf("/");
      if (file.mime.startsWith("image/") && slash > 0) galleries.add(path.slice(0, slash));
    }
    for (const gallery of galleries)
      pages.push(`${c}r/${latest.public_id}/gallery/${encodePath(gallery)}/`);
  }

  await mkdir(out, { recursive: true });
  const index: string[] = [];
  for (const [n, path] of pages.entries()) {
    const response = await app.request(path);
    const file = `${String(n).padStart(3, "0")}-${path.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.txt`;
    await writeFile(join(out, file), new Uint8Array(await response.arrayBuffer()));
    index.push(`${response.status}\t${path}\t${file}\t${response.headers.get("location") ?? ""}\n`);
  }
  await writeFile(join(out, "index.tsv"), index.join(""));
  count = pages.length;
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`Snapshot: ${count} pages → ${out}`);
process.exit(0);
