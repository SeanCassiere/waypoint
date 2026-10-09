// A fully local writer for UI work: an in-memory bucket, a no-op cloud sync, and realistic
// seeded content (several collections, histories with a fork, a failed and an uploading
// revision, share links in every state, images, a binary file, an HTML plan, and Trash).
// Usage: pnpm build && pnpm demo [port] [data-dir] (tsx runs the writer from source; the build
// provides the viewer assets).
// Set WAYPOINT_PUBLIC_BASE_URL (e.g. http://127.0.0.1:7422) so share URLs point at a demo reader
// (`pnpm demo:reader`).
// Set WAYPOINT_DEMO_READER_FIXTURE=1 to add the reader lane's "Field kit: reader fixture" link.
// Set WAYPOINT_DEMO_RENDITIONS_FIXTURE=1 to add RX-08's "Field kit: renditions fixture" link.
// It never touches Turso, R2, or ~/.config/waypoint.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { serve } from "@hono/node-server";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import { openDatabases, type SyncClient } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { writerRenderers } from "../apps/writer/src/renderer.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";
// @waypoint/core from source: the repository root doesn't depend on the workspace packages.
import { newId, parseId, parseShareTokenKey, publicIdFor } from "../packages/core/src/index.ts";

const port = Number(process.argv[2] ?? 7421);
const dir = process.argv[3] ?? (await mkdtemp(join(tmpdir(), "waypoint-demo-")));
const base = `http://127.0.0.1:${port}`;
const { waypoint, queue } = await openDatabases({
  environment: "dev",
  dataDir: dir,
  baseUrl: base,
  port,
  queueGiveUpHours: 72,
  maxBlobBytes: 64 * 1024 * 1024,
  sync: false,
});
await migrate(waypoint, waypointMigrations);
await migrate(queue, queueMigrations);
const cloud: SyncClient = {
  lastPullAt: Date.now(),
  verified: true,
  pull: () => Promise.resolve(false),
  push: () => Promise.resolve(),
  checkpoint: () => Promise.resolve(),
};
await guardEnvironment(waypoint, cloud, "dev", false);
const blobs = new BlobStore(dir, 64 * 1024 * 1024);
const reads = new ReadModel(waypoint, queue, base);
const ingest = new IngestService(waypoint, queue, blobs, reads, cloud, undefined, writerRenderers);
const syncLoop = new SyncLoop(queue, cloud, Date.now, waypoint);
const committer = new WriterCommitter(
  waypoint,
  queue,
  blobs,
  new MemoryBucket(),
  syncLoop,
  ingest,
  Date.now,
  Math.random,
  72,
  undefined,
  (id) => reads.notifyRevision(id),
);
ingest.committer = committer;
// The share token key (what WAYPOINT_SHARE_TOKEN_KEY holds as 43 base64url characters), so the
// seeded share links have URLs. It's ephemeral unless WAYPOINT_SHARE_TOKEN_KEY is set: without it
// a rerun on the same data dir has a new key, and shows those links as "URL unavailable"; with it,
// a rerun keeps its links' URLs.
const shareTokenKey = process.env.WAYPOINT_SHARE_TOKEN_KEY
  ? parseShareTokenKey(process.env.WAYPOINT_SHARE_TOKEN_KEY)
  : new Uint8Array(randomBytes(32));
syncLoop.start();
committer.wake();
const app = createApp({
  waypoint,
  queue,
  blobs,
  reads,
  ingest,
  committer,
  syncLoop,
  environment: "dev",
  port,
  publicBaseUrl: process.env.WAYPOINT_PUBLIC_BASE_URL || "https://reader-dev.example.test",
  shareTokenKey,
});

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await app.request(path, init);
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
  if (!value || typeof value !== "object") throw new Error("Bad response");
  return Object.fromEntries(Object.entries(value));
}
async function put(path: string, content: string | Uint8Array, mime?: string) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
  return { path, hash, ...(mime ? { mime } : {}) };
}
type File = Awaited<ReturnType<typeof put>>;
async function create(
  title: string,
  metadata: Record<string, unknown>,
  host: string,
  message: string,
  files: File[],
  head?: string,
) {
  const result = await call(
    "/api/collections",
    json("POST", {
      title,
      metadata: { ...metadata, source_host: host },
      message,
      files,
      head_path: head ?? files[0]?.path,
    }),
  );
  return { id: String(result.collection_id), revision: String(result.revision_id) };
}
async function add(
  collection: string,
  host: string,
  message: string,
  files: File[],
  extra: Record<string, unknown> = {},
) {
  const result = await call(
    `/api/collections/${collection}/revisions`,
    json("POST", { message, files, metadata: { source_host: host }, ...extra }),
  );
  return String(result.revision_id);
}
async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const row = await queue.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_revisions");
    if (!row?.n) return;
    committer.wake();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Committer did not settle");
}

