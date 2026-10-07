import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { newId } from "@waypoint/core";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { BlobStore } from "../../../apps/writer/src/blob-store.js";
import type { Config } from "../../../apps/writer/src/config.js";
import { openDatabases } from "../../../apps/writer/src/db.js";
import { createApp } from "../../../apps/writer/src/http.js";
import { IngestService } from "../../../apps/writer/src/ingest.js";
import {
  guardEnvironment,
  migrate,
  queueMigrations,
  waypointMigrations,
} from "../../../apps/writer/src/migrations.js";
import { ReadModel } from "../../../apps/writer/src/read-model.js";
import { writerRenderer } from "../../../apps/writer/src/renderer.js";
import { WaypointClient } from "../src/client.js";
import { createServer } from "../src/index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function writer(maxBlobBytes = 1024 * 1024) {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-mcp-real-"));
  const config: Config = {
    environment: "dev",
    dataDir: dir,
    baseUrl: "http://localhost:7410",
    port: 7410,
    queueGiveUpHours: 72,
    maxBlobBytes,
    sync: false,
  };
  const opened = await openDatabases(config);
  await migrate(opened.waypoint, waypointMigrations);
  await migrate(opened.queue, queueMigrations);
  await guardEnvironment(opened.waypoint, opened.syncClient, "dev", false);
  const blobs = new BlobStore(dir, maxBlobBytes);
  const reads = new ReadModel(opened.waypoint, opened.queue, config.baseUrl);
  const ingest = new IngestService(
    opened.waypoint,
    opened.queue,
    blobs,
    reads,
    opened.syncClient,
    undefined,
    writerRenderer,
  );
  const services = { waypoint: opened.waypoint, queue: opened.queue, blobs, reads, ingest };
  const app = createApp(services);
  const fetcher: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const waypoint = new WaypointClient(config.baseUrl, "test-host", undefined, fetcher);
  closers.push(async () => {
    await opened.waypoint.close();
    await opened.queue.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, waypoint, reads, queue: opened.queue, dir, fetcher, services };
}

it("uses real read shapes for merge, unchanged, source markdown, binary URLs, resolve, and status", async () => {
  const { waypoint, reads, dir } = await writer();
  const binaryPath = join(dir, "image.png");
  await writeFile(binaryPath, new Uint8Array([0, 1, 2, 3]));
  const created = await waypoint.create({
    title: "Real writer",
    files: [
      { path: "index.md", content: "# Heading" },
      { path: "old.txt", content: "old" },
      { path: "image.png", source_path: binaryPath },
    ],
  });
  expect(created).toMatchObject({ unchanged: false });
  const first = await waypoint.getCollection(created.collection_id);
  expect(first.revision?.files.map((file) => file.path)).toEqual([
    "image.png",
    "index.md",
    "old.txt",
  ]);
  expect(first.revision?.metadata.source_host).toBe("test-host");
  const added = await waypoint.add({
    collection_id: created.collection_id,
    files: [{ path: "new.txt", content: "new" }],
    remove: ["old.txt"],
  });
  expect(added).toMatchObject({ unchanged: false });
  const detail = await waypoint.getCollection(created.collection_id);
  expect(detail.revision?.files.map((file) => file.path)).toEqual([
    "image.png",
    "index.md",
    "new.txt",
  ]);
  const unchanged = await waypoint.add({ collection_id: created.collection_id });
  expect(unchanged).toMatchObject({ unchanged: true, revision_id: added.revision_id });
  const text = z
    .object({ content: z.string(), url: z.string() })
    .parse(await waypoint.readFile(created.collection_id, "index.md"));
  expect(text.content).toBe("# Heading");
  expect(text.url).toContain("/raw/r/");
  const binary = z
    .object({ mime: z.string(), url: z.string() })
    .parse(await waypoint.readFile(created.collection_id, "image.png"));
  expect(binary.mime).toBe("image/png");
  expect(binary.url).toBe(detail.revision?.files.find((file) => file.path === "image.png")?.url);
  const rendition = await waypoint.fetcher(binary.url.replace("image.png", "index.md"));
  expect(await rendition.text()).toContain("<html");
  expect(
    await waypoint.resolve(z.object({ latest_url: z.string() }).parse(created).latest_url),
  ).toMatchObject({
    collection_id: created.collection_id,
  });
  expect(await waypoint.status()).toMatchObject({ queue: { pending_collections: 1 } });
  expect((await reads.searchCollections()).collections).toHaveLength(1);
});

