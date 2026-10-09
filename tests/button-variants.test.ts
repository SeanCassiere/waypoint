// VS-05c: the viewer's button variants, checked on the rendered pages. Revoke… and Revoke all are
// the only quiet red text actions (owner decision 9 Oct 2026) and are never buttons; danger-solid
// (the step that does it now) sits only in a dialog or an inline confirmation popover; an outlined
// danger button (asks first) ends its label with "…"; the shared confirm dialog's OK is
// danger-solid on every page before any script runs.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintRevisionId, publicIdFor } from "@waypoint/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.ts";
import { MemoryBucket } from "../apps/writer/src/bucket.ts";
import { WriterCommitter } from "../apps/writer/src/committer.ts";
import type { Config } from "../apps/writer/src/config.ts";
import { openDatabases, type Db } from "../apps/writer/src/db.ts";
import { createApp } from "../apps/writer/src/http.ts";
import { IngestService } from "../apps/writer/src/ingest.ts";
import { migrate, queueMigrations, waypointMigrations } from "../apps/writer/src/migrations.ts";
import { ReadModel } from "../apps/writer/src/read-model.ts";
import { SyncLoop } from "../apps/writer/src/sync-loop.ts";

const DAY = 86_400_000;
const CLIENT = new URL("../apps/writer/src/client/", import.meta.url);
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** One element of a rendered page: its tag, attributes, parent and text content. */
interface El {
  tag: string;
  attrs: Map<string, string>;
  parent: El | undefined;
  text: string;
}
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "");
/**
 * A small parser for the writer's own (well-formed, escaped) markup: every element with its
 * ancestors and text. Script and style bodies aren't text; SVG's self-closing tags are handled.
 */
