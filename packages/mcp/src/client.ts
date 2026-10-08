import { createReadStream } from "node:fs";

import {
  DEFAULT_LIMITS,
  WaypointError,
  buildManifest,
  hashBytes,
  idTimestamp,
  isContentHash,
  isTextMime,
  mintRevisionId,
  newId,
  parseId,
  validatePath,
  withBase,
  type AddRevisionRequest,
  type CollectionDetail,
  type CreateCollectionRequest,
  type Limits,
  type ManifestEntry,
  type RevisionDetail,
  type WriteResult,
  type SearchCollectionsResponse,
  type WaitForRevisionResponse,
  type ListRevisionsResponse,
  type ResolveResponse,
  type StatusResponse,
} from "@waypoint/core";
import { z } from "zod";

import { prepareFiles, type FileInput, type PreparedFile, type SourceDir } from "./files.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly status: number;
  constructor(code: string, message: string, details: Record<string, unknown> = {}, status = 400) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
export interface WriteInput {
  files?: FileInput[] | undefined;
  source_dir?: SourceDir | undefined;
  head_path?: string | undefined;
  message?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}
export interface CreateInput extends WriteInput {
  title: string;
}
export interface AddInput extends WriteInput {
  collection_id: string;
  remove?: string[] | undefined;
  mode?: "merge" | "replace" | undefined;
  parent_revision_id?: string | undefined;
}
const writeResult = z.looseObject({
  collection_id: z.string(),
  revision_id: z.string(),
  display_number: z.number(),
  url: z.string(),
  latest_url: z.string(),
  sync_state: z.enum(["pending", "committed", "synced", "failed"]),
  unchanged: z.boolean(),
}) satisfies z.ZodType<WriteResult>;
export type WriteOutcome =
  | z.infer<typeof writeResult>
  | {
      collection_id: string;
      revision_id: string;
      warning: string;
      raw_response: unknown;
    };
