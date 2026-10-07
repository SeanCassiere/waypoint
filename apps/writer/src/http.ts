import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  isContentHash,
  isWaypointError,
  validatePath,
  validateClientId,
  isTextMime,
  MCP_LAUNCHER_API,
  WaypointError,
  withBase,
  newId,
  newShareToken,
  hashShareToken,
  shareShellUrl,
  type ShareLink,
  type CreateCollectionRequest,
  type AddRevisionRequest,
} from "@waypoint/core";
import { Hono } from "hono";
import { Context } from "hono";
import { z } from "zod";

import { BlobStore } from "./blob-store.js";
import type { Bucket } from "./bucket.js";
import { BucketError } from "./bucket.js";
import { blobKey, type WriterCommitter } from "./committer.js";
import { inSeries, type Db, type DbHandle } from "./db.js";
import { IngestService } from "./ingest.js";
import { parseMultipart } from "./multipart.js";
import { ReadModel } from "./read-model.js";
import { getStatus } from "./status-data.js";
import type { SyncLoop } from "./sync-loop.js";
import { viewerApp } from "./viewer/index.js";
export interface HttpServices {
  waypoint: Db;
  queue: Db;
  blobs: BlobStore;
  reads: ReadModel;
  ingest: IngestService;
  bucket?: Bucket | undefined;
  committer?: WriterCommitter | undefined;
  syncLoop?: SyncLoop | undefined;
  environment?: "dev" | "prod";
  port?: number;
  publicBaseUrl?: string;
  mcpTarballPath?: string;
  mcpLauncherPath?: string;
  mcpServerPath?: string;
  mcpSkillPath?: string;
  shutdownSignal?: AbortSignal;
}
async function parseJson(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type))
    throw new WaypointError("unsupported_media_type", "Content-Type must be application/json");
  const source = c.req.raw.body;
  if (!source) throw new WaypointError("validation_failed", "JSON body required");
  let size = 0;
  const limited = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 8 * 1024 * 1024)
          throw new WaypointError("revision_too_large", "JSON body exceeds limit");
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(limited).json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new WaypointError("validation_failed", "Malformed JSON body");
    throw error;
  }
}
const fileSchema = z.object({ path: z.string(), hash: z.string(), mime: z.string().optional() });
const createSchema = z.object({
  collection_id: z.string().optional(),
  revision_id: z.string().optional(),
  title: z.string(),
  head_path: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  files: z.array(fileSchema),
});
const addSchema = z.object({
  revision_id: z.string().optional(),
  parent_revision_id: z.string().optional(),
  mode: z.enum(["merge", "replace"]).optional(),
  head_path: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  files: z.array(fileSchema).optional(),
  remove: z.array(z.string()).optional(),
});
function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new WaypointError("validation_failed", "Invalid request body");
  return result.data;
}
function createRequest(input: unknown): CreateCollectionRequest {
  const value = validated(createSchema, input);
  return {
    title: value.title,
    files: value.files.map((file) => ({
      path: file.path,
      hash: file.hash,
      ...(file.mime ? { mime: file.mime } : {}),
    })),
    ...(value.collection_id ? { collection_id: value.collection_id } : {}),
    ...(value.revision_id ? { revision_id: value.revision_id } : {}),
    ...(value.head_path ? { head_path: value.head_path } : {}),
    ...(value.message ? { message: value.message } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}
function addRequest(input: unknown): AddRevisionRequest {
  const value = validated(addSchema, input);
  return {
    ...(value.revision_id ? { revision_id: value.revision_id } : {}),
    ...(value.parent_revision_id ? { parent_revision_id: value.parent_revision_id } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(value.head_path ? { head_path: value.head_path } : {}),
    ...(value.message ? { message: value.message } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
    ...(value.files
      ? {
          files: value.files.map((file) => ({
            path: file.path,
            hash: file.hash,
            ...(file.mime ? { mime: file.mime } : {}),
          })),
        }
      : {}),
    ...(value.remove ? { remove: value.remove } : {}),
  };
}
const artifact = (path: string) =>
  readFile(path).then(
    (bytes) => ({ bytes, hash: createHash("sha256").update(bytes).digest("hex") }),
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
const matchesEtag = (header: string | undefined, etag: string) =>
  header?.split(",").some((item) => {
    const token = item.trim().replace(/^W\//, "");
    return token === etag || token === "*";
  }) ?? false;
export function createApp(s: HttpServices): Hono {
  const app = new Hono();
  const revisionEvents = s.reads.revisionEvents;
  let waiters = 0;
  const tarballPath =
    s.mcpTarballPath ??
    fileURLToPath(new URL("../../../packages/mcp/dist/waypoint-mcp.tgz", import.meta.url));
  const tarball = artifact(tarballPath);
  const launcher = artifact(
    s.mcpLauncherPath ??
      fileURLToPath(new URL("../../../packages/mcp/dist/launcher.mjs", import.meta.url)),
  );
  const serverBundle = artifact(
    s.mcpServerPath ??
      fileURLToPath(new URL("../../../packages/mcp/dist/waypoint-mcp-server.mjs", import.meta.url)),
  );
  const skill = artifact(
    s.mcpSkillPath ?? fileURLToPath(new URL("../../../skills/waypoint/SKILL.md", import.meta.url)),
  );
  const downloads = new Map<string, Promise<void>>();
  async function ensureBlob(hash: string): Promise<void> {
    if (await s.blobs.has(hash)) return;
    if (!s.bucket || !(await s.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash]))) return;
    let flight = downloads.get(hash);
    if (!flight) {
      flight = (async () => {
        try {
          await s.blobs.put(await s.bucket!.get(blobKey(hash)), hash);
        } catch (error) {
          if (isWaypointError(error) && error.code === "blob_hash_mismatch") {
            console.error(`Corrupt bucket blob ${hash}`);
            throw new WaypointError("bucket_corrupt", "Bucket blob hash mismatch");
          }
          if (error instanceof BucketError) {
            if (error.status === 404 && error.code === "NoSuchKey")
              throw new WaypointError("not_found", "Bucket blob not found");
            console.error(`Bucket blob read failed for ${hash}: ${error.message}`);
            throw new WaypointError("bucket_unavailable", "Bucket blob unavailable");
          }
          throw error;
        }
      })().finally(() => downloads.delete(hash));
      downloads.set(hash, flight);
    }
    await flight;
  }
  app.onError((error, c) => {
    if (isWaypointError(error))
      return new Response(JSON.stringify(error.toBody()), {
        status: error.httpStatus,
        headers: { "content-type": "application/json" },
      });
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return c.json(new WaypointError("internal_error", "Internal server error").toBody(), 500);
  });
  const base = new URL(s.reads.baseUrl);
  const port = s.port ?? 7410;
  const allowedOrigins = new Set([
    base.origin,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  app.use("*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const site = c.req.header("sec-fetch-site")?.toLowerCase();
      const origin = c.req.header("origin");
      if (
        site === "cross-site" ||
        site === "same-site" ||
        (origin !== undefined && !allowedOrigins.has(origin))
      )
        throw new WaypointError("forbidden", "Cross-origin write rejected");
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const length = Number(c.req.header("content-length") ?? 0);
    const max =
      c.req.path.startsWith("/api/blobs/") && c.req.method === "PUT"
        ? s.blobs.maxBlobBytes
        : s.ingest.maxRevisionBytes + 8 * 1024 * 1024;
    if (Number.isFinite(length) && length > max)
      throw new WaypointError(
        c.req.method === "PUT" ? "blob_too_large" : "revision_too_large",
        "Request body exceeds limit",
      );
    await next();
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/mcp", () => {
    const tarballUrl = withBase(s.reads.baseUrl, "/mcp/waypoint-mcp.tgz");
    const skillUrl = withBase(s.reads.baseUrl, "/mcp/skill/SKILL.md");
    const snippet = `# Waypoint MCP\n\nThe local server reads files from this machine and writes them to Waypoint. Updates take effect the next time the agent starts the MCP server; configs never need changing. Set WAYPOINT_MCP_PIN=embedded for debugging.\n\nClaude Code:\n\n\`\`\`sh\nclaude mcp add waypoint --env WAYPOINT_URL=${s.reads.baseUrl} -- npx --prefer-offline -y ${tarballUrl}\n\`\`\`\n\n\`\`\`json\n{"mcpServers":{"waypoint":{"command":"npx","args":["--prefer-offline","-y","${tarballUrl}"],"env":{"WAYPOINT_URL":"${s.reads.baseUrl}"}}}}\n\`\`\`\n\nCodex:\n\n\`\`\`toml\n[mcp_servers.waypoint]\ncommand = "npx"\nargs = ["--prefer-offline", "-y", "${tarballUrl}"]\n[mcp_servers.waypoint.env]\nWAYPOINT_URL = "${s.reads.baseUrl}"\n\`\`\`\n\nInstall the Waypoint skill:\n\n\`\`\`sh\nmkdir -p ~/.codex/skills/waypoint && curl -fsSL ${skillUrl} -o ~/.codex/skills/waypoint/SKILL.md\nmkdir -p ~/.claude/skills/waypoint && curl -fsSL ${skillUrl} -o ~/.claude/skills/waypoint/SKILL.md\n\`\`\`\n`;
    return new Response(snippet, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  });
  app.get("/mcp/server.mjs", async (c) => {
    const loaded = await serverBundle;
    if (!loaded) return new Response("MCP server bundle not built", { status: 404 });
    const etag = `"sha256-${loaded.hash}"`;
    const headers = {
      "content-type": "text/javascript; charset=utf-8",
      etag,
      "x-waypoint-content-sha256": loaded.hash,
      "cache-control": "no-cache",
    };
    if (matchesEtag(c.req.header("if-none-match"), etag))
      return new Response(null, { status: 304, headers });
    return new Response(loaded.bytes, { headers });
  });
  app.get("/mcp/version", async (c) => {
    const [server, packageTarball, launcherCode] = await Promise.all([
      serverBundle,
      tarball,
      launcher,
    ]);
    if (!server || !packageTarball || !launcherCode)
      return new Response("MCP artifacts not built", { status: 404 });
    return c.json({
      server_sha256: server.hash,
      package_sha256: packageTarball.hash,
      launcher_sha256: launcherCode.hash,
      launcher_api: MCP_LAUNCHER_API,
    });
  });
  app.get("/mcp/skill/SKILL.md", async () => {
    const loaded = await skill;
    return loaded
      ? new Response(loaded.bytes, { headers: { "content-type": "text/markdown; charset=utf-8" } })
      : new Response("Skill not found", { status: 404 });
  });
  app.get("/mcp/:filename", async (c) => {
    const loaded = await tarball;
    if (!loaded) return new Response("MCP tarball not built", { status: 404 });
    const filename = c.req.param("filename");
    // Legacy URLs help machines that never installed; existing npx cache entries stay pinned until cleared or reconfigured.
    if (filename !== "waypoint-mcp.tgz" && !/^waypoint-mcp-[a-f0-9]{12}\.tgz$/.test(filename))
      return new Response("Not found", { status: 404 });
    const { bytes, hash } = loaded;
    const etag = `"sha256-${hash}"`;
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      etag,
      "cache-control": "no-cache",
    };
    if (filename === "waypoint-mcp.tgz" && matchesEtag(c.req.header("if-none-match"), etag))
      return new Response(null, { status: 304, headers });
    return new Response(bytes, { headers });
  });
  app.post("/api/blobs/check", async (c) => {
    const body = validated(z.object({ hashes: z.array(z.string()) }), await parseJson(c));
    if (
      !Array.isArray(body.hashes) ||
      body.hashes.some((x) => typeof x !== "string" || !isContentHash(x))
    )
      throw new WaypointError("validation_failed", "hashes must be content hashes");
    const missing: string[] = [];
    for (const hash of body.hashes) if (!(await s.blobs.has(hash))) missing.push(hash);
    return c.json({ missing });
  });
  app.put("/api/blobs/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isContentHash(hash)) throw new WaypointError("validation_failed", "Invalid hash");
    if (!c.req.raw.body) throw new WaypointError("validation_failed", "Body required");
    const result = await s.blobs.put(Readable.fromWeb(c.req.raw.body), hash);
    return c.json(result);
  });
  async function validateMultipartMeta(
    meta: Record<string, unknown>,
    collectionId?: string,
  ): Promise<void> {
    if ("files" in meta)
      throw new WaypointError("validation_failed", "Multipart meta must not contain files");
    if (collectionId === undefined) {
      const request = createRequest({ ...meta, files: [] });
      if (request.head_path) validatePath(request.head_path);
      if (request.collection_id) {
        const existing = await s.reads.collection(request.collection_id);
        if (existing) {
          const first = (await s.reads.revisions(existing.id))[0];
          if (!request.revision_id || first?.id !== request.revision_id)
            throw new WaypointError("revision_conflict", "Collection ID already used");
          return;
        }
        validateClientId(request.collection_id, { prefix: "col", now: Date.now() });
      }
      if (request.revision_id) {
        if (await s.reads.revision(request.revision_id))
          throw new WaypointError("revision_conflict", "Revision ID already used");
        validateClientId(request.revision_id, { prefix: "rev", now: Date.now() });
      }
      return;
    }
    const request = addRequest(meta);
    const collection = await s.reads.collection(collectionId);
    if (!collection) throw new WaypointError("collection_not_found", "Collection not found");
    if (collection.deleted_at != null)
      throw new WaypointError("collection_deleted", "Collection is deleted");
    if (
      await s.queue.get("SELECT collection_id FROM pending_purges WHERE collection_id=?", [
        collectionId,
      ])
    )
      throw new WaypointError("collection_purged", "Collection is being purged");
    if (request.head_path) validatePath(request.head_path);
    for (const path of request.remove ?? []) validatePath(path);
    if (request.revision_id) {
      const retried = await s.reads.revision(request.revision_id);
      if (retried) {
        if (
          retried.collection_id === collectionId &&
          (request.parent_revision_id === undefined ||
            request.parent_revision_id === retried.parent_revision_id)
        )
          return;
        throw new WaypointError("revision_conflict", "Revision ID already used");
      }
    }
    let parentId = request.parent_revision_id;
    if (!parentId) {
      const revisions = await s.reads.revisions(collectionId);
      const newest = revisions.at(-1);
      if (newest?.sync_state === "failed")
        throw new WaypointError("parent_failed", "Newest revision failed", {
          revision_id: newest.id,
        });
      parentId = (await s.reads.latest(collectionId))?.id;
    }
    if (parentId) {
      const parent = await s.reads.revision(parentId);
      if (!parent || parent.collection_id !== collectionId)
        throw new WaypointError("parent_not_found", "Parent revision not found", {
          revision_id: parentId,
        });
      if (parent.sync_state === "failed")
        throw new WaypointError("parent_failed", "Parent revision failed", {
          revision_id: parentId,
        });
    }
    if (request.revision_id)
      validateClientId(request.revision_id, {
        prefix: "rev",
        now: Date.now(),
        ...(parentId ? { parentId } : {}),
      });
  }
  async function writeBody(c: Context, collectionId?: string): Promise<Record<string, unknown>> {
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("multipart/form-data"))
      return parseMultipart(
        c.req.raw,
        s.blobs,
        {
          maxFiles: s.ingest.maxFiles,
          maxRevisionBytes: s.ingest.maxRevisionBytes,
        },
        (meta) => validateMultipartMeta(meta, collectionId),
      );
    return validated(z.record(z.string(), z.unknown()), await parseJson(c));
  }
  app.post("/api/collections", async (c) => {
    const result = await s.ingest.create(createRequest(await writeBody(c)));
    s.reads.notifyRevision(result.collection_id);
    return c.json(result);
  });
  app.post("/api/collections/:id/revisions", async (c) => {
    const result = await s.ingest.add(
      c.req.param("id"),
      addRequest(await writeBody(c, c.req.param("id"))),
    );
    s.reads.notifyRevision(result.collection_id);
    return c.json(result);
  });
  app.get("/api/collections", async (c) => {
    const params = c.req.query();
    let metadata: Record<string, unknown> | undefined;
    if (params.metadata !== undefined) {
      try {
        const parsed: unknown = JSON.parse(params.metadata);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        metadata = z.record(z.string(), z.unknown()).parse(parsed);
      } catch {
        throw new WaypointError("validation_failed", "Invalid metadata filter");
      }
    }
    const updated = params.updated_after;
    if (
      updated !== undefined &&
      !/^\d+$/.test(updated) &&
      !z.iso.datetime({ offset: true }).safeParse(updated).success &&
      !z.iso.date().safeParse(updated).success
    )
      throw new WaypointError("validation_failed", "Invalid updated_after");
    const updatedAfter =
      updated === undefined
        ? undefined
        : /^\d+$/.test(updated)
          ? Number(updated)
          : Date.parse(updated);
    if (updatedAfter !== undefined && (!Number.isSafeInteger(updatedAfter) || updatedAfter < 0))
      throw new WaypointError("validation_failed", "Invalid updated_after");
    const sort = params.sort;
    if (sort !== undefined && sort !== "updated" && sort !== "created")
      throw new WaypointError("validation_failed", "Invalid sort");
    return c.json(
      await s.reads.searchCollections({
        query: params.query,
        metadata,
        updated_after: updatedAfter,
        sort,
        limit: params.limit === undefined ? undefined : Number(params.limit),
        cursor: params.cursor,
        include_deleted: params.include_deleted === "true" || params.include_deleted === "1",
      }),
    );
  });
  app.get("/api/collections/:id", async (c) => {
    const input = c.req.param("id");
    const id = input.startsWith("col_") ? input : (await s.reads.collectionByPublicId(input))?.id;
    if (!id) throw new WaypointError("collection_not_found", "Collection not found");
    const detail = await s.reads.getCollection(id, c.req.query("revision_id"));
    if (c.req.query("include_head") !== "1") return c.json(detail);
    const headPath = detail.revision?.head_path;
    const file = detail.revision?.files.find((entry) => entry.path === headPath);
    if (!file || !headPath) return c.json({ ...detail, head: null });
    if (!isTextMime(file.mime))
      return c.json({
        ...detail,
        head: { path: headPath, mime: file.mime, text: null, truncated: false, url: file.url },
      });
    try {
      await ensureBlob(file.hash);
    } catch (error) {
      if (
        !(isWaypointError(error) && (error.code === "not_found" || error.code === "blob_missing"))
      )
        throw error;
      return c.json({
        ...detail,
        head: {
          path: headPath,
          mime: file.mime,
          text: null,
          truncated: false,
          url: file.url,
          unavailable: true,
        },
      });
    }
    const max = 64 * 1024;
    let handle;
    try {
      handle = await open(s.blobs.path(file.hash), "r");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return c.json({
        ...detail,
        head: {
          path: headPath,
          mime: file.mime,
          text: null,
          truncated: false,
          url: file.url,
          unavailable: true,
        },
      });
    }
    const bytes = Buffer.alloc(max + 1);
    let count = 0;
    try {
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
    } finally {
      await handle.close();
    }
    const truncated = count > max;
    let end = Math.min(count, max);
    if (truncated) {
      for (let trim = 0; trim < 4; trim++) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
          break;
        } catch {
          end--;
        }
      }
    }
    const text = new TextDecoder().decode(bytes.subarray(0, end));
    return c.json({
      ...detail,
      head: { path: headPath, mime: file.mime, text, truncated, url: file.url },
    });
  });
  app.patch("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    const body = validated(
      z.object({
        title: z.string().min(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      await parseJson(c),
    );
    if (body.title === undefined && body.metadata === undefined)
      throw new WaypointError("validation_failed", "No changes supplied");
    return c.json(
      await s.ingest.withCollectionLock(id, async () => {
        const row = await s.reads.collection(id);
        if (!row) throw new WaypointError("collection_not_found", "Collection not found");
        if (await s.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [id]))
          throw new WaypointError("conflict", "Collection purge is queued");
        const pending = await s.queue.get("SELECT id FROM pending_collections WHERE id=?", [id]);
        if (!pending)
          await s.queue.run(
            "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
            [id, Date.now()],
          );
        const db = pending ? s.queue : s.waypoint;
        const table = pending ? "pending_collections" : "collections";
        const result = await db.run(`UPDATE ${table} SET title=?,metadata=? WHERE id=?`, [
          body.title ?? row.title,
          JSON.stringify(body.metadata ?? JSON.parse(row.metadata)),
          id,
        ]);
        if (!result.changes)
          throw new WaypointError("collection_not_found", "Collection not found");
        s.ingest.committer.wake();
        return s.reads.getCollection(id);
      }),
    );
  });
  app.delete("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    return c.json(
      await s.ingest.withCollectionLock(id, async () => {
        const row = await s.reads.collection(id);
        if (!row) throw new WaypointError("collection_not_found", "Collection not found");
        if (await s.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [id]))
          throw new WaypointError("conflict", "Collection purge is queued");
        const pending = await s.queue.get("SELECT id FROM pending_collections WHERE id=?", [id]);
        if (pending) {
          const result = await s.queue.run(
            "UPDATE pending_collections SET deleted_at=COALESCE(deleted_at,?) WHERE id=?",
            [Date.now(), id],
          );
          if (!result.changes)
            throw new WaypointError("collection_not_found", "Collection not found");
        } else {
          await s.queue.run(
            "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
            [id, Date.now()],
          );
          await s.waypoint.run(
            "INSERT OR IGNORE INTO collection_tombstones (collection_id,deleted_at) VALUES (?,?)",
            [id, Date.now()],
          );
        }
        s.ingest.committer.wake();
        return s.reads.getCollection(id);
      }),
    );
  });
  app.post("/api/collections/:id/undelete", async (c) => {
    const id = c.req.param("id");
    return c.json(
      await s.ingest.withCollectionLock(id, async () => {
        const row = await s.reads.collection(id);
        if (!row) throw new WaypointError("collection_not_found", "Collection not found");
        if (row.deleted_at == null)
          throw new WaypointError("conflict", "Collection is not deleted");
        if (await s.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [id]))
          throw new WaypointError("conflict", "Collection purge is queued");
        const pending = await s.queue.get("SELECT id FROM pending_collections WHERE id=?", [id]);
        if (pending) {
          const result = await s.queue.run(
            "UPDATE pending_collections SET deleted_at=NULL WHERE id=?",
            [id],
          );
          if (!result.changes)
            throw new WaypointError("collection_not_found", "Collection not found");
        } else {
          await s.queue.run(
            "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
            [id, Date.now()],
          );
          const result = await s.waypoint.run(
            "DELETE FROM collection_tombstones WHERE collection_id=?",
            [id],
          );
          if (!result.changes) throw new WaypointError("conflict", "Collection is not deleted");
        }
        s.ingest.committer.wake();
        return s.reads.getCollection(id);
      }),
    );
  });
  type ShareRow = Pick<
    ShareLink,
    "id" | "collection_id" | "revision_id" | "label" | "expires_at" | "revoked_at" | "created_at"
  >;
  async function shareView(row: ShareRow): Promise<ShareLink> {
    const collection = await s.reads.collection(row.collection_id);
    const target = row.revision_id
      ? await s.reads.revision(row.revision_id)
      : await s.reads.latest(row.collection_id);
    const now = Date.now();
    const status =
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at !== null && row.expires_at <= now
          ? "expired"
          : "active";
    return {
      ...row,
      mode: row.revision_id ? "pinned" : "latest",
      status,
      publicly_available:
        status === "active" && collection?.deleted_at == null && target?.sync_state === "synced",
    };
  }
  app.post("/api/collections/:id/share-links", async (c) => {
    if (!s.publicBaseUrl) throw new WaypointError("conflict", "Sharing is not configured");
    const id = c.req.param("id");
    const body = validated(
      z.object({
        revision_id: z.string().optional(),
        label: z.string().max(200).nullable().optional(),
        expires_at: z.number().int().positive().nullable().optional(),
      }),
      await parseJson(c),
    );
    return c.json(
      await s.ingest.withCollectionLock(id, async () => {
        const collection = await s.reads.collection(id);
        if (!collection) throw new WaypointError("collection_not_found", "Collection not found");
        if (collection.deleted_at != null)
          throw new WaypointError("collection_deleted", "Collection is deleted");
        if (await s.queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [id]))
          throw new WaypointError("collection_purged", "Collection is being purged");
        if (body.revision_id) {
          const revision = await s.reads.revision(body.revision_id);
          if (!revision || revision.collection_id !== id)
            throw new WaypointError("validation_failed", "Revision does not belong to collection");
          if (revision.sync_state === "failed")
            throw new WaypointError("validation_failed", "Failed revision cannot be shared");
        } else if (!(await s.reads.latest(id))) {
          throw new WaypointError("validation_failed", "No successful revision to share");
        }
        if (body.expires_at != null && body.expires_at <= Date.now())
          throw new WaypointError("validation_failed", "Expiry must be in the future");
        const token = newShareToken();
        const row: ShareRow = {
          id: newId("shl"),
          collection_id: id,
          revision_id: body.revision_id ?? null,
          label: body.label ?? null,
          expires_at: body.expires_at ?? null,
          revoked_at: null,
          created_at: Date.now(),
        };
        await s.queue.run(
          "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
          [id, Date.now()],
        );
        await s.waypoint.run(
          "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            row.id,
            await hashShareToken(token),
            id,
            row.revision_id,
            row.label,
            row.expires_at,
            null,
            row.created_at,
          ],
        );
        s.ingest.committer.wake();
        s.syncLoop?.triggerPush();
        const target = row.revision_id
          ? await s.reads.revision(row.revision_id)
          : await s.reads.latest(id);
        return {
          share_link: await shareView(row),
          url: shareShellUrl(
            s.publicBaseUrl!,
            token,
            collection.public_id,
            row.revision_id ? target?.public_id : undefined,
            target?.head_path,
          ),
          token,
        };
      }),
      201,
    );
  });
  app.get("/api/collections/:id/share-links", async (c) => {
    if (!s.publicBaseUrl) throw new WaypointError("conflict", "Sharing is not configured");
    const id = c.req.param("id");
    if (!(await s.reads.collection(id)))
      throw new WaypointError("collection_not_found", "Collection not found");
    const rows = await s.waypoint.all<ShareRow>(
      "SELECT id,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE collection_id=? ORDER BY created_at DESC",
      [id],
    );
    return c.json({ share_links: await Promise.all(rows.map(shareView)) });
  });
  app.post("/api/share-links/:id/revoke", async (c) => {
    if (!s.publicBaseUrl) throw new WaypointError("conflict", "Sharing is not configured");
    await parseJson(c);
    const id = c.req.param("id");
    const found = await s.waypoint.get<ShareRow>(
      "SELECT id,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE id=?",
      [id],
    );
    if (!found) throw new WaypointError("not_found", "Share link not found");
    return c.json(
      await s.ingest.withCollectionLock(found.collection_id, async () => {
        const row = await s.waypoint.get<ShareRow>(
          "SELECT id,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE id=?",
          [id],
        );
        if (!row) throw new WaypointError("not_found", "Share link not found");
        if (row.revoked_at === null) {
          await s.queue.run(
            "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
            [row.collection_id, Date.now()],
          );
          await s.waypoint.run(
            "UPDATE share_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
            [Date.now(), id],
          );
          s.ingest.committer.wake();
          s.syncLoop?.triggerPush();
        }
        const current = await s.waypoint.get<ShareRow>(
          "SELECT id,collection_id,revision_id,label,expires_at,revoked_at,created_at FROM share_links WHERE id=?",
          [id],
        );
        return shareView(current!);
      }),
    );
  });
  app.post("/api/collections/:id/purge", async (c) => {
    const id = c.req.param("id");
    const body = validated(z.object({ confirm: z.string() }), await parseJson(c));
    if (body.confirm !== id)
      throw new WaypointError("validation_failed", "Purge confirmation must match collection ID");
    return c.json(
      await s.ingest.withCollectionLock(id, async () => {
        const row = await s.reads.collection(id);
        if (!row) throw new WaypointError("collection_not_found", "Collection not found");
        const pending = await s.queue.get("SELECT id FROM pending_collections WHERE id=?", [id]);
        if (pending) {
          const unused = await s.queue.transaction(async (tx) => {
            const revisions = await tx.all<{ id: string }>(
              "SELECT id FROM pending_revisions WHERE collection_id=?",
              [id],
            );
            for (const revision of revisions)
              await tx.run(
                "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
                [`manifests/${revision.id}.json`, Date.now()],
              );
            await tx.run(
              "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
              [`collections/${id}.json`, Date.now()],
            );
            await tx.run("DELETE FROM pending_revisions WHERE collection_id=?", [id]);
            await tx.run("DELETE FROM pending_snapshots WHERE collection_id=?", [id]);
            const result = await tx.run("DELETE FROM pending_collections WHERE id=?", [id]);
            if (!result.changes)
              throw new WaypointError("collection_not_found", "Collection not found");
            return prunePendingStorage(tx, s.waypoint);
          });
          await s.ingest.withGcExclusive(() => deleteUnusedBlobs(s, unused));
          await s.waypoint.run("DELETE FROM share_links WHERE collection_id=?", [id]);
          s.syncLoop?.triggerPush();
          s.ingest.committer.wake();
          return { purged: true };
        }
        // Revoke public access as soon as the purge is accepted, even if bucket
        // deletion retries for days. The snapshot is queued before the DB edit.
        await s.queue.run(
          "INSERT OR REPLACE INTO pending_snapshots (collection_id,requested_at) VALUES (?,?)",
          [id, Date.now()],
        );
        await s.waypoint.run(
          "UPDATE share_links SET revoked_at=? WHERE collection_id=? AND revoked_at IS NULL",
          [Date.now(), id],
        );
        s.syncLoop?.triggerPush();
        await s.queue.run(
          "INSERT INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0) ON CONFLICT(collection_id) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
          [id, Date.now()],
        );
        s.ingest.committer.wake();
        return { queued: true };
      }),
      202,
    );
  });
  app.get("/api/collections/:id/revisions", async (c) => {
    const input = c.req.param("id");
    const id = input.startsWith("col_") ? input : (await s.reads.collectionByPublicId(input))?.id;
    if (!id) throw new WaypointError("collection_not_found", "Collection not found");
    if (!(await s.reads.collection(id)))
      throw new WaypointError("collection_not_found", "Collection not found");
    const after = c.req.query("after");
    if (!after) return c.json(await s.reads.listRevisions(id));
    const seconds = Number(c.req.query("wait") ?? 0);
    if (!Number.isFinite(seconds)) throw new WaypointError("validation_failed", "Invalid wait");
    const waitSeconds = Math.max(0, Math.min(seconds, 50));
    const list = async () => {
      const revisions = (await s.reads.listRevisions(id)).revisions;
      if (!revisions.some((revision) => revision.id === after))
        throw new WaypointError("not_found", "Revision does not belong to collection");
      return revisions.filter((revision) => revision.id > after);
    };
    if (waitSeconds === 0) {
      const revisions = await list();
      return c.json({ changed: revisions.length > 0, revisions });
    }
    let notified = false;
    let wake: (() => void) | undefined;
    const onRevision = (changedId: string) => {
      if (changedId === id) {
        notified = true;
        wake?.();
      }
    };
    const onAbort = () => wake?.();
    revisionEvents.on("revision", onRevision);
    c.req.raw.signal.addEventListener("abort", onAbort);
    s.shutdownSignal?.addEventListener("abort", onAbort);
    let counted = false;
    try {
      let revisions = await list();
      if (notified && !revisions.length) {
        notified = false;
        revisions = await list();
      }
      if (revisions.length || c.req.raw.signal.aborted || s.shutdownSignal?.aborted)
        return c.json({ changed: revisions.length > 0, revisions });
      if (waiters >= 200) {
        c.header("Retry-After", "2");
        return c.json(
          { error: { code: "unavailable", message: "Too many revision waiters", details: {} } },
          503,
        );
      }
      waiters++;
      counted = true;
      const deadline = Date.now() + waitSeconds * 1000;
      while (
        !revisions.length &&
        Date.now() < deadline &&
        !c.req.raw.signal.aborted &&
        !s.shutdownSignal?.aborted
      ) {
        if (notified) {
          notified = false;
          revisions = await list();
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(2000, deadline - Date.now()));
          function done() {
            clearTimeout(timer);
            if (wake === done) wake = undefined;
            resolve();
          }
          wake = done;
          if (notified || c.req.raw.signal.aborted || s.shutdownSignal?.aborted) done();
        });
        if (!c.req.raw.signal.aborted && !s.shutdownSignal?.aborted) revisions = await list();
      }
      return c.json({ changed: revisions.length > 0, revisions });
    } finally {
      if (counted) waiters--;
      revisionEvents.off("revision", onRevision);
      c.req.raw.signal.removeEventListener("abort", onAbort);
      s.shutdownSignal?.removeEventListener("abort", onAbort);
    }
  });
  app.get("/api/revisions/:id", async (c) => c.json(await s.reads.getRevision(c.req.param("id"))));
  async function serve(
    id: string,
    path: string,
    source: boolean,
    ifNoneMatch?: string,
  ): Promise<Response> {
    if (/%(?:2f|5c)/i.test(path))
      throw new WaypointError("path_invalid", "Encoded separator in file path");
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new WaypointError("path_invalid", "Malformed file path encoding");
    }
    const entry = await s.reads.file(id, validatePath(decoded));
    const rendition =
      entry.mime === "text/markdown" && !source ? await s.reads.rendition(entry.hash) : undefined;
    if (rendition)
      try {
        await ensureBlob(rendition.hash);
      } catch (error) {
        console.error(
          `Rendition fetch failed for ${rendition.hash}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    const availableRendition =
      rendition && (await s.blobs.has(rendition.hash)) ? rendition : undefined;
    const served = availableRendition
      ? {
          hash: availableRendition.hash,
          mime: availableRendition.mime,
          size: await s.blobs.size(availableRendition.hash),
        }
      : entry;
    await ensureBlob(served.hash);
    if (!(await s.blobs.has(served.hash)))
      throw new WaypointError("not_found", "Blob is unavailable locally");
    const mime = isTextMime(served.mime) ? `${served.mime}; charset=utf-8` : served.mime;
    const changeable = entry.mime === "text/markdown" && !source;
    const headers = new Headers({
      "content-type": mime,
      "x-content-type-options": "nosniff",
      "cache-control": changeable ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (changeable) {
      const etag = `"${served.hash}"`;
      headers.set("etag", etag);
      if (
        ifNoneMatch
          ?.split(",")
          .some((candidate) => [etag, `W/${etag}`, "*"].includes(candidate.trim()))
      )
        return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(served.size));
    return new Response(Readable.toWeb(s.blobs.open(served.hash)), {
      headers,
    });
  }
  app.get("/api/revisions/:id/files/*", async (c) =>
    serve(
      c.req.param("id"),
      new URL(c.req.raw.url).pathname.split("/files/").slice(1).join("/files/"),
      new URL(c.req.raw.url).searchParams.has("source"),
      c.req.header("if-none-match"),
    ),
  );
  app.post("/api/resolve", async (c) => {
    const body = validated(z.object({ url: z.string() }), await parseJson(c));
    if (typeof body.url !== "string") throw new WaypointError("validation_failed", "url required");
    return c.json(await s.reads.resolve(body.url));
  });
  app.get("/raw/r/:publicId/*", async (c) => {
    const publicId = c.req.param("publicId").toLowerCase();
    const row =
      (await s.queue.get<{ id: string }>("SELECT id FROM pending_revisions WHERE public_id=?", [
        publicId,
      ])) ??
      (await s.waypoint.get<{ id: string }>("SELECT id FROM revisions WHERE public_id=?", [
        publicId,
      ]));
    if (!row) throw new WaypointError("not_found", "Revision not found");
    const pathname = new URL(c.req.raw.url).pathname;
    const prefix = `/raw/r/${c.req.param("publicId")}/`;
    return serve(
      row.id,
      pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "",
      new URL(c.req.raw.url).searchParams.has("source"),
      c.req.header("if-none-match"),
    );
  });
  app.get("/api/status", async (c) => c.json(await getStatus(s)));
  app.post("/api/queue/:revision_id/retry", async (c) => {
    const id = c.req.param("revision_id");
    const root = await s.queue.get<{ collection_id: string }>(
      "SELECT collection_id FROM pending_revisions WHERE id=?",
      [id],
    );
    if (!root) throw new WaypointError("not_found", "Queue revision not found");
    return c.json(
      await s.ingest.withCollectionLock(root.collection_id, async () => {
        const current = await s.queue.get<{ state: string }>(
          "SELECT state FROM pending_revisions WHERE id=?",
          [id],
        );
        if (!current) throw new WaypointError("not_found", "Queue revision not found");
        if (current.state !== "failed")
          throw new WaypointError("conflict", "Revision is not failed");
        const descendants = await descendantsOf(s.queue, id);
        const retried: string[] = [];
        await inSeries(descendants, async (revision) => {
          const result = await s.queue.run(
            "UPDATE pending_revisions SET state='pending',attempts=0,first_attempt_at=NULL,next_attempt_at=NULL,last_error=NULL,error_kind=NULL WHERE id=? AND state='failed'",
            [revision],
          );
          if (result.changes) retried.push(revision);
        });
        s.ingest.committer.wake();
        return { retried };
      }),
    );
  });
  app.delete("/api/queue/:revision_id", async (c) => {
    const id = c.req.param("revision_id");
    const root = await s.queue.get<{ collection_id: string }>(
      "SELECT collection_id FROM pending_revisions WHERE id=?",
      [id],
    );
    if (!root) throw new WaypointError("not_found", "Queue revision not found");
    if (s.ingest.isCollectionIngesting(root.collection_id))
      throw new WaypointError("conflict", "Collection ingest is in flight");
    return c.json(
      await s.ingest.withCollectionLock(root.collection_id, async () => {
        if (s.ingest.isCollectionIngesting(root.collection_id))
          throw new WaypointError("conflict", "Collection ingest is in flight");
        if (await s.waypoint.get("SELECT id FROM revisions WHERE id=?", [id]))
          throw new WaypointError("conflict", "Revision is already committed");
        const descendants = await descendantsOf(s.queue, id);
        if (!descendants.length) throw new WaypointError("not_found", "Queue revision not found");
        const unused = await s.queue.transaction(async (tx) => {
          await inSeries(descendants.toReversed(), async (revision) => {
            const deleted = await tx.run("DELETE FROM pending_revisions WHERE id=?", [revision]);
            if (!deleted.changes) throw new WaypointError("not_found", "Queue revision not found");
            await tx.run(
              "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
              [`manifests/${revision}.json`, Date.now()],
            );
          });
          if (
            !(await tx.get("SELECT id FROM pending_revisions WHERE collection_id=?", [
              root.collection_id,
            ]))
          )
            await tx.run("DELETE FROM pending_collections WHERE id=?", [root.collection_id]);
          return prunePendingStorage(tx, s.waypoint);
        });
        await s.ingest.withGcExclusive(() => deleteUnusedBlobs(s, unused));
        s.ingest.committer.wake();
        return { dropped: descendants };
      }),
    );
  });
  app.route("/", viewerApp(s));
  return app;
}
async function prunePendingStorage(tx: DbHandle, waypoint: Db): Promise<string[]> {
  const rows = await tx.all<{ manifest_json: string }>(
    "SELECT manifest_json FROM pending_revisions",
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    const manifest: unknown = JSON.parse(row.manifest_json);
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("files" in manifest) ||
      !manifest.files ||
      typeof manifest.files !== "object"
    )
      throw new Error("Invalid stored manifest");
    const entries: unknown[] = Object.values(manifest.files);
    for (const entry of entries)
      if (entry && typeof entry === "object" && "hash" in entry && typeof entry.hash === "string")
        referenced.add(entry.hash);
  }
  const renditions = await tx.all<{ source_hash: string; output_hash: string }>(
    "SELECT source_hash,output_hash FROM pending_renditions",
  );
  await inSeries(renditions, async (rendition) => {
    if (!referenced.has(rendition.source_hash))
      await tx.run("DELETE FROM pending_renditions WHERE source_hash=?", [rendition.source_hash]);
    else referenced.add(rendition.output_hash);
  });
  const pendingBlobs = await tx.all<{ hash: string }>("SELECT hash FROM pending_blobs");
  const unused = pendingBlobs.filter((blob) => !referenced.has(blob.hash)).map((blob) => blob.hash);
  await inSeries(unused, async (hash) => {
    if (!(await waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])))
      await tx.run(
        "INSERT INTO pending_r2_deletes (key,requested_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_attempt_at=NULL,last_error=NULL",
        [blobKey(hash), Date.now()],
      );
    await tx.run("DELETE FROM pending_blobs WHERE hash=?", [hash]);
  });
  return unused;
}
async function deleteUnusedBlobs(s: HttpServices, hashes: string[]): Promise<void> {
  await inSeries(hashes, async (hash) => {
    if (s.ingest.isBlobInUse(hash)) return;
    if (await s.queue.get("SELECT hash FROM pending_blobs WHERE hash=?", [hash])) return;
    if (await s.waypoint.get("SELECT hash FROM blobs WHERE hash=?", [hash])) return;
    try {
      const file = await stat(s.blobs.path(hash));
      if (Date.now() - file.mtimeMs < 15 * 60_000) return;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (s.ingest.isBlobInUse(hash)) return;
    await s.blobs.delete(hash);
  });
}
async function descendantsOf(db: Db, id: string): Promise<string[]> {
  const rows = await db.all<{ id: string; parent_revision_id: string | null }>(
    "SELECT id,parent_revision_id FROM pending_revisions",
  );
  const found = new Set<string>();
  if (!rows.some((x) => x.id === id)) return [];
  found.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (row.parent_revision_id && found.has(row.parent_revision_id) && !found.has(row.id)) {
        found.add(row.id);
        changed = true;
      }
  }
  return [...found];
}