it("hands off a collection through MCP search, URL reading, and revision waiting", async () => {
  const { waypoint, fetcher } = await writer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(waypoint);
  const mcp = new Client({ name: "handoff", version: "1" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  closers.push(async () => {
    await mcp.close();
    await server.close();
  });
  const created = await waypoint.create({
    title: "Handoff plan",
    metadata: { project: "agent-test", tags: ["research"] },
    files: [{ path: "index.md", content: "# Plan" }],
  });
  const found = await mcp.callTool({
    name: "search_collections",
    arguments: { query: "research" },
  });
  expect(found.isError).toBeFalsy();
  expect(found.structuredContent).toMatchObject({
    collections: [
      {
        id: created.collection_id,
        match: "metadata",
        latest_revision: { display_number: 1, head_path: "index.md", file_count: 1 },
      },
    ],
  });
  // Compact for agents: one line, without the viewer's queue, share and change-count detail.
  const text = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(found.content)[0]!.text;
  expect(text).not.toContain("\n");
  for (const key of ['"queue"', '"share"', '"changes"']) expect(text).not.toContain(key);
  const latestUrl = z.object({ latest_url: z.string() }).parse(created).latest_url;
  const read = await mcp.callTool({
    name: "get_collection",
    arguments: { collection: latestUrl, include_head: true },
  });
  expect(read.structuredContent).toMatchObject({
    id: created.collection_id,
    head: { text: "# Plan" },
  });
  expect(
    (await mcp.callTool({ name: "list_revisions", arguments: { collection: latestUrl } }))
      .structuredContent,
  ).toMatchObject({ revisions: [{ id: created.revision_id }] });
  expect(
    (
      await mcp.callTool({
        name: "read_file",
        arguments: { collection: latestUrl, path: "index.md" },
      })
    ).structuredContent,
  ).toMatchObject({ content: "# Plan" });
  expect(
    (await mcp.callTool({ name: "search_collections", arguments: { updated_after: "2026-10-07" } }))
      .isError,
  ).toBeFalsy();
  const waiting = mcp.callTool({
    name: "wait_for_revision",
    arguments: {
      collection: latestUrl,
      after_revision_id: created.revision_id,
      timeout_seconds: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const other = new WaypointClient(waypoint.base, "second-agent", undefined, fetcher);
  const added = await other.add({
    collection_id: created.collection_id,
    files: [{ path: "results.md", content: "Done" }],
  });
  expect((await waiting).structuredContent).toMatchObject({
    changed: true,
    revisions: [{ id: added.revision_id }],
  });
  expect(
    (
      await mcp.callTool({
        name: "add_revision",
        arguments: {
          collection: latestUrl,
          files: [{ path: "followup.md", content: "Follow-up" }],
        },
      })
    ).isError,
  ).toBeFalsy();
});

it("reads an older revision's head through get_collection", async () => {
  const { waypoint } = await writer();
  const first = await waypoint.create({
    title: "Versions",
    files: [{ path: "index.md", content: "VERSION ONE" }],
  });
  const second = await waypoint.add({
    collection_id: first.collection_id,
    files: [{ path: "index.md", content: "VERSION TWO" }],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(waypoint);
  const mcp = new Client({ name: "versions", version: "1" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  closers.push(async () => {
    await mcp.close();
    await server.close();
  });
  const url = z.object({ latest_url: z.string() }).parse(first).latest_url;
  const result = await mcp.callTool({
    name: "get_collection",
    arguments: { collection: url, revision_id: first.revision_id, include_head: true },
  });
  expect(result.structuredContent).toMatchObject({
    revision: { id: first.revision_id },
    latest_revision: { id: second.revision_id },
    head: { text: "VERSION ONE" },
  });
});

it("retries an over-cap revision wait within its request budget", async () => {
  const { waypoint, fetcher } = await writer();
  const first = await waypoint.create({
    title: "Retry wait",
    files: [{ path: "index.txt", content: "one" }],
  });
  const second = await waypoint.add({
    collection_id: first.collection_id,
    files: [{ path: "index.txt", content: "two" }],
  });
  let calls = 0;
  const retryingFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/revisions?after=")) {
      calls++;
      if (calls === 1)
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "unavailable", message: "busy" } }), {
            status: 503,
            headers: { "retry-after": "0" },
          }),
        );
    }
    return fetcher(input, init);
  };
  const reader = new WaypointClient(waypoint.base, "retrying", undefined, retryingFetch);
  expect(await reader.waitForRevision(first.collection_id, first.revision_id, 1)).toMatchObject({
    changed: true,
    revisions: [{ id: second.revision_id }],
  });
  expect(calls).toBe(2);
});

it("reuses minted IDs when an agent repeats the same MCP call", async () => {
  const { waypoint, reads } = await writer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(waypoint);
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const listedTools = (await client.listTools()).tools;
  expect(listedTools.map((tool) => tool.name)).toEqual([
    "create_collection",
    "add_revision",
    "get_collection",
    "search_collections",
    "wait_for_revision",
    "list_revisions",
    "read_file",
    "resolve_url",
    "waypoint_status",
  ]);
  for (const tool of listedTools) {
    const schema = z
      .object({ properties: z.record(z.string(), z.object({ description: z.string() })) })
      .parse(tool.inputSchema);
    expect(Object.values(schema.properties).every((field) => field.description.length > 0)).toBe(
      true,
    );
  }
  const writeSchema = JSON.stringify(
    listedTools.find((tool) => tool.name === "create_collection")?.inputSchema,
  );
  expect(writeSchema).toContain("Absolute path to a local file");
  expect(writeSchema).toContain("Inline UTF-8 text, at most 1 MB");
  expect(writeSchema).toContain("slash-less patterns match basenames");
  const args = {
    title: "Repeat",
    head_path: "index.txt",
    files: [
      { path: "index.txt", content: "same" },
      { path: "other.txt", content: "other" },
    ],
  };
  const first = await client.callTool({ name: "create_collection", arguments: args });
  const second = await client.callTool({
    name: "create_collection",
    arguments: { ...args, files: args.files.toReversed() },
  });
  expect(first.isError).toBeFalsy();
  expect(second.isError).toBeFalsy();
  const result = z
    .object({ collection_id: z.string(), revision_id: z.string() })
    .parse(first.structuredContent);
  expect(second.structuredContent).toMatchObject(result);
  expect((await reads.searchCollections()).collections).toHaveLength(1);
  const addArgs = {
    collection_id: result.collection_id,
    files: [{ path: "next.txt", content: "next" }],
  };
  const [added, repeated] = await Promise.all([
    client.callTool({ name: "add_revision", arguments: addArgs }),
    client.callTool({ name: "add_revision", arguments: addArgs }),
  ]);
  expect(repeated.structuredContent).toMatchObject(
    z.object({ revision_id: z.string() }).parse(added.structuredContent),
  );
  expect(await reads.revisions(result.collection_id)).toHaveLength(2);
});

it("creates a new revision when a repeated request would revert a newer revision", async () => {
  const { waypoint, reads } = await writer();
  const created = await waypoint.create({
    title: "Revert",
    files: [{ path: "index.txt", content: "initial" }],
  });
  const firstInput = {
    collection_id: created.collection_id,
    files: [{ path: "index.txt", content: "v1" }],
  };
  const first = await waypoint.add(firstInput);
  const second = await waypoint.add({
    collection_id: created.collection_id,
    files: [{ path: "index.txt", content: "v2" }],
  });
  const reverted = await waypoint.add(firstInput);
  expect(reverted.revision_id).not.toBe(first.revision_id);
  expect(reverted.revision_id).not.toBe(second.revision_id);
  expect((await waypoint.getCollection(created.collection_id)).latest_revision?.id).toBe(
    reverted.revision_id,
  );
  expect(await reads.revisions(created.collection_id)).toHaveLength(4);
});

it("drops a rejected write's cached ID before an undelete and intervening revision", async () => {
  const { waypoint, app } = await writer();
  const created = await waypoint.create({
    title: "Undelete",
    files: [{ path: "index.txt", content: "initial" }],
  });
  expect(
    (await app.request(`/api/collections/${created.collection_id}`, { method: "DELETE" })).status,
  ).toBe(200);
  const input = {
    collection_id: created.collection_id,
    files: [{ path: "agent.txt", content: "agent" }],
  };
  await expect(waypoint.add(input)).rejects.toMatchObject({
    code: "collection_deleted",
    status: 410,
  });
  expect(
    (await app.request(`/api/collections/${created.collection_id}/undelete`, { method: "POST" }))
      .status,
  ).toBe(200);
  await waypoint.add({
    collection_id: created.collection_id,
    files: [{ path: "other.txt", content: "other" }],
  });
  const added = await waypoint.add(input);
  const latest = await waypoint.getCollection(created.collection_id);
  expect(latest.latest_revision?.id).toBe(added.revision_id);
  expect(latest.revision?.files.map((file) => file.path)).toEqual([
    "agent.txt",
    "index.txt",
    "other.txt",
  ]);
});

it("surfaces real writer errors and rejects a revision from another collection", async () => {
  const { waypoint, app, queue } = await writer();
  await expect(waypoint.getCollection(newId("col"))).rejects.toMatchObject({
    code: "collection_not_found",
    status: 404,
  });
  const first = await waypoint.create({
    title: "One",
    files: [{ path: "index.txt", content: "a" }],
  });
  const second = await waypoint.create({
    title: "Two",
    files: [{ path: "index.txt", content: "b" }],
  });
  await expect(
    waypoint.getCollection(first.collection_id, second.revision_id),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    waypoint.readFile(first.collection_id, "index.txt", second.revision_id),
  ).rejects.toMatchObject({ code: "not_found" });
  const deleted = await app.request(`/api/collections/${first.collection_id}`, {
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  await expect(
    waypoint.add({
      collection_id: first.collection_id,
      files: [{ path: "more.txt", content: "x" }],
    }),
  ).rejects.toMatchObject({ code: "collection_deleted", status: 410 });
  await queue.run("UPDATE pending_revisions SET state='failed' WHERE id=?", [second.revision_id]);
  await expect(
    waypoint.add({
      collection_id: second.collection_id,
      parent_revision_id: second.revision_id,
      files: [{ path: "more.txt", content: "x" }],
    }),
  ).rejects.toMatchObject({ code: "parent_failed", status: 422 });
});

it("serves the MCP snippet and tarball with a strong ETag", async () => {
  const { app, services } = await writer();
  const help = await app.request("/mcp");
  expect(help.status).toBe(200);
  const helpText = await help.text();
  const missing = createApp({
    ...services,
    mcpTarballPath: "/tmp/waypoint-mcp-no-such-file.tgz",
  });
  expect((await missing.request("/mcp/waypoint-mcp.tgz")).status).toBe(404);
  const tarball = "packages/mcp/dist/waypoint-mcp.tgz";
  if (!existsSync(tarball)) return;
  const response = await app.request("/mcp/waypoint-mcp.tgz");
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toMatch(/^"sha256-[a-f0-9]{64}"$/);
  const version = response.headers.get("etag")?.slice(8, 20);
  expect(helpText).toContain(`/mcp/waypoint-mcp.tgz`);
  expect(helpText).not.toContain(`/mcp/waypoint-mcp-${version}.tgz`);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const immutable = await app.request(`/mcp/waypoint-mcp-${version}.tgz`);
  expect(immutable.status).toBe(200);
  expect(immutable.headers.get("cache-control")).toBe("no-cache");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(tarball));
  expect(
    (
      await app.request("/mcp/waypoint-mcp.tgz", {
        headers: { "if-none-match": `"other", W/${response.headers.get("etag") ?? ""}` },
      })
    ).status,
  ).toBe(304);
});

it("retries transient write failures with the same IDs, including a lost committed response", async () => {
  const { app, reads } = await writer();
  const ids: string[] = [];
  let failNetwork = true;
  let loseCommitted = true;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/api/collections" && init?.method === "POST") {
      if (typeof init.body !== "string") throw new Error("Expected JSON body");
      const body = z
        .object({ collection_id: z.string(), revision_id: z.string() })
        .parse(JSON.parse(init.body));
      ids.push(`${body.collection_id}/${body.revision_id}`);
      if (failNetwork) {
        failNetwork = false;
        throw new Error("socket closed");
      }
      if (loseCommitted) {
        loseCommitted = false;
        await app.fetch(new Request(input, init));
        throw new Error("response lost");
      }
    }
    return app.fetch(new Request(input, init));
  };
  const client = new WaypointClient("http://localhost:7410", "test-host", undefined, fetcher, 3000);
  const result = await client.create({
    title: "Retry",
    files: [{ path: "index.txt", content: "safe" }],
  });
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(1);
  expect((await reads.searchCollections()).collections).toHaveLength(1);
  expect((await client.getCollection(result.collection_id)).revision?.id).toBe(result.revision_id);
});

it("honours 429 Retry-After and retries each PUT with a fresh stream", async () => {
  const { app, dir } = await writer();
  const sourcePath = join(dir, "upload.bin");
  await writeFile(sourcePath, new Uint8Array([0, 1, 2, 3, 4]));
  let checks = 0;
  let puts = 0;
  const putBodies: Uint8Array[] = [];
  const times: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/api/blobs/check") {
      times.push(Date.now());
      if (checks++ === 0)
        return new Response("slow", { status: 429, headers: { "retry-after": "0.05" } });
    }
    if (url.pathname.startsWith("/api/blobs/") && init?.method === "PUT") {
      puts++;
      if (puts === 1) {
        putBodies.push(new Uint8Array(await new Request(input, init).arrayBuffer()));
        return new Response("temporary", { status: 503 });
      }
      const request = new Request(input, init);
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      putBodies.push(bytes);
      return app.fetch(request);
    }
    return app.fetch(new Request(input, init));
  };
  const client = new WaypointClient("http://localhost:7410", "test-host", undefined, fetcher, 3000);
  await client.create({
    title: "Stream",
    files: [{ path: "index.bin", source_path: sourcePath, mime: "application/octet-stream" }],
  });
  expect(times).toHaveLength(2);
  expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30);
  expect(putBodies).toEqual([new Uint8Array([0, 1, 2, 3, 4]), new Uint8Array([0, 1, 2, 3, 4])]);
});

