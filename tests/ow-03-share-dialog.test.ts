// OW-03: the share dialog shows what each target publishes (the "Public sees" track, a
// checklist from the target's own manifest) and its Preview link follows the chosen target.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isContentHash, mintRevisionId, publicIdFor, type Manifest } from "@waypoint/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import type { Health, HealthItem } from "../apps/writer/src/health.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel, type RevisionRow } from "../apps/writer/src/read-model.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
import type { CollectionContext } from "../apps/writer/src/viewer/pages/collection/shell.tsx";
import {
  previewHref,
  revisionWord,
  shareDisclosure,
} from "../apps/writer/src/viewer/pages/share.tsx";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let collectionId: string;
let collectionPublicId: string;
/** A fixed test key (never a real one). */
const shareTokenKey = new Uint8Array(32).fill(42);

async function put(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  if ((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status !== 200)
    throw new Error("Blob upload failed");
  return hash;
}
async function idOf(response: Response, key: string): Promise<string> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !(key in value)) throw new Error(`No ${key}`);
  const id: unknown = Object.fromEntries(Object.entries(value))[key];
  if (typeof id !== "string") throw new Error(`No ${key}`);
  return id;
}
async function addRevision(body: object): Promise<string> {
  const response = await app.request(`/api/collections/${collectionId}/revisions`, json(body));
  if (response.status !== 200) throw new Error(`Revision failed: ${await response.text()}`);
  return idOf(response, "revision_id");
}
/** A pending revision on `parent`, straight into the queue (merge-mode result `files`). */
async function queueRevision(
  parent: string,
  files: Record<string, object>,
  headPath = "index.txt",
): Promise<string> {
  const id = mintRevisionId({ now: Date.now() });
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,?,?,'pending',0)",
    [
      id,
      await publicIdFor(id),
      collectionId,
      parent,
      headPath,
      null,
      "{}",
      JSON.stringify({ headPath, files }),
      Date.now(),
    ],
  );
  return id;
}
async function publicIdOf(id: string): Promise<string> {
  const row =
    (await waypoint.get<{ public_id: string }>("SELECT public_id FROM revisions WHERE id=?", [
      id,
    ])) ??
    (await queue.get<{ public_id: string }>("SELECT public_id FROM pending_revisions WHERE id=?", [
      id,
    ]));
  if (!row) throw new Error("No revision");
  return row.public_id;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-ow03-"));
  const config: Config = {
    environment: "dev",
    dataDir: directory,
    baseUrl: "http://localhost:7410",
    publicBaseUrl: "https://reader-dev.example.test",
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
  const blobs = new BlobStore(directory, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const ingest = new IngestService(waypoint, queue, blobs, reads, opened.syncClient);
  const sync = new SyncLoop(queue, opened.syncClient, Date.now, waypoint);
  worker = new WriterCommitter(waypoint, queue, blobs, new MemoryBucket(), sync, ingest);
  ingest.committer = worker;
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest,
    publicBaseUrl: "https://reader-dev.example.test",
    shareTokenKey,
  });
  // #1: index.txt, committed and synced (no unpushed row).
  const created = await app.request(
    "/api/collections",
    json({ title: "Shared test", files: [{ path: "index.txt", hash: await put("hello public") }] }),
  );
  if (created.status !== 200) throw new Error("Collection creation failed");
  collectionId = await idOf(created, "collection_id");
  await worker.drain();
  const col = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [collectionId],
  );
  if (!col) throw new Error("Commit missing");
  collectionPublicId = col.public_id;
});
afterEach(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

const decode = (text: string): string =>
  text
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
/** Text of an HTML fragment (line and block tags read as spaces, whitespace collapsed). */
const textOf = (fragment: string): string =>
  decode(fragment.replaceAll(/<\/?(?:br|div|p)\b[^>]*>/g, " ").replaceAll(/<[^>]*>/g, ""))
    .replaceAll(/\s+/g, " ")
    .trim();
async function dialogAt(path: string): Promise<string> {
  const html = await (await app.request(path)).text();
  const start = html.indexOf('<dialog class="dlg share"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</dialog>", start));
}
/** The track for a target: its markup (tracks hold no nested div). */
function track(dialog: string, target: "only" | "latest"): string | undefined {
  return new RegExp(`<div class="track when-${target}"[^>]*>[\\s\\S]*?</div>`).exec(dialog)?.[0];
}
const chips = (fragment: string): string[] =>
  [...fragment.matchAll(/<span class="sc[^"]*">([\s\S]*?)<\/span>/g)].map(([, body]) =>
    textOf(body ?? ""),
  );
const note = (fragment: string): string =>
  textOf(/<p class="tnote">([\s\S]*?)<\/p>/.exec(fragment)?.[1] ?? "");
/** The checklist alternative for a target (`<div class="when-…">` up to the next one or the never row). */
function checklist(dialog: string, target: "only" | "latest"): string {
  const start = dialog.indexOf(`<div class="when-${target}">`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = dialog.indexOf('class="row when-never"', start);
  const other = dialog.indexOf('<div class="when-', start + 1);
  return dialog.slice(start, other > 0 && other < end ? other : end);
}
function preview(dialog: string): { href: string; latest: string; pinned: string } {
  const tag = /<a [^>]*data-preview-for="target"[^>]*>/.exec(dialog)?.[0] ?? "";
  const attr = (name: string) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "");
  return { href: attr("href"), latest: attr("data-latest"), pinned: attr("data-pinned") };
}

/** The first revision's id (#1, synced). */
const firstId = async (): Promise<string> =>
  (
    await waypoint.get<{ id: string }>(
      "SELECT id FROM revisions WHERE collection_id=? ORDER BY id LIMIT 1",
      [collectionId],
    )
  )?.id ?? "";
/** A merge-mode manifest that keeps #1's index.txt. */
const indexOnly = async () => ({
  "index.txt": { hash: await put("hello public"), mime: "text/plain", size: 12 },
});

describe("OW-03 share dialog", () => {
  it("up to date: L1 and O1, no warnings", async () => {
    const dialog = await dialogAt(`/c/${collectionPublicId}/`);
    const latest = track(dialog, "latest") ?? "";
    expect(chips(latest)).toEqual(["#1 now"]);
    expect(note(latest)).toBe("Latest: shows the newest revision, now #1.");
    expect(note(track(dialog, "only") ?? "")).toBe(
      "An Only #1 link shows this revision. It won't change.",
    );
    expect(dialog).not.toContain("data-warn");
    expect(dialog).not.toContain('class="row next"');
  });

  it("syncing: the track, per-target checklists and preview hrefs from the targets' manifests", async () => {
    // #2 adds two.txt (merge) and is committed but not pushed.
    const second = await addRevision({ files: [{ path: "two.txt", hash: await put("two") }] });
    await worker.drain();
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      second,
      Date.now(),
    ]);
    worker.stop();
    await worker.drain();
    // #3 on #2 changes index.txt only (stays pending); #4 on #2 failed. Queued directly: with
    // the committer stopped, the API would wait for each commit.
    const [index, two] = await Promise.all([put("hello again"), put("two")]);
    const third = await queueRevision(second, {
      "index.txt": { hash: index, mime: "text/plain", size: 11 },
      "two.txt": { hash: two, mime: "text/plain", size: 3 },
    });
    const fourth = await queueRevision(second, {
      "index.txt": { hash: index, mime: "text/plain", size: 11 },
      "four.txt": { hash: await put("four"), mime: "text/plain", size: 4 },
    });
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [fourth]);
    const [firstPub, thirdPub, fourthPub] = await Promise.all([
      waypoint
        .get<{ public_id: string }>(
          "SELECT public_id FROM revisions WHERE collection_id=? ORDER BY id LIMIT 1",
          [collectionId],
        )
        .then((row) => row?.public_id ?? ""),
      publicIdOf(third),
      publicIdOf(fourth),
    ]);

    /** The Latest track and checklist are the same whichever revision the dialog opens on. */
    const expectLatestDisclosure = (dialog: string) => {
      const latest = track(dialog, "latest") ?? "";
      expect(chips(latest)).toEqual(["#1 now", "#2 uploading", "#3 uploading", "#4 failed"]);
      expect(latest).toMatch(/<s>#4 failed<\/s>/);
      expect(latest.match(/class="to"/g)).toHaveLength(3);
      expect(note(latest)).toBe(
        "Latest: shows the newest revision. While #3 uploads, recipients see #1 with a syncing note.",
      );
      expect(latest).toContain("data-warn");
      const latestRows = checklist(dialog, "latest");
      expect(textOf(latestRows)).toContain("Now: the file in #1 index.txt");
      expect(textOf(latestRows)).toContain("When #3 syncs: 2 files + two.txt · index.txt");
      expect(latestRows).toContain('<span class="add">+ two.txt</span>');
      expect(latestRows).not.toContain('class="rm"');
      expect(latestRows).not.toContain("four.txt");
      expect(latestRows).toContain("Every future revision");
    };

    // Latest URL: #3 (the newest non-failed revision).
    const dialog = await dialogAt(`/c/${collectionPublicId}/`);
    expectLatestDisclosure(dialog);
    const only = track(dialog, "only") ?? "";
    expect(chips(only)).toEqual(["#3 uploading"]);
    expect(note(only)).toBe(
      "Until #3 syncs, people with the link see “This link isn't available”.",
    );
    const onlyRows = checklist(dialog, "only");
    expect(textOf(onlyRows)).toContain(
      "All 2 files in #3, not just the one you're reading index.txt · two.txt",
    );
    const fromLatest = preview(dialog);
    expect(fromLatest.latest).not.toContain("/r/");
    expect(fromLatest.latest).toMatch(/\?as=public$/);
    expect(fromLatest.pinned).toContain(`/r/${thirdPub}/`);
    expect(fromLatest.href).toBe(fromLatest.pinned);
    // A Latest preview URL naming a file #1 lacks opens #1's head file (previewHref's
    // fresh-context form keeps the path).
    const missing = await app.request(`/c/${collectionPublicId}/two.txt?as=public`);
    expect(missing.status).toBe(200);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain(`/raw/r/${firstPub}/index.txt`);
    expect(missingHtml).not.toContain(`/raw/r/${firstPub}/two.txt`);
    expect(dialog).toContain("Preview #3 as public");
    expect(dialog).not.toMatch(/class="warn|stuck/);

    // From failed #4: the same Latest disclosure (not #4's files under #1), Only is disabled,
    // Latest is the default and the preview opens it.
    const failed = await dialogAt(`/c/${collectionPublicId}/r/${fourthPub}/`);
    expectLatestDisclosure(failed);
    expect(failed).toMatch(/<input type="radio" name="target" value="only" disabled/);
    expect(track(failed, "only")).toBeUndefined();
    const fromFailed = preview(failed);
    expect(fromFailed.href).toBe(fromFailed.latest);
    expect(fromFailed.latest).not.toContain("/r/");
    expect(failed).toContain('title="Opens the Latest URL as a stranger sees it today"');
    expect(textOf(failed)).toContain("Preview what this link shows: #1");
    expect(failed).not.toMatch(/class="warn|stuck/);

    // Pinned #1 (synced): O1.
    const pinned = await dialogAt(`/c/${collectionPublicId}/r/${firstPub}/`);
    expect(note(track(pinned, "only") ?? "")).toBe(
      "An Only #1 link shows this revision. It won't change.",
    );
    expect(preview(pinned).pinned).toContain(`/r/${firstPub}/`);
  });

  it("a newer revision changes the head file: the Latest preview still opens the synced file", async () => {
    // #2 adds other.txt and syncs; #3 on #2 makes other.txt the head and adds new.txt (pending).
    const second = await addRevision({ files: [{ path: "other.txt", hash: await put("other") }] });
    await worker.drain();
    worker.stop();
    await worker.drain();
    const [index, other] = await Promise.all([put("hello public"), put("other")]);
    await queueRevision(
      second,
      {
        "index.txt": { hash: index, mime: "text/plain", size: 12 },
        "other.txt": { hash: other, mime: "text/plain", size: 5 },
        "new.txt": { hash: await put("new"), mime: "text/plain", size: 3 },
      },
      "other.txt",
    );
    const secondPub = await publicIdOf(second);
    const base = `/c/${collectionPublicId}/`;
    /** The file the Latest preview opens from a dialog on `page`. */
    const opened = async (page: string): Promise<{ latest: string; file: string }> => {
      const { latest } = preview(await dialogAt(page));
      const html = await (await app.request(latest)).text();
      const files = [...html.matchAll(new RegExp(`/raw/r/${secondPub}/([a-z.]+)`, "g"))];
      return { latest, file: files.at(0)?.[1] ?? "" };
    };
    // index.txt (in #2) is named: a bare Latest URL would resolve to #3's head, other.txt.
    expect(await opened(`${base}index.txt`)).toEqual({
      latest: `${base}index.txt?as=public`,
      file: "index.txt",
    });
    // new.txt isn't in #2: #2's head file, index.txt, named for the same reason.
    expect(await opened(`${base}new.txt`)).toEqual({
      latest: `${base}index.txt?as=public`,
      file: "index.txt",
    });
    // other.txt (in #2 and #3's head) stays elided, and the bare Latest URL opens it.
    expect(await opened(base)).toEqual({ latest: `${base}?as=public`, file: "other.txt" });
  });

  it("more than four steps: three chips stay after a leading +N more (four after now)", async () => {
    worker.stop();
    await worker.drain();
    const parent = await firstId();
    const files = await indexOnly();
    for (let i = 0; i < 5; i++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Display numbers follow queue order.
      await queueRevision(parent, files);
    const latest = track(await dialogAt(`/c/${collectionPublicId}/`), "latest") ?? "";
    expect(chips(latest)).toEqual([
      "#1 now",
      "+2 more",
      "#4 uploading",
      "#5 uploading",
      "#6 uploading",
    ]);
    expect(latest.match(/class="to"/g)).toHaveLength(4);
  });

  it("newest failed, nothing syncing: L3", async () => {
    worker.stop();
    await worker.drain();
    const failed = await queueRevision(await firstId(), await indexOnly());
    await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [failed]);
    const latest = track(await dialogAt(`/c/${collectionPublicId}/`), "latest") ?? "";
    expect(chips(latest)).toEqual(["#1 now", "#2 failed"]);
    expect(note(latest)).toBe(
      "Latest: shows the newest revision that has synced. #2 failed to upload, so recipients see #1 until you retry it.",
    );
    expect(latest).toContain("data-warn");
  });

  it("nothing synced: L4, and the Latest preview opens the collection URL", async () => {
    await queue.run("INSERT INTO unpushed (revision_id,committed_at) VALUES (?,?)", [
      await firstId(),
      Date.now(),
    ]);
    const dialog = await dialogAt(`/c/${collectionPublicId}/`);
    const latest = track(dialog, "latest") ?? "";
    expect(chips(latest)).toEqual(["#1 uploading"]);
    expect(note(latest)).toBe(
      "Nothing in this collection has synced yet. The link won't work until it does.",
    );
    expect(textOf(checklist(dialog, "latest"))).toContain(
      "Now: nothing. No revision has synced yet.",
    );
    expect(dialog).toContain("Title, then every future revision once one syncs");
    expect(preview(dialog).latest).toBe(`/c/${collectionPublicId}/?as=public`);
    expect(textOf(dialog)).toContain("Preview what this link shows ");
  });
});

const item = (id: string, sync: HealthItem["sync"]): HealthItem => ({
  id,
  public_id: "p",
  collection_id: "c",
  collection_public_id: null,
  collection_title: null,
  display_number: 2,
  message: null,
  created_at: 0,
  last_error: null,
  error_kind: null,
  source_host: null,
  state: "pending",
  first_attempt_at: null,
  attempts: 0,
  next_attempt_at: null,
  parent_revision_id: null,
  parent_state: null,
  sync,
});
const health = (pending: HealthItem[]): Health => ({
  state: "uploading",
  label: "",
  short: "",
  aria: "",
  failed: [],
  pending,
  stalled: [],
  waiting: [],
  collections: [],
  oldestPendingAt: null,
  lastPushAt: null,
  lastPullAt: null,
  cloudLastOkAt: null,
  cloudError: null,
  blockedReason: null,
  environment: "dev",
  syncEnabled: true,
});
const row = (id: string, sync_state: RevisionRow["sync_state"]): RevisionRow => ({
  id,
  public_id: "p",
  collection_id: "c",
  parent_revision_id: null,
  head_path: "index.txt",
  message: null,
  metadata: "{}",
  created_at: 0,
  sync_state,
});

describe("revisionWord", () => {
  it("reads FC2's precomputed health for queued revisions, never stuck", () => {
    expect(revisionWord(row("a", "pending"), health([item("a", "stalled")]))).toBe("stalled");
    expect(revisionWord(row("a", "pending"), health([item("a", "waiting")]))).toBe("waiting");
    expect(revisionWord(row("a", "pending"), health([item("b", "stalled")]))).toBe("uploading");
    expect(revisionWord(row("a", "committed"), health([]))).toBe("uploading");
    expect(revisionWord(row("a", "synced"), health([]))).toBe("synced");
    expect(revisionWord(row("a", "failed"), health([]))).toBe("failed");
  });
});

const someHash = `sha256:${"0".repeat(64)}`;
function manifestOf(headPath: string, paths: string[]): Manifest {
  if (!isContentHash(someHash)) throw new Error("Bad hash");
  const entry = { hash: someHash, mime: "text/plain", size: 1 };
  return { headPath, files: Object.fromEntries(paths.map((path) => [path, entry])) };
}
const rev = (n: number, state: RevisionRow["sync_state"], headPath = "index.txt"): RevisionRow => ({
  ...row(`r${n}`, state),
  public_id: `p${n}`,
  display_number: n,
  head_path: headPath,
});

describe("shareDisclosure and previewHref", () => {
  // #1 synced (index.txt, b.txt); #2–#6 pending; #6 keeps b.txt and adds a.txt and z.txt, its head.
  const six = rev(6, "pending", "z.txt");
  const rows = [rev(1, "synced"), ...[2, 3, 4, 5].map((n) => rev(n, "pending")), six];
  const manifests = new Map([
    ["r1", manifestOf("index.txt", ["b.txt", "index.txt"])],
    ["r6", manifestOf("z.txt", ["z.txt", "index.txt", "b.txt", "a.txt"])],
  ]);
  const contextOn = (revision: RevisionRow): CollectionContext => {
    const manifest = manifests.get(revision.id);
    if (!manifest) throw new Error("No manifest");
    const stub = {
      s: {
        reads: {
          manifestOf: (of: RevisionRow) => {
            const found = manifests.get(of.id);
            return found ? Promise.resolve(found) : Promise.reject(new Error("No manifest"));
          },
        },
      },
      chrome: { health: health([]) },
      collection: { public_id: "c" },
      rows,
      latest: rows.at(-1),
      revision,
      pinned: revision.id !== rows.at(-1)?.id,
      manifest,
      publicSees: rows[0],
    };
    // A stub of the fields shareDisclosure and previewHref read.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return stub as CollectionContext;
  };

  it("lists the head file first, keeps a path only where the target has it", async () => {
    const onLatest = contextOn(six);
    const d = await shareDisclosure(onLatest, "a.txt");
    expect(d.current.files).toEqual(["z.txt", "a.txt", "b.txt", "index.txt"]);
    expect(d.newestSynced?.files).toEqual(["index.txt", "b.txt"]);
    expect(d.next?.files).toEqual(["z.txt", "a.txt", "b.txt", "index.txt"]);
    expect(d.steps.map((step) => step.n)).toEqual([2, 3, 4, 5, 6]);
    expect(d.syncing).toBe(true);
    // a.txt isn't in #1, so the Latest preview opens #1's head file, named in the URL because
    // the bare Latest URL resolves to #6's head (z.txt).
    expect(d.hrefs).toEqual({
      latest: "/c/c/index.txt?as=public",
      pinned: "/c/c/r/p6/a.txt?as=public",
    });
    expect(previewHref(onLatest, "a.txt", "latest")).toBe(d.hrefs.latest);
    expect(previewHref(onLatest, "a.txt", "only")).toBe(d.hrefs.pinned);
    expect(previewHref(onLatest, "a.txt")).toBe("/c/c/a.txt?as=public");

    const onSynced = contextOn(rows[0] ?? rev(1, "synced"));
    const synced = await shareDisclosure(onSynced, "b.txt");
    expect(synced.hrefs.latest).toBe("/c/c/b.txt?as=public");
    expect(previewHref(onSynced, "b.txt", "latest")).toBe(synced.hrefs.latest);
    expect(previewHref(onSynced, "b.txt")).toBe("/c/c/r/p1/b.txt?as=public");
  });

  it('previewHref(…, "latest") keeps a path the newest synced revision also has, from a newer one', async () => {
    // b.txt is in #1 (newest synced) and in #6, the page's revision.
    const onLatest = contextOn(six);
    // On a fresh context (#1's manifest not loaded yet) the path is kept: the same URL as
    // hrefs.latest when #1 has the file.
    expect(previewHref(onLatest, "b.txt", "latest")).toBe("/c/c/b.txt?as=public");
    // a.txt is only in #6: kept too; the public preview then opens #1's head file (asserted
    // over HTTP in the syncing test).
    expect(previewHref(contextOn(six), "a.txt", "latest")).toBe("/c/c/a.txt?as=public");
    const d = await shareDisclosure(onLatest, "b.txt");
    expect(d.hrefs.latest).toBe("/c/c/b.txt?as=public");
    expect(previewHref(onLatest, "b.txt", "latest")).toBe(d.hrefs.latest);
    // Once #1's manifest is known, a path it lacks becomes #1's head file, as in hrefs.latest.
    expect(previewHref(onLatest, "a.txt", "latest")).toBe("/c/c/index.txt?as=public");
  });
});