// --- tiny PNG encoder for screenshot-like images -------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}
type Rect = [number, number, number, number, [number, number, number]];
function png(
  width: number,
  height: number,
  background: [number, number, number],
  rects: Rect[],
): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      let color = background;
      for (const [rx, ry, rw, rh, c] of rects)
        if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) color = c;
      raw.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function screen(
  accent: [number, number, number],
  button: [number, number, number],
  variant = 0,
): Uint8Array {
  const w = 720;
  const h = 450;
  return png(
    w,
    h,
    [250, 249, 246],
    [
      [0, 0, w, 48, [27, 26, 23]],
      [24, 16, 90, 16, [252, 251, 249]],
      [60, 90, 360 + variant * 20, 22, [70, 67, 61]],
      [60, 130, 520, 12, [214, 209, 199]],
      [60, 152, 480, 12, [214, 209, 199]],
      [60, 174, 500, 12, [214, 209, 199]],
      [60, 230, 600, 120, accent],
      [w - 220, h - 70, 160, 40, button],
    ],
  );
}

// --- content --------------------------------------------------------------------------------
const webhooksV1 = `# Webhook idempotency research

## Recommendation

For a service that **sends** webhooks after changing its own database, use a transactional outbox, deliver each event at least once with retries, and give every event a stable ID that receivers can deduplicate. These mechanisms cover different failure points: the outbox preserves the event across a sender crash; retries handle temporary delivery failures; receiver deduplication handles repeated attempts. [1][2][3]

| Approach | How it works | Strength | Main limit |
| --- | --- | --- | --- |
| Idempotency keys | Reuse one stable key for every attempt of the *same logical event*. The receiver stores the key with its result. | Simple contract for safe retries. [1] | Requires durable, atomic receiver storage and a retention period. [1] |
| Transactional outbox | Commit the business change and an outbox row in one transaction; a worker sends it. | Closes the gap between committing a change and scheduling its webhook. | Adds a table, a worker, cleanup and monitoring. [2] |
| At least once with dedupe | Retry failed or uncertain deliveries; the receiver records each processed event ID. | Tolerates network errors and lost acknowledgements. | Attempts may arrive more than once or out of order. [3][4] |

## Suggested delivery contract

1. Assign \`event_id\` when the event is written to the outbox.
2. Send \`Webhook-Id: <event_id>\` on **every** attempt.
3. Retry with exponential backoff for 72 hours, then dead-letter.

\`\`\`ts
await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
  await tx.insert(outbox).values({ event_id: ulid(), type: "order.created", payload: order });
});
\`\`\`

> [!NOTE]
> Receivers should treat a repeated \`Webhook-Id\` as success and return 200.

## Open questions

- How long should receivers keep processed IDs?
- Do we sign retries with the original timestamp?
`;
const webhooksV2 = webhooksV1
  .replace(
    "## Suggested delivery contract",
    `## Fit for our serverless functions

The transactional outbox pattern requires a transactional database: the business change and outbox record must commit in the same transaction. That requirement makes it a poor fit for our serverless functions. Without a shared transaction, writing an outbox record separately does not close the failure gap between the business change and webhook scheduling.

## Suggested delivery contract`,
  )
  .replace(
    "Retry with exponential backoff for 72 hours, then dead-letter.",
    "Retry with exponential backoff for 24 hours, then dead-letter and alert the owner.",
  );
