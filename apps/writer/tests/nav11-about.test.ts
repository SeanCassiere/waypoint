import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { MemoryBucket } from "../src/bucket.ts";
import { WriterCommitter } from "../src/committer.ts";
import type { Config } from "../src/config.ts";
import { openDatabases, type Db, type SyncClient } from "../src/db.ts";
import { createApp, type HttpServices } from "../src/http.ts";
import { IngestService } from "../src/ingest.ts";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../src/migrations.ts";
import { ReadModel } from "../src/read-model.ts";
import { SyncLoop } from "../src/sync-loop.ts";

// NAV-11: the About this collection card at the foot of every Files tab, and the one Collection
// details dialog that replaces Rename and Edit metadata. Setup as in NAV-04's test: an in-process
// app with sharing configured; a committer syncs the webhook collection's three revisions, so its
// one share link (a direct row) is live. The bare collection has no metadata and no links.

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;

interface Written {
  collection_id: string;
  revision_id: string;
  url: string;
}
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string): Promise<{ path: string; hash: string }> {
  const bytes = new TextEncoder().encode(content);
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  expect((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(
    200,
  );
  return { path, hash };
}
async function post(path: string, body: unknown): Promise<Written> {
  const response = await app.request(path, json(body));
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("revision_id" in value) ||
    !("url" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.revision_id !== "string" ||
    typeof value.url !== "string"
  )
    throw new Error("Invalid write result");
  return { collection_id: value.collection_id, revision_id: value.revision_id, url: value.url };
}
/** hono/jsx escapes ', " and &; assertions compare decoded text. */
const decoded = (html: string): string =>
  html.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
async function get(path: string): Promise<string> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return decoded(await response.text());
}
/** The markup from `marker` up to the next `end` (or the end of the page). */
function region(html: string, marker: string, end: string): string {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`no ${marker}`);
  const stop = html.indexOf(end, start + marker.length);
  return html.slice(start, stop === -1 ? undefined : stop);
}
/** The Files tab's panel (up to the next tab panel). */
const filesTab = (html: string) => region(html, 'id="tp-files"', 'role="tabpanel"');
const card = (html: string) => region(html, '<section class="about"', "</section>");
const details = (html: string) =>
  region(html, '<dialog class="dlg details" id="details"', "</dialog>");
