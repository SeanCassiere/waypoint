import { connect as syncConnect } from '@tursodatabase/sync';
import { connect as localConnect } from '@tursodatabase/database';
import { connect as serverlessConnect } from '@tursodatabase/serverless';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken || !url.startsWith('turso://')) throw new Error('dev TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
const dir = await mkdtemp(join(tmpdir(), 'waypoint-s2-'));
const table = `spike_s2_${randomBytes(5).toString('hex')}`;
const ms = () => Math.round(performance.now());
const result = { platform: `${process.platform}/${process.arch}`, node: process.version, table };
let sync, local;
try {
  let t = ms();
  sync = await syncConnect({ path: join(dir, 'replica.db'), url, authToken });
  result.bootstrapMs = ms() - t;
  await sync.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, value TEXT)`);
  await sync.exec(`INSERT INTO ${table} VALUES ('probe', 'ok')`);
  t = ms(); await sync.push(); result.pushMs = ms() - t;
  t = ms(); result.pullChanged = await sync.pull(); result.pullMs = ms() - t;
  result.localRows = await (await sync.prepare(`SELECT * FROM ${table}`)).all();

  const httpUrl = url.replace(/^turso:\/\//, 'https://');
  for (const [name, queryUrl] of [['tursoUrl', url], ['httpsUrl', httpUrl]]) {
    try {
      const client = serverlessConnect({ url: queryUrl, authToken });
      result[name] = { ok: true, rows: await client.all(`SELECT * FROM ${table}`) };
    } catch (e) {
      result[name] = { ok: false, error: `${e.name}: ${e.message}`.replaceAll(authToken, '[redacted]').replaceAll(url, '[redacted-url]').replaceAll(httpUrl, '[redacted-url]').slice(0, 300) };
    }
  }

  local = await localConnect(join(dir, 'queue.db'));
  await local.exec('CREATE TABLE q (id TEXT PRIMARY KEY)');
  await local.exec("INSERT INTO q VALUES ('queued')");
  result.localOnlyRows = await (await local.prepare('SELECT * FROM q')).all();
  result.coexistSyncRows = await (await sync.prepare(`SELECT * FROM ${table}`)).all();

  const builtin = new DatabaseSync(join(dir, 'builtin.db'));
  builtin.exec('CREATE TABLE q (id TEXT PRIMARY KEY)');
  builtin.prepare("INSERT INTO q VALUES ('queued')").run();
  result.nodeSqliteRows = builtin.prepare('SELECT * FROM q').all();
  builtin.close();
} catch (e) {
  // Deliberately omit message/stack: they can contain request details.
  result.failure = { name: e.name, stage: Object.keys(result).at(-1) };
} finally {
  await Promise.allSettled([sync?.close(), local?.close()]);
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
