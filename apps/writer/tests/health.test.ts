// FC2 (OW-06a/OW-10a): one sync-health rule, the Retry stamp, and the scoped pill's inputs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import {
  getHealth,
  scopeFor,
  STALLED_AFTER_MS,
  syncStateOf,
  type Health,
  type HealthItem,
  type HealthState,
  type RevisionHealth,
} from "../src/health.ts";
import { createApp, type HttpServices } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

describe("syncStateOf", () => {
  const base = {
    state: "pending" as const,
    parent_state: null,
    first_attempt_at: null,
    created_at: NOW - MINUTE,
    last_error: null,
  };
  const cases: [string, Parameters<typeof syncStateOf>[0], RevisionHealth][] = [
    ["failed", { ...base, state: "failed" }, "failed"],
    [
      "a child of a pending parent, even old and erroring",
      {
        ...base,
        parent_state: "pending",
        created_at: NOW - 120 * MINUTE,
        first_attempt_at: NOW - 120 * MINUTE,
        last_error: "timeout",
      },
      "waiting",
    ],
    [
      "never attempted, 9 min 59 s old",
      { ...base, created_at: NOW - STALLED_AFTER_MS + 1000 },
      "uploading",
    ],
    [
      "never attempted, exactly 10 min old",
      { ...base, created_at: NOW - STALLED_AFTER_MS },
      "stalled",
    ],
    [
      "a long upload that's progressing",
      { ...base, created_at: NOW - 40 * MINUTE, first_attempt_at: NOW - 30 * MINUTE },
      "uploading",
    ],
    [
      "an upload with an error for 30 min",
      {
        ...base,
        created_at: NOW - 40 * MINUTE,
        first_attempt_at: NOW - 30 * MINUTE,
        last_error: "timeout",
      },
      "stalled",
    ],
    [
      "just retried",
      { ...base, created_at: NOW - 120 * MINUTE, first_attempt_at: NOW },
      "uploading",
    ],
    ["a pending child of a failed parent", { ...base, parent_state: "failed" }, "uploading"],
  ];
  it.each(cases)("%s", (_name, item, expected) => {
    expect(syncStateOf(item, NOW)).toBe(expected);
  });
});

/** A hand-built Health whose lists agree with its items. */
const healthOf = (state: HealthState, items: HealthItem[]): Health => {
  const pending = items.filter((row) => row.state === "pending");
  return {
    state,
    label: "",
    short: "",
    aria: "",
    failed: items.filter((row) => row.state === "failed"),
    pending,
    stalled: pending.filter((row) => row.sync === "stalled"),
    waiting: pending.filter((row) => row.sync === "waiting"),
    collections: [],
    oldestPendingAt: null,
    lastPushAt: null,
    lastPullAt: null,
    cloudLastOkAt: null,
    cloudError: null,
    blockedReason: null,
    environment: "dev",
    syncEnabled: state !== "off",
  };
};

describe("scopeFor", () => {
  const HERE = "herePub";
  let serial = 0;
  const item = (sync: RevisionHealth, collectionPub: string | null): HealthItem => ({
    id: `rev_${++serial}`,
    public_id: `pub${serial}`,
    collection_id: `col_${collectionPub ?? "none"}`,
    collection_public_id: collectionPub,
    collection_title: null,
    display_number: 1,
    message: null,
    created_at: NOW,
    last_error: null,
    error_kind: null,
    source_host: null,
    state: sync === "failed" ? "failed" : "pending",
    first_attempt_at: null,
    attempts: 0,
    next_attempt_at: null,
    parent_revision_id: null,
    parent_state: null,
    sync,
  });
  it("is null for writer-wide conditions", () => {
    const items = [item("failed", HERE), item("stalled", "other")];
    for (const state of ["blocked", "offline", "off"] as const)
      expect(scopeFor(healthOf(state, items), HERE)).toBeNull();
  });
  it("is null when nothing is failed or stalled", () => {
    expect(scopeFor(healthOf("synced", []), HERE)).toBeNull();
    expect(
      scopeFor(healthOf("uploading", [item("uploading", HERE), item("waiting", "other")]), HERE),
    ).toBeNull();
  });
  it("tells here, elsewhere and mixed apart", () => {
    expect(scopeFor(healthOf("failed", [item("failed", HERE)]), HERE)).toBe("here");
    expect(scopeFor(healthOf("stalled", [item("stalled", HERE)]), HERE)).toBe("here");
    expect(scopeFor(healthOf("failed", [item("failed", "other")]), HERE)).toBe("elsewhere");
    expect(scopeFor(healthOf("stalled", [item("stalled", "other")]), HERE)).toBe("elsewhere");
    expect(
      scopeFor(healthOf("failed", [item("stalled", HERE), item("failed", "other")]), HERE),
    ).toBe("mixed");
  });
  it("counts an item without a collection public ID as elsewhere", () => {
    expect(scopeFor(healthOf("failed", [item("failed", null)]), HERE)).toBe("elsewhere");
  });
  it("ignores this collection's normal uploads", () => {
    expect(
      scopeFor(healthOf("failed", [item("uploading", HERE), item("failed", "other")]), HERE),
    ).toBe("elsewhere");
  });
  it("is null without a collection", () => {
    const failing = healthOf("failed", [item("failed", HERE)]);
    expect(scopeFor(failing, null)).toBeNull();
    expect(scopeFor(failing, undefined)).toBeNull();
  });
});

