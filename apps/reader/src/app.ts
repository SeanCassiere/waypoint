import {
  hashShareToken,
  isShareToken,
  isTextMime,
  parseShareUrl,
  shareShellUrl,
  validatePath,
  encodePath,
} from "@waypoint/core";
import { Hono, type Context } from "hono";

export interface ReaderEnv {
  TURSO_DATABASE_URL: string;
  TURSO_READONLY_TOKEN: string;
  R2_ACCOUNT_ID: string;
  R2_READER_ACCESS_KEY_ID: string;
  R2_READER_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  RAW_CAP_KEY: string;
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
type File = { path: string; blob_hash: string; mime: string };
type Rendition = { output_hash: string; output_mime: string; renderer_version: number };
const standard = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private",
};
const rawCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
const page404 = "<!doctype html><title>Not found</title><h1>Not found</h1>";
const denied = (status = 404): Response =>
  new Response(page404, {
    status,
    headers: { ...standard, "Content-Type": "text/html; charset=utf-8" },
  });
const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => entities[char]!);
const css =
  "body{margin:0;font:16px system-ui;color:#1b222b;background:#fff}header{padding:1rem;border-bottom:1px solid #aaa}main{display:grid;grid-template-columns:minmax(12rem,20rem) 1fr;height:calc(100vh - 6rem)}nav{padding:1rem;overflow:auto;border-right:1px solid #aaa}nav a{display:block;padding:.4rem;color:inherit;word-break:break-all}nav a[aria-current]{font-weight:bold;background:#ddd}iframe{width:100%;height:100%;border:0}small{color:#666}@media(max-width:650px){main{grid-template-columns:1fr;grid-template-rows:12rem 1fr}nav{border-right:0;border-bottom:1px solid #aaa}}@media(prefers-color-scheme:dark){body{color:#eee;background:#141820}nav a[aria-current]{background:#38404a}small{color:#aaa}}";
const cssHash = crypto.subtle
  .digest("SHA-256", new TextEncoder().encode(css))
  .then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
