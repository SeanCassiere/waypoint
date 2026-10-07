import { inSeries, type Db, type SyncClient } from "./db.js";
export const waypointMigrations = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY CHECK (id GLOB 'col_*' AND length(id) = 30), public_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collection_tombstones (collection_id TEXT PRIMARY KEY REFERENCES collections(id), deleted_at INTEGER NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY CHECK (id GLOB 'rev_*' AND length(id) = 30), public_id TEXT NOT NULL UNIQUE, collection_id TEXT NOT NULL REFERENCES collections(id), parent_revision_id TEXT REFERENCES revisions(id), head_path TEXT NOT NULL, message TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS revisions_by_collection ON revisions (collection_id, id);
CREATE TABLE IF NOT EXISTS revision_files (revision_id TEXT NOT NULL REFERENCES revisions(id), path TEXT NOT NULL, blob_hash TEXT NOT NULL REFERENCES blobs(hash), mime TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (revision_id, path));
CREATE INDEX IF NOT EXISTS revision_files_by_blob ON revision_files (blob_hash);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY CHECK (hash GLOB 'sha256:*' AND length(hash) = 71), size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS renditions (source_hash TEXT NOT NULL REFERENCES blobs(hash), renderer TEXT NOT NULL, renderer_version INTEGER NOT NULL, output_hash TEXT NOT NULL REFERENCES blobs(hash), output_mime TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (source_hash, renderer, renderer_version));
`,
  },
];
export const queueMigrations = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE IF NOT EXISTS pending_collections (id TEXT PRIMARY KEY CHECK (id GLOB 'col_*' AND length(id) = 30), public_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS pending_revisions (id TEXT PRIMARY KEY CHECK (id GLOB 'rev_*' AND length(id) = 30), public_id TEXT NOT NULL UNIQUE, collection_id TEXT NOT NULL, parent_revision_id TEXT, head_path TEXT NOT NULL, message TEXT, metadata TEXT NOT NULL DEFAULT '{}', manifest_json TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','failed')), attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, next_attempt_at INTEGER, last_error TEXT, error_kind TEXT CHECK (error_kind IN ('transient','permanent')));
CREATE INDEX IF NOT EXISTS pending_revisions_by_collection ON pending_revisions (collection_id, id);
CREATE TABLE IF NOT EXISTS pending_blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_renditions (source_hash TEXT NOT NULL, renderer TEXT NOT NULL, renderer_version INTEGER NOT NULL, output_hash TEXT NOT NULL, output_mime TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (source_hash, renderer, renderer_version));
CREATE TABLE IF NOT EXISTS pending_snapshots (collection_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_r2_deletes (key TEXT PRIMARY KEY, requested_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_purges (collection_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, step INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS unpushed (revision_id TEXT PRIMARY KEY, committed_at INTEGER NOT NULL);
`,
  },
];
export async function migrate(
  db: Db,
  migrations: readonly { id: string; sql: string }[],
): Promise<void> {
  const table = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  );
  if (!table)
    await db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
  await inSeries(migrations, async (migration) => {
    const exists = await db.get<{ id: string }>("SELECT id FROM schema_migrations WHERE id=?", [
      migration.id,
    ]);
    if (exists) return;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?,?)", [
        migration.id,
        Date.now(),
      ]);
    });
  });
}
export async function guardEnvironment(
  db: Db,
  sync: SyncClient,
  environment: "dev" | "prod",
  remote = true,
): Promise<void> {
  const read = async (): Promise<string | undefined> => {
    const table = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
    );
    if (!table) return undefined;
    return (await db.get<{ value: string }>("SELECT value FROM meta WHERE key='environment'"))
      ?.value;
  };
  const local = await read();
  if (local && local !== environment)
    throw new Error(
      `Environment mismatch: local waypoint.db is ${local}, config is ${environment}`,
    );
  const verify = async () => {
    if (sync.probe && !(await sync.probe())) throw new Error("Sync server unavailable");
    await sync.pull();
    const pulled = await read();
    if (pulled && pulled !== environment)
      throw new Error(
        `Environment mismatch: remote cloud DB is ${pulled}, config is ${environment}`,
      );
    if (!pulled && local) throw new Error("Remote environment marker is missing");
    sync.verified = true;
    return pulled;
  };
  if (remote) {
    try {
      await verify();
    } catch (error) {
      if (
        !local ||
        (error instanceof Error && /Environment mismatch|marker is missing/.test(error.message))
      )
        throw error;
      sync.verified = false;
    }
    sync.beforePush = async () => {
      await verify();
    };
  } else sync.verified = true;
  if (!local && !(await read())) {
    await db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await db.run("INSERT INTO meta (key,value) VALUES ('environment',?)", [environment]);
    if (remote) await sync.push();
  }
}