it("exhausts network retries with minted IDs and never retries ordinary 4xx", async () => {
  let calls = 0;
  const network: typeof fetch = () => {
    calls++;
    return Promise.reject(new Error("offline"));
  };
  const client = new WaypointClient("http://localhost:7410", "test-host", undefined, network, 10);
  await expect(
    client.create({ title: "Offline", files: [{ path: "index.txt", content: "x" }] }),
  ).rejects.toThrow(/collection_id=col_.*revision_id=rev_/);
  expect(calls).toBeGreaterThanOrEqual(1);
  for (const body of ["plain error", '{"error":"bad"}']) {
    let count = 0;
    const bad: typeof fetch = () => {
      count++;
      return Promise.resolve(new Response(body, { status: 400 }));
    };
    const reader = new WaypointClient("http://localhost:7410", "test-host", undefined, bad, 100);
    await expect(reader.status()).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(count).toBe(1);
  }
});

it("re-mints only for ID rejection codes and keeps a committed result when the response drifts", async () => {
  const { app, reads } = await writer();
  const seen: string[] = [];
  let rejectCode: string | undefined = "clock_skew";
  let addReject = true;
  let drift = false;
  let extra = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const write =
      init?.method === "POST" &&
      (url.pathname === "/api/collections" || url.pathname.endsWith("/revisions"));
    if (write && typeof init.body === "string") {
      const body = z.object({ revision_id: z.string() }).parse(JSON.parse(init.body));
      seen.push(body.revision_id);
      if (url.pathname === "/api/collections" && rejectCode) {
        const code = rejectCode;
        rejectCode = undefined;
        return new Response(JSON.stringify({ error: { code, message: code, details: {} } }), {
          status: 400,
        });
      }
      if (url.pathname.endsWith("/revisions") && addReject) {
        addReject = false;
        return new Response(
          JSON.stringify({
            error: {
              code: "id_before_parent",
              message: "before parent",
              details: { parent_timestamp: Date.now() + 1000 },
            },
          }),
          { status: 400 },
        );
      }
      const response = await app.fetch(new Request(input, init));
      if (drift) {
        drift = false;
        return new Response(JSON.stringify({ surprise: "new shape" }), { status: 200 });
      }
      if (extra) {
        extra = false;
        return new Response(
          JSON.stringify({
            ...z.record(z.string(), z.unknown()).parse(await response.json()),
            future: "kept",
          }),
          { status: 200 },
        );
      }
      return response;
    }
    return app.fetch(new Request(input, init));
  };
  const client = new WaypointClient("http://localhost:7410", "test-host", undefined, fetcher);
  const first = await client.create({ title: "IDs", files: [{ path: "index.txt", content: "a" }] });
  expect(seen[0]).not.toBe(seen[1]);
  const second = await client.add({
    collection_id: first.collection_id,
    files: [{ path: "b.txt", content: "b" }],
  });
  expect(seen[2]).not.toBe(seen[3]);
  drift = true;
  const changed = await client.add({
    collection_id: first.collection_id,
    files: [{ path: "c.txt", content: "c" }],
  });
  expect(
    z
      .object({ warning: z.string(), raw_response: z.object({ surprise: z.string() }) })
      .parse(changed),
  ).toMatchObject({ raw_response: { surprise: "new shape" } });
  expect(await reads.revisions(first.collection_id)).toHaveLength(3);
  extra = true;
  const withExtra = await client.add({
    collection_id: first.collection_id,
    files: [{ path: "d.txt", content: "d" }],
  });
  expect(withExtra).toMatchObject({ future: "kept" });
  expect(second.revision_id).toBeTruthy();
});