export function renderFileLinks(
  files: ReadonlyArray<{ path: string }>,
  prefix: string,
  current: string,
): string {
  return files
    .map(
      (item) =>
        `<a href="${prefix}${item.path.split("/").map(encodeURIComponent).join("/")}"${item.path === current ? ' aria-current="page"' : ""}>${escape(item.path)}</a>`,
    )
    .join("");
}
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
  async function deny(env: ReaderEnv, ip: string): Promise<Response> {
    try {
      if (env.TOKEN_MISS_LIMITER && !(await env.TOKEN_MISS_LIMITER.limit({ key: ip })).success) {
        // Map insertion order provides a bounded LRU. Expired entries are removed on access.
        blockedIps.delete(ip);
        blockedIps.set(ip, now() + 60_000);
        if (blockedIps.size > 10_000) blockedIps.delete(blockedIps.keys().next().value!);
      }
    } catch (error) {
      logFailure("limiter", error);
    }
    return denied();
  }
  async function lookup(db: ReaderDb, kind: "token" | "id", value: string): Promise<Link | null> {
    const key = kind === "token" ? await hashShareToken(value) : value;
    const cached = lookupCache.get(key);
    if (cached && cached.until > now()) return cached.link;
    const row =
      (await db.all<Link>(`${linkSql}s.${kind === "token" ? "token_hash" : "id"}=?`, [key]))[0] ??
      null;
    if (lookupCache.size > 1000) lookupCache.clear();
    lookupCache.set(key, { until: now() + 30_000, link: row });
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
  app.get(
    "/healthz",
    () =>
      new Response("ok", { headers: { ...standard, "Content-Type": "text/plain; charset=utf-8" } }),
  );
  app.get("/healthz/deep", async (c) => {
    try {
      await deps.db(c.env).all("SELECT 1 FROM collections LIMIT 1");
      const result = await deps.blob(c.env).probe();
      if (!result.ok) throw new Error("R2 probe failed");
      return new Response("ok", {
        headers: { ...standard, "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      logFailure("health", error);
      return new Response("fail", {
        status: 503,
        headers: { ...standard, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  });
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
    const blockedUntil = blockedIps.get(ip);
    if (blockedUntil !== undefined) {
      if (blockedUntil > now()) {
        blockedIps.delete(ip);
        blockedIps.set(ip, blockedUntil);
        return denied();
      }
      blockedIps.delete(ip);
    }
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
        if (!match) return deny(env, ip);
        route = {
          kind: "raw",
          linkId: match[1]!,
          cap: match[2]!,
          revisionPublicId: match[3]!.toLowerCase(),
          path: decodeRawPath(match[4] ?? ""),
        };
      } else {
        const parsed = parseShareUrl(c.req.path);
        if (parsed.kind !== "shell") return deny(env, ip);
        route = parsed;
      }
    } catch {
      return deny(env, ip);
    }
    if (route.kind === "shell" && (!route.token || !isShareToken(route.token)))
      return deny(env, ip);
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
      return deny(env, ip);
    }
    if (!link) return deny(env, ip);
    if (route.kind === "raw") {
      try {
        if (!equalCap(route.cap!, await rawCap(env.RAW_CAP_KEY, link.id, route.revisionPublicId!)))
          return deny(env, ip);
      } catch (error) {
        logFailure("capability", error);
        return deny(env, ip);
      }
    }
    if (
      link.revoked_at !== null ||
      (link.expires_at !== null && link.expires_at <= now()) ||
      link.deleted_at !== null
    ) {
      record(link, link.revision_id ?? "", route.path ?? "", 404);
      return deny(env, ip);
    }
    if (route.kind === "shell" && route.collectionPublicId !== link.public_id) {
      record(link, link.revision_id ?? "", route.path ?? "", 404);
      return deny(env, ip);
    }
    if (route.kind === "shell" && link.revision_id && !route.revisionPublicId) {
      record(link, link.revision_id, route.path ?? "", 404);
      return deny(env, ip);
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
      return deny(env, ip);
    }
    if (route.revisionPublicId && route.revisionPublicId !== revision.public_id) {
      record(link, revision.id, route.path ?? "", 404);
      return deny(env, ip);
    }
    const path = route.kind === "shell" ? (route.path ?? revision.head_path) : route.path!;
    try {
      validatePath(path);
    } catch {
      record(link, revision.id, path, 404);
      return deny(env, ip);
    }
    const file = (
      await db.all<File>(
        "SELECT path,blob_hash,mime FROM revision_files WHERE revision_id=? AND path=?",
        [revision.id, path],
      )
    )[0];
    if (!file) {
      record(link, revision.id, path, 404);
      return deny(env, ip);
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
      const links = renderFileLinks(files, prefix, path);
      const cap = await rawCap(env.RAW_CAP_KEY, link.id, revision.public_id);
      const frame = `${base}/x/${link.id}.${cap}/r/${revision.public_id}/${encodePath(path)}`;
      const csp = `default-src 'none'; style-src 'sha256-${await cssHash}'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(link.title)}</title><style>${css}</style></head><body><header><strong>${escape(link.title)}</strong>${link.revision_id ? `<br><small>Snapshot from ${escape(new Date(revision.created_at).toLocaleDateString("en-CA"))}</small>` : ""}</header><main><nav aria-label="Files">${links}</nav><iframe title="${escape(path)}" src="${escape(frame)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe></main></body></html>`;
      response = new Response(html, {
        headers: {
          ...standard,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "X-Frame-Options": "DENY",
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
          "Content-Type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime,
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
        return deny(env, ip);
      }
      if (!source.ok && markdown && hash !== file.blob_hash) {
        hash = file.blob_hash;
        mime = file.mime;
        try {
          source = await blobResponse(env, hash, origin, retain);
        } catch (error) {
          logFailure("R2", error);
          return deny(env, ip);
        }
      }
      if (!source.ok || !source.body) {
        console.error(`R2: HttpError: status ${source.status}`);
        record(link, revision.id, path, 404);
        return deny(env, ip);
      }
      const headers = new Headers({
        ...standard,
        "Content-Type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime,
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
  app.notFound(() => denied());
  app.onError((error, c) => {
    logFailure("reader", error);
    return c.req.path.startsWith("/s/") || c.req.path.startsWith("/x/")
      ? deny(c.env, c.req.header("cf-connecting-ip") ?? "unknown")
      : denied();
  });
  return app;
}
