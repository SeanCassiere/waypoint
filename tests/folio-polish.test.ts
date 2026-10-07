import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore } from "../apps/writer/src/blob-store.js";
import type { Config } from "../apps/writer/src/config.js";
import { openDatabases, type Db } from "../apps/writer/src/db.js";
import { createApp } from "../apps/writer/src/http.js";
import { IngestService } from "../apps/writer/src/ingest.js";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../apps/writer/src/migrations.js";
import { ReadModel } from "../apps/writer/src/read-model.js";
import { parseSearch } from "../apps/writer/src/search-query.js";
import { WaypointClient } from "../packages/mcp/src/client.js";

let dir: string;
let waypoint: Db;
let queue: Db;
let app: ReturnType<typeof createApp>;
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
async function upload(path: string, content: string | Uint8Array, mime?: string) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const hash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  await app.request(`/api/blobs/${hash}`, { method: "PUT", body: bytes });
  return { path, hash, ...(mime ? { mime } : {}) };
}
async function write(path: string, body: unknown): Promise<Record<string, string>> {
  const value: unknown = await (await app.request(path, json(body))).json();
  if (!value || typeof value !== "object") throw new Error("bad write");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
function tinyPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0]))),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(parts.flatMap((part) => [...part]));
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "waypoint-polish-"));
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
  app = createApp({
    waypoint,
    queue,
    blobs,
    reads,
    ingest: new IngestService(waypoint, queue, blobs, reads, opened.syncClient),
  });
});
afterEach(async () => {
  await waypoint.close();
  await queue.close();
  await rm(dir, { recursive: true, force: true });
});

describe("search tokens and redirects (B6)", () => {
  it("parses tokens, quoted values and free text", () => {
    expect(
      parseSearch(
        'rate project:"api team" tag:plan host:agent-1 is:shared is:unsynced is:pending in:trash',
      ),
    ).toEqual({
      text: "rate",
      project: "api team",
      tags: ["plan"],
      host: "agent-1",
      shared: true,
      unsynced: true,
      pending: true,
      trash: true,
      tokens: true,
    });
    expect(parseSearch("plain words color:red")).toMatchObject({
      text: "plain words color:red",
      tokens: false,
    });
  });
  it("filters by tokens, redirects exact IDs and URLs, and serves facets", async () => {
    const one = await write("/api/collections", {
      title: "Rate plan",
      metadata: { project: "api", tags: ["plan", "q4"], source_host: "agent-1" },
      files: [await upload("index.md", "# Rate")],
    });
    await write("/api/collections", {
      title: "Webhooks",
      metadata: { project: "webhooks", source_host: "macbook-air" },
      files: [await upload("index.md", "# Hooks")],
    });
    const search = async (q: string) => (await app.request(`/?q=${encodeURIComponent(q)}`)).text();
    expect(await search("project:api")).toContain("Rate plan");
    expect(await search("project:api")).not.toContain("Webhooks</");
    expect(await search("tag:q4 tag:plan")).toContain("Rate plan");
    expect(await search("tag:missing")).toContain("No collections match");
    expect(await search("host:macbook-air")).toContain("Webhooks");
    expect(await search("is:pending")).toContain("Rate plan");
    const pub = new URL(one.latest_url ?? "").pathname;
    const rev = new URL(one.url ?? "").pathname;
    const go = async (q: string) => {
      const response = await app.request(`/?q=${encodeURIComponent(q)}`);
      return [response.status, response.headers.get("location")];
    };
    expect(await go(one.collection_id ?? "")).toEqual([302, pub]);
    expect(await go(one.revision_id ?? "")).toEqual([302, rev]);
    expect(await go(pub.split("/")[2] ?? "")).toEqual([302, pub]);
    expect(await go(`http://localhost:7410${rev}index.md`)).toEqual([302, `${rev}index.md`]);
    await app.request(`/api/collections/${one.collection_id}`, { method: "DELETE" });
    expect(await search("in:trash")).toContain("Rate plan");
    expect(await go(one.collection_id ?? "")).toEqual([302, pub]);
    expect((await app.request(pub)).status).toBe(410);
    const facets: unknown = await (await app.request("/api/facets")).json();
    expect(facets).toMatchObject({
      projects: [{ value: "webhooks", count: 1 }],
      hosts: expect.arrayContaining([
        expect.objectContaining({ value: "macbook-air", count: 1 }),
      ]) as unknown,
    });
  });
});

describe("Connect an agent, gallery and watchers", () => {
  it("negotiates /mcp: HTML for browsers, markdown for agents and /mcp.md", async () => {
    const html = await app.request("/mcp", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const page = await html.text();
    expect(page).toContain("Connect an agent");
    expect(page).toContain("claude mcp add waypoint");
    expect(page).toContain("Machines that have published");
    const codex = await app.request("/mcp?client=codex", { headers: { accept: "text/html" } });
    expect(await codex.text()).toContain("[mcp_servers.waypoint]");
    expect((await app.request("/mcp")).headers.get("content-type")).toContain("text/markdown");
    expect(await (await app.request("/mcp.md")).text()).toContain("# Waypoint MCP");
  });
  it("renders a folder gallery with change glyphs and removed images", async () => {
    const png = tinyPng();
    const first = await write("/api/collections", {
      title: "Shots",
      head_path: "index.md",
      files: [
        await upload("index.md", "# Shots"),
        ...(await Promise.all(
          ["a", "b", "c", "d"].map((name) => upload(`shots/${name}.png`, png, "image/png")),
        )),
      ],
    });
    const second = await write(`/api/collections/${first.collection_id}/revisions`, {
      files: [await upload("shots/e.png", png, "image/png")],
      remove: ["shots/d.png"],
    });
    const pinned = new URL(second.url ?? "").pathname;
    const shell = await (await app.request(pinned)).text();
    expect(shell).toContain("View as gallery (4)");
    const gallery = await app.request(`${pinned}gallery/shots/`);
    expect(gallery.status).toBe(200);
    const html = await gallery.text();
    expect(html).toContain("4 images in #2");
    expect(html).toContain("Removed in #2");
    expect(html).toContain('id="lightbox"');
    expect((await app.request(`${pinned}gallery/nothing/`)).status).toBe(404);
  });
  it("registers long-polling agents from X-Waypoint-Client (B5)", async () => {
    const created = await write("/api/collections", {
      title: "Watched",
      files: [await upload("index.md", "# W")],
    });
    const waiting = app.request(
      `/api/collections/${created.collection_id}/revisions?after=${created.revision_id}&wait=2`,
      { headers: { "x-waypoint-client": "codex-mcp-client/agent-1" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during: unknown = await (await app.request("/api/watchers")).json();
    expect(during).toMatchObject({
      watchers: [
        {
          collection_id: created.collection_id,
          after: created.revision_id,
          client: "codex-mcp-client/agent-1",
        },
      ],
    });
    const status = await (await app.request("/status")).text();
    expect(status).toContain("codex on agent-1");
    expect(status).toContain("is waiting for a new revision of");
    await waiting;
    expect(await (await app.request("/api/watchers")).json()).toEqual({ watchers: [] });
  });
  it("the MCP server bundle sends X-Waypoint-Client", async () => {
    const seen: string[] = [];
    const client = new WaypointClient("http://writer.test", "agent-1", undefined, (input, init) => {
      seen.push(new Headers(init?.headers).get("x-waypoint-client") ?? "");
      void input;
      return Promise.resolve(new Response(JSON.stringify({ collections: [], next_cursor: null })));
    });
    client.clientName = "claude-code";
    await client.searchCollections({});
    expect(seen).toEqual(["claude-code/agent-1"]);
  });
});