function parse(html: string): El[] {
  const elements: El[] = [];
  const open: El[] = [];
  const token =
    /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    const [, close, rawTag, rawAttrs = "", text] = match;
    if (text !== undefined) {
      const decoded = decode(text);
      for (const el of open) el.text += decoded;
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (close) {
      const at = open.findLastIndex((el) => el.tag === tag);
      if (at >= 0) open.length = at;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const [, name = "", dq, sq, bare] of rawAttrs.matchAll(
      /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    ))
      attrs.set(name.toLowerCase(), decode(dq ?? sq ?? bare ?? ""));
    const el: El = { tag, attrs, parent: open.at(-1), text: "" };
    elements.push(el);
    if (tag === "script" || tag === "style") {
      // Raw text: skip to the closing tag.
      const end = html.indexOf(`</${tag}`, token.lastIndex);
      token.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    if (!VOID.has(tag) && !rawAttrs.trimEnd().endsWith("/")) open.push(el);
  }
  return elements;
}
const classes = (el: El) => new Set((el.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
const textOf = (el: El) => el.text.replace(/\s+/g, " ").trim();
function* ancestors(el: El): Generator<El> {
  for (let at = el.parent; at; at = at.parent) yield at;
}
/** Where an element is, for failure messages. */
const describeEl = (el: El) => `<${el.tag} class="${el.attrs.get("class") ?? ""}">${textOf(el)}`;

/** The variant rules (Spec §1); returns every violation. */
function violations(elements: El[]): string[] {
  const found: string[] = [];
  for (const el of elements) {
    const list = classes(el);
    const text = textOf(el);
    const revokeAction = text.startsWith("Revoke") && text.endsWith("…");
    // (a) The quiet red text action is Revoke… or Revoke all … only, and those are never buttons.
    if (list.has("txtbtn") && list.has("danger") && !revokeAction)
      found.push(`txtbtn danger on something other than Revoke: ${describeEl(el)}`);
    if (list.has("btn") && revokeAction) found.push(`Revoke as a button: ${describeEl(el)}`);
    // (b) danger-solid only in a dialog or an inline confirmation popover.
    if (
      list.has("danger-solid") &&
      ![...ancestors(el)].some(
        (at) =>
          at.tag === "dialog" ||
          (at.attrs.get("role") === "group" &&
            (at.attrs.get("aria-label") ?? "").startsWith("Confirm")),
      )
    )
      found.push(`danger-solid outside a confirm step: ${describeEl(el)}`);
    // (c) An outlined danger button asks first: its label ends with "…".
    if (list.has("btn") && list.has("danger") && !list.has("danger-solid") && !text.endsWith("…"))
      found.push(`outlined danger without "…": ${describeEl(el)}`);
  }
  return found;
}

let directory: string;
let waypoint: Db;
let queue: Db;
let worker: WriterCommitter;
let app: ReturnType<typeof createApp>;
let hash: string;
const shareTokenKey = new Uint8Array(32).fill(42);
const pages = new Map<string, El[]>();

async function made(title: string): Promise<{ id: string; pub: string; revision: string }> {
  const response = await app.request(
    "/api/collections",
    json({ title, files: [{ path: "index.txt", hash }] }),
  );
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("revision_id" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.revision_id !== "string"
  )
    throw new Error(`Collection failed: ${JSON.stringify(value)}`);
  await worker.drain();
  const row = await waypoint.get<{ public_id: string }>(
    "SELECT public_id FROM collections WHERE id=?",
    [value.collection_id],
  );
  if (!row) throw new Error("Commit missing");
  return { id: value.collection_id, pub: row.public_id, revision: value.revision_id };
}
async function link(collectionId: string, payload: object): Promise<void> {
  const response = await app.request(`/api/collections/${collectionId}/share-links`, json(payload));
  if (response.status !== 201) throw new Error(`Link failed: ${await response.text()}`);
}

/**
 * Shared: three live links (two that expire, so Extend… shows) and Revoke all. Failing: #2 failed
 * (Needs attention, Status, History, the status line on #2's page). Leaked: a link, then Trash
 * (Restore…, Purge…, a paused link).
 */
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "waypoint-vs05c-"));
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
  const bytes = new TextEncoder().encode("hello buttons");
  hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  if ((await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes })).status !== 200)
    throw new Error("Blob upload failed");

  const now = Date.now();
  const shared = await made("Shared");
  await link(shared.id, { label: "Sam", expires_at: now + 2 * 3_600_000 });
  await link(shared.id, {
    label: "Priya",
    revision_id: shared.revision,
    expires_at: now + 7 * DAY,
  });
  await link(shared.id, { label: "Forever" });
  const failing = await made("Failing");
  const leaked = await made("Leaked");
  await link(leaked.id, { label: "Vendor" });
  if ((await app.request(`/api/collections/${leaked.id}`, { method: "DELETE" })).status !== 200)
    throw new Error("Trash failed");
  await worker.drain();
  worker.stop();
  await worker.drain();
  // Failing #2 stays in queue.db, failed, as the committer leaves a permanent failure.
  const second = mintRevisionId({ now: Date.now(), parentId: failing.revision });
  const secondPub = await publicIdFor(second);
  await queue.run(
    "INSERT INTO pending_revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,manifest_json,created_at,state,attempts,last_error,error_kind) VALUES (?,?,?,?,?,?,?,?,?,'failed',5,?,?)",
    [
      second,
      secondPub,
      failing.id,
      failing.revision,
      "index.txt",
      "second",
      "{}",
      JSON.stringify({
        headPath: "index.txt",
        files: { "index.txt": { hash, mime: "text/plain", size: 13 } },
      }),
      Date.now(),
      "Upload failed",
      "permanent",
    ],
  );
  for (const [name, path] of [
    ["Recent", "/"],
    ["the Links tab", `/c/${shared.pub}/?panel=links`],
    ["/links", "/links"],
    ["/trash", "/trash"],
    ["/status", "/status"],
    ["History", `/c/${failing.pub}/?panel=history`],
    ["Failing #2", `/c/${failing.pub}/r/${secondPub}/`],
  ] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One app, one page at a time.
    const response = await app.request(path);
    if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- One app, one page at a time.
    pages.set(name, parse(await response.text()));
  }
});
afterAll(async () => {
  worker.stop();
  await worker.drain();
  await waypoint.close();
  await queue.close();
  await rm(directory, { recursive: true, force: true });
});

