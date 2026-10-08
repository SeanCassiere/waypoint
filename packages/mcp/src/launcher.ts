#!/usr/bin/env node
// This launcher is cached indefinitely by npx. Keep its protocol and fallback behavior backward-compatible.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MCP_LAUNCHER_API } from "@waypoint/core";

export const LAUNCHER_API = MCP_LAUNCHER_API;
type Source = "fresh" | "cache" | "embedded";
interface ServerModule {
  LAUNCHER_API: number;
  startServer: (options: {
    launcher: { version: number; bundleSha256: string; source: Source };
  }) => Promise<void>;
}
function isServerModule(value: unknown): value is ServerModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "LAUNCHER_API" in value &&
    "startServer" in value &&
    typeof value.startServer === "function"
  );
}
interface CachedBundle {
  path: string;
  sha: string;
  etag?: string | null | undefined;
}
interface Candidate extends CachedBundle {
  source: Source;
  temporary?: boolean;
}
interface LaunchOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  embeddedPath?: string;
}
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const log = (message: string) => process.stderr.write(`[waypoint-mcp] ${message}\n`);
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export function normalizedUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("WAYPOINT_URL must be an HTTP(S) URL without credentials, query or fragment");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}
export function cacheDirectory(base: string, env: NodeJS.ProcessEnv = process.env) {
  const root = env.WAYPOINT_MCP_CACHE_DIR || env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(root, "waypoint-mcp", sha256(base).slice(0, 16));
}
async function validatedFile(path: string, sha: unknown) {
  if (!validSha(sha)) return false;
  try {
    return sha256(await readFile(path)) === sha;
  } catch {
    return false;
  }
}
async function cachedCandidates(dir: string) {
  const result: CachedBundle[] = [];
  let current: Partial<CachedBundle & { sha256: string }> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "current.json"), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sha256" in parsed &&
      validSha(parsed.sha256)
    )
      current = {
        sha256: parsed.sha256,
        etag: "etag" in parsed && typeof parsed.etag === "string" ? parsed.etag : undefined,
      };
  } catch {
    /* empty cache */
  }
  if (
    validSha(current?.sha256) &&
    (await validatedFile(join(dir, `${current.sha256}.mjs`), current.sha256))
  )
    result.push({
      path: join(dir, `${current.sha256}.mjs`),
      sha: current.sha256,
      etag: current.etag,
    });
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return result;
  }
  const others = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.mjs$/.test(name) && name !== `${current?.sha256}.mjs`)
      .map(async (name) => {
        try {
          return { name, mtime: (await stat(join(dir, name))).mtimeMs };
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      }),
  );
  for (const { name } of others
    .filter((item) => item !== undefined)
    .toSorted((a, b) => b.mtime - a.mtime)) {
    const sha = name.slice(0, 64);
    if (await validatedFile(join(dir, name), sha)) result.push({ path: join(dir, name), sha });
  }
  return result;
}
async function atomicWrite(path: string, bytes: string | Uint8Array) {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
async function pruneBundles(dir: string, sha: string) {
  try {
    const names = (await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.mjs$/.test(name));
    const ranked = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtime: (await stat(join(dir, name))).mtimeMs };
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      }),
    );
    for (const { name } of ranked
      .filter((item) => item !== undefined)
      .filter((item) => item.name !== `${sha}.mjs`)
      .toSorted((a, b) => b.mtime - a.mtime)
      .slice(2))
      await rm(join(dir, name), { force: true });
  } catch (error) {
    if (!isMissing(error))
      log(`cache pruning failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function writeCachedBundle(dir: string, bytes: Uint8Array, sha: string) {
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, `${sha}.mjs`), bytes);
  return join(dir, `${sha}.mjs`);
}
async function temporaryBundle(bytes: Uint8Array, sha: string): Promise<Candidate> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-mcp-"));
  const path = join(dir, `${sha}.mjs`);
  try {
    await writeFile(path, bytes);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { path, sha, source: "fresh", temporary: true };
}
export async function candidates({
  env = process.env,
  fetcher = fetch,
  timeoutMs = 5000,
  embeddedPath = fileURLToPath(new URL("./waypoint-mcp-server.mjs", import.meta.url)),
}: LaunchOptions = {}): Promise<Candidate[]> {
  if (!env.WAYPOINT_URL) throw new Error("WAYPOINT_URL is required");
  const base = normalizedUrl(env.WAYPOINT_URL);
  const embeddedBytes = await readFile(embeddedPath);
  const embedded: Candidate = {
    path: embeddedPath,
    sha: sha256(embeddedBytes),
    source: "embedded",
  };
  const url = new URL(base);
  // WAYPOINT_MCP_ALLOW_HTTP=1: the operator accepts plain HTTP to this writer (a private network
  // or a TLS-terminating tunnel). `.ts.net` stays exempt for configs that predate the opt-out.
  if (
    env.WAYPOINT_MCP_ALLOW_HTTP !== "1" &&
    url.protocol === "http:" &&
    url.hostname !== "localhost" &&
    !url.hostname.endsWith(".localhost") &&
    url.hostname !== "[::1]" &&
    !/^127(?:\.\d{1,3}){3}$/.test(url.hostname) &&
    !url.hostname.endsWith(".ts.net")
  )
    log(`warning: WAYPOINT_URL uses plain HTTP to ${url.hostname}`);
  if (env.WAYPOINT_MCP_PIN === "embedded") return [embedded];
  let dir: string | undefined;
  try {
    dir = cacheDirectory(base, env);
  } catch (error) {
    log(`cache directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let cached: CachedBundle[] = [];
  if (dir) {
    try {
      cached = await cachedCandidates(dir);
    } catch (error) {
      log(`cache discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let fresh: Candidate | undefined;
  try {
    const headers = cached[0]?.etag ? { "If-None-Match": cached[0].etag } : {};
    const response = await fetcher(`${base}/mcp/server.mjs`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304) {
      if (cached[0])
        return [
          { ...cached[0], source: "cache" as const },
          ...cached.slice(1).map((item) => ({ ...item, source: "cache" as const })),
          embedded,
        ];
      throw new Error("304 without a valid cached bundle");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha = response.headers.get("X-Waypoint-Content-SHA256");
    if (!validSha(sha) || sha256(bytes) !== sha) throw new Error("server bundle SHA-256 mismatch");
    if (dir) {
      try {
        fresh = { path: await writeCachedBundle(dir, bytes, sha), sha, source: "fresh" };
        try {
          await atomicWrite(
            join(dir, "current.json"),
            JSON.stringify({
              sha256: sha,
              etag: response.headers.get("etag"),
              fetched_at: new Date().toISOString(),
            }),
          );
        } catch (error) {
          log(`cache metadata failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await pruneBundles(dir, sha);
      } catch (error) {
        log(`cache write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!fresh) fresh = await temporaryBundle(bytes, sha);
  } catch (error) {
    log(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [
    ...(fresh ? [fresh] : []),
    ...cached.map((item) => ({ ...item, source: "cache" as const })),
    embedded,
  ];
}
export async function launch(options: LaunchOptions = {}) {
  const list = await candidates(options);
  for (const candidate of list) {
    let module: ServerModule;
    try {
      if (!existsSync(candidate.path)) throw new Error("bundle missing");
      const imported: unknown = await import(pathToFileURL(candidate.path).href);
      if (!isServerModule(imported) || imported.LAUNCHER_API !== LAUNCHER_API)
        throw new Error("incompatible LAUNCHER_API");
      module = imported;
    } catch (error) {
      log(
        `bundle ${candidate.sha.slice(0, 12)} rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (candidate.temporary)
        await rm(dirname(candidate.path), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    log(`using ${candidate.source} bundle ${candidate.sha.slice(0, 12)}`);
    try {
      await module.startServer({
        launcher: { version: LAUNCHER_API, bundleSha256: candidate.sha, source: candidate.source },
      });
      return candidate;
    } catch (error) {
      log(`server failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (candidate.temporary)
        await rm(dirname(candidate.path), { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new Error("No compatible MCP server bundle available");
}
function isMain(): boolean {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}
if (isMain())
  launch().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
