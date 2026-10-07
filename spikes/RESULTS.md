# Phase 0 results: S1, S2, S4

Run on 2026-10-07, Linux x64, Node 24.21.0, pnpm 11.28.2. `@tursodatabase/sync` and `@tursodatabase/database` were 0.8.2, `@tursodatabase/serverless` was 1.4.1, and local `tursodb` was 0.8.2. S1 and S4 used a local sync server only. S2 used the dev cloud DB only. Full safe output is in `s1-sync/output.txt`, `s2-platform/output.txt`, and `s4-migration-harness/output.txt`.

The Node sync API used here is `connect({path, url, authToken?, bootstrapIfEmpty?})`, `db.exec(sql)`, `await db.prepare(sql)` then `.all()`, `db.push()`, `db.pull()` (boolean return), `db.checkpoint()`, `db.stats()`, and `db.close()`. The local server URL was `http://127.0.0.1:<port>` without a token. Cloud sync used `turso://...` plus `authToken`.

## S1 — multi-writer sync

Each numbered case used separate replica files and connections (`a.db`, `b.db`) against the same local sync server. A third fresh replica read the final remote state. Operations were sequentially orchestrated but A and B made their local conflicting edits before either pushed.

1. **Different column updates merge; conflict resolution is not whole-row replacement in this case.** A set `x='xA'`, B set `y='yB'`, then A and B pushed. Cloud, A, and B all ended with `{x:'xA', y:'yB'}`. Both pushes and pulls succeeded. This supports column-level merging for disjoint `UPDATE`s; it does not prove the rule for every SQL shape. **Confidence: high for this case.**

2. **Delete won over a concurrent update in the tested order.** A deleted the row and pushed; B's earlier local `UPDATE x='updated'` then pushed. Both pushes succeeded, and cloud/A/B had no row after pull. A physical delete therefore survived a later conflicting update in this case. The opposite push order and later new insert were not tested. **Confidence: high for this order.**

3. **A `UNIQUE` collision errors at push, then pull recovers the replica.** A inserted `(id='a', public_id='same')` and pushed. B had locally inserted `(id='b', public_id='same')`; B's `push()` failed with `UNIQUE constraint failed: t.public_id` / `BATCH_STEP_ERROR`. B still showed its local row immediately after the error. `pull()` succeeded, replacing it with A's row; a later B `push()` succeeded. No permanent stuck state appeared in this run. **Confidence: high for this conflict.**

4. **Identical concurrent INSERTs converged.** Both writers inserted exactly `(id='same', x='value')`; both pushes and pulls succeeded. Cloud/A/B each had one identical row. **Confidence: high.**

5. **`INSERT OR IGNORE` is not a cross-writer first-wins guard.** A inserted `(same, fromA)`, B inserted `(same, fromB)` before syncing. Both pushes succeeded; after A then B pushed, cloud/A/B all held `fromB`. Local `OR IGNORE` did not stop the later remote value from winning. **Confidence: high for this order.**

6. **Pull bypassed FK enforcement even while the connection reported it enabled.** On B, `PRAGMA foreign_keys=ON` returned `1`, and a local invalid child insert failed. When A pushed a parent and child in separate pushes, B pulled both successfully. In the stronger reversed test, A pushed a child referencing an absent parent, B pulled it successfully while `foreign_keys` still returned `1`, then A pushed the parent and B pulled it; `PRAGMA foreign_key_check` was empty at the end. The sync apply path can temporarily create FK violations despite the user's pragma. **Confidence: high for these cases; no guarantee about all batch ordering.**

7. **Deletes propagate, and a purge race can leave an orphan.** A deleted two rows, pushed, and untouched B pulled an empty table. In a separate race, A deleted parent `p` while B had an unpushed child `c → p`. A pushed the deletion; B pulled it, then pushed the child. Cloud ended with no parent and one child. This confirms the SQL race; the experiment did not test R2 blob garbage collection. **Confidence: high for SQL state, none for R2 GC.**

8. **Offline local writes survive a failed push.** With the local server stopped, A inserted `offline` successfully. `push()` rejected with a fetch error. After restarting the same server, `push()` succeeded and B pulled the row. **Confidence: high.**

9. **A new replica bootstrapped all existing data.** Fresh default `connect()` saw `{id:'existing'}` immediately. Unexpectedly, `connect({bootstrapIfEmpty:false})` also saw that row before an explicit pull; its subsequent `pull()` returned `false`. The installed 0.8.2 JS implementation constructs the native engine with `bootstrapIfEmpty` computed from whether `url` is non-null and does not pass the supplied option. Treat the documented flag as ineffective in this version. **Confidence: high for this package/version.**

10. **`checkpoint()` worked after push.** `mainWalSize` went from 53,584 bytes to 0. A later insert, push, and B pull still worked; cloud contained both rows. Use it after successful pushes as designed. **Confidence: high for this run.**

Key trimmed output:

```text
1 cloud/a/b: {id:r, x:xA, y:yB}
2 cloud/a/b: []
3 pushB: UNIQUE constraint failed: t.public_id; pullB: true; retryB: success
5 cloud/a/b: {id:same, x:fromB}
6b B pulled child before parent; foreign_keys: 1; final foreign_key_check: []
7 cloudParent: []; cloudChild: [{id:c, parent_id:p}]
8 offline push: fetch failed; later push: success; B: [{id:offline}]
9 bootstrapIfEmpty:false, before pull: [{id:existing}]
10 checkpoint: success; mainWalSize: 53584 -> 0
```