const page = (name: string): El[] => {
  const elements = pages.get(name);
  if (!elements) throw new Error(`${name} wasn't rendered`);
  return elements;
};
const withClasses = (elements: El[], ...names: string[]) =>
  elements.filter((el) => {
    const list = classes(el);
    return names.every((name) => list.has(name));
  });

describe("VS-05c button variants", () => {
  it("holds the variant rules on every rendered page", () => {
    const found = [...pages].map(([name, elements]) => ({
      name,
      violations: violations(elements),
    }));
    expect(found).toEqual([...pages.keys()].map((name) => ({ name, violations: [] })));
  });

  it("renders the pages' destructive controls (the rules aren't vacuous)", () => {
    // Outlined danger that asks first: Drop… (History, Status), Purge… (Trash).
    const outlined = (name: string) =>
      withClasses(page(name), "btn", "danger").filter((el) => !classes(el).has("danger-solid"));
    expect(outlined("History").map(textOf)).toContain("Drop…");
    expect(outlined("/status").map(textOf)).toContain("Drop #2…");
    expect(outlined("/trash").map(textOf)).toContain("Purge…");
    // The status line on the failed revision's page.
    expect(
      outlined("Failing #2")
        .filter((el) => el.attrs.get("data-action") === "drop")
        .map(textOf),
    ).toContain("Drop…");
    // The Links tab card's popover confirm is danger-solid, inside "Confirm revoke".
    const confirm = withClasses(page("the Links tab"), "btn", "sm", "danger-solid");
    expect(confirm.map(textOf)).toContain("Revoke link");
  });

  it("keeps Revoke… and Revoke all as quiet red text on the Links tab and /links", () => {
    for (const name of ["the Links tab", "/links"]) {
      const quiet = withClasses(page(name), "txtbtn", "danger").map(textOf);
      expect({ name, revoke: quiet.includes("Revoke…") }).toEqual({ name, revoke: true });
      expect({ name, all: quiet.some((text) => text.startsWith("Revoke all")) }).toEqual({
        name,
        all: true,
      });
    }
    expect(
      withClasses(page("the Links tab"), "txtbtn", "danger").some((el) => el.tag === "summary"),
    ).toBe(true);
  });

  it("renders the shared confirm dialog's OK as danger-solid on every page", () => {
    for (const [name, elements] of pages) {
      const ok = elements.filter(
        (el) =>
          el.attrs.has("data-confirm-ok") &&
          [...ancestors(el)].some((at) => at.attrs.get("id") === "confirm"),
      );
      expect({ name, classes: ok.map((el) => el.attrs.get("class")) }).toEqual({
        name,
        classes: ["btn danger-solid"],
      });
    }
  });

  it("never sets txtbtn danger from client script", async () => {
    const files = (await readdir(CLIENT)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A handful of small files.
      const source = await readFile(new URL(file, CLIENT), "utf8");
      const literal = /(["'`])[^"'`\n]*txtbtn danger[^"'`\n]*\1/.exec(source)?.[0] ?? null;
      expect({ file, literal }).toEqual({ file, literal: null });
    }
  });

  it("parses nesting, text and attributes the way the rules need", () => {
    const elements = parse(
      '<!doctype html><dialog id="d"><div role="group" aria-label="Confirm x"><button class="btn danger-solid">Go <svg><path d="M0 0"/></svg>&amp; on</button></div></dialog><script>if (a<b) "<p>"</script><button class="btn danger">Drop</button>',
    );
    const [solid, outline] = withClasses(elements, "btn");
    expect(solid && textOf(solid)).toBe("Go & on");
    expect(solid && [...ancestors(solid)].map((at) => at.tag)).toEqual(["div", "dialog"]);
    expect(violations(elements)).toEqual([
      `outlined danger without "…": ${outline && describeEl(outline)}`,
    ]);
  });
});
