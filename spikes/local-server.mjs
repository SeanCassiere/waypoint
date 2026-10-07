import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '@tursodatabase/sync';

const binary = resolve('spikes/.tools/turso_cli-x86_64-unknown-linux-gnu/tursodb');

async function freePort() {
  const socket = createServer();
  await new Promise((ok) => socket.listen(0, '127.0.0.1', ok));
  const port = socket.address().port;
  await new Promise((ok) => socket.close(ok));
  return port;
}

export async function localServer() {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-sync-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverPath = join(dir, 'server.db');
  let proc;
  async function start() {
    proc = spawn(binary, [serverPath, '--sync-server', `127.0.0.1:${port}`], { stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) throw new Error(`local sync server exited ${proc.exitCode}`);
      try {
        await fetch(url, { signal: AbortSignal.timeout(200) });
        return;
      } catch { await delay(50); }
    }
    throw new Error('local sync server did not start');
  }
  async function stop() {
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await Promise.race([new Promise((ok) => proc.once('exit', ok)), delay(2000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  await start();
  return {
    dir, url, start, stop,
    replica: (name, opts = {}) => connect({ path: join(dir, `${name}.db`), url, ...opts }),
    cleanup: async () => { await stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

export async function rows(db, sql) { return db.prepare(sql).then((stmt) => stmt.all()); }
export async function attempt(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: String(error.message ?? error).slice(0, 300) }; }
}
