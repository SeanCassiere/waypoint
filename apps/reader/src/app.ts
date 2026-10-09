import {
  buildInfo,
  hashShareToken,
  isShareToken,
  isTextMime,
  parseShareUrl,
  rawContentType,
  shareShellUrl,
  validatePath,
} from "@waypoint/core";
import { encodeLinkPath, renderPublicShell } from "@waypoint/ui";
import { Hono, type Context } from "hono";

import { shellScriptHash, shellStyleHash, staticStyleHash } from "./csp-hashes.ts";
import { deniedPage, frameDeniedPage, rootPage } from "./pages.ts";

export interface ReaderEnv {
  TURSO_DATABASE_URL: string;
  TURSO_READONLY_TOKEN: string;
  /** Cloudflare R2 account; optional when WAYPOINT_S3_ENDPOINT is set. */
  R2_ACCOUNT_ID?: string;
  R2_READER_ACCESS_KEY_ID: string;
  R2_READER_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  RAW_CAP_KEY: string;
  /** S3-compatible endpoint overriding R2's, e.g. `https://minio.example:9000`. */
  WAYPOINT_S3_ENDPOINT?: string;
  /** SigV4 signing region; `auto` (R2) when unset. */
  WAYPOINT_S3_REGION?: string;
  /** The git commit this Worker was deployed from (a Worker variable), for /healthz. */
  WAYPOINT_BUILD_SHA?: string;
  TOKEN_MISS_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  ACCESS_LOG?: {
    writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
  };
}
export interface ReaderDb {
  all<T>(sql: string, args?: (string | number)[]): Promise<T[]>;
}
export interface ReaderBlob {
  fetch(hash: string): Promise<Response>;
  probe(): Promise<Response>;
}
export interface ReaderDeps {
  db(env: ReaderEnv): ReaderDb;
  blob(env: ReaderEnv): ReaderBlob;
  cache?: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
  now?: () => number;
}
type Link = {
  id: string;
  collection_id: string;
  revision_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  public_id: string;
  title: string;
  deleted_at: number | null;
  pinned_public_id: string | null;
  pinned_head_path: string | null;
  pinned_created_at: number | null;
};
type Revision = { id: string; public_id: string; head_path: string; created_at: number };
type File = { path: string; blob_hash: string; mime: string; size?: number | null };
type Rendition = { output_hash: string; output_mime: string; renderer_version: number };
const standard = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private",
};
const rawCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
/**
 * Hash-only CSPs. The hashes are build-time constants (csp-hashes.ts, verified against the exact
 * inline <style> and <script> bodies by tests/reader-csp-hashes.test.ts), so no response,
 * least of all the denial, waits on crypto.
 */
