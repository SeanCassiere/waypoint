import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type { Config } from "./config.ts";

export interface Bucket {
  putIfAbsent(
    key: string,
    body: Uint8Array | (() => Readable),
    options: {
      contentType: string;
      contentLength: number;
      checksumSHA256?: string;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  put(key: string, body: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Readable>;
  head(key: string, signal?: AbortSignal): Promise<boolean>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  list(prefix: string): Promise<string[]>;
  listPages(prefix: string): AsyncIterable<string[]>;
}

export class BucketError extends Error {
  readonly kind: "transient" | "permanent" | "account";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(
    message: string,
    kind: "transient" | "permanent" | "account",
    status?: number,
    code?: string,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !filterMetadata(error)) return undefined;
  return error.$metadata.httpStatusCode;
}
function filterMetadata(error: object): error is { $metadata: { httpStatusCode?: number } } {
  return "$metadata" in error && typeof error.$metadata === "object" && error.$metadata !== null;
}
export function bucketError(error: unknown): BucketError {
  const status = statusOf(error);
  const code =
    error && typeof error === "object" && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  const kind =
    status === 401 || status === 403 || (status === 404 && code === "NoSuchBucket")
      ? "account"
      : status === undefined ||
          status === 408 ||
          status === 409 ||
          status === 429 ||
          status >= 500 ||
          /RequestTimeout|ConditionalRequestConflict|Timeout|AbortError/i.test(code)
        ? "transient"
        : "permanent";
  return new BucketError(
    `Bucket request failed${status ? ` (${status})` : ""}${code ? `: ${code}` : ""}`,
    kind,
    status,
    code,
  );
}

export class R2Bucket implements Bucket {
  private client: S3Client;
  private name: string;
  private retryDelay: () => number;
  private readTimeoutMs: number;
  constructor(
    config: Config,
    options: {
      endpoint?: string;
      requestTimeoutMs?: number;
      connectionTimeoutMs?: number;
      retryDelay?: () => number;
      readTimeoutMs?: number;
    } = {},
  ) {
    this.name = config.r2Bucket!;
    const endpoint =
      options.endpoint ??
      config.s3Endpoint ??
      (config.r2AccountId ? `https://${config.r2AccountId}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint) throw new Error("WAYPOINT_S3_ENDPOINT or R2_ACCOUNT_ID is required");
    this.client = new S3Client({
      endpoint,
      region: config.s3Region ?? "auto",
      // Path-style (`<endpoint>/<bucket>/<key>`) works with R2, MinIO and most S3-compatible
      // stores, and needs no per-bucket DNS name.
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: new NodeHttpHandler({
        connectionTimeout: options.connectionTimeoutMs ?? 5000,
        requestTimeout: options.requestTimeoutMs ?? 120_000,
        throwOnRequestTimeout: true,
      }),
      credentials: {
        accessKeyId: config.r2AccessKeyId!,
        secretAccessKey: config.r2SecretAccessKey!,
      },
      maxAttempts: 1,
    });
    this.retryDelay = options.retryDelay ?? (() => 100 + Math.floor(Math.random() * 200));
    this.readTimeoutMs = options.readTimeoutMs ?? 30_000;
  }
  async putIfAbsent(
    key: string,
    body: Uint8Array | (() => Readable),
    options: {
      contentType: string;
      contentLength: number;
      checksumSHA256?: string;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.name,
            Key: key,
            Body: typeof body === "function" ? body() : body,
            ContentType: options.contentType,
            ContentLength: options.contentLength,
            ...(options.checksumSHA256 ? { ChecksumSHA256: options.checksumSHA256 } : {}),
            IfNoneMatch: "*",
          }),
          options.signal ? { abortSignal: options.signal } : {},
        );
        return;
      } catch (error) {
        const status = statusOf(error);
        if (status === 412) return;
        if (status === 429 && attempt === 0) {
          await delay(this.retryDelay(), undefined, { signal: options.signal });
          continue;
        }
        throw bucketError(error);
      }
    }
  }
  async put(key: string, body: Uint8Array, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.name, Key: key, Body: body }),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      throw bucketError(error);
    }
  }
  async get(key: string, signal?: AbortSignal): Promise<Readable> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.name, Key: key }), {
        abortSignal: controller.signal,
      });
      if (!result.Body) throw new BucketError("Bucket object has no body", "permanent");
      const source = Readable.fromWeb(result.Body.transformToWebStream());
      const timeoutMs = this.readTimeoutMs;
      return Readable.from(
        (async function* () {
          const iterator = source[Symbol.asyncIterator]();
          try {
            for (;;) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const next = await Promise.race([
                  iterator.next(),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      reject(new BucketError("Bucket read timed out", "transient"));
                    }, timeoutMs);
                  }),
                ]);
                if (timer) {
                  clearTimeout(timer);
                  timer = undefined;
                }
                if (next.done) return;
                yield next.value;
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          } catch (error) {
            throw error instanceof BucketError ? error : bucketError(error);
          } finally {
            source.destroy();
            signal?.removeEventListener("abort", onAbort);
          }
        })(),
      );
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw error instanceof BucketError ? error : bucketError(error);
    }
  }
  async head(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.name, Key: key }),
        signal ? { abortSignal: signal } : {},
      );
      return true;
    } catch (error) {
      if (statusOf(error) === 404 && bucketError(error).kind !== "account") return false;
      throw bucketError(error);
    }
  }
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.name, Key: key }),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      throw bucketError(error);
    }
  }
  async *listPages(prefix: string): AsyncIterable<string[]> {
    let token: string | undefined;
    do {
      try {
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.name, Prefix: prefix, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
        yield keys;
        token = page.NextContinuationToken;
      } catch (error) {
        throw bucketError(error);
      }
    } while (token);
  }
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const page of this.listPages(prefix)) keys.push(...page);
    return keys;
  }
}

const abortedRequest = () =>
  new BucketError("Bucket request aborted", "transient", undefined, "AbortError");

/** The bucket object recording which environment (dev or prod) owns the bucket (D54). */
export const ENVIRONMENT_MARKER_KEY = "meta/environment.json";

/**
 * A bucket that checks its environment marker before the first request, so a dev writer never
 * reads from or uploads into a prod bucket (or the reverse), whatever the bucket is called.
 *
 * A bucket without a marker (one that predates it, or a new one) gets one written, never a
 * failure. A marker naming another environment is an "account" error: the committer pauses and
 * retries it like a revoked token, `restore` refuses, and /status shows the reason. Only a
 * successful check is remembered; a failed or unreachable one runs again on the next request.
 */
export class EnvironmentCheckedBucket implements Bucket {
  readonly inner: Bucket;
  readonly environment: "dev" | "prod";
  private checked: Promise<void> | undefined;
  private now: () => number;
  constructor(inner: Bucket, environment: "dev" | "prod", now: () => number = Date.now) {
    this.inner = inner;
    this.environment = environment;
    this.now = now;
  }
  /**
   * Resolves once the marker matches this writer's environment. The check is shared and runs
   * without any caller's abort signal, so one caller giving up doesn't fail it for the others; a
   * caller's signal only stops that caller waiting for it (a stopping committer isn't held up).
   */
  verify(signal?: AbortSignal): Promise<void> {
    // Before starting a check: one started for a caller that has already given up would have
    // nobody to handle its failure (an unhandled rejection ends the process mid-shutdown).
    if (signal?.aborted) return Promise.reject(abortedRequest());
    this.checked ??= this.check().catch((error: unknown) => {
      this.checked = undefined;
      throw error;
    });
    if (!signal) return this.checked;
    const checked = this.checked;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortedRequest());
      signal.addEventListener("abort", onAbort, { once: true });
      checked.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
  private async readMarker(): Promise<string | undefined> {
    if (!(await this.inner.head(ENVIRONMENT_MARKER_KEY))) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of await this.inner.get(ENVIRONMENT_MARKER_KEY)) {
      const value: unknown = chunk;
      if (typeof value === "string") chunks.push(Buffer.from(value));
      else if (value instanceof Uint8Array) chunks.push(value);
      // A marker is a few dozen bytes; anything large isn't one.
      if (chunks.reduce((total, part) => total + part.byteLength, 0) > 4096) break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("environment" in parsed) ||
      typeof parsed.environment !== "string"
    )
      throw new BucketError(
        `Bucket environment marker ${ENVIRONMENT_MARKER_KEY} is unreadable`,
        "account",
      );
    return parsed.environment;
  }
  /**
   * The check's errors reach whichever request triggered it, so none of them may read as a
   * problem with that request: a "permanent" one (say the marker deleted between readMarker's
   * HEAD and GET) would fail the revision being uploaded and its children. Anything that isn't
   * already transient is a bucket problem, reported like one ("account": retried, on /status).
   */
  private async check(): Promise<void> {
    try {
      await this.checkMarker();
    } catch (error) {
      if (error instanceof BucketError && (error.kind === "account" || error.kind === "transient"))
        throw error;
      throw new BucketError(
        `Bucket environment marker check failed: ${error instanceof Error ? error.message : String(error)}`,
        "account",
        error instanceof BucketError ? error.status : undefined,
        error instanceof BucketError ? error.code : undefined,
      );
    }
  }
  private async checkMarker(): Promise<void> {
    let marker = await this.readMarker();
    if (marker === undefined) {
      const body = new TextEncoder().encode(
        `${JSON.stringify({
          format_version: 1,
          environment: this.environment,
          created_at: this.now(),
        })}\n`,
      );
      // If-None-Match: when two writers race, one marker wins and both read it back.
      await this.inner.putIfAbsent(ENVIRONMENT_MARKER_KEY, body, {
        contentType: "application/json",
        contentLength: body.byteLength,
      });
      marker = await this.readMarker();
    }
    if (marker !== this.environment)
      throw new BucketError(
        `Environment mismatch: bucket is marked ${marker ?? "missing"}, config is ${this.environment}`,
        "account",
      );
  }
  async putIfAbsent(...args: Parameters<Bucket["putIfAbsent"]>): Promise<void> {
    await this.verify(args[2].signal);
    return this.inner.putIfAbsent(...args);
  }
  async put(key: string, body: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.verify(signal);
    return this.inner.put(key, body, signal);
  }
  async get(key: string, signal?: AbortSignal): Promise<Readable> {
    await this.verify(signal);
    return this.inner.get(key, signal);
  }
  async head(key: string, signal?: AbortSignal): Promise<boolean> {
    await this.verify(signal);
    return this.inner.head(key, signal);
  }
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.verify(signal);
    return this.inner.delete(key, signal);
  }
  async list(prefix: string): Promise<string[]> {
    await this.verify();
    return this.inner.list(prefix);
  }
  async *listPages(prefix: string): AsyncIterable<string[]> {
    await this.verify();
    yield* this.inner.listPages(prefix);
  }
}

/** The writer's bucket: S3-compatible storage behind the environment marker check. */
export function openBucket(config: Config): EnvironmentCheckedBucket {
  return new EnvironmentCheckedBucket(new R2Bucket(config), config.environment);
}

export class MemoryBucket implements Bucket {
  readonly objects = new Map<string, Uint8Array>();
  fail?: BucketError;
  private check(): void {
    if (this.fail) throw this.fail;
  }
  async putIfAbsent(key: string, body: Uint8Array | (() => Readable)): Promise<void> {
    this.check();
    if (!this.objects.has(key)) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of typeof body === "function" ? body() : Readable.from([body])) {
        const value: unknown = chunk;
        if (typeof value === "string") chunks.push(new TextEncoder().encode(value));
        else if (value instanceof Uint8Array) chunks.push(value);
        else throw new Error("Invalid fake bucket body");
      }
      this.objects.set(key, Buffer.concat(chunks));
    }
  }
  put(key: string, body: Uint8Array): Promise<void> {
    this.check();
    this.objects.set(key, Uint8Array.from(body));
    return Promise.resolve();
  }
  get(key: string): Promise<Readable> {
    this.check();
    const body = this.objects.get(key);
    if (!body) throw new BucketError("Bucket object missing", "permanent", 404, "NoSuchKey");
    return Promise.resolve(Readable.from([body]));
  }
  head(key: string): Promise<boolean> {
    this.check();
    return Promise.resolve(this.objects.has(key));
  }
  delete(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
    return Promise.resolve();
  }
  list(prefix: string): Promise<string[]> {
    this.check();
    return Promise.resolve(
      [...this.objects.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
    );
  }
  async *listPages(prefix: string): AsyncIterable<string[]> {
    const keys = await this.list(prefix);
    for (let offset = 0; offset < keys.length; offset += 1000)
      yield keys.slice(offset, offset + 1000);
  }
}