const revisionSummary = z.looseObject({
  id: z.string(),
  public_id: z.string(),
  collection_id: z.string(),
  parent_revision_id: z.string().nullable(),
  display_number: z.number(),
  head_path: z.string(),
  message: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.number(),
  sync_state: z.enum(["pending", "committed", "synced", "failed"]),
  url: z.string(),
});
const revisionDetail = revisionSummary.extend({
  files: z.array(
    z.looseObject({
      path: z.string(),
      hash: z.string(),
      mime: z.string(),
      size: z.number(),
      url: z.string(),
    }),
  ),
});
const collectionDetail = z.looseObject({
  id: z.string(),
  public_id: z.string(),
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.number(),
  deleted: z.boolean(),
  latest_revision: revisionSummary.nullable(),
  latest_url: z.string(),
  revision: revisionDetail.nullable(),
  head: z
    .looseObject({
      path: z.string(),
      mime: z.string(),
      text: z.string().nullable(),
      truncated: z.boolean(),
      url: z.string(),
      unavailable: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
const searchCollectionsResult = z.looseObject({
  collections: z.array(
    z.looseObject({
      id: z.string(),
      public_id: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.unknown()),
      created_at: z.number(),
      updated_at: z.number(),
      deleted: z.boolean(),
      revision_count: z.number(),
      latest_revision: z
        .looseObject({
          id: z.string(),
          display_number: z.number(),
          message: z.string().nullable(),
          created_at: z.number(),
          sync_state: z.enum(["pending", "committed", "synced", "failed"]),
          head_path: z.string(),
          file_count: z.number(),
        })
        .nullable(),
      latest_url: z.string(),
      match: z.enum(["id", "title", "metadata"]).nullable(),
    }),
  ),
  next_cursor: z.string().nullable(),
}) satisfies z.ZodType<SearchCollectionsResponse>;
const listRevisionsResult = z.looseObject({
  revisions: z.array(revisionSummary),
}) satisfies z.ZodType<ListRevisionsResponse>;
const resolveResult = z
  .looseObject({
    collection_id: z.string(),
    revision_id: z.string().optional(),
    path: z.string().optional(),
  })
  .transform((value) => ({
    collection_id: value.collection_id,
    ...(value.revision_id === undefined ? {} : { revision_id: value.revision_id }),
    ...(value.path === undefined ? {} : { path: value.path }),
  })) satisfies z.ZodType<ResolveResponse>;
const statusResult = z.looseObject({
  environment: z.enum(["dev", "prod"]),
  queue: z.looseObject({
    pending_collections: z.number(),
    pending_revisions: z.number(),
    failed_revisions: z.number(),
    pending_blobs: z.number(),
    pending_renditions: z.number(),
    rerender_pending: z.number().optional(),
    pending_snapshots: z.number(),
    pending_r2_deletes: z.number(),
    pending_purges: z.number(),
    unpushed: z.number(),
  }),
  oldest_pending_age_ms: z.number().nullable(),
  failed_items: z.array(
    z.looseObject({
      id: z.string(),
      created_at: z.number(),
      last_error: z.string().nullable(),
      error_kind: z.string().nullable(),
      collection_public_id: z.string().nullable(),
    }),
  ),
  pending_items: z.array(z.object({ id: z.string(), collection_public_id: z.string().nullable() })),
  sync_enabled: z.boolean(),
  queue_errors: z.array(z.object({ kind: z.string(), id: z.string(), last_error: z.string() })),
  last_upload_at: z.number().nullable(),
  last_push_at: z.number().nullable(),
  last_pull_at: z.number().nullable(),
  last_error: z.string().nullable(),
  sync_verified: z.boolean(),
  sync_blocked: z.boolean(),
  account_paused: z.boolean(),
  account_error: z.string().nullable(),
  version: z.string().optional(),
  sha: z.string().nullable().optional(),
  warnings: z.array(z.looseObject({ code: z.string(), message: z.string() })).optional(),
}) satisfies z.ZodType<StatusResponse>;
const CACHE_TTL_MS = 10 * 60_000;
interface CachedIds {
  collectionId?: string;
  revisionId: string;
  parentId?: string;
  expires: number;
}
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Tool call aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Tool call aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
function object(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Tool call aborted");
}
function urlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
function requestFiles(files: PreparedFile[]): Array<{ path: string; hash: string; mime: string }> {
  return files.map(({ path, hash, mime }) => ({ path, hash, mime }));
}
function manifestFiles(files: PreparedFile[]): Record<string, ManifestEntry> {
  return Object.fromEntries(
    files.map(({ path, hash, mime, size }) => {
      if (!isContentHash(hash)) throw new Error(`Invalid content hash: ${hash}`);
      return [path, { hash, mime, size }];
    }),
  );
}
function parentFiles(revision: RevisionDetail): Record<string, ManifestEntry> {
  return Object.fromEntries(
    revision.files.map((file) => {
      if (!isContentHash(file.hash)) throw new Error(`Invalid content hash: ${file.path}`);
      return [file.path, { hash: file.hash, mime: file.mime, size: file.size }];
    }),
  );
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const headerSafe = (value: string) => value.replace(/[^\w.@+-]/g, "").slice(0, 60);
export class WaypointClient {
  readonly base: string;
  private readonly ids = new Map<string, CachedIds>();
  private readonly pendingAdds = new Map<
    string,
    Promise<{ ids: CachedIds; selected: CollectionDetail }>
  >();
  /** The MCP client's name (for example "claude-code"), learned at initialization (B5). */
  clientName: string | null = null;
  readonly sourceHost: string;
  readonly limits: Limits;
  readonly fetcher: typeof fetch;
  readonly retryBudgetMs: number;
  readonly requestTimeoutMs: number;
  constructor(
    base: string,
    sourceHost: string,
    limits: Limits = DEFAULT_LIMITS,
    fetcher: typeof fetch = fetch,
    retryBudgetMs = 25_000,
    requestTimeoutMs = 30_000,
  ) {
    this.sourceHost = sourceHost;
    this.limits = limits;
    this.fetcher = fetcher;
    this.retryBudgetMs = retryBudgetMs;
    this.requestTimeoutMs = requestTimeoutMs;
    withBase(base, "/api/status");
    this.base = base;
  }
  /** "agent/host" for X-Waypoint-Client, so Status can show who is waiting (B5). */
  clientLabel(): string {
    return `${headerSafe(this.clientName ?? "") || "agent"}/${headerSafe(this.sourceHost) || "unknown"}`;
  }
  private url(path: string): string {
    const [route, query] = path.split("?", 2);
    const url = new URL(withBase(this.base, route ?? ""));
    if (query !== undefined) url.search = `?${query}`;
    return url.toString();
  }
  private async request(
    path: string,
    init: (RequestInit & { duplex?: "half" }) | (() => RequestInit & { duplex?: "half" }) = {},
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
    retryBudgetMs = this.retryBudgetMs,
  ): Promise<Response> {
    const deadline = Date.now() + retryBudgetMs;
    let attempt = 0;
    for (;;) {
      abortIfNeeded(signal);
      const remaining = deadline - Date.now();
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining)));
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        const options = typeof init === "function" ? init() : init;
        const headers = new Headers(options.headers);
        headers.set("X-Waypoint-Client", this.clientLabel());
        response = await this.fetcher(this.url(path), { ...options, headers, signal: combined });
      } catch (error) {
        abortIfNeeded(signal);
        if (Date.now() >= deadline || attempt >= 10)
          throw new Error(
            `Network request failed after retries: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        await sleep(Math.min(this.backoff(attempt++), Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      if (response.ok) return response;
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      if (retryable && Date.now() < deadline && attempt < 10) {
        const wait = retryAfter(response.headers.get("retry-after")) ?? this.backoff(attempt);
        await response.body?.cancel();
        await sleep(Math.min(wait, Math.max(0, deadline - Date.now())), signal);
        attempt++;
        continue;
      }
      const raw = (await response.text()).slice(0, 4096);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const envelope =
        typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
      if (
        typeof envelope === "object" &&
        envelope !== null &&
        "code" in envelope &&
        "message" in envelope &&
        typeof envelope.code === "string" &&
        typeof envelope.message === "string"
      ) {
        const details =
          "details" in envelope &&
          typeof envelope.details === "object" &&
          envelope.details !== null &&
          !Array.isArray(envelope.details)
            ? object(envelope.details)
            : {};
        throw new ApiError(envelope.code, envelope.message, details, response.status);
      }
      throw new ApiError(
        "http_error",
        `HTTP ${response.status}${raw ? `: ${raw}` : `: ${response.statusText}`}`,
        {},
        response.status,
      );
    }
  }
  private backoff(attempt: number): number {
    return Math.min(5000, 250 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
  }
  private async json(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      },
      signal,
    );
    return response.json();
  }
  private withIds(error: unknown, ids: CachedIds, signal?: AbortSignal): Error {
    abortIfNeeded(signal);
    const label = `collection_id=${ids.collectionId ?? "unknown"}, revision_id=${ids.revisionId}`;
    if (error instanceof ApiError) {
      if (error.status === 408 || error.status === 429 || error.status >= 500)
        return new ApiError(
          error.code,
          `${error.message}; minted ${label}`,
          { ...error.details, collection_id: ids.collectionId, revision_id: ids.revisionId },
          error.status,
        );
      return error;
    }
    return new Error(`${error instanceof Error ? error.message : String(error)}; minted ${label}`);
  }
  private async write(
    path: string,
    body: unknown,
    ids: CachedIds,
    signal?: AbortSignal,
  ): Promise<WriteOutcome> {
    try {
      const response = await this.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        signal,
      );
      const rawText = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        raw = rawText;
      }
      const parsed = writeResult.safeParse(raw);
      if (parsed.success) return parsed.data;
      return {
        collection_id: ids.collectionId ?? "",
        revision_id: ids.revisionId,
        warning: "Writer accepted the write, but its response did not match WriteResult",
        raw_response: raw,
      };
    } catch (error) {
      throw this.withIds(error, ids, signal);
    }
  }
  private fileStream(path: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    const iterator = createReadStream(path)[Symbol.asyncIterator]();
    return new ReadableStream({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else {
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid file stream chunk");
          controller.enqueue(new Uint8Array(chunk));
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
  private async upload(files: PreparedFile[], signal?: AbortSignal): Promise<void> {
    if (!files.length) return;
    const unique = new Map(files.map((file) => [file.hash, file]));
    const checked = object(
      await this.json("/api/blobs/check", "POST", { hashes: [...unique.keys()] }, signal),
    );
    for (const hash of z.array(z.string()).parse(checked.missing)) {
      const file = unique.get(hash);
      if (!file) throw new Error(`Writer requested an unknown hash: ${hash}`);
      await this.request(
        `/api/blobs/${encodeURIComponent(hash)}`,
        () => ({
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.bytes ?? this.fileStream(file.sourcePath ?? ""),
          duplex: "half",
        }),
        signal,
        Math.max(this.requestTimeoutMs, Math.ceil(file.size / (1024 * 1024)) * 2000),
      );
    }
  }
  private metadata(metadata?: Record<string, unknown>): Record<string, unknown> {
    return { source_host: this.sourceHost, ...metadata };
  }
  private async fingerprint(input: unknown): Promise<string> {
    return hashBytes(new TextEncoder().encode(JSON.stringify(canonical(input))));
  }
  private cached(key: string): CachedIds | undefined {
    const now = Date.now();
    for (const [oldKey, value] of this.ids) if (value.expires <= now) this.ids.delete(oldKey);
    return this.ids.get(key);
  }
  private discardOnDefiniteFailure(key: string, error: unknown): void {
    if (
      error instanceof WaypointError ||
      (error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429)
    )
      this.ids.delete(key);
  }
  async create(input: CreateInput, signal?: AbortSignal): Promise<WriteOutcome> {
    const files = await prepareFiles(input.files, input.source_dir, this.limits, signal);
    buildManifest({
      mode: "replace",
      files: manifestFiles(files),
      ...(input.head_path ? { headPath: input.head_path } : {}),
      limits: this.limits,
    });
    const key = await this.fingerprint({
      tool: "create_collection",
      title: input.title,
      head_path: input.head_path,
      message: input.message,
      metadata: input.metadata,
      files: requestFiles(files).toSorted((a, b) => a.path.localeCompare(b.path)),
    });
    const ids = this.cached(key) ?? {
      collectionId: newId("col"),
      revisionId: mintRevisionId({ now: Date.now() }),
      expires: Date.now() + CACHE_TTL_MS,
    };
    ids.collectionId ??= newId("col");
    this.ids.set(key, ids);
    try {
      await this.upload(files, signal);
    } catch (error) {
      this.discardOnDefiniteFailure(key, error);
      throw this.withIds(error, ids, signal);
    }
    const body: CreateCollectionRequest = {
      collection_id: ids.collectionId,
      revision_id: ids.revisionId,
      title: input.title,
      files: requestFiles(files),
      metadata: this.metadata(input.metadata),
      ...(input.head_path ? { head_path: input.head_path } : {}),
      ...(input.message ? { message: input.message } : {}),
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.write("/api/collections", body, ids, signal);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["clock_skew", "stale_id"].includes(error.code) ||
          attempt === 3
        ) {
          this.discardOnDefiniteFailure(key, error);
          throw error;
        }
        ids.collectionId = newId("col");
        ids.revisionId = mintRevisionId({ now: Date.now() });
        body.collection_id = ids.collectionId;
        body.revision_id = ids.revisionId;
      }
    }
    throw new Error("Could not create collection");
  }
  async add(input: AddInput, signal?: AbortSignal): Promise<WriteOutcome> {
    input = { ...input, collection_id: await this.collectionId(input.collection_id, signal) };
    parseId(input.collection_id, "col");
    if (input.parent_revision_id) parseId(input.parent_revision_id, "rev");
    const files = await prepareFiles(input.files, input.source_dir, this.limits, signal);
    const remove = input.remove?.map(validatePath) ?? [];
    if (files.some(({ path }) => remove.includes(path)))
      throw new WaypointError("validation_failed", "A path cannot appear in files and remove");
    const key = await this.fingerprint({
      tool: "add_revision",
      collection_id: input.collection_id,
      parent_revision_id: input.parent_revision_id,
      mode: input.mode ?? "merge",
      remove: remove.toSorted(),
      head_path: input.head_path,
      message: input.message,
      metadata: input.metadata,
      files: requestFiles(files).toSorted((a, b) => a.path.localeCompare(b.path)),
    });
    const cached = this.cached(key);
    let ids: CachedIds;
    let selected: CollectionDetail;
    if (cached) {
      try {
        const latest = await this.getCollection(input.collection_id, undefined, signal);
        const latestId = latest.latest_revision?.id;
        if (
          !input.parent_revision_id &&
          latestId !== cached.revisionId &&
          latestId !== cached.parentId
        ) {
          this.ids.delete(key);
        } else {
          ids = cached;
          selected = await this.getCollection(input.collection_id, cached.parentId, signal);
        }
      } catch (error) {
        this.discardOnDefiniteFailure(key, error);
        throw error;
      }
    }
    if (!this.ids.has(key)) {
      let pending = this.pendingAdds.get(key);
      if (!pending) {
        pending = this.getCollection(input.collection_id, input.parent_revision_id, signal).then(
          (detail) => {
            if (!detail.revision)
              throw new WaypointError("parent_not_found", "Collection has no latest revision");
            const minted: CachedIds = {
              revisionId: mintRevisionId({ now: Date.now(), parentId: detail.revision.id }),
              parentId: detail.revision.id,
              expires: Date.now() + CACHE_TTL_MS,
            };
            this.ids.set(key, minted);
            return { ids: minted, selected: detail };
          },
        );
        this.pendingAdds.set(key, pending);
        void pending.then(
          () => this.pendingAdds.delete(key),
          () => this.pendingAdds.delete(key),
        );
      }
      ({ ids, selected } = await pending);
    } else {
      ids = ids!;
      selected = selected!;
    }
    const revision = selected.revision;
    if (!revision) throw new WaypointError("parent_not_found", "Collection has no latest revision");
    const parentId = revision.id;
    try {
      buildManifest({
        mode: input.mode ?? "merge",
        parent: { headPath: revision.head_path, files: parentFiles(revision) },
        files: manifestFiles(files),
        remove,
        ...(input.head_path ? { headPath: input.head_path } : {}),
        limits: this.limits,
      });
      try {
        await this.upload(files, signal);
      } catch (error) {
        this.discardOnDefiniteFailure(key, error);
        throw this.withIds(error, { ...ids, collectionId: input.collection_id }, signal);
      }
      const body: AddRevisionRequest = {
        revision_id: ids.revisionId,
        parent_revision_id: parentId,
        mode: input.mode ?? "merge",
        files: requestFiles(files),
        metadata: this.metadata(input.metadata),
        remove,
        ...(input.head_path ? { head_path: input.head_path } : {}),
        ...(input.message ? { message: input.message } : {}),
      };
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await this.write(
            `/api/collections/${input.collection_id}/revisions`,
            body,
            { ...ids, collectionId: input.collection_id },
            signal,
          );
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            !["id_before_parent", "clock_skew", "stale_id"].includes(error.code) ||
            attempt === 3
          ) {
            this.discardOnDefiniteFailure(key, error);
            throw error;
          }
          const parentTimestamp = error.details.parent_timestamp;
          const now =
            error.code === "id_before_parent" && typeof parentTimestamp === "number"
              ? Math.max(Date.now(), parentTimestamp + 1, idTimestamp(parentId) + 1)
              : Date.now();
          ids.revisionId = mintRevisionId({ now, parentId });
          body.revision_id = ids.revisionId;
        }
      }
      throw new Error("Could not add revision");
    } catch (error) {
      this.discardOnDefiniteFailure(key, error);
      throw error;
    }
  }
  async getCollection(
    id: string,
    revisionId?: string,
    signal?: AbortSignal,
    includeHead = false,
  ): Promise<CollectionDetail> {
    id = await this.collectionId(id, signal);
    if (revisionId) parseId(revisionId, "rev");
    const params = new URLSearchParams();
    if (revisionId) params.set("revision_id", revisionId);
    if (includeHead) params.set("include_head", "1");
    const collection = collectionDetail.parse(
      await this.json(
        `/api/collections/${id}${params.size ? `?${params.toString()}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
    );
    const revision = collection.revision;
    if (revision && revision.collection_id !== id)
      throw new WaypointError(
        "not_found",
        `Revision ${revision.id} does not belong to collection ${id}`,
      );
    return { ...collection, revision };
  }
  private async collectionId(input: string, signal?: AbortSignal): Promise<string> {
    if (input.startsWith("col_")) return parseId(input, "col");
    if (/^[0-9a-hjkmnp-tv-z]{12}$/i.test(input)) {
      const detail = collectionDetail.parse(
        await this.json(`/api/collections/${input.toLowerCase()}`, "GET", undefined, signal),
      );
      return detail.id;
    }
    const result = resolveResult.parse(await this.resolve(input, signal));
    return result.collection_id;
  }
  searchCollections(
    options: {
      query?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      updated_after?: string | number | undefined;
      sort?: "updated" | "created" | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
      include_deleted?: boolean | undefined;
    },
    signal?: AbortSignal,
  ): Promise<SearchCollectionsResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
      if (value !== undefined)
        params.set(
          key,
          key === "metadata"
            ? JSON.stringify(value)
            : typeof value === "string"
              ? value
              : typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : "",
        );
    return this.json(`/api/collections?${params.toString()}`, "GET", undefined, signal).then(
      (value) => searchCollectionsResult.parse(value),
    );
  }
  async listRevisions(id: string, signal?: AbortSignal): Promise<unknown> {
    id = await this.collectionId(id, signal);
    return this.json(`/api/collections/${id}/revisions`, "GET", undefined, signal).then((value) =>
      listRevisionsResult.parse(value),
    );
  }
  async waitForRevision(
    id: string,
    after: string,
    seconds = 30,
    signal?: AbortSignal,
  ): Promise<WaitForRevisionResponse> {
    id = await this.collectionId(id, signal);
    parseId(after, "rev");
    const params = new URLSearchParams({ after, wait: String(seconds) });
    const response = await this.request(
      `/api/collections/${id}/revisions?${params.toString()}`,
      {},
      signal,
      (seconds + 5) * 1000,
      (seconds + 5) * 1000,
    );
    return z
      .looseObject({ changed: z.boolean(), revisions: z.array(revisionSummary) })
      .parse(await response.json());
  }
  resolve(url: string, signal?: AbortSignal): Promise<unknown> {
    return this.json("/api/resolve", "POST", { url }, signal).then((value) =>
      resolveResult.parse(value),
    );
  }
  status(signal?: AbortSignal): Promise<StatusResponse> {
    return this.json("/api/status", "GET", undefined, signal).then((value) =>
      statusResult.parse(value),
    );
  }
  async readFile(
    collectionId: string,
    path: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const selected = await this.getCollection(collectionId, revisionId, signal);
    collectionId = selected.id;
    const revision = selected.revision;
    if (!revision) throw new WaypointError("not_found", "Collection has no revision");
    const normalized = validatePath(path);
    const file = revision.files.find((entry) => entry.path === normalized);
    if (!file) throw new WaypointError("not_found", `File not found: ${normalized}`);
    const metadata = {
      collection_id: collectionId,
      revision_id: revision.id,
      path: normalized,
      mime: file.mime,
      size: file.size,
      url: file.url,
    };
    if (!isTextMime(file.mime)) return metadata;
    const response = await this.request(
      `/api/revisions/${revision.id}/files/${urlPath(normalized)}?source`,
      {},
      signal,
    );
    const max = 256 * 1024;
    const reader = response.body?.getReader();
    if (!reader) return { ...metadata, content: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      abortIfNeeded(signal);
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid response stream chunk");
      if (total + chunk.length > max) {
        chunks.push(chunk.slice(0, max - total));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
    const bytes = Buffer.concat(chunks);
    return {
      ...metadata,
      content: new TextDecoder().decode(bytes, { stream: truncated }),
      ...(truncated ? { truncated: true, note: "Text truncated at 256 KB" } : {}),
    };
  }
}
