// Usage: pnpm live-smoke /path/to/dev.env (tsx runs the writer modules from source).
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ENVIRONMENT_MARKER_KEY, openBucket } from "../apps/writer/src/bucket.ts";
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
// refused here rather than probed. The marker must already exist (the dev writer writes it): the
// smoke never stamps an unmarked bucket as dev.
const bucket = openBucket(config);
if (!(await bucket.inner.head(ENVIRONMENT_MARKER_KEY)))
  throw new Error(`Bucket has no ${ENVIRONMENT_MARKER_KEY}; run the dev writer against it first`);
await bucket.verify();
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