describe("getHealth", () => {
  let dir: string;
  let waypoint: Db;
  let queue: Db;
  let local: HttpServices;
  let live: HttpServices;
  let app: ReturnType<typeof createApp>;
  let worker: WriterCommitter | undefined;
  let serial = 0;
  /** A sync client that's on, so `syncEnabled` is true; nothing is ever pulled or pushed. */
  const cloud: SyncClient = {
    lastPullAt: 0,
    verified: true,
    pull: () => Promise.resolve(false),
    push: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
  /** Writes one revision with its own content (an unchanged manifest wouldn't make one). */
  async function write(path: string, body: object): Promise<{ collection: string; id: string }> {
    const bytes = new TextEncoder().encode(`Content ${++serial}`);
    const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
    expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
      200,
    );
    const response = await app.request(
      path,
      json({ files: [{ path: "index.md", hash }], ...body }),
    );
    expect(response.status).toBe(200);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("collection_id" in value) ||
      !("revision_id" in value) ||
      typeof value.collection_id !== "string" ||
      typeof value.revision_id !== "string"
    )
      throw new Error("Invalid write result");
    return { collection: value.collection_id, id: value.revision_id };
  }
  const createCollection = (title: string) => write("/api/collections", { title });
  const addRevision = (collection: string, parent: string) =>
    write(`/api/collections/${collection}/revisions`, { parent_revision_id: parent });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "waypoint-health-test-"));
    const config: Config = {
      environment: "dev",
      dataDir: dir,
      baseUrl: "http://localhost:7410",
      port: 7410,
      queueGiveUpHours: 72,
      maxBlobBytes: 1024 * 1024,
      sync: false,
    };
    const opened = await openDatabases(config);
    waypoint = opened.waypoint;
    queue = opened.queue;
    await migrate(waypoint, waypointMigrations);
    await migrate(queue, queueMigrations);
    const blobs = new BlobStore(dir, config.maxBlobBytes);
    const reads = new ReadModel(waypoint, queue, config.baseUrl);
    local = {
      waypoint,
      queue,
      blobs,
      reads,
      ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
    };
    live = { ...local, ingest: new IngestService(waypoint, queue, blobs, reads, cloud) };
    app = createApp(live);
  });
  afterEach(async () => {
    worker?.stop();
    await worker?.drain();
    worker = undefined;
    await waypoint.close();
    await queue.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("never calls anything stalled with sync off", async () => {
    const { id } = await createCollection("Sync off");
    await queue.run("UPDATE pending_revisions SET created_at=? WHERE id=?", [
      Date.now() - 11 * MINUTE,
      id,
    ]);
    const health = await getHealth(local);
    expect(health.state).toBe("off");
    expect(health.stalled).toEqual([]);
    expect(health.pending.find((row) => row.id === id)?.sync).toBe("uploading");
  });

  it("waits on a queued parent, stalls an old one, and groups lineage rows", async () => {
    const parent = await createCollection("Alpha");
    const child = await addRevision(parent.collection, parent.id);
    const now = Date.now();
    let health = await getHealth(live, now);
    expect(health.state).toBe("uploading");
    const queuedChild = health.pending.find((row) => row.id === child.id);
    expect(queuedChild).toMatchObject({ parent_state: "pending", sync: "waiting", attempts: 0 });
    expect(health.waiting.map((row) => row.id)).toEqual([child.id]);

    await queue.run("UPDATE pending_revisions SET created_at=? WHERE id=?", [
      now - 11 * MINUTE,
      parent.id,
    ]);
    health = await getHealth(live, now);
    expect(health.state).toBe("stalled");
    expect(health.label).toBe("1 stalled");
    expect(health.short).toBe("1 stalled");
    expect(health.aria).toBe("Writer status: 1 revision stalled");
    expect(health.stalled.map((row) => row.id)).toEqual([parent.id]);
    // The waiting child stays waiting, whatever its parent's state.
    expect(health.waiting.map((row) => row.id)).toEqual([child.id]);
    expect(health.collections).toHaveLength(1);
    const [entry] = health.collections;
    expect(entry?.worst).toBe("stalled");
    expect(entry?.collection_title).toBe("Alpha");
    expect(entry?.items.map((row) => row.id)).toEqual([child.id, parent.id]);
    const pub = (id: string) => health.pending.find((queued) => queued.id === id)?.public_id;
    expect(entry?.rows).toEqual([
      {
        id: parent.id,
        public_id: pub(parent.id),
        parent_revision_id: null,
        display_number: 1,
        sync_state: "pending",
      },
      {
        id: child.id,
        public_id: pub(child.id),
        parent_revision_id: parent.id,
        display_number: 2,
        sync_state: "pending",
      },
    ]);

    // A collection with a failed revision sorts first; failed beats stalled.
    const other = await createCollection("Bravo");
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [other.id]);
    health = await getHealth(live, now);
    expect(health.state).toBe("failed");
    expect(health.label).toBe("1 failed");
    expect(health.collections.map((row) => [row.collection_title, row.worst])).toEqual([
      ["Bravo", "failed"],
      ["Alpha", "stalled"],
    ]);

    // A pending child of a failed parent isn't waiting.
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [parent.id]);
    health = await getHealth(live, now);
    expect(health.pending.find((row) => row.id === child.id)).toMatchObject({
      parent_state: "failed",
      sync: "uploading",
    });
    expect(health.waiting).toEqual([]);
  });

  it("keeps rows in display-number order when a committed revision is newer than a failed one", async () => {
    const sync = new SyncLoop(queue, cloud, Date.now, waypoint);
    worker = new WriterCommitter(
      waypoint,
      queue,
      live.blobs,
      new MemoryBucket(),
      sync,
      live.ingest,
    );
    const commit = async () => {
      worker?.wake();
      await worker?.drain();
    };
    const root = await createCollection("Lineage");
    await commit();
    // #2 fails while queued; #3 (a sibling off #1) commits after it.
    const failed = await addRevision(root.collection, root.id);
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [failed.id]);
    const newer = await addRevision(root.collection, root.id);
    await commit();
    expect(
      await waypoint.get<{ id: string }>("SELECT id FROM revisions WHERE id=?", [newer.id]),
    ).toBeTruthy();
    const health = await getHealth(live);
    const rows = health.collections[0]?.rows ?? [];
    expect(rows.map((row) => [row.id, row.display_number, row.sync_state])).toEqual([
      [root.id, 1, expect.stringMatching(/^(committed|synced)$/)],
      [failed.id, 2, "failed"],
      [newer.id, 3, expect.stringMatching(/^(committed|synced)$/)],
    ]);
  });

  it("stamps first_attempt_at at Retry for the root and its failed descendants", async () => {
    const root = await createCollection("Retry");
    const child = await addRevision(root.collection, root.id);
    await queue.run(
      "UPDATE pending_revisions SET state='failed',first_attempt_at=?,attempts=4,last_error='boom'",
      [Date.now() - 120 * MINUTE],
    );
    const response = await app.request(`/api/queue/${root.id}/retry`, { method: "POST" });
    expect(response.status).toBe(200);
    const rows = await queue.all<{ id: string; state: string; first_attempt_at: number | null }>(
      "SELECT id,state,first_attempt_at FROM pending_revisions",
    );
    expect(rows.map((row) => row.id).toSorted()).toEqual([root.id, child.id].toSorted());
    for (const row of rows) {
      expect(row.state).toBe("pending");
      expect(Math.abs((row.first_attempt_at ?? 0) - Date.now())).toBeLessThan(1000);
    }
    const health = await getHealth(live);
    expect(health.pending.find((row) => row.id === root.id)?.sync).toBe("uploading");
  });
});