it("returns truncated UTF-8 text on a complete character boundary", async () => {
  const { waypoint } = await writer();
  const content = "a".repeat(256 * 1024 - 1) + "😀z";
  const created = await waypoint.create({ title: "Long", files: [{ path: "index.txt", content }] });
  const result = z
    .object({ content: z.string(), truncated: z.boolean() })
    .parse(await waypoint.readFile(created.collection_id, "index.txt"));
  expect(result.truncated).toBe(true);
  expect(result.content).toBe("a".repeat(256 * 1024 - 1));
  expect(result.content).not.toContain("�");
});

it("surfaces real 409 and 413 write errors", async () => {
  const { app, waypoint } = await writer();
  const first = await waypoint.create({
    title: "Original",
    files: [{ path: "index.txt", content: "a" }],
  });
  const conflictedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.pathname === "/api/collections" &&
      init?.method === "POST" &&
      typeof init.body === "string"
    ) {
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
      return app.fetch(
        new Request(input, {
          ...init,
          body: JSON.stringify({ ...body, revision_id: first.revision_id }),
        }),
      );
    }
    return app.fetch(new Request(input, init));
  };
  const conflict = new WaypointClient(
    "http://localhost:7410",
    "test-host",
    undefined,
    conflictedFetch,
  );
  await expect(
    conflict.create({ title: "Conflict", files: [{ path: "index.txt", content: "b" }] }),
  ).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
  const limited = await writer(2);
  await expect(
    limited.waypoint.create({ title: "Large", files: [{ path: "index.txt", content: "abc" }] }),
  ).rejects.toMatchObject({ code: "blob_too_large", status: 413 });
});

