import { localServer, rows } from '../local-server.mjs';

const migrationId = '0002_add_note';
async function applyMigration(db) {
  const applied = await rows(db, `SELECT id FROM schema_migrations WHERE id='${migrationId}'`);
  if (applied.length) return 'already applied';
  const columns = await rows(db, 'PRAGMA table_info(items)');
  if (!columns.some((c) => c.name === 'note')) await db.exec("ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  await db.exec('CREATE TABLE IF NOT EXISTS item_events (id TEXT PRIMARY KEY, item_id TEXT NOT NULL)');
  await db.exec('CREATE INDEX IF NOT EXISTS items_by_note ON items(note)');
  await db.exec(`INSERT OR IGNORE INTO schema_migrations VALUES ('${migrationId}', 1)`);
  return 'applied';
}

const s = await localServer();
let a, b;
try {
  a = await s.replica('a'); b = await s.replica('b');
  await a.exec('CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  await a.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  await a.exec("INSERT INTO items VALUES ('first', 'before')");
  await a.push(); await b.pull();

  const aMigration = await applyMigration(a);
  await a.exec("UPDATE items SET note='from A' WHERE id='first'");
  await a.push();
  const bPull = await b.pull();
  const bMigration = await applyMigration(b);
  await b.exec("INSERT INTO items(id,title,note) VALUES ('second','after','from B')");
  await b.exec("INSERT INTO item_events VALUES ('event1','second')");
  await b.push(); await a.pull();
  const retry = await applyMigration(a);

  const inspect = async (db) => ({
    columns: (await rows(db, 'PRAGMA table_info(items)')).map((r) => r.name),
    index: await rows(db, "SELECT name FROM sqlite_master WHERE type='index' AND name='items_by_note'"),
    tables: await rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='item_events'"),
    migrations: await rows(db, 'SELECT id FROM schema_migrations'),
    items: await rows(db, 'SELECT * FROM items ORDER BY id'),
    events: await rows(db, 'SELECT * FROM item_events'),
  });
  const left = await inspect(a), right = await inspect(b);
  const passed = JSON.stringify(left) === JSON.stringify(right) && left.columns.includes('note') && left.items.length === 2 && left.migrations.length === 1;
  console.log(JSON.stringify({ passed, aMigration, bPull, bMigration, retry, a: left, b: right }));
  if (!passed) process.exitCode = 1;
} finally {
  await Promise.allSettled([a?.close(), b?.close()]);
  await s.cleanup();
}
