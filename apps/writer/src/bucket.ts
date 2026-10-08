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
    this.client = new S3Client({
      endpoint: options.endpoint ?? `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
      region: "auto",
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