## S2 — platform and clients

1. **Node 24 Linux x64 works.** pnpm 11 installed the native `@tursodatabase/sync` 0.8.2 Linux x64 package without install or prebuilt-binary errors. The script bootstrapped, queried, pushed, and pulled. macOS arm64 was not tested here. **Confidence: high for this machine.**

2. **Dev cloud sync worked.** The final run created `spike_s2_0d0b7e467f` (CREATE only), inserted `('probe','ok')`, pushed, and pulled. Bootstrap took about 482 ms, push 122 ms, and pull 212 ms in that run. Earlier attempts created `spike_s2_99af957ccd` and `spike_s2_4b199590eb`; no tables were dropped or renamed. These are rough single-run latencies, not benchmarks. **Confidence: high for connectivity, low for latency prediction.**

3. **The fetch-based serverless client queried the Sync cloud DB.** `@tursodatabase/serverless` 1.4.1 with the full-access dev token returned the row using either the original `turso://` URL or an explicit `https://` conversion. Its implementation normalizes `turso://` to HTTPS. The run did not check a read-only token or Cloudflare Workers runtime. The API used was `connect({url, authToken}).all(sql)`; `prepare()` is async. **Confidence: high for Node/full-access token, unverified for Workers/read-only token.**

4. **A local-only database coexisted with the sync DB.** `@tursodatabase/database` 0.8.2 opened `queue.db` in the same process, created and read a `q` row while the sync replica remained queryable. Node's built-in `node:sqlite` also created and read a local table. The Turso local package uses the same engine and async API as the synced DB and is the better `queue.db` choice for this design; `node:sqlite` is a viable simpler alternative if the queue's SQLite compatibility is tested separately. **Confidence: high for basic coexistence, moderate for library recommendation.**

Trimmed output:

```text
platform: linux/x64, node: v24.21.0
bootstrapMs: 482, pushMs: 122, pullMs: 212
localRows: [{id:probe, value:ok}]
tursoUrl: success, httpsUrl: success, localOnlyRows: [{id:queued}]
```

## S4 — migration rehearsal

`s4-migration-harness/run.mjs` starts two replicas on a local sync server. A creates baseline schema/data and pushes; B pulls. A applies `0002_add_note` using a guarded `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS`, then records it in `schema_migrations`, writes data, and pushes. B pulls, sees the migration already recorded, writes using the new schema, and pushes; A pulls and reruns the migration as an idempotence check. Both replicas had identical columns, index, table, one migration row, two data rows, and an event row. The script exited successfully with `passed:true`. This demonstrates **serialized** additive migration rollout; it does not validate simultaneous DDL by two writers. **Confidence: high for the rehearsed pattern.**

```text
passed: true; aMigration: applied; bPull: true
bMigration: already applied; retry: already applied
columns: [id,title,note]; migrations: [0002_add_note]; items: 2 on both
```

## Design implications

- **Tombstones vs `deleted_at`:** Disjoint column edits merged, so the write-path document's blanket row-level last-push-wins statement is inaccurate for this tested package. A physical delete beat a concurrent update in one ordering. The separate `collection_tombstones` table still cleanly isolates deletion state from mutable `collections.title`/`metadata`, but its undelete race semantics require a dedicated test before multi-writer reliance. Do not infer that `deleted_at` on `collections` is safe from the observed column merge alone.
- **`UNIQUE(public_id)`:** Keep the constraints as collision guards, but treat a push constraint failure as a real durability failure. A later pull may resolve the local state by replacing a conflicting row. Derived public IDs make identical retries safe; different IDs with a hash collision cannot both sync. The committer must inspect/report the failure and avoid marking the losing revision synced merely because a later retry succeeds.
- **FK pragma:** Keep `PRAGMA foreign_keys=OFF` on `waypoint.db` and enforce relationships in the committer, as the data model proposes. `ON` affects local SQL but the sync apply path accepted an orphan, so it does not guarantee replicated integrity. Check pulled state where integrity matters.
- **Purge race:** An unpushed child can land in the cloud after its parent has been purged. The Phase 1 single-writer purge restriction is justified. Multi-writer purge needs a durable purge marker, coordination/grace period, and blob-GC protection for other writers' queued references. This spike did not exercise R2 deletion.
- **Offline behavior:** Local committed rows remain writable during outage; retry `push()` after connectivity returns. A failed push must leave `unpushed` records intact. Bootstrap of a new file still requires remote availability in 0.8.2 because `bootstrapIfEmpty:false` was ignored.
- **`queue.db`:** Use `@tursodatabase/database` 0.8.2 for local-only storage alongside `@tursodatabase/sync`, with separate files and connections. It worked under the same Node process.
- **Serverless reader:** The serverless client can query the dev Sync DB with the full-access token and accepts `turso://` directly. Read-only token permissions and Cloudflare Workers compatibility remain unverified.
- **Writer API names:** Use `connect({path,url,authToken})`, then `push()`, `pull()`, and `checkpoint()` after successful push; `pull()` returns a boolean. `prepare()` must be awaited in the sync client. Avoid relying on `bootstrapIfEmpty:false` in 0.8.2 without a fixed release and a new test.
