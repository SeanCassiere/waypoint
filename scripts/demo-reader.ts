// The public reader over a demo writer's data, for UI work on reader pages: it serves
// createReaderApp from source over a live snapshot of the writer's local waypoint.db and its blob
// directory. Start the writer with WAYPOINT_PUBLIC_BASE_URL=http://127.0.0.1:<port> so its share
// URLs point here.
// Usage: pnpm demo:reader <port> <writer-data-dir>
// It reads the writer's local DB, so revocations, renames and committed revisions show within
// about 6 s (a 0.5 s snapshot check plus the reader's 5 s link cache), with no push delay; queued
// revisions (uploading, failed) are absent, as on the real reader. It never writes to the writer's
// data directory, and never touches Turso, R2, or ~/.config/waypoint.
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { serve } from "@hono/node-server";

import { createReaderApp, type ReaderEnv } from "../apps/reader/src/app.ts";

const [portText = "", dataDir = ""] = process.argv.slice(2);
const port = Number(portText);
if (
  !/^\d+$/.test(portText) ||
  port < 1 ||
  port > 65535 ||
  !dataDir ||
  !existsSync(join(dataDir, "waypoint.db"))
) {
  console.error("Usage: pnpm demo:reader <port> <writer-data-dir>");
  process.exit(2);
}

// The writer's SQLite files, copied together so the copy is consistent with its WAL.
const SOURCES = ["waypoint.db", "waypoint.db-wal", "waypoint.db-shm"];
/** Each source's size and mtime ("-" when absent): a change means the writer wrote. */
async function signature(): Promise<string> {
  const parts = await Promise.all(
    SOURCES.map((name) =>
      stat(join(dataDir, name)).then(
        (info) => `${info.size}:${info.mtimeMs}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

interface Snapshot {
  dir: string;
  db: DatabaseSync;
  signature: string;
}
/** Copies the writer's DB files into a fresh temp dir and opens the copy read-only. */
async function snapshot(): Promise<Snapshot> {
  const current = await signature();
  const dir = await mkdtemp(join(tmpdir(), "waypoint-demo-reader-"));
  try {
    await Promise.all(
      SOURCES.map((name) =>
        copyFile(join(dataDir, name), join(dir, name)).catch((error: unknown) => {
          // The WAL and its index come and go with checkpoints; the DB itself must be there.
          if (name === "waypoint.db") throw error;
        }),
      ),
    );
    const db = new DatabaseSync(join(dir, "waypoint.db"), { readOnly: true });
    try {
      // A copy torn mid-write fails here rather than on a page.
      db.prepare("SELECT count(*) FROM share_links").get();
    } catch (error) {
      db.close();
      throw error;
    }
    return { dir, db, signature: current };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

let live: Snapshot;
try {
  live = await snapshot();
} catch (error) {
  console.error(`Can't open ${join(dataDir, "waypoint.db")}: ${String(error)}`);
  process.exit(1);
}
let checkedAt = 0;
let checking: Promise<void> | undefined;
let shuttingDown = false;
/** At most every 500 ms: a new snapshot if the writer's files changed (else the current one). */
function refresh(): Promise<void> {
  if (shuttingDown || Date.now() - checkedAt < 500) return Promise.resolve();
  checking ??= (async () => {
    try {
      if ((await signature()) === live.signature) return;
      const previous = live;
      try {
        live = await snapshot();
      } catch (error) {
        console.error(`Kept the previous snapshot: ${String(error)}`);
        return;
      }
      previous.db.close();
      await rm(previous.dir, { recursive: true, force: true });
    } finally {
      checkedAt = Date.now();
      checking = undefined;
    }
  })();
  return checking;
}

const env: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const app = createReaderApp({
  db: () => ({
    all: async (sql, args = []) => {
      await refresh();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return live.db.prepare(sql).all(...args) as never;
    },
  }),
  blob: () => ({
    probe: () => Promise.resolve(new Response("ok")),
    fetch: async (hash) => {
      // The writer's BlobStore layout.
      const hex = hash.replace(/^sha256:/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return new Response("missing", { status: 404 });
      try {
        return new Response(await readFile(join(dataDir, "blobs", "sha256", hex.slice(0, 2), hex)));
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
  }),
});
/** Closes the DB and removes the snapshot, then exits (once, whatever asked first). */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await checking;
  live.db.close();
  await rm(live.dir, { recursive: true, force: true });
  process.exit(code);
}
const server = serve({ fetch: (req) => app.fetch(req, env), hostname: "127.0.0.1", port }, () =>
  console.log(`Demo reader on http://127.0.0.1:${port} (writer data ${dataDir})`),
);
// E.g. the port is taken: say so, and still clean up.
server.on("error", (error: unknown) => {
  console.error(`Can't serve on port ${port}: ${String(error)}`);
  void shutdown(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(0));
