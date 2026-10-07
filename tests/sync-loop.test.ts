import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, retrySyncBusy, type Db, type SyncClient } from "../apps/writer/src/db.js";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.js";
import { SyncLoop } from "../apps/writer/src/sync-loop.js";

let dir: string;
let queue: Db;
let waypoint: Db;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-sync-loop-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes: 1024,
    sync: false,
  };
  const db = await openDatabases(config);
  queue = db.queue;
  waypoint = db.waypoint;
  await migrate(queue, queueMigrations);
  await migrate(waypoint, waypointMigrations);
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});
describe("sync busy retry", () => {
  it("retries database-busy pulls with a short local backoff", async () => {
    let calls = 0;
    const result = await retrySyncBusy(() => {
      calls++;
      return calls < 3 ? Promise.reject(new Error("database is busy")) : Promise.resolve(true);
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });
});
describe("sync loop", () => {
  it("assigns monotonically increasing sequence numbers after deletion", async () => {
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('first',1)");
    const first = await queue.get<{ seq: number }>(
      "SELECT seq FROM unpushed WHERE revision_id='first'",
    );
    await queue.run("DELETE FROM unpushed WHERE revision_id='first'");
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('second',2)");
    const second = await queue.get<{ seq: number }>(
      "SELECT seq FROM unpushed WHERE revision_id='second'",
    );
    expect(second!.seq).toBeGreaterThan(first!.seq);
  });
  it("keeps a row inserted after push start even if SQLite reuses a rowid", async () => {
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: async () => {
        await queue.run("DELETE FROM unpushed WHERE revision_id='old'");
        await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('new',2)");
      },
      checkpoint: () => Promise.resolve(),
    };
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('old',1)");
    await new SyncLoop(queue, client).push();
    expect(await queue.all("SELECT revision_id FROM unpushed")).toEqual([{ revision_id: "new" }]);
  });
  it("retains rows committed after push start and checkpoints before clearing older rows", async () => {
    let clock = 100;
    const calls: string[] = [];
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: async () => {
        calls.push("push");
        await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('later',150)");
        clock = 200;
      },
      checkpoint: () => {
        calls.push("checkpoint");
        return Promise.resolve();
      },
    };
    const loop = new SyncLoop(queue, client, () => clock);
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('older',99)");
    await loop.push();
    expect(calls).toEqual(["push", "checkpoint"]);
    expect(await queue.all("SELECT revision_id FROM unpushed")).toEqual([{ revision_id: "later" }]);
    expect(loop.lastPushAt).toBe(200);
  });
  it("pulls and retries once on a constraint failure, then blocks if it repeats", async () => {
    const calls: string[] = [];
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => {
        calls.push("pull");
        return Promise.resolve(true);
      },
      push: () => {
        calls.push("push");
        return Promise.reject(
          new Error("UNIQUE constraint failed: collections.public_id; BATCH_STEP_ERROR"),
        );
      },
      checkpoint: () => {
        calls.push("checkpoint");
        return Promise.resolve();
      },
    };
    const loop = new SyncLoop(queue, client);
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('rev',1)");
    await expect(loop.push()).rejects.toThrow("UNIQUE");
    expect(calls).toEqual(["push", "pull", "push"]);
    expect(loop.blocked).toBe(true);
    expect(loop.lastError).toContain("UNIQUE");
    expect(await queue.all("SELECT revision_id FROM unpushed")).toEqual([{ revision_id: "rev" }]);
  });
  it("starts another push for a request received during an in-flight push", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let pushes = 0;
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: async () => {
        pushes++;
        if (pushes === 1) {
          firstStarted?.();
          await firstGate;
        }
      },
      checkpoint: () => Promise.resolve(),
    };
    const loop = new SyncLoop(queue, client);
    const first = loop.push();
    await started;
    let secondDone = false;
    const second = loop.push().then(() => {
      secondDone = true;
    });
    expect(secondDone).toBe(false);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(pushes).toBe(2);
    expect(secondDone).toBe(true);
  });
  it.each(["push", "pull", "checkpoint"] as const)(
    "drains promptly when a native %s never resolves",
    async (operation) => {
      let entered: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const never = () => {
        entered?.();
        return new Promise<void>(() => undefined);
      };
      const client: SyncClient = {
        lastPullAt: null,
        pull: operation === "pull" ? () => never().then(() => false) : () => Promise.resolve(false),
        push: operation === "push" ? never : () => Promise.resolve(),
        checkpoint: operation === "checkpoint" ? never : () => Promise.resolve(),
      };
      const loop = new SyncLoop(queue, client);
      const work = operation === "pull" ? loop.pull() : loop.push();
      void work.catch(() => undefined);
      await started;
      loop.stop();
      await expect(
        Promise.race([
          loop.drain(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Shutdown stalled")), 500),
          ),
        ]),
      ).resolves.toBeUndefined();
      await expect(work).rejects.toThrow("Sync loop stopped");
    },
  );
  it("does not start a second native push while a timed-out one is still running", async () => {
    let finish: (() => void) | undefined;
    const firstNative = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: () => {
        calls++;
        return calls === 1 ? firstNative : Promise.resolve();
      },
      checkpoint: () => Promise.resolve(),
    };
    const loop = new SyncLoop(queue, client, Date.now, undefined, { pushMs: 30 });
    await expect(loop.push()).rejects.toThrow("Push timed out");
    const second = loop.push();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    finish?.();
    await second;
    expect(calls).toBe(2);
  });
  it("keeps committed rows during a network outage", async () => {
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(false),
      push: () => Promise.reject(new Error("fetch failed")),
      checkpoint: () => Promise.resolve(),
    };
    const loop = new SyncLoop(queue, client);
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('rev',1)");
    await expect(loop.push()).rejects.toThrow("fetch failed");
    expect(loop.blocked).toBe(false);
    expect(loop.lastError).toBe("fetch failed");
    expect(await queue.all("SELECT revision_id FROM unpushed")).toEqual([{ revision_id: "rev" }]);
  });
  it("keeps a revision blocked if a conflict pull displaced its local row", async () => {
    const client: SyncClient = {
      lastPullAt: null,
      pull: () => Promise.resolve(true),
      push: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    };
    const loop = new SyncLoop(queue, client, () => 100, waypoint);
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES ('rev_missing',1)");
    await expect(loop.push()).rejects.toThrow("disappeared");
    expect(loop.blocked).toBe(true);
    expect(
      await queue.get("SELECT revision_id FROM unpushed WHERE revision_id='rev_missing'"),
    ).toBeTruthy();
  });
});
