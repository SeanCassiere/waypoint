import { localServer, rows, attempt } from '../local-server.mjs';

async function scenario(name, fn) {
  const s = await localServer();
  let a, b, c;
  try {
    a = await s.replica('a');
    b = await s.replica('b');
    const remote = async (sql) => {
      c = await s.replica(`remote-${Math.random().toString(36).slice(2)}`);
      const value = await rows(c, sql);
      await c.close(); c = undefined;
      return value;
    };
    const result = await fn({ a, b, s, remote });
    console.log(JSON.stringify({ scenario: name, ...result }));
  } catch (e) {
    console.log(JSON.stringify({ scenario: name, fatal: String(e.stack ?? e).slice(0, 700) }));
  } finally {
    await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
    await s.cleanup();
  }
}

await scenario('1 row-vs-column', async ({ a, b, remote }) => {
  await a.exec("CREATE TABLE t(id TEXT PRIMARY KEY, x TEXT, y TEXT)");
  await a.exec("INSERT INTO t VALUES('r','x0','y0')"); await a.push(); await b.pull();
  await a.exec("UPDATE t SET x='xA' WHERE id='r'");
  await b.exec("UPDATE t SET y='yB' WHERE id='r'");
  const pushes = [await attempt(() => a.push()), await attempt(() => b.push())];
  const cloud = await remote('SELECT * FROM t');
  const pulls = [await attempt(() => a.pull()), await attempt(() => b.pull())];
  return { pushes, cloud, pulls, a: await rows(a, 'SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('2 delete-vs-update', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY, x TEXT)');
  await a.exec("INSERT INTO t VALUES('r','old')"); await a.push(); await b.pull();
  await a.exec("DELETE FROM t WHERE id='r'");
  await b.exec("UPDATE t SET x='updated' WHERE id='r'");
  const pushes = [await attempt(() => a.push()), await attempt(() => b.push())];
  const cloud = await remote('SELECT * FROM t');
  const pulls = [await attempt(() => a.pull()), await attempt(() => b.pull())];
  return { pushes, cloud, pulls, a: await rows(a, 'SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('3 UNIQUE collision', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY, public_id TEXT UNIQUE)'); await a.push(); await b.pull();
  await a.exec("INSERT INTO t VALUES('a','same')");
  await b.exec("INSERT INTO t VALUES('b','same')");
  const pushA = await attempt(() => a.push());
  const pushB = await attempt(() => b.push());
  const bAfterFailedPush = await attempt(() => rows(b, 'SELECT * FROM t ORDER BY id'));
  const pullA = await attempt(() => a.pull());
  const pullB = await attempt(() => b.pull());
  const retryB = await attempt(() => b.push());
  const cloud = await remote('SELECT * FROM t ORDER BY id');
  return { pushA, pushB, bAfterFailedPush, pullA, pullB, retryB, cloud, a: await attempt(() => rows(a, 'SELECT * FROM t ORDER BY id')), b: await attempt(() => rows(b, 'SELECT * FROM t ORDER BY id')) };
});

await scenario('4 identical INSERT', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY, x TEXT)'); await a.push(); await b.pull();
  await a.exec("INSERT INTO t VALUES('same','value')");
  await b.exec("INSERT INTO t VALUES('same','value')");
  const pushes = [await attempt(() => a.push()), await attempt(() => b.push())];
  const pulls = [await attempt(() => a.pull()), await attempt(() => b.pull())];
  return { pushes, pulls, cloud: await remote('SELECT * FROM t'), a: await rows(a, 'SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('5 INSERT OR IGNORE different', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY, x TEXT)'); await a.push(); await b.pull();
  await a.exec("INSERT OR IGNORE INTO t VALUES('same','fromA')");
  await b.exec("INSERT OR IGNORE INTO t VALUES('same','fromB')");
  const pushes = [await attempt(() => a.push()), await attempt(() => b.push())];
  const pulls = [await attempt(() => a.pull()), await attempt(() => b.pull())];
  return { pushes, pulls, cloud: await remote('SELECT * FROM t'), a: await rows(a, 'SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('6 foreign keys', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE parent(id TEXT PRIMARY KEY)');
  await a.exec('CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
  await a.push(); await b.pull();
  await b.exec('PRAGMA foreign_keys=ON');
  const fkBefore = await rows(b, 'PRAGMA foreign_keys');
  await a.exec("INSERT INTO parent VALUES('p')"); await a.push();
  await a.exec("INSERT INTO child VALUES('c','p')"); await a.push();
  const pull = await attempt(() => b.pull());
  const fkAfter = await rows(b, 'PRAGMA foreign_keys');
  const invalid = await attempt(() => b.exec("INSERT INTO child VALUES('bad','missing')"));
  return { fkBefore, pull, fkAfter, invalid, cloud: await remote('SELECT * FROM child'), parents: await rows(b, 'SELECT * FROM parent'), children: await rows(b, 'SELECT * FROM child') };
});

await scenario('6b child-before-parent pulls', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE parent(id TEXT PRIMARY KEY)');
  await a.exec('CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
  await a.push(); await b.pull();
  await b.exec('PRAGMA foreign_keys=ON');
  await a.exec("INSERT INTO child VALUES('early','late')");
  const pushChild = await attempt(() => a.push());
  const pullChild = await attempt(() => b.pull());
  const bChild = await attempt(() => rows(b, 'SELECT * FROM child'));
  const fkAfterChild = await rows(b, 'PRAGMA foreign_keys');
  await a.exec("INSERT INTO parent VALUES('late')");
  const pushParent = await attempt(() => a.push());
  const pullParent = await attempt(() => b.pull());
  return { pushChild, pullChild, bChild, fkAfterChild, pushParent, pullParent, fkCheck: await rows(b, 'PRAGMA foreign_key_check'), cloudChild: await remote('SELECT * FROM child'), bParent: await rows(b, 'SELECT * FROM parent') };
});

await scenario('7a untouched delete propagation', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY)');
  await a.exec("INSERT INTO t VALUES('one')"); await a.exec("INSERT INTO t VALUES('two')");
  await a.push(); await b.pull();
  await a.exec("DELETE FROM t WHERE id IN ('one','two')");
  const push = await attempt(() => a.push());
  const pull = await attempt(() => b.pull());
  return { push, pull, cloud: await remote('SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('7 delete and purge race', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE parent(id TEXT PRIMARY KEY)');
  await a.exec('CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
  await a.exec("INSERT INTO parent VALUES('p')"); await a.push(); await b.pull();
  await a.exec("DELETE FROM parent WHERE id='p'");
  await b.exec("INSERT INTO child VALUES('c','p')");
  const pushA = await attempt(() => a.push());
  const pullB = await attempt(() => b.pull());
  const pushB = await attempt(() => b.push());
  const pullA = await attempt(() => a.pull());
  return { pushA, pullB, pushB, pullA, cloudParent: await remote('SELECT * FROM parent'), cloudChild: await remote('SELECT * FROM child'), aParent: await rows(a, 'SELECT * FROM parent'), bParent: await rows(b, 'SELECT * FROM parent') };
});

await scenario('8 offline', async ({ a, b, s, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY)'); await a.push(); await b.pull();
  await s.stop();
  const write = await attempt(() => a.exec("INSERT INTO t VALUES('offline')"));
  const pushOffline = await attempt(() => a.push());
  const local = await rows(a, 'SELECT * FROM t');
  await s.start();
  const pushLater = await attempt(() => a.push());
  const pullB = await attempt(() => b.pull());
  return { write, pushOffline, local, pushLater, pullB, cloud: await remote('SELECT * FROM t'), b: await rows(b, 'SELECT * FROM t') };
});

await scenario('9 bootstrap', async ({ a, s }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY)'); await a.exec("INSERT INTO t VALUES('existing')"); await a.push();
  const fresh = await s.replica('fresh-default');
  const defaultRows = await rows(fresh, 'SELECT * FROM t'); await fresh.close();
  const noBootstrap = await s.replica('fresh-no-bootstrap', { bootstrapIfEmpty: false });
  const before = await attempt(() => rows(noBootstrap, 'SELECT * FROM t'));
  const pull = await attempt(() => noBootstrap.pull());
  const after = await rows(noBootstrap, 'SELECT * FROM t'); await noBootstrap.close();
  return { defaultRows, before, pull, after };
});

await scenario('10 checkpoint', async ({ a, b, remote }) => {
  await a.exec('CREATE TABLE t(id TEXT PRIMARY KEY)'); await a.exec("INSERT INTO t VALUES('before')"); await a.push();
  const before = await a.stats();
  const checkpoint = await attempt(() => a.checkpoint());
  const after = await a.stats();
  await a.exec("INSERT INTO t VALUES('after')");
  const push = await attempt(() => a.push());
  const pull = await attempt(() => b.pull());
  return { checkpoint, before: { mainWalSize: before.mainWalSize, cdcOperations: before.cdcOperations }, after: { mainWalSize: after.mainWalSize, cdcOperations: after.cdcOperations }, push, pull, cloud: await remote('SELECT * FROM t ORDER BY id') };
});