it("keeps a URL base path and rejects unsafe base URLs", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = (input) => {
    paths.push(new URL(input instanceof Request ? input.url : input).pathname);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          environment: "dev",
          queue: {
            pending_collections: 0,
            pending_revisions: 0,
            failed_revisions: 0,
            pending_blobs: 0,
            pending_renditions: 0,
            pending_snapshots: 0,
            pending_r2_deletes: 0,
            pending_purges: 0,
            unpushed: 0,
          },
          oldest_pending_age_ms: null,
          failed_items: [],
          pending_items: [],
          sync_enabled: false,
          queue_errors: [],
          last_upload_at: null,
          last_push_at: null,
          last_pull_at: null,
          last_error: null,
          sync_verified: false,
          sync_blocked: false,
          account_paused: false,
          account_error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  await new WaypointClient("https://example.test/waypoint", "host", undefined, fetcher).status();
  expect(paths).toEqual(["/waypoint/api/status"]);
  for (const base of [
    "https://user:pass@example.test",
    "https://example.test/?q=x",
    "https://example.test/#fragment",
  ])
    expect(() => new WaypointClient(base, "host")).toThrow(
      "Writer base URL must not contain credentials, query, or fragment",
    );
});

it("honours user source_host metadata and aborts before filesystem work", async () => {
  const { waypoint } = await writer();
  const created = await waypoint.create({
    title: "Host",
    metadata: { source_host: "chosen" },
    files: [{ path: "index.txt", content: "x" }],
  });
  expect((await waypoint.getCollection(created.collection_id)).revision?.metadata.source_host).toBe(
    "chosen",
  );
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(
    waypoint.create(
      { title: "Cancelled", files: [{ path: "index.txt", content: "x" }] },
      abort.signal,
    ),
  ).rejects.toThrow("cancelled");
});

