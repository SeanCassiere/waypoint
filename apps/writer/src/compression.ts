import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import type { MiddlewareHandler } from "hono";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Below this, compression saves less than the header and the CPU cost it adds. */
export const MIN_COMPRESS_BYTES = 1024;
/** Larger bodies (big raw files) are sent as they are rather than buffered and compressed. */
export const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;
const TEXT =
  /^(?:text\/[\w.+-]+|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)\s*(?:;|$)/i;

function encodingFor(accept: string | undefined): "br" | "gzip" | null {
  if (!accept) return null;
  const offered = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
    offered.set(name, q === undefined ? 1 : Number(q));
  }
  const allowed = (name: string) => (offered.get(name) ?? offered.get("*") ?? 0) > 0;
  return allowed("br") ? "br" : allowed("gzip") ? "gzip" : null;
}

/** Compressed bodies of immutable responses (strong ETag or immutable cache), by size. */
class CompressedCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.maxBytes / 4 || this.entries.has(key)) return;
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    for (const [oldest, bytes] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= bytes.byteLength;
    }
  }
}

/**
 * Compresses text responses (viewer HTML, CSS, JS, JSON, text renditions) with Brotli or gzip.
 * Images, other binary blobs, ranges and the MCP launcher's downloads are left alone. A
 * compressed response's ETag becomes weak (same content, different bytes), which the
 * If-None-Match checks accept, and `Vary: Accept-Encoding` keeps caches apart.
 */
export function compression(options: { cacheBytes?: number } = {}): MiddlewareHandler {
  const cache = new CompressedCache(options.cacheBytes ?? 16 * 1024 * 1024);
  return async (c, next) => {
    await next();
    if (c.req.method !== "GET") return;
    // The MCP launcher verifies and ETag-caches its downloads byte for byte; leave them exact.
    if (c.req.path.startsWith("/mcp/")) return;
    const response = c.res;
    const headers = response.headers;
    if (
      response.status !== 200 ||
      !response.body ||
      headers.has("content-encoding") ||
      headers.has("content-range") ||
      !TEXT.test(headers.get("content-type") ?? "") ||
      /\bno-transform\b/i.test(headers.get("cache-control") ?? "") ||
      headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
    )
      return;
    const length = Number(headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(length) && (length < MIN_COMPRESS_BYTES || length > MAX_COMPRESS_BYTES))
      return;
    const vary = headers.get("vary");
    const varied = vary
      ? /\baccept-encoding\b/i.test(vary)
        ? vary
        : `${vary}, Accept-Encoding`
      : "Accept-Encoding";
    const encoding = encodingFor(c.req.header("accept-encoding"));
    if (!encoding) {
      headers.set("vary", varied);
      return;
    }
    const body = new Uint8Array(await response.arrayBuffer());
    // Hono copies the old response's headers onto a replacement, so headers are set after it.
    if (body.byteLength < MIN_COMPRESS_BYTES || body.byteLength > MAX_COMPRESS_BYTES) {
      c.res = new Response(body, { status: response.status, headers });
      c.res.headers.set("vary", varied);
      return;
    }
    const etag = headers.get("etag");
    const immutable = /\bimmutable\b/i.test(headers.get("cache-control") ?? "");
    const key =
      etag && !etag.startsWith("W/")
        ? `${encoding}|${etag}`
        : immutable
          ? `${encoding}|${c.req.path}`
          : null;
    let compressed = key ? cache.get(key) : undefined;
    if (!compressed) {
      compressed =
        encoding === "br"
          ? new Uint8Array(
              await brotli(body, {
                params: {
                  [constants.BROTLI_PARAM_QUALITY]: 5,
                  [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
                },
              }),
            )
          : new Uint8Array(await gzipAsync(body, { level: 6 }));
      if (key) cache.set(key, compressed);
    }
    c.res = new Response(compressed, { status: response.status, headers });
    c.res.headers.set("vary", varied);
    c.res.headers.set("content-encoding", encoding);
    c.res.headers.set("content-length", String(compressed.byteLength));
    if (etag) c.res.headers.set("etag", etag.startsWith("W/") ? etag : `W/${etag}`);
  };
}
