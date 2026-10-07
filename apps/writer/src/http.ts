import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  isContentHash,
  isWaypointError,
  validatePath,
  validateClientId,
  isTextMime,
  WaypointError,
  withBase,
  type CreateCollectionRequest,
  type AddRevisionRequest,
} from "@waypoint/core";
import { Hono } from "hono";
import { Context } from "hono";
import { z } from "zod";

import { BlobStore } from "./blob-store.js";
import { inSeries, type Db, type DbHandle } from "./db.js";
import { IngestService } from "./ingest.js";
import { parseMultipart } from "./multipart.js";
import { ReadModel } from "./read-model.js";
export interface HttpServices {
  waypoint: Db;
  queue: Db;
  blobs: BlobStore;
  reads: ReadModel;
  ingest: IngestService;
  port?: number;
  mcpTarballPath?: string;
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
export function createApp(s: HttpServices): Hono {
  const app = new Hono();
  const tarballPath =
    s.mcpTarballPath ??
    fileURLToPath(new URL("../../../packages/mcp/dist/waypoint-mcp.tgz", import.meta.url));
  const tarball = readFile(tarballPath).then(
    (bytes) => ({ bytes, hash: createHash("sha256").update(bytes).digest("hex") }),
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
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
  app.get("/mcp", async () => {
    const loaded = await tarball;
    const tarballUrl = withBase(
      s.reads.baseUrl,
      `/mcp/waypoint-mcp${loaded ? `-${loaded.hash.slice(0, 12)}` : ""}.tgz`,
    );
    const snippet = `# Waypoint MCP\n\nThe local server reads files from this machine and writes them to Waypoint.\n\nClaude Code:\n\n\`\`\`json\n{"mcpServers":{"waypoint":{"command":"npx","args":["-y","${tarballUrl}"],"env":{"WAYPOINT_URL":"${s.reads.baseUrl}"}}}}\n\`\`\`\n\nCodex:\n\n\`\`\`toml\n[mcp_servers.waypoint]\ncommand = "npx"\nargs = ["-y", "${tarballUrl}"]\n[mcp_servers.waypoint.env]\nWAYPOINT_URL = "${s.reads.baseUrl}"\n\`\`\`\n`;
    return new Response(snippet, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  });
  app.get("/mcp/:filename", async (c) => {
    const loaded = await tarball;
    if (!loaded) return new Response("MCP tarball not built", { status: 404 });
    const versioned = `waypoint-mcp-${loaded.hash.slice(0, 12)}.tgz`;
    if (c.req.param("filename") !== "waypoint-mcp.tgz" && c.req.param("filename") !== versioned)
      return new Response("Not found", { status: 404 });
    const { bytes, hash } = loaded;
    const etag = `"sha256-${hash}"`;
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      etag,
      "cache-control":
        c.req.param("filename") === versioned ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (
      c.req
        .header("if-none-match")
        ?.split(",")
        .some((item) => {
          const token = item.trim().replace(/^W\//, "");
          return token === etag || token === "*";
        })
    )
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
  app.post("/api/collections", async (c) =>
    c.json(await s.ingest.create(createRequest(await writeBody(c)))),
  );
  app.post("/api/collections/:id/revisions", async (c) =>
    c.json(
      await s.ingest.add(c.req.param("id"), addRequest(await writeBody(c, c.req.param("id")))),
    ),
  );
  app.get("/api/collections", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new WaypointError("validation_failed", "Invalid limit");
    return c.json({
      collections: await s.reads.listCollections(
        c.req.query("query") ?? "",
        limit,
        c.req.query("include_deleted") === "true",
      ),
    });
  });
  app.get("/api/collections/:id", async (c) =>
    c.json(await s.reads.getCollection(c.req.param("id"))),
  );
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
        return s.reads.getCollection(id);
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
            await tx.run("DELETE FROM pending_revisions WHERE collection_id=?", [id]);
            const result = await tx.run("DELETE FROM pending_collections WHERE id=?", [id]);
            if (!result.changes)
              throw new WaypointError("collection_not_found", "Collection not found");
            return prunePendingStorage(tx);
          });
          await deleteUnusedBlobs(s, unused);
          return { purged: true };
        }
        await s.queue.run(
          "INSERT OR IGNORE INTO pending_purges (collection_id,requested_at,step) VALUES (?,?,0)",
          [id, Date.now()],
        );
        return { queued: true };
      }),
      202,
    );
  });
  app.get("/api/collections/:id/revisions", async (c) => {
    const id = c.req.param("id");
    if (!(await s.reads.collection(id)))
      throw new WaypointError("collection_not_found", "Collection not found");
    return c.json(await s.reads.listRevisions(id));
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
    const availableRendition =
      rendition && (await s.blobs.has(rendition.hash)) ? rendition : undefined;
    const served = availableRendition
      ? {
          hash: availableRendition.hash,
          mime: availableRendition.mime,
          size: await s.blobs.size(availableRendition.hash),
        }
      : entry;
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
  app.get("/api/status", async (c) => {
    const rows = await s.queue.all<{
      id: string;
      state: string;
      created_at: number;
      last_error: string | null;
    }>("SELECT id,state,created_at,last_error FROM pending_revisions");
    const pending = rows.filter((x) => x.state === "pending");
    return c.json({
      queue: {
        pending_collections: (await s.queue.all("SELECT id FROM pending_collections")).length,
        pending_revisions: pending.length,
        failed_revisions: rows.length - pending.length,
        pending_blobs: (await s.queue.all("SELECT hash FROM pending_blobs")).length,
        pending_renditions: (await s.queue.all("SELECT source_hash FROM pending_renditions"))
          .length,
        pending_snapshots: (await s.queue.all("SELECT collection_id FROM pending_snapshots"))
          .length,
        pending_r2_deletes: (await s.queue.all("SELECT key FROM pending_r2_deletes")).length,
        pending_purges: (await s.queue.all("SELECT collection_id FROM pending_purges")).length,
        unpushed: (await s.queue.all("SELECT revision_id FROM unpushed")).length,
      },
      oldest_pending_age_ms: pending.length
        ? Date.now() - Math.min(...pending.map((x) => x.created_at))
        : null,
      failed_items: rows
        .filter((x) => x.state === "failed")
        .map((x) => ({ id: x.id, created_at: x.created_at, last_error: x.last_error })),
      last_upload_at: null,
      last_push_at: null,
      last_pull_at: s.ingest.sync.lastPullAt,
      last_error:
        rows
          .filter((row) => row.last_error !== null)
          .toSorted(
            (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )[0]?.last_error ?? null,
      sync_verified: Boolean(s.ingest.sync.verified),
    });
  });
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
              "INSERT OR IGNORE INTO pending_r2_deletes (key,requested_at) VALUES (?,?)",
              [`manifests/${revision}.json`, Date.now()],
            );
          });
          if (
            !(await tx.get("SELECT id FROM pending_revisions WHERE collection_id=?", [
              root.collection_id,
            ]))
          )
            await tx.run("DELETE FROM pending_collections WHERE id=?", [root.collection_id]);
          return prunePendingStorage(tx);
        });
        await deleteUnusedBlobs(s, unused);
        return { dropped: descendants };
      }),
    );
  });
  return app;
}
async function prunePendingStorage(tx: DbHandle): Promise<string[]> {
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
  await inSeries(unused, (hash) => tx.run("DELETE FROM pending_blobs WHERE hash=?", [hash]));
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