it("re-mints on stale_id and retries 408 but keeps other 400 IDs unchanged", async () => {
  const { app } = await writer();
  const seen: string[] = [];
  let code: string | undefined = "stale_id";
  let timeoutOnce = true;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/api/blobs/check" && timeoutOnce) {
      timeoutOnce = false;
      return new Response("timeout", { status: 408 });
    }
    if (
      url.pathname === "/api/collections" &&
      init?.method === "POST" &&
      typeof init.body === "string"
    ) {
      const body = z.object({ revision_id: z.string() }).parse(JSON.parse(init.body));
      seen.push(body.revision_id);
      if (code) {
        const rejected = code;
        code = undefined;
        return new Response(
          JSON.stringify({ error: { code: rejected, message: rejected, details: {} } }),
          { status: 400 },
        );
      }
    }
    return app.fetch(new Request(input, init));
  };
  const client = new WaypointClient("http://localhost:7410", "test-host", undefined, fetcher);
  await client.create({ title: "Stale", files: [{ path: "index.txt", content: "x" }] });
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
  code = "validation_failed";
  const before = seen.length;
  await expect(
    client.create({ title: "Invalid", files: [{ path: "index.txt", content: "y" }] }),
  ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  expect(seen).toHaveLength(before + 1);
});

it("times out an individual HTTP request and preserves the retry budget", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
        once: true,
      });
    });
  const client = new WaypointClient(
    "http://localhost:7410",
    "test-host",
    undefined,
    fetcher,
    25,
    5,
  );
  await expect(client.status()).rejects.toThrow("request timed out");
  expect(calls).toBeGreaterThanOrEqual(1);
});

