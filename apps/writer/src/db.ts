import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { connect as connectLocal } from "@tursodatabase/database";
import { connect as connectSync } from "@tursodatabase/sync";

import type { Config } from "./config.js";

export type Params = readonly (string | number | null)[];
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}
interface Statement {
  all<T>(...args: Params): Promise<T[]>;
  get<T>(...args: Params): Promise<T | undefined>;
  run(...args: Params): Promise<RunResult>;
}
interface EngineStatement extends Statement {
  close(): void;
}
interface Engine {
  prepare(sql: string): Promise<EngineStatement>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export interface DbHandle {
  all<T>(sql: string, args?: Params): Promise<T[]>;
  get<T>(sql: string, args?: Params): Promise<T | undefined>;
  run(sql: string, args?: Params): Promise<RunResult>;
  exec(sql: string): Promise<void>;
}
export function inSeries<T>(items: Iterable<T>, fn: (item: T) => Promise<unknown>): Promise<void> {
  return Array.from(items).reduce<Promise<void>>(
    (previous, item) =>
      previous.then(async () => {
        await fn(item);
      }),
    Promise.resolve(),
  );
}
export async function retrySyncBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message)
        ) ||
        attempt >= 5
      )
        throw error;
      await delay(10 * (attempt + 1));
    }
  }
}
/** Prepared statements kept per connection. Each distinct SQL string costs one slot. */
export const STATEMENT_CACHE_SIZE = 256;
/** Schema changes make prepared statements stale (Turso aborts the process on a stale one). */
const SCHEMA_CHANGE = /\b(?:CREATE|ALTER|DROP)\s/i;
export class Db implements DbHandle {
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Prepared statements by SQL, least recently used first. The engine leaks native memory for
   * every statement it prepares (about 12.5 KB when never closed, about 2.5 KB even when closed;
   * see docs/architecture.md), so statements are prepared once and reused. Schema changes drop
   * them all: running a statement prepared against an older schema aborts the process.
   */
  private statements = new Map<string, EngineStatement>();
  private busy = new Set<EngineStatement>();
  /** Called after each statement with its execution time (tests and diagnostics). */
  onStatement: ((sql: string, ms: number) => void) | undefined = undefined;
  constructor(readonly engine: Engine) {}
  connectionOperation<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn);
    this.chain = task.catch(() => undefined);
    return task;
  }
  /** Number of cached prepared statements (for tests and diagnostics). */
  get cachedStatements(): number {
    return this.statements.size;
  }
  private async execute<T>(sql: string, use: (statement: Statement) => Promise<T>): Promise<T> {
    const schemaChange = SCHEMA_CHANGE.test(sql);
    let statement = this.statements.get(sql);
    // A transaction callback can run statements concurrently; a statement already running gets
    // a one-off sibling instead of having its bindings replaced mid-step.
    const cached = Boolean(statement) && !this.busy.has(statement!);
    if (statement && cached) {
      this.statements.delete(sql);
      this.statements.set(sql, statement);
    } else statement = await this.engine.prepare(sql);
    const keep = !schemaChange && (cached || !this.statements.has(sql));
    if (keep && !cached) {
      this.statements.set(sql, statement);
      for (const [key, oldest] of this.statements) {
        if (this.statements.size <= STATEMENT_CACHE_SIZE) break;
        this.statements.delete(key);
        // A running statement is closed by its own caller once it finishes.
        if (!this.busy.has(oldest)) oldest.close();
      }
    }
    this.busy.add(statement);
    let failed = false;
    const started = this.onStatement ? performance.now() : 0;
    try {
      return await use(statement);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.onStatement?.(sql, performance.now() - started);
      this.busy.delete(statement);
      const owned = this.statements.get(sql) === statement;
      // A failed statement is prepared afresh next time rather than trusted again.
      if (owned && failed) this.statements.delete(sql);
      if (!owned || failed) statement.close();
      if (schemaChange) this.dropStatements();
    }
  }
  private dropStatements(): void {
    for (const statement of this.statements.values())
      if (!this.busy.has(statement)) statement.close();
    this.statements.clear();
  }
  /** Forgets every prepared statement, on the connection chain (after a pull changed the database). */
  resetStatements(): Promise<void> {
    return this.connectionOperation(() => {
      this.dropStatements();
      return Promise.resolve();
    });
  }
  private raw: DbHandle = {
    all: async <T>(sql: string, args: Params = []) =>
      this.retryBusy(() => this.execute(sql, (statement) => statement.all<T>(...args))),
    get: async <T>(sql: string, args: Params = []) =>
      this.retryBusy(() => this.execute(sql, (statement) => statement.get<T>(...args))),
    run: (sql: string, args: Params = []) =>
      this.retryBusy(() => this.execute(sql, (statement) => statement.run(...args))),
    exec: async (sql: string) => {
      try {
        await this.retryBusy(() => this.engine.exec(sql));
      } finally {
        if (SCHEMA_CHANGE.test(sql)) this.dropStatements();
      }
    },
  };
  private async retryBusy<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message)
          ) ||
          attempt >= 5
        )
          throw error;
        await delay(10 * (attempt + 1));
      }
    }
  }
  prepare(sql: string): Promise<Statement> {
    return Promise.resolve({
      all: <T>(...args: Params) => this.connectionOperation(() => this.raw.all<T>(sql, args)),
      get: <T>(...args: Params) => this.connectionOperation(() => this.raw.get<T>(sql, args)),
      run: (...args: Params) => this.connectionOperation(() => this.raw.run(sql, args)),
    });
  }
  all<T>(sql: string, args: Params = []): Promise<T[]> {
    return this.connectionOperation(() => this.raw.all<T>(sql, args));
  }
  get<T>(sql: string, args: Params = []): Promise<T | undefined> {
    return this.connectionOperation(() => this.raw.get<T>(sql, args));
  }
  run(sql: string, args: Params = []): Promise<RunResult> {
    return this.connectionOperation(() => this.raw.run(sql, args));
  }
  exec(sql: string): Promise<void> {
    return this.connectionOperation(() => this.raw.exec(sql));
  }
  transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
    return this.connectionOperation(async () => {
      await this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.raw);
        await this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        await this.raw.exec("ROLLBACK");
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return this.connectionOperation(() => {
      this.dropStatements();
      return this.engine.close();
    });
  }
}
export interface SyncClient {
  pull(): Promise<boolean>;
  push(): Promise<void>;
  checkpoint(): Promise<void>;
  probe?(): Promise<boolean>;
  lastPullAt: number | null;
  verified?: boolean;
  beforePush?: () => Promise<void>;
  afterPull?: () => Promise<void>;
  blockedReason?: string;
}
export class LocalSyncClient implements SyncClient {
  lastPullAt: number | null = Date.now();
  verified = true;
  pull(): Promise<boolean> {
    this.lastPullAt = Date.now();
    return Promise.resolve(false);
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
  checkpoint(): Promise<void> {
    return Promise.resolve();
  }
}
export async function openDatabases(
  config: Config,
): Promise<{ waypoint: Db; queue: Db; syncClient: SyncClient }> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const queue = new Db(await connectLocal(join(config.dataDir, "queue.db")));
  if (!config.sync) {
    const waypoint = new Db(await connectLocal(join(config.dataDir, "waypoint.db")));
    await waypoint.exec("PRAGMA foreign_keys=OFF");
    return { waypoint, queue, syncClient: new LocalSyncClient() };
  }
  const remote = await connectSync({
    path: join(config.dataDir, "waypoint.db"),
    url: config.tursoUrl!,
    authToken: config.tursoAuthToken!,
  });
  const waypoint = new Db(remote);
  await waypoint.exec("PRAGMA foreign_keys=OFF");
  let pullFlight: Promise<boolean> | undefined;
  const syncClient: SyncClient = {
    lastPullAt: null,
    verified: false,
    async probe() {
      const url = config.tursoUrl!.replace(/^turso:\/\//, "https://");
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return true;
      } catch {
        return false;
      }
    },
    pull() {
      if (this.blockedReason) return Promise.reject(new Error(this.blockedReason));
      if (pullFlight) return pullFlight;
      pullFlight = this.probe!()
        .then(async (reachable) => {
          if (!reachable) throw new Error("Sync server unavailable");
          // Turso's native engine coordinates pull with local statements. The app mutex
          // covers SQL statements only: a network pull must not queue local reads or
          // writes behind it. The single-flight promise prevents concurrent pulls.
          return retrySyncBusy(() => remote.pull());
        })
        .then(async (changed) => {
          // A pull can carry schema changes; statements prepared before it must not run again.
          if (changed) await waypoint.resetStatements();
          await this.afterPull?.();
          this.lastPullAt = Date.now();
          return changed;
        })
        .finally(() => {
          pullFlight = undefined;
        });
      return pullFlight;
    },
    async push() {
      await this.beforePush?.();
      await remote.push();
    },
    checkpoint() {
      return remote.checkpoint();
    },
  };
  return { waypoint, queue, syncClient };
}