const text = (markup: string) => markup.replace(/<[^>]*>/g, "");
/** The opening tag of the first element matching `marker` (a class or attribute snippet). */
function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker}`);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

let webhook: Written;
let bare: Written;
let odd: Written;
let blank: Written;
let webhookPub = "";
const docOf = (written: Written) => new URL(written.url).pathname;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-nav11-test-"));
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
  await guardEnvironment(waypoint, opened.syncClient, "dev", false);
  const blobs = new BlobStore(dir, config.maxBlobBytes);
  const reads = new ReadModel(waypoint, queue, config.baseUrl);
  const services: HttpServices = {
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  };
  // A cloud that accepts every push, as the demo writer runs.
  const cloud: SyncClient = {
    lastPullAt: Date.now(),
    verified: true,
    pull: () => Promise.resolve(false),
    push: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
  };
  const ingest = new IngestService(waypoint, queue, blobs, reads, cloud);
  const syncLoop = new SyncLoop(queue, cloud, Date.now, waypoint);
  const committer = new WriterCommitter(
    waypoint,
    queue,
    blobs,
    new MemoryBucket(),
    syncLoop,
    ingest,
  );
  ingest.committer = committer;
  app = createApp({
    ...services,
    ingest,
    committer,
    syncLoop,
    environment: "dev",
    publicBaseUrl: "https://reader.example.test",
    shareTokenKey: new Uint8Array(32).fill(42),
  });
  syncLoop.start();
  try {
    webhook = await post("/api/collections", {
      title: "Webhook idempotency research",
      metadata: {
        project: "webhooks",
        tags: ["research"],
        source_host: "devbox",
        ticket: "W-12",
      },
      files: [await upload("index.md", "# Webhooks 1")],
    });
    let parent = webhook;
    const later = await Promise.all([2, 3].map((n) => upload("index.md", `# Webhooks ${n}`)));
    for (const [i, file] of later.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
      parent = await post(`/api/collections/${webhook.collection_id}/revisions`, {
        message: `Message ${i + 2}`,
        parent_revision_id: parent.revision_id,
        files: [file],
      });
    }
    webhook = { ...webhook, url: parent.url };
    for (let i = 0; i < 200; i++) {
      committer.wake();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
      await new Promise((resolve) => setTimeout(resolve, 25));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the committer settles.
      const rows = await reads.revisions(webhook.collection_id);
      if (rows.length === 3 && rows.every((row) => row.sync_state === "synced")) break;
    }
    committer.stop();
    // One live link that follows the latest revision (FKs are off).
    await waypoint.run(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        `shl_${"1".padStart(26, "0")}`,
        "token-1",
        webhook.collection_id,
        null,
        "link",
        null,
        null,
        1,
      ],
    );
    bare = await post("/api/collections", {
      title: "Bare collection",
      files: [await upload("index.md", "# Bare")],
    });
    // Metadata the fields can't show: a number project and a tag list with a non-string entry.
    odd = await post("/api/collections", {
      title: "Odd metadata",
      metadata: { project: 42, tags: ["kept", { id: 1 }], ticket: "W-9" },
      files: [await upload("index.md", "# Odd")],
    });
    // A blank project and a blank tag beside a real one.
    blank = await post("/api/collections", {
      title: "Blank metadata",
      metadata: { project: "  ", tags: ["", "kept"] },
      files: [await upload("index.md", "# Blank")],
    });
    webhookPub = /\/c\/([^/]+)\//.exec(webhook.url)?.[1] ?? "";
  } finally {
    committer.stop();
    syncLoop.stop();
  }
}, 30_000);
afterAll(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("About this collection", () => {
  it("is the foot of the Files tab, after the legend, with the collection's values", async () => {
    const files = filesTab(await get(docOf(webhook)));
    const legend = files.indexOf('class="legend"');
    const at = files.indexOf('<section class="about" aria-labelledby="about-h">');
    expect(legend).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(legend);
    const about = card(files);
    expect(about).toContain('<h3 id="about-h">About this collection</h3>');
    expect(about).toContain('href="/?q=project%3Awebhooks"');
    expect(about).toContain('href="/?q=tag%3Aresearch"');
    expect(about).toContain('href="/?q=host%3Adevbox"');
    expect(text(about)).toContain("· 3 revisions");
    expect(about).toContain(`<code class="idv">${webhookPub}</code>`);
    const copy = tagOf(about, 'class="idcopy"');
    expect(copy).toMatch(/\shidden[\s=>]/);
    expect(copy).toContain('data-action="copy-text"');
    expect(copy).toContain(`data-text="${webhookPub}"`);
    expect(copy).toContain('data-label="collection public ID"');
    expect(copy).toContain('aria-label="Copy ID"');
    expect(text(about)).toContain(
      "Project, tags and host are what Recent's filters and project: tag: host: search use.",
    );
    expect(about).toContain("<code>project:</code> <code>tag:</code> <code>host:</code>");
    const edit = tagOf(about, 'commandfor="details"');
    expect(edit).toContain('command="show-modal"');
    expect(edit).toContain('data-focus="project"');
    expect(text(about)).toContain("Edit");
    // Tags show as plain text, no # prefix.
    expect(text(about)).not.toContain("#research");
  });

  it("is on the Changes page's Files tab too", async () => {
    const files = filesTab(await get(`${docOf(webhook).replace(/index\.md$/, "")}changes`));
    expect(files.indexOf('<section class="about"')).toBeGreaterThan(
      files.lastIndexOf('class="legend"'),
    );
    expect(card(files)).toContain("· 3 revisions");
  });

  it("shows only Started and ID without project, tags or host", async () => {
    const about = card(filesTab(await get(docOf(bare))));
    expect([...about.matchAll(/<dt>([^<]*)<\/dt>/g)].map(([, label]) => label)).toEqual([
      "Started",
      "ID",
    ]);
    expect(text(about)).toContain("· 1 revision");
    expect(about).not.toContain('class="tok');
  });

  it("leaves out a blank project or tag", async () => {
    const about = card(filesTab(await get(docOf(blank))));
    expect([...about.matchAll(/<dt>([^<]*)<\/dt>/g)].map(([, label]) => label)).toEqual([
      "Tags",
      "Started",
      "ID",
    ]);
    expect([...about.matchAll(/class="tok"[^>]*>([^<]*)</g)].map(([, tag]) => tag)).toEqual([
      "kept",
    ]);
    expect(about).not.toContain("project%3A");
  });
});

describe("Collection details", () => {
  it("replaces Rename and Edit metadata with one dialog of fields", async () => {
    const html = await get(docOf(webhook));
    expect(html).not.toContain('id="rename"');
    expect(html).not.toContain('id="metadata"');
    const dialog = details(html);
    expect(dialog).toContain('<h2 id="details-title">Collection details</h2>');
    expect(tagOf(dialog, 'name="title"')).toContain('value="Webhook idempotency research"');
    expect(tagOf(dialog, 'name="title"')).toContain("autofocus");
    const project = tagOf(dialog, 'name="project"');
    expect(project).toContain('value="webhooks"');
    expect(project).toContain('list="details-projects"');
    expect(project).toContain('aria-describedby="details-project-hint"');
    expect(dialog).toContain('<datalist id="details-projects"></datalist>');
    expect(tagOf(dialog, 'name="tags"')).toContain('value="research"');
    expect(text(dialog)).toContain("Groups collections on Recent. Search with project:webhooks.");
    expect(text(dialog)).toContain("Separate with commas. Search with tag:research.");
    expect(tagOf(dialog, "data-tag-suggest")).toMatch(/\shidden[\s=>]/);
    expect(text(dialog)).toContain("Used on other collections:");
    expect(text(region(dialog, 'class="fl ro"', "</div>"))).toMatch(/Written on\s+devbox/);
    expect(dialog).toContain("Set by the agent that created the collection.");
    // The extra JSON holds every key but the fields' and source_host.
    const extra = region(dialog, '<textarea name="extra"', "</textarea>");
    expect(extra).toContain('"ticket": "W-12"');
    expect(extra).not.toContain('"project"');
    expect(extra).not.toContain('"tags"');
    expect(extra).not.toContain('"source_host"');
    expect(text(dialog)).toContain("Other metadata (JSON) · 1 key");
    expect(tagOf(dialog, "data-json-error")).toContain('id="details-json-err"');
    const keep = tagOf(dialog, 'data-form="details"');
    expect(keep).toContain("data-keep=");
    expect(keep).toContain('"source_host":"devbox"');
    const save = tagOf(dialog, "data-details-save");
    expect(save).toContain('type="submit"');
    expect(save).toMatch(/\sdisabled[\s=>]/);
    expect(dialog).toContain(
      '<button type="button" class="btn" commandfor="details" command="close">Cancel</button>',
    );
    expect(dialog).not.toContain('formmethod="dialog"');
    expect(text(dialog)).toContain("Saving needs JavaScript, which isn't running on this page.");
    expect(tagOf(dialog, "data-nojs")).toContain('class="grow nojs"');
  });

  it("says live links will show a new title", async () => {
    const dialog = details(await get(docOf(webhook)));
    expect(dialog).toContain('class="pubnote"');
    expect(text(dialog)).toContain("Public links show the title.");
    expect(dialog).toContain("<b>1 live link</b> will show the new one.");
    expect(details(await get(docOf(bare)))).not.toContain("pubnote");
  });

  it("opens from Rename… on Title and Edit details… on Project", async () => {
    const more = region(await get(docOf(webhook)), 'id="more-menu"', "</div></div>");
    const rename = tagOf(more, 'data-focus="title"');
    expect(rename).toContain('commandfor="details"');
    expect(rename).toContain('command="show-modal"');
    expect(text(region(more, 'data-focus="title"', "</button>"))).toContain("Rename…");
    const edit = tagOf(more, 'data-focus="project"');
    expect(edit).toContain('commandfor="details"');
    expect(edit).toContain('command="show-modal"');
    expect(text(region(more, 'data-focus="project"', "</button>"))).toContain("Edit details…");
    expect(more).not.toContain("Edit metadata");
  });

  it("carries a project or tags the fields can't show through data-keep", async () => {
    const dialog = details(await get(docOf(odd)));
    expect(tagOf(dialog, 'name="project"')).toContain('value=""');
    expect(tagOf(dialog, 'name="tags"')).toContain('value=""');
    // The page is decoded, so the attribute's quotes are plain: take it up to the tag's end.
    const keep = /data-keep="(.*)">$/.exec(tagOf(dialog, 'data-form="details"'))?.[1] ?? "";
    expect(JSON.parse(keep)).toEqual({ project: 42, tags: ["kept", { id: 1 }] });
    const extra = region(dialog, '<textarea name="extra"', "</textarea>");
    expect(extra).toContain('"ticket": "W-9"');
    expect(extra).not.toContain('"project"');
    expect(text(dialog)).toContain("Other metadata (JSON) · 1 key");
  });

  it("names no blank project or tag in the hints", async () => {
    const dialog = details(await get(docOf(blank)));
    expect(text(region(dialog, 'id="details-project-hint"', "</small>")).trim()).toMatch(
      /Groups collections on Recent\.$/,
    );
    expect(text(region(dialog, 'id="details-tags-hint"', "</small>")).trim()).toMatch(
      /Separate with commas\. Search with tag:kept\.$/,
    );
  });

  it("has plain hints and an empty extra without metadata", async () => {
    const dialog = details(await get(docOf(bare)));
    expect(text(region(dialog, 'id="details-project-hint"', "</small>")).trim()).toMatch(
      /Groups collections on Recent\.$/,
    );
    expect(text(region(dialog, 'id="details-tags-hint"', "</small>")).trim()).toMatch(
      /Separate with commas\.$/,
    );
    expect(dialog).not.toContain("Written on");
    expect(region(dialog, '<textarea name="extra"', "</textarea>")).toMatch(/>\{\}$/);
    expect(text(dialog)).toContain("Other metadata (JSON) · 0 keys");
    expect(tagOf(dialog, 'data-form="details"')).toContain('data-keep="{}"');
  });
});