it("serves stable MCP artifacts, legacy URLs, version and skill", async () => {
  const { services, dir } = await writer();
  const mcpServerPath = join(dir, "server.mjs");
  const mcpTarballPath = join(dir, "launcher.tgz");
  const mcpLauncherPath = join(dir, "launcher.mjs");
  const mcpSkillPath = join(dir, "SKILL.md");
  await Promise.all([
    writeFile(mcpServerPath, "export const LAUNCHER_API = 1;"),
    writeFile(mcpTarballPath, "launcher"),
    writeFile(mcpLauncherPath, "launcher code"),
    writeFile(mcpSkillPath, "# Waypoint skill"),
  ]);
  const app = createApp({
    ...services,
    mcpServerPath,
    mcpTarballPath,
    mcpLauncherPath,
    mcpSkillPath,
  });
  const server = await app.request("/mcp/server.mjs");
  expect(server.status).toBe(200);
  expect(server.headers.get("content-type")).toContain("text/javascript");
  expect(server.headers.get("cache-control")).toBe("no-cache");
  const serverSha = server.headers.get("x-waypoint-content-sha256");
  expect(serverSha).toMatch(/^[a-f0-9]{64}$/);
  expect(server.headers.get("etag")).toBe(`"sha256-${serverSha}"`);
  expect(
    (
      await app.request("/mcp/server.mjs", {
        headers: { "if-none-match": server.headers.get("etag") ?? "" },
      })
    ).status,
  ).toBe(304);
  const stable = await app.request("/mcp/waypoint-mcp.tgz");
  const legacy = await app.request("/mcp/waypoint-mcp-deadbeef1234.tgz");
  expect(stable.status).toBe(200);
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("cache-control")).toBe("no-cache");
  expect(
    (
      await app.request("/mcp/waypoint-mcp-deadbeef1234.tgz", {
        headers: { "if-none-match": stable.headers.get("etag") ?? "" },
      })
    ).status,
  ).toBe(200);
  expect(await legacy.text()).toBe(await stable.text());
  expect((await app.request("/mcp/waypoint-mcp-bad.tgz")).status).toBe(404);
  expect(await (await app.request("/mcp/version")).json()).toEqual({
    server_sha256: serverSha,
    package_sha256: stable.headers.get("etag")?.slice(8, -1),
    launcher_sha256: createHash("sha256").update("launcher code").digest("hex"),
    launcher_api: 1,
  });
  expect(await (await app.request("/mcp/skill/SKILL.md")).text()).toBe("# Waypoint skill");
  const help = await (await app.request("/mcp")).text();
  expect(help).toContain("claude mcp add waypoint");
  expect(help.match(/--prefer-offline/g)).toHaveLength(3);
  expect(help).toContain("~/.codex/skills/waypoint/SKILL.md");
  expect(help).toContain("~/.claude/skills/waypoint/SKILL.md");
  expect(help).toContain("WAYPOINT_MCP_PIN=embedded");
  expect(help).toContain("/mcp/waypoint-mcp.tgz");
  expect(help).not.toMatch(/waypoint-mcp-[a-f0-9]{12}\.tgz/);
  const missing = createApp({ ...services, mcpSkillPath: join(dir, "missing.md") });
  expect((await missing.request("/mcp/skill/SKILL.md")).status).toBe(404);
});

