// Usage: pnpm live-smoke /path/to/dev.env (tsx runs the writer modules from source).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  BucketError,
  ENVIRONMENT_MARKER_KEY,
  MISSING_MARKER_CODE,
  openBucket,
} from "../apps/writer/src/bucket.ts";
import { loadConfig } from "../apps/writer/src/config.ts";

const envPath = process.argv[2];
if (!envPath) throw new Error("Usage: pnpm live-smoke /path/to/dev.env");
const env: NodeJS.ProcessEnv = {};
for (const line of (await readFile(envPath, "utf8")).split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (match) env[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
}
if (env.WAYPOINT_ENV === "prod") throw new Error("Live smoke refuses WAYPOINT_ENV=prod");
const config = loadConfig(env);
if (!config.sync || config.environment !== "dev")
  throw new Error("Live smoke requires the dev sync environment");
const base = config.baseUrl.replace(/\/$/, "");
const statusResponse = await fetch(`${base}/api/status`);
if (!statusResponse.ok) throw new Error(`Status failed (${statusResponse.status})`);
const status: unknown = await statusResponse.json();
if (
  !status ||
  typeof status !== "object" ||
  !("environment" in status) ||
  status.environment !== "dev"
)
  throw new Error("Writer status is not dev");
// The marker-checked bucket (D54), so a dev env file pointing at another environment's bucket is
// refused here rather than probed. The marker must already exist (the dev writer writes it on its
// first bucket request): checkMarker never writes one, so the smoke never stamps an unmarked bucket
// as dev.
const bucket = openBucket(config);
try {
  await bucket.checkMarker();
} catch (error) {
  if (error instanceof BucketError && error.code === MISSING_MARKER_CODE)
    throw new Error(
      `Bucket has no ${ENVIRONMENT_MARKER_KEY}; commit something through the dev writer first so it writes the marker`,
      { cause: error },
    );
  throw error;
}
const runId = randomUUID();
const files = [
  {
    path: "index.md",
    mime: "text/markdown",
    body: new TextEncoder().encode(`# Waypoint smoke\n\nDev write path probe ${runId}.\n`),
  },
  {
    path: "probe.svg",
    mime: "image/svg+xml",
    body: new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>${runId}</title><rect width="1" height="1" fill="red"/></svg>`,
    ),
  },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let collectionId: string | undefined;
try {
  const entries = [];
  for (const file of files) {
    const hash = `sha256:${createHash("sha256").update(file.body).digest("hex")}`;
    const upload = await fetch(`${base}/api/blobs/${hash}`, { method: "PUT", body: file.body });
    if (!upload.ok) throw new Error(`Blob upload failed (${upload.status})`);
    entries.push({ path: file.path, hash, mime: file.mime });
  }
  const response = await fetch(`${base}/api/collections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: `Smoke ${new Date().toISOString()}`,
      metadata: { smoke: true },
      files: entries,
      head_path: "index.md",
    }),
  });
  if (!response.ok) throw new Error(`Collection create failed (${response.status})`);
  const created: unknown = await response.json();
  if (
    !created ||
    typeof created !== "object" ||
    !("revision_id" in created) ||
    typeof created.revision_id !== "string" ||
    !("collection_id" in created) ||
    typeof created.collection_id !== "string" ||
    !("url" in created) ||
    typeof created.url !== "string"
  )
    throw new Error("Invalid writer response");
  collectionId = created.collection_id;
  const revisionId = created.revision_id;
  let synced = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const stateResponse = await fetch(`${base}/api/revisions/${revisionId}`);
    if (!stateResponse.ok) throw new Error(`Revision lookup failed (${stateResponse.status})`);
    const state: unknown = await stateResponse.json();
    if (
      state &&
      typeof state === "object" &&
      "sync_state" in state &&
      state.sync_state === "synced"
    ) {
      synced = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!synced) throw new Error("Revision did not reach synced within 120 seconds");
  for (const entry of entries)
    if (!(await bucket.head(`blobs/sha256/${entry.hash.slice(7)}`)))
      throw new Error(`Missing bucket blob: ${entry.path}`);
  if (!(await bucket.head(`manifests/${revisionId}.json`))) throw new Error("Missing DR manifest");
  if (!(await bucket.head(`collections/${collectionId}.json`)))
    throw new Error("Missing collection snapshot");
  // RX-11: a Latest link says a newer version is being synced while one uploads, and stops once it
  // has synced. Four 40 MiB incompressible files keep the upload busy long enough to see the note.
  const shareResponse = await fetch(`${base}/api/collections/${collectionId}/share-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const share: unknown = shareResponse.ok ? await shareResponse.json() : null;
  const linkUrl =
    share && typeof share === "object" && "url" in share && typeof share.url === "string"
      ? share.url
      : null;
  if (!linkUrl) console.log("RX-11 step skipped: sharing is not configured");
  else {
    const note = "A newer version is being synced.";
    const syncState = async (id: string): Promise<unknown> => {
      const stateResponse = await fetch(`${base}/api/revisions/${id}`);
      if (!stateResponse.ok) throw new Error(`Revision lookup failed (${stateResponse.status})`);
      const state: unknown = await stateResponse.json();
      return state && typeof state === "object" && "sync_state" in state
        ? state.sync_state
        : undefined;
    };
    // The new link reaches the reader with the writer's next push.
    let shell: Response | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      shell = await fetch(linkUrl);
      if (shell.status === 200) break;
      await sleep(1000);
    }
    if (shell?.status !== 200) throw new Error(`RX-11: share link failed (${shell?.status})`);
    if ((await shell.text()).includes(note))
      throw new Error("RX-11: the note shows with nothing newer queued");
    const big = [];
    for (let i = 1; i <= 4; i++) {
      const body = randomBytes(40 * 1024 * 1024);
      const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const upload = await fetch(`${base}/api/blobs/${hash}`, { method: "PUT", body });
      if (!upload.ok) throw new Error(`Blob upload failed (${upload.status})`);
      big.push({ path: `big-${i}.bin`, hash, mime: "application/octet-stream" });
    }
    let bigId: string | undefined;
    const started = Date.now();
    const adding = fetch(`${base}/api/collections/${collectionId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: big }),
    }).then(async (addResponse) => {
      if (!addResponse.ok) throw new Error(`Revision add failed (${addResponse.status})`);
      const added: unknown = await addResponse.json();
      if (
        !added ||
        typeof added !== "object" ||
        !("revision_id" in added) ||
        typeof added.revision_id !== "string"
      )
        throw new Error("Invalid writer response");
      bigId = added.revision_id;
      return added.revision_id;
    });
    // Awaited below; this only keeps an early failure from being unhandled meanwhile.
    adding.catch(() => undefined);
    let seenAfter: number | undefined;
    while (seenAfter === undefined) {
      if (Date.now() - started > 120_000)
        throw new Error("RX-11: the note didn't appear within 120 seconds");
      const page = await fetch(linkUrl);
      if (page.status !== 200) throw new Error(`RX-11: share link failed (${page.status})`);
      if ((await page.text()).includes(note)) seenAfter = Date.now() - started;
      else if (bigId && (await syncState(bigId)) === "synced")
        throw new Error(
          "RX-11: the note was never observed before the new revision synced; rerun (the upload finished before the push)",
        );
      else await sleep(250);
    }
    const revision = await adding;
    let committedAt: number | undefined;
    for (let attempt = 0; attempt < 180 && committedAt === undefined; attempt++) {
      if ((await syncState(revision)) === "synced") committedAt = Date.now();
      else await sleep(1000);
    }
    if (committedAt === undefined)
      throw new Error("RX-11: the new revision did not reach synced within 180 seconds");
    let goneAfter: number | undefined;
    for (let attempt = 0; attempt < 30 && goneAfter === undefined; attempt++) {
      const page = await fetch(linkUrl);
      const html = page.status === 200 ? await page.text() : "";
      if (html && !html.includes(note) && html.includes('data-p="big-1.bin"'))
        goneAfter = Date.now() - committedAt;
      else await sleep(1000);
    }
    if (goneAfter === undefined)
      throw new Error(
        "RX-11: the note stayed, or the new revision wasn't served, after 30 seconds",
      );
    console.log(`RX-11 note: seen after ${seenAfter} ms, gone ${goneAfter} ms after the commit`);
  }
  console.log(created.url);
  console.log(`${base}/api/revisions/${revisionId}`);
} finally {
  if (collectionId) {
    const purge = await fetch(`${base}/api/collections/${collectionId}/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: collectionId }),
    });
    if (!purge.ok) console.error(`Smoke collection purge request failed (${purge.status})`);
    else
      console.log(
        `Purge queued for ${collectionId}; GC waits for the 15-minute blob grace period.`,
      );
  }
}