const shellPolicy = `default-src 'none'; style-src ${shellStyleHash}; script-src ${shellScriptHash}; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const staticPolicy = `default-src 'none'; style-src ${staticStyleHash}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
/** The `/x/` denial card's policy: the static one, but the shell (same origin) may frame it. */
const framePolicy = `default-src 'none'; style-src ${staticStyleHash}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
const staticHeaders = (cache: string, policy = staticPolicy): Record<string, string> => ({
  "X-Robots-Tag": standard["X-Robots-Tag"],
  "Referrer-Policy": standard["Referrer-Policy"],
  "X-Content-Type-Options": standard["X-Content-Type-Options"],
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": policy,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": cache,
});
const deniedHeaders = staticHeaders("no-store");
const frameDeniedHeaders = staticHeaders("no-store", framePolicy);
/**
 * One denial per route family (spec §9.2): same status, body and headers for every reason within
 * the family. Build denials only through deniedFor().
 */
const denied = (): Response => new Response(deniedPage, { status: 404, headers: deniedHeaders });
const frameDenied = (): Response =>
  new Response(frameDeniedPage, { status: 404, headers: frameDeniedHeaders });
/**
 * Picks the family from the requested path alone, never from the reason: raw content (`/x/`, shown
 * inside the shell's frame) gets the framable card, everything else the full page.
 */
const deniedFor = (path: string): Response => (path.startsWith("/x/") ? frameDenied() : denied());
/** Content the sandboxed iframe can show; anything else gets the download card. */
const previewable = (mime: string): boolean => isTextMime(mime) || mime.startsWith("image/");
/**
 * How long an isolate trusts a live link lookup. This bounds revocation latency after the
 * writer's push; each isolate queries Turso at most once per link per window.
 */
export const LOOKUP_TTL_MS = 5_000;
/** Lookup entries per isolate before the cache is cleared. */
const LOOKUP_CACHE_MAX = 1_000;
const linkSql =
  "SELECT s.id,s.collection_id,s.revision_id,s.expires_at,s.revoked_at,c.public_id,c.title,t.deleted_at,pr.public_id AS pinned_public_id,pr.head_path AS pinned_head_path,pr.created_at AS pinned_created_at FROM share_links s JOIN collections c ON c.id=s.collection_id LEFT JOIN collection_tombstones t ON t.collection_id=c.id LEFT JOIN revisions pr ON pr.id=s.revision_id AND pr.collection_id=s.collection_id WHERE ";
function decodeRawPath(encoded: string): string {
  if (!encoded || /%(?:2f|5c)/i.test(encoded)) throw new Error("Invalid path");
  const path = encoded.split("/").map(decodeURIComponent).join("/");
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid path");
  return validatePath(path);
}
function keyBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid capability key");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length !== 32) throw new Error("Invalid capability key");
  return bytes;
}
const capKeys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();
async function rawCap(key: string, id: string, revisionPublicId: string): Promise<string> {
  let imported = capKeys.get(key);
  if (!imported) {
    imported = crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes(key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    capKeys.set(key, imported);
  }
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await imported,
      new TextEncoder().encode(`${id}\n${revisionPublicId}`),
    ),
  );
  return btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
    .slice(0, 22);
}
function equalCap(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function logFailure(kind: string, error: unknown): void {
  // Provider error messages can contain signed URLs or credentials.
  const name =
    error instanceof Error ? error.name.replace(/[^A-Za-z]/g, "").slice(0, 40) : "UnknownError";
  const raw = error instanceof Error ? error.message : "request failed";
  const message = /https?:|wps_|sha256:|[?&](?:X-Amz|token|key|sig)|[A-Za-z0-9_-]{43}/i.test(raw)
    ? "[redacted]"
    : raw.slice(0, 160);
  console.error(`${kind}: ${name}: ${message}`);
}
export function createReaderApp(deps: ReaderDeps): Hono<{ Bindings: ReaderEnv }> {
  const app = new Hono<{ Bindings: ReaderEnv }>();
  const lookupCache = new Map<string, { until: number; link: Link | null }>();
  const blockedIps = new Map<string, number>();
  const now = deps.now ?? Date.now;
  /** Counts one denial-equivalent request for this IP; false once the limiter rejects it. */
  async function count(env: ReaderEnv, ip: string): Promise<boolean> {
    try {
      if (env.TOKEN_MISS_LIMITER && !(await env.TOKEN_MISS_LIMITER.limit({ key: ip })).success) {
        // Map insertion order provides a bounded LRU. Expired entries are removed on access.
        blockedIps.delete(ip);
        blockedIps.set(ip, now() + 60_000);
        if (blockedIps.size > 10_000) blockedIps.delete(blockedIps.keys().next().value!);
        return false;
      }
    } catch (error) {
      logFailure("limiter", error);
    }
    return true;
  }
  /** True while this IP is blocked; refreshes its LRU position, drops it once expired. */
  function blocked(ip: string): boolean {
    const until = blockedIps.get(ip);
    if (until === undefined) return false;
    blockedIps.delete(ip);
    if (until <= now()) return false;
    blockedIps.set(ip, until);
    return true;
  }
  async function deny(env: ReaderEnv, ip: string, path: string): Promise<Response> {
    await count(env, ip);
    return deniedFor(path);
  }
  /**
   * Looks up a link by token hash (shell) or link ID (raw). Only live links are cached, for
   * LOOKUP_TTL_MS, so a revocation pushed by the writer takes effect within that window.
   * Misses, revoked links and tombstoned collections are never cached: they always re-query.
   */
  async function lookup(db: ReaderDb, kind: "token" | "id", value: string): Promise<Link | null> {
    const key = kind === "token" ? await hashShareToken(value) : value;
    const cached = lookupCache.get(key);
    if (cached && cached.until > now()) return cached.link;
    if (cached) lookupCache.delete(key);
    const row =
      (await db.all<Link>(`${linkSql}s.${kind === "token" ? "token_hash" : "id"}=?`, [key]))[0] ??
      null;
    if (row && row.revoked_at === null && row.deleted_at === null) {
      if (lookupCache.size >= LOOKUP_CACHE_MAX) lookupCache.clear();
      lookupCache.set(key, { until: now() + LOOKUP_TTL_MS, link: row });
    }
    return row;
  }
  async function blobResponse(
    env: ReaderEnv,
    hash: string,
    origin: string,
    retain: (work: Promise<void>) => void,
  ): Promise<Response> {
    const cache = deps.cache;
    const key = new Request(`${origin}/__internal/blob/${hash}`);
    const hit = await cache?.match(key);
    if (hit) return hit;
    const source = await deps.blob(env).fetch(hash);
    if (source.ok && cache) {
      const copy = new Response(source.body, {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
      // tee() in clone preserves streaming to the client while storing the immutable blob.
      const client = copy.clone();
      retain(cache.put(key, copy).catch(() => undefined));
      return client;
    }
    return source;
  }
  // Health bodies stay exactly `ok` or `fail` (deploy smoke checks compare them); the version and
  // commit ride in headers.
  const healthHeaders = (env: ReaderEnv): Record<string, string> => {
    const build = buildInfo(env.WAYPOINT_BUILD_SHA);
    return {
      ...standard,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Waypoint-Version": build.version,
      ...(build.sha ? { "X-Waypoint-Sha": build.sha } : {}),
    };
  };
  app.get("/healthz", (c) => new Response("ok", { headers: healthHeaders(c.env) }));
  app.get("/healthz/deep", async (c) => {
    // Each deep probe queries Turso and R2, so it counts toward the per-IP limiter like a
    // denial; a blocked IP gets the uniform denial without touching either.
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (blocked(ip) || !(await count(c.env, ip))) return deniedFor(c.req.path);
    try {
      await deps.db(c.env).all("SELECT 1 FROM collections LIMIT 1");
      const result = await deps.blob(c.env).probe();
      if (!result.ok) throw new Error("R2 probe failed");
      return new Response("ok", { headers: healthHeaders(c.env) });
    } catch (error) {
      logFailure("health", error);
      return new Response("fail", { status: 503, headers: healthHeaders(c.env) });
    }
  });
  // The bare root (spec §9.2): a fixed page that confirms nothing, so it is a 200 that uptime
  // checks can probe. Hono answers HEAD from this GET handler with the same headers.
  const rootHeaders = staticHeaders("public, max-age=3600");
  app.get("/", (c) =>
    c.req.path === "/" ? new Response(rootPage, { headers: rootHeaders }) : deniedFor(c.req.path),
  );
  app.get(
    "/robots.txt",
    () =>
      new Response("User-agent: *\nDisallow: /\n", {
        headers: { ...standard, "Content-Type": "text/plain; charset=utf-8" },
      }),
  );
  const serve = async (c: Context<{ Bindings: ReaderEnv }>) => {
    const env = c.env;
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (blocked(ip)) return deniedFor(c.req.path);
    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
    const record = (link: Link, revisionId: string, path: string, status: number): void => {
      try {
        env.ACCESS_LOG?.writeDataPoint({
          indexes: [link.id],
          blobs: [link.collection_id, revisionId, path, String(status), cf?.country ?? ""],
          doubles: [now()],
        });
      } catch {
        // Analytics must not affect content serving.
        return;
      }
    };
    let route: {
      kind: "shell" | "raw";
      token?: string;
      linkId?: string;
      cap?: string;
      collectionPublicId?: string;
      revisionPublicId?: string;
      path?: string;
    };
    try {
      if (c.req.path.startsWith("/x/")) {
        const match =
          /^\/x\/(shl_[a-z0-9]{26})\.([A-Za-z0-9_-]{22})\/r\/([0-9a-hjkmnp-tv-z]{12})\/(.+)$/i.exec(
            c.req.path,
          );
        if (!match) return deny(env, ip, c.req.path);
        route = {
          kind: "raw",
          linkId: match[1]!,
          cap: match[2]!,
          revisionPublicId: match[3]!.toLowerCase(),
          path: decodeRawPath(match[4] ?? ""),
        };
      } else {
        const parsed = parseShareUrl(c.req.path);
        if (parsed.kind !== "shell") return deny(env, ip, c.req.path);
        route = parsed;
      }
    } catch {
      return deny(env, ip, c.req.path);
    }
    if (route.kind === "shell" && (!route.token || !isShareToken(route.token)))
      return deny(env, ip, c.req.path);
    const db = deps.db(env);
    let link: Link | null;
    try {
      link = await lookup(
        db,
        route.kind === "shell" ? "token" : "id",
        route.kind === "shell" ? route.token! : route.linkId!,
      );
    } catch (error) {
      logFailure("Turso", error);
      return deny(env, ip, c.req.path);
    }
    if (!link) return deny(env, ip, c.req.path);
    if (route.kind === "raw") {
      try {
        if (!equalCap(route.cap!, await rawCap(env.RAW_CAP_KEY, link.id, route.revisionPublicId!)))
          return deny(env, ip, c.req.path);
      } catch (error) {
        logFailure("capability", error);
        return deny(env, ip, c.req.path);
      }
    }
    if (
      link.revoked_at !== null ||
      (link.expires_at !== null && link.expires_at <= now()) ||
      link.deleted_at !== null
    ) {
      record(link, link.revision_id ?? "", route.path ?? "", 404);
      return deny(env, ip, c.req.path);
    }
    if (route.kind === "shell" && route.collectionPublicId !== link.public_id) {
      record(link, link.revision_id ?? "", route.path ?? "", 404);
      return deny(env, ip, c.req.path);
    }
    if (route.kind === "shell" && link.revision_id && !route.revisionPublicId) {
      record(link, link.revision_id, route.path ?? "", 404);
      return deny(env, ip, c.req.path);
    }
    const revision = link.revision_id
      ? link.pinned_public_id && link.pinned_head_path && link.pinned_created_at !== null
        ? {
            id: link.revision_id,
            public_id: link.pinned_public_id,
            head_path: link.pinned_head_path,
            created_at: link.pinned_created_at,
          }
        : undefined
      : (
          await db.all<Revision>(
            "SELECT id,public_id,head_path,created_at FROM revisions WHERE collection_id=? ORDER BY id DESC LIMIT 1",
            [link.collection_id],
          )
        )[0];
    if (!revision) {
      record(link, link.revision_id ?? "", route.path ?? "", 404);
      return deny(env, ip, c.req.path);
    }
    if (route.revisionPublicId && route.revisionPublicId !== revision.public_id) {
      record(link, revision.id, route.path ?? "", 404);
      return deny(env, ip, c.req.path);
    }
    const path = route.kind === "shell" ? (route.path ?? revision.head_path) : route.path!;
    try {
      validatePath(path);
    } catch {
      record(link, revision.id, path, 404);
      return deny(env, ip, c.req.path);
    }
    const file = (
      await db.all<File>(
        "SELECT path,blob_hash,mime,size FROM revision_files WHERE revision_id=? AND path=?",
        [revision.id, path],
      )
    )[0];
    if (!file) {
      record(link, revision.id, path, 404);
      return deny(env, ip, c.req.path);
    }
    let status = 200;
    let response: Response;
    if (route.kind === "shell") {
      const files = await db.all<Pick<File, "path">>(
        "SELECT path FROM revision_files WHERE revision_id=? ORDER BY path",
        [revision.id],
      );
      const base = new URL(c.req.url).origin;
      const prefix = shareShellUrl(
        base,
        route.token!,
        link.public_id,
        link.revision_id ? revision.public_id : undefined,
      );
      // Links relative to this page's own URL: smaller, and they don't repeat the share token.
      // The page's folder depth below the shell prefix decides how many "../" to use; a page
      // above it (no trailing slash) falls back to root-relative links.
      const prefixPath = new URL(prefix).pathname;
      const depth = new URL(c.req.url).pathname.split("/").length - prefixPath.split("/").length;
      const linkPrefix = depth < 0 ? prefixPath : depth === 0 ? "./" : "../".repeat(depth);
      const cap = await rawCap(env.RAW_CAP_KEY, link.id, revision.public_id);
      const html = renderPublicShell({
        title: link.title,
        files,
        head: revision.head_path,
        current: path,
        // Relative, minimally encoded links keep a 2,000-file shell small.
        fileHref: (item) => linkPrefix + encodeLinkPath(item),
        frameBase: `${base}/x/${link.id}.${cap}/r/${revision.public_id}/`,
        updatedAt: link.revision_id ? null : revision.created_at,
        snapshotAt: link.revision_id ? revision.created_at : null,
        expiresAt: link.expires_at,
        now: now(),
        download: previewable(file.mime) ? null : { mime: file.mime, size: file.size ?? null },
      });
      response = new Response(html, {
        headers: {
          ...standard,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": shellPolicy,
          "X-Frame-Options": "DENY",
          // Documents may open popups that escape the sandbox; sever their opener to the shell.
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      });
    } else {
      const origin = new URL(c.req.url).origin;
      const retain = (work: Promise<void>): void => {
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          void work;
        }
      };
      let hash = file.blob_hash;
      let mime = file.mime;
      const markdown = mime === "text/markdown";
      if (markdown) {
        const rendition = (
          await db.all<Rendition>(
            "SELECT output_hash,output_mime,renderer_version FROM renditions WHERE source_hash=? AND renderer='markdown' ORDER BY renderer_version DESC LIMIT 1",
            [hash],
          )
        )[0];
        if (rendition) {
          hash = rendition.output_hash;
          mime = rendition.output_mime;
        }
      }
      if (markdown && c.req.header("if-none-match") === `"${hash}"`) {
        const headers = new Headers({
          ...standard,
          "Content-Type": rawContentType(mime),
          "Content-Security-Policy": rawCsp,
          "Cache-Control": "private, no-cache",
          ETag: `"${hash}"`,
        });
        record(link, revision.id, path, 304);
        return new Response(null, { status: 304, headers });
      }
      let source: Response;
      try {
        source = await blobResponse(env, hash, origin, retain);
      } catch (error) {
        logFailure("R2", error);
        return deny(env, ip, c.req.path);
      }
      if (!source.ok && markdown && hash !== file.blob_hash) {
        hash = file.blob_hash;
        mime = file.mime;
        try {
          source = await blobResponse(env, hash, origin, retain);
        } catch (error) {
          logFailure("R2", error);
          return deny(env, ip, c.req.path);
        }
      }
      if (!source.ok || !source.body) {
        console.error(`R2: HttpError: status ${source.status}`);
        record(link, revision.id, path, 404);
        return deny(env, ip, c.req.path);
      }
      const headers = new Headers({
        ...standard,
        "Content-Type": rawContentType(mime),
        "Content-Security-Policy": rawCsp,
        "Cache-Control": "private, no-cache",
      });
      if (markdown) headers.set("ETag", `"${hash}"`);
      response = new Response(source.body, { headers });
    }
    record(link, revision.id, path, status);
    return response;
  };
  app.get("/s/*", serve);
  app.get("/x/*", serve);
  app.notFound((c) => deniedFor(c.req.path));
  app.onError((error, c) => {
    logFailure("reader", error);
    return c.req.path.startsWith("/s/") || c.req.path.startsWith("/x/")
      ? deny(c.env, c.req.header("cf-connecting-ip") ?? "unknown", c.req.path)
      : deniedFor(c.req.path);
  });
  return app;
}