const sources = `# Sources

1. Stripe, *Idempotent requests*.
2. Chris Richardson, *Pattern: Transactional outbox*.
3. Standard Webhooks specification, *Retries and idempotency*.
4. Svix, *Webhook delivery guarantees*.
`;
const checklist = `# Implementation checklist

- [x] Outbox table with \`event_id\`, \`type\`, \`payload\`, \`created_at\`
- [x] Relay worker with exponential backoff
- [ ] \`Webhook-Id\` header on every attempt
- [ ] Dead-letter queue and alert after 24 hours
- [ ] Receiver guide: dedupe by \`Webhook-Id\`, keep IDs for 7 days
`;
const runbook = (n: number) => `# Postgres 17 upgrade runbook

> [!WARNING]
> Illustrative content for the Waypoint redesign. Not a real runbook.

## Summary

Upgrade the primary cluster from Postgres 15.8 to 17.2 using \`pg_upgrade --link\` during a ${n > 3 ? 20 : 30}-minute maintenance window. A logical replica on 17.2 is kept warm as the fallback path.

## Preconditions

${
  n > 2
    ? `- [x] Extensions verified against 17.2 (see [compatibility matrix](extensions.md))
- [x] \`pg_upgrade --check\` passes on a restored snapshot
- [ ] Logical replica caught up to within 5 s of the primary
- [ ] Maintenance window announced 48 h ahead`
    : "Verify extensions, run `pg_upgrade --check` on a snapshot, and announce the window."
}

## Steps

1. Stop application writers and drain PgBouncer: \`PAUSE app;\`
2. Take a final snapshot of the data volume.
3. Run the upgrade:

\`\`\`bash
pg_upgrade --link \\
  -b /usr/lib/postgresql/15/bin -B /usr/lib/postgresql/17/bin \\
  -d /var/lib/postgresql/15/main -D /var/lib/postgresql/17/main \\
  --jobs ${n > 4 ? 8 : 4}
\`\`\`

4. Start 17.2, run \`vacuumdb --all --analyze-in-stages\`, then ${n > 4 ? "resume PgBouncer" : "reopen the firewall"}.
${
  n > 1
    ? `
## Rollback

| Failure point | Action | Expected downtime |
| --- | --- | --- |
| \`--check\` fails | Abort; nothing changed | 0 min |
| Upgrade fails before start | ${n > 3 ? "Restore 15.8 data dir from snapshot" : "Restore from backup"} | ${n > 3 ? "25 min" : "~1 h"} |${n > 3 ? "\n| Errors after resume | Promote the logical replica, repoint PgBouncer | 4 min |" : ""}
`
    : ""
}`;
const extensions = `# Extension compatibility

