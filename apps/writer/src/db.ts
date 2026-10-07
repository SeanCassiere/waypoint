import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
interface Engine {
  prepare(sql: string): Promise<Statement>;
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
export class Db implements DbHandle {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly engine: Engine) {}
  connectionOperation<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn);
    this.chain = task.catch(() => undefined);
    return task;
  }
  private raw: DbHandle = {
    all: async <T>(sql: string, args: Params = []) =>
      (await this.engine.prepare(sql)).all<T>(...args),
    get: async <T>(sql: string, args: Params = []) =>
      (await this.engine.prepare(sql)).get<T>(...args),
    run: async (sql: string, args: Params = []) => (await this.engine.prepare(sql)).run(...args),
    exec: (sql: string) => this.engine.exec(sql),
  };
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
    return this.connectionOperation(() => this.engine.close());
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
      if (pullFlight) return pullFlight;
      pullFlight = this.probe!()
        .then(async (reachable) => {
          if (!reachable) throw new Error("Sync server unavailable");
          // Turso's native engine coordinates pull with local statements. The app mutex
          // covers SQL statements only: a network pull must not queue local reads or
          // writes behind it. The single-flight promise prevents concurrent pulls.
          return remote.pull();
        })
        .then((changed) => {
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
      await waypoint.connectionOperation(() => remote.push());
    },
    checkpoint() {
      return waypoint.connectionOperation(() => remote.checkpoint());
    },
  };
  return { waypoint, queue, syncClient };
}