it("reports the running and latest MCP bundle through waypoint_status", async () => {
  const { waypoint, services, dir } = await writer();
  const mcpServerPath = join(dir, "server.mjs");
  const mcpTarballPath = join(dir, "launcher.tgz");
  const mcpLauncherPath = join(dir, "launcher.mjs");
  await writeFile(mcpServerPath, "current server");
  await writeFile(mcpTarballPath, "launcher");
  await writeFile(mcpLauncherPath, "launcher code");
  const app = createApp({ ...services, mcpServerPath, mcpTarballPath, mcpLauncherPath });
  const fetcher: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const clientApi = new WaypointClient(waypoint.base, "test", undefined, fetcher);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(clientApi, {
    version: 1,
    bundleSha256: "a".repeat(64),
    source: "cache",
  });
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: "waypoint_status" });
  const statusMcp = z.object({ mcp: z.unknown() }).parse(result.structuredContent).mcp;
  const version = z
    .object({ server_sha256: z.string() })
    .parse(await (await app.request("/mcp/version")).json());
  expect(statusMcp).toEqual({
    running_sha256: "a".repeat(64),
    source: "cache",
    latest_sha256: version.server_sha256,
    update_available: true,
  });
});

it.skipIf(
  !existsSync("packages/mcp/dist/launcher.mjs") ||
    !existsSync("packages/mcp/dist/waypoint-mcp-server.mjs"),
)("launches against the real writer and reports MCP update state over stdio", async () => {
  const { app, dir } = await writer();
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing writer port");
  const child = spawn("node", ["packages/mcp/dist/launcher.mjs"], {
    env: {
      ...process.env,
      WAYPOINT_URL: `http://127.0.0.1:${address.port}`,
      WAYPOINT_MCP_CACHE_DIR: join(dir, "cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const messages: Array<Record<string, unknown>> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    while (output.includes("\n")) {
      const index = output.indexOf("\n");
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      if (line) messages.push(z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    }
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify(message) + "\n");
  const waitFor = async (id: number): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`MCP exited: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`MCP timeout: ${errors}`);
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect((await waitFor(1)).result).toBeTruthy();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "waypoint_status", arguments: {} },
    });
    const called = await waitFor(2);
    const result = z
      .object({
        structuredContent: z.object({
          mcp: z.object({
            running_sha256: z.string(),
            source: z.string(),
            latest_sha256: z.string(),
            update_available: z.boolean(),
          }),
        }),
      })
      .parse(called.result);
    expect(result.structuredContent.mcp).toMatchObject({
      source: "fresh",
      update_available: false,
    });
    expect(result.structuredContent.mcp.running_sha256).toBe(
      result.structuredContent.mcp.latest_sha256,
    );
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
  }
});