| Extension | 15.8 | 17.2 | Action |
| --- | --- | --- | --- |
| pg_stat_statements | 1.10 | 1.11 | upgraded by pg_upgrade |
| postgis | 3.3.4 | 3.5.0 | install 3.5 packages first |
| pg_partman | 4.7.3 | 5.1.0 | run \`ALTER EXTENSION ... UPDATE\` |
`;
const pgbouncer = `#!/usr/bin/env bash
set -euo pipefail
psql -h pgbouncer -p 6432 -U admin pgbouncer -c "PAUSE app;"
`;
const plan = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Q4 onboarding revamp</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#1b1a17;background:#fff}h1{font-size:2rem;margin:0 0 .3em}.card{border:1px solid #e5e4e0;border-radius:12px;padding:16px 20px;margin:16px 0}.k{display:inline-block;padding:2px 10px;border-radius:99px;background:#e8f0fd;color:#1f5fd1;font-size:13px}@media(prefers-color-scheme:dark){body{background:#151514;color:#ebe8e2}.card{border-color:#2b2c30}}</style></head>
<body><h1>Q4 onboarding revamp</h1><p>Goal: a new workspace reaches its first shared document in under five minutes.</p>
<div class="card"><span class="k">Week 1</span><h3>Guided setup</h3><p>Replace the empty dashboard with a three-step checklist.</p></div>
<div class="card"><span class="k">Week 2</span><h3>Templates</h3><p>Offer five starter documents chosen from support tickets.</p></div>
<div class="card"><span class="k">Week 3</span><h3>Measure</h3><p>Track time-to-first-share and drop-off per step.</p></div></body></html>`;

const webhooks = await create(
  "Webhook idempotency research",
  { project: "webhooks", tags: ["research"] },
  "devbox",
  "Add webhook idempotency comparison and references",
  [await put("index.md", webhooksV1), await put("sources.md", sources)],
);
await add(webhooks.id, "devbox", "Clarify outbox transactional DB requirement and serverless fit", [
  await put("index.md", webhooksV2),
]);
const webhooks3 = await add(
  webhooks.id,
  "devbox",
  "Add implementation checklist based on research revision 2",
  [await put("checklist.md", checklist)],
);

const pg = await create(
  "Postgres 17 upgrade runbook",
  { project: "infra", tags: ["runbook"] },
  "devbox",
  "Initial upgrade runbook",
  [await put("runbook.md", runbook(1))],
);
const pgRevisions = [pg.revision];
for (const [n, message] of [
  [2, "Add rollback section"],
  [3, "Split preconditions into a checklist"],
  [4, "Rewrite rollback table with expected downtime"],
  [5, "Add extension compatibility matrix"],
] as const)
  pgRevisions.push(
    await add(pg.id, "devbox", message, [
      await put("runbook.md", runbook(n)),
      ...(n >= 5 ? [await put("extensions.md", extensions)] : []),
    ]),
  );

const shots = ["checkout", "cart", "payment", "review", "confirmation", "receipt"];
const audit = await create(
  "Checkout flow screenshot audit",
  { project: "web", tags: ["audit"] },
  "macbook-air",
  "Baseline screenshots for the checkout flow",
  [
    await put(
      "report.md",
      "# Checkout screenshot audit\n\nSix screens captured at 1440×900. See the `shots/` gallery.\n\n| Screen | Contrast | Notes |\n| --- | --- | --- |\n| Payment | 3.1:1 | Pay button fails AA |\n| Review | 4.8:1 | OK |\n",
    ),
    ...(await Promise.all(
      shots.map((name, i) =>
        put(`shots/${name}.png`, screen([228, 226 - i * 6, 220], [120, 160, 220]), "image/png"),
      ),
    )),
  ],
);
await add(
  audit.id,
  "macbook-air",
  "Re-run after button contrast fix",
  [
    await put(
      "report.md",
      "# Checkout screenshot audit\n\nSix screens captured at 1440×900. See the `shots/` gallery.\n\n| Screen | Contrast | Notes |\n| --- | --- | --- |\n| Payment | 5.2:1 | Fixed: darker pay button |\n| Review | 4.8:1 | OK |\n",
    ),
    await put("shots/payment.png", screen([228, 214, 220], [31, 95, 209], 2), "image/png"),
    await put("shots/receipt.png", screen([228, 196, 220], [31, 95, 209], 4), "image/png"),
    await put("shots/coupon.png", screen([220, 236, 226], [23, 102, 58], 1), "image/png"),
  ],
  { remove: ["shots/cart.png"] },
);

const rate = await create(
  "HTTP API rate limiting plan",
  { project: "api" },
  "devbox",
  "First draft of token-bucket limits",
  [
    await put(
      "plan.md",
      "# HTTP API rate limiting plan\n\n## Limits\n\n| Tier | Requests / min | Burst |\n| --- | --- | --- |\n| Free | 60 | 20 |\n| Team | 600 | 200 |\n\n## Rollout\n\nShadow mode for a week, then enforce.\n",
    ),
  ],
);
await add(rate.id, "devbox", "Add staged rollout and rollback criteria", [
  await put(
    "plan.md",
    "# HTTP API rate limiting plan\n\n## Limits\n\n| Tier | Requests / min | Burst |\n| --- | --- | --- |\n| Free | 60 | 20 |\n| Team | 600 | 200 |\n\n## Rollout\n\n1. Shadow mode for a week.\n2. Enforce for 10% of free-tier keys.\n3. Enforce everywhere.\n\n## Rollback criteria\n\nRoll back if 429s exceed 0.5% of requests for 15 minutes.\n",
  ),
]);
const onboarding = await create(
  "Q4 onboarding revamp",
  { project: "web", tags: ["plan"] },
  "macbook-air",
  "Plan for the onboarding revamp",
  [await put("plan.html", plan)],
);
const e2e = await create(
  "Waypoint phase 1 — end-to-end check",
  { project: "waypoint", tags: ["e2e"] },
  "devbox",
  "Initial details",
  [await put("details.md", "# Phase 1 end-to-end check\n\nAll checks passed on devbox.\n")],
);
await add(e2e.id, "devbox", "Update details", [
  await put(
    "details.md",
    "# Phase 1 end-to-end check\n\nAll checks passed on devbox and the MacBook Air.\n",
  ),
]);
const auth = await create(
  "Auth session refactor plan",
  { project: "auth", tags: ["plan"] },
  "macbook-air",
  "Address review: keep refresh tokens server-side only",
  [
    await put(
      "plan.md",
      "# Auth session refactor\n\nRefresh tokens stay server-side; the browser holds a short-lived session cookie.\n",
    ),
  ],
);
const evalRun = await create(
  "Search relevance eval — run 2026-10-06",
  { project: "search", tags: ["eval"] },
  "devbox",
  "Initial eval report with raw events",
  [
    await put(
      "report.md",
      "# Search relevance eval\n\nnDCG@10 rose from 0.61 to 0.66. Raw events are in `data/events.parquet`.\n",
    ),
    await put(
      "data/events.parquet",
      new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)),
      "application/vnd.apache.parquet",
    ),
  ],
);
const scratch = await create(
  "Scratch: MCP smoke run 2026-10-05",
  { tags: ["scratch"] },
  "devbox",
  "Smoke run",
  [await put("out.txt", "ok\n")],
);
const leaked = await create(
  "Leaked .env in run output (do not share)",
  {},
  "devbox",
  "Run output",
  [await put("output.md", "# Run output\n\n```\nAPI_KEY=redacted-for-demo\n```\n")],
);
await settle();

// Share links in every state.
const link = async (collection: string, body: Record<string, unknown>): Promise<string> => {
  const shared = (await call(`/api/collections/${collection}/share-links`, json("POST", body)))
    .share_link;
  const id = shared && typeof shared === "object" && "id" in shared ? shared.id : undefined;
  if (typeof id !== "string") throw new Error("Share link not created");
  return id;
};
const day = 86_400_000;
await link(webhooks.id, {
  revision_id: webhooks3,
  label: "Priya — payments review",
  expires_at: Date.now() + 7 * day,
});
await link(webhooks.id, { label: "Design review — Sam", expires_at: Date.now() + 2 * 3_600_000 });
const blog = await link(webhooks.id, {
  revision_id: webhooks.revision,
  label: "Blog draft feedback",
});
await call(`/api/share-links/${blog}/revoke`, json("POST", {}));
const expired = await link(webhooks.id, { expires_at: Date.now() + 60_000 });
await waypoint.run("UPDATE share_links SET expires_at=? WHERE id=?", [
  Date.now() - 4 * day,
  expired,
]);
await link(rate.id, {});
await link(onboarding.id, { label: "Leadership preview" });
await link(leaked.id, { revision_id: leaked.revision, label: "Vendor debug" });
await syncLoop.push();

let readerFixtureUrl: string | undefined;
if (process.env.WAYPOINT_DEMO_READER_FIXTURE === "1") {
  // Subfolders, CSV, TSV, a large binary and more than 8 files, for the reader's spot checks.
  const fixture = await create(
    "Field kit: reader fixture",
    { project: "demo", tags: ["fixture"] },
    "devbox",
    "Reader fixture",
    [
      await put(
        "index.md",
        "# Field kit\n\nStart with the [day 1 notes](notes/day-1.md). The raw numbers are in [the sample table](data/sample.csv).\n\n## Contents\n\n- [Day 1](notes/day-1.md)\n- [Day 2](notes/day-2.md)\n\n## Open questions\n\nWhich region goes first?\n",
      ),
      await put("README.md", "# README\n\nFixture for reader checks.\n"),
      await put(
        "notes/day-1.md",
        "# Day 1\n\nContinue with [day 2](day-2.md) or go [back to the index](../index.md).\n",
      ),
      await put("notes/day-2.md", "# Day 2\n\nSee [day 3](day-3.md).\n"),
      await put("notes/day-3.md", "# Day 3\n"),
      await put("notes/day-4.md", "# Day 4\n"),
      await put(
        "data/sample.csv",
        "region,requests,errors\neu-west,1200,3\nus-east,3400,11\nap-south,800,0\n",
        "text/csv",
      ),
      await put(
        "data/sample.tsv",
        "region\trequests\nwest\t12\neast\t34\n",
        "text/tab-separated-values",
      ),
      await put("data/events.json", '{"events":[{"id":1,"kind":"deploy"}]}\n', "application/json"),
      await put("scripts/run.sh", "#!/bin/sh\necho ok\n", "text/x-shellscript"),
      await put("images/diagram.png", screen([214, 226, 236], [31, 95, 209], 3), "image/png"),
      await put(
        "archive/build-output.tar.gz",
        Uint8Array.from({ length: 4_300_000 }, (_, i) => (i * 31) % 251),
        "application/gzip",
      ),
    ],
    "index.md",
  );
  await settle();
  const fixtureLink = await call(
    `/api/collections/${fixture.id}/share-links`,
    json("POST", { label: "Reader fixture" }),
  );
  readerFixtureUrl = String(fixtureLink.url);
  await syncLoop.push();
}
let renditionsFixtureUrl: string | undefined;
if (process.env.WAYPOINT_DEMO_RENDITIONS_FIXTURE === "1") {
  // RX-08: text, code, logs, JSON and CSV files for the text and table views' spot checks.
  const drain = `${[
    "#!/usr/bin/env bash",
    "# Pause PgBouncer, wait for in-flight transactions, then hand over to pg_upgrade.",
    "# Run from the bastion as the admin user. Safe to re-run: every step checks state first.",
    "set -euo pipefail",
    "",
    'PGB_HOST="${PGB_HOST:-pgbouncer}"',
    'PGB_PORT="${PGB_PORT:-6432}"',
    'DB="app"',
    "DRAIN_TIMEOUT=120   # seconds to wait for active server connections to finish",
    "",
    'log() { echo "[$(date -u +%H:%M:%S)] $*"; }',
    "",
    "pgb() {",
    '  psql -h "$PGB_HOST" -p "$PGB_PORT" -U admin pgbouncer -tAc "$1"',
    "}",
    "",
    'log "Pausing $DB on $PGB_HOST:$PGB_PORT"',
    'pgb "PAUSE $DB;"',
    "",
    "# PAUSE returns once clients are queued; server connections may still be busy.",
    'for i in $(seq 1 "$DRAIN_TIMEOUT"); do',
    '  active=$(pgb "SHOW SERVERS;" | awk -F\'|\' -v db="$DB" \'$2 == db && $4 == "active"\' | wc -l)',
    '  if [ "$active" -eq 0 ]; then',
    '    log "Drained after ${i}s"',
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    "",
    'if [ "$active" -ne 0 ]; then',
    '  log "Still $active active connections after ${DRAIN_TIMEOUT}s; resuming and aborting"',
    '  pgb "RESUME $DB;"',
    "  exit 1",
    "fi",
    "",
    'log "Paused. Clients are queued, not refused. Run pg_upgrade now, then:"',
    "log \"  pgb 'RESUME $DB;'\"",
  ].join("\n")}\n`;
  const metrics =
    '{"run":"2026-10-06T21:14:03Z","model":"rerank-v4","baseline":"bm25+rules","queries":1200,"metrics":{"ndcg@10":{"baseline":0.412,"candidate":0.468,"delta":0.056},"mrr@10":{"baseline":0.377,"candidate":0.431,"delta":0.054},"recall@50":{"baseline":0.781,"candidate":0.804,"delta":0.023},"p95_latency_ms":{"baseline":38,"candidate":61,"delta":23}},"slices":[{"name":"navigational","queries":410,"ndcg_delta":0.012},{"name":"long-tail","queries":520,"ndcg_delta":0.091},{"name":"misspelled","queries":270,"ndcg_delta":0.047}],"regressions":["q-0193","q-0877"],"passed":true}' +
    "\n";
  const queries = [
    "refund policy for annual plan",
    "how to rotate api keys",
    "webhook retry schedule",
    "export invoices csv",
    "sso with okta",
    "rate limit headers",
    "delete workspace",
    "change billing email",
    "audit log retention",
    "2fa recovery codes",
    "ip allowlist",
    "custom domain ssl",
    "pagination cursor",
    "data residency eu",
  ];
  const results = [
    "query_id,query,ndcg@10,mrr,recall@50,latency_ms",
    ...Array.from({ length: 1284 }, (_, index) => {
      const i = index + 1;
      return [
        `q-${String(i).padStart(4, "0")}`,
        queries[(i - 1) % queries.length],
        (0.6 + ((i * 37) % 400) / 1000).toFixed(3),
        (0.55 + ((i * 53) % 400) / 1000).toFixed(3),
        (0.8 + ((i * 29) % 200) / 1000).toFixed(3),
        String(30 + ((i * 7) % 30)),
      ].join(",");
    }),
  ];
  const log = [
    ...Array.from(
      { length: 40 },
      (_, n) =>
        `2026-10-06T21:14:${String(n % 60).padStart(2, "0")}Z INFO request id=${n + 1} status=200`,
    ),
    "2026-10-06T21:15:00Z WARN payload=".padEnd(5000, "ab"),
  ];
  let huge = "";
  for (let i = 1; huge.length < 2_200_000; i++) huge += `line ${i}\n`;
  const fixture = await create(
    "Field kit: renditions fixture",
    { project: "demo", tags: ["fixture"] },
    "devbox",
    "Renditions fixture",
    [
      await put("drain.sh", drain),
      await put("metrics.json", metrics),
      await put(
        "events.jsonl",
        '{"id":1,"kind":"deploy"}\n{"id":2,"kind":"build"}\n{"id":3,"kind":"test"}\n',
      ),
      await put("server.log", `${log.join("\n")}\n`),
      await put(
        "trojan.js",
        'const s = "</pre><script>alert(1)</script>";\n// \u202E}\u202C {\n\u200B\u0000x\ry\n',
      ),
      await put("results.csv", `${results.join("\n")}\n`),
      await put("quoted.csv", 'name,note\n"Smith, J.","said ""hi""\nthen left"\nLee,ok\n'),
      await put("broken.csv", 'a,b\n"unterminated,1\n'),
      await put("wide.tsv", "region\trequests\nwest\t12\neast\t34\n", "text/tab-separated-values"),
      await put(
        "big.py",
        `${Array.from({ length: 6000 }, (_, index) => `x_${index + 1} = ${index + 1}`).join("\n")}\n`,
      ),
      await put("huge.txt", huge.slice(0, 2_200_000)),
      await put("page.html", "<!doctype html><h1>HTML stays HTML</h1>"),
      await put("notes.md", "# Notes\n\nMarkdown still renders.\n"),
    ],
    "drain.sh",
  );
  await settle();
  const fixtureLink = await call(
    `/api/collections/${fixture.id}/share-links`,
    json("POST", { label: "Renditions fixture" }),
  );
  renditionsFixtureUrl = String(fixtureLink.url);
  await syncLoop.push();
}

// Trash.
await call(`/api/collections/${scratch.id}`, { method: "DELETE" });
await call(`/api/collections/${leaked.id}`, { method: "DELETE" });
await settle();

// Spread the timeline over a few days so Recent shows its day groups.
const now = Date.now();
const shift = async (collection: string, hoursAgo: number[]) => {
  const rows = await waypoint.all<{ id: string }>(
    "SELECT id FROM revisions WHERE collection_id=? ORDER BY id",
    [collection],
  );
  for (const [index, row] of rows.entries()) {
    const at = now - (hoursAgo[index] ?? hoursAgo.at(-1) ?? 0) * 3_600_000;
    await waypoint.run("UPDATE revisions SET created_at=? WHERE id=?", [at, row.id]);
  }
  await waypoint.run("UPDATE collections SET created_at=? WHERE id=?", [
    now - (hoursAgo[0] ?? 0) * 3_600_000,
    collection,
  ]);
};
await shift(webhooks.id, [26, 0.6, 0.4]);
await shift(pg.id, [52, 51, 50.5, 49.8, 6]);
await shift(audit.id, [30, 2.2]);
await shift(rate.id, [28, 3.2]);
await shift(onboarding.id, [27]);
await shift(e2e.id, [40, 4.1]);
await shift(auth.id, [38]);
await shift(evalRun.id, [44]);
await shift(scratch.id, [60]);
await shift(leaked.id, [7]);
await waypoint.run("UPDATE collection_tombstones SET deleted_at=? WHERE collection_id=?", [
  now - 50 * 3_600_000,
  scratch.id,
]);
await waypoint.run("UPDATE collection_tombstones SET deleted_at=? WHERE collection_id=?", [
  now - 4 * 3_600_000,
  leaked.id,
]);

// A failed fork (#6 on #4) and an uploading revision (#7 on #5). The committer stops first so
// both stay queued.
committer.stop();
const forked = await add(
  pg.id,
  "macbook-air",
  "Alternative: pg_upgrade --link with logical replica fallback",
  [
    await put(
      "runbook.md",
      runbook(4).replace(
        "## Summary",
        "## Summary\n\nThis variant keeps the logical replica as the primary fallback.",
      ),
    ),
  ],
  {
    parent_revision_id: pgRevisions[3],
  },
);
await add(
  pg.id,
  "devbox",
  "Add PgBouncer pause/resume script",
  [await put("pgbouncer.sh", pgbouncer)],
  { parent_revision_id: pgRevisions[4] },
);
await queue.run(
  "UPDATE pending_revisions SET state='failed',last_error=?,error_kind='permanent',created_at=? WHERE id=?",
  ["R2 PUT blobs/sha256/9c/9c41… timed out after 5 attempts", now - 1.1 * 3_600_000, forked],
);
await queue.run("UPDATE pending_revisions SET created_at=? WHERE id<>?", [
  now - 0.05 * 3_600_000,
  forked,
]);
// The direct SQL above bypasses the queue's call sites; this makes Postgres's syncing row (RX-11)
// match its queue: #7 is pending, so Latest links show #5 with the note.
await ingest.withCollectionLock(pg.id, () => committer.refreshSyncing(pg.id));

// Purges at their real steps (OW-14), opt-in: Scratch retrying its bucket step, and an already
// erased collection waiting out the blob grace window. The committer is stopped, so they stay.
if (process.env.WAYPOINT_DEMO_PURGING === "1") {
  const scratchRow = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [scratch.id],
  );
  await queue.run(
    "INSERT INTO pending_purges (collection_id,requested_at,step,next_attempt_at,attempts,last_error,title,public_id) VALUES (?,?,0,?,3,?,?,?)",
    [
      scratch.id,
      now - 6 * 60_000,
      now + 9 * 60_000,
      `R2 DELETE manifests/${scratch.revision}.json 503 Service Unavailable`,
      "Scratch: MCP smoke run 2026-10-05",
      scratchRow?.public_id ?? null,
    ],
  );
  const erased = newId("col");
  await queue.run(
    "INSERT INTO pending_purges (collection_id,requested_at,step,next_attempt_at,attempts,last_error,title,public_id) VALUES (?,?,2,?,0,NULL,?,?)",
    [
      erased,
      now - 3 * 60_000,
      now + 12 * 60_000,
      "Incident 4411 raw logs",
      await publicIdFor(parseId(erased, "col")),
    ],
  );
  for (let i = 1; i <= 4; i++)
    await queue.run("INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?)", [
      `blobs/sha256/00/demo-purge-${i}`,
      now,
    ]);
}

serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(`Demo writer on ${base} (data ${dir})`);
if (process.env.WAYPOINT_DEMO_READER_FIXTURE === "1")
  console.log(`Reader fixture link: ${readerFixtureUrl}`);
if (process.env.WAYPOINT_DEMO_RENDITIONS_FIXTURE === "1")
  console.log(`Renditions fixture link: ${renditionsFixtureUrl}`);
