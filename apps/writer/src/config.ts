import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { buildInfo, parseShareTokenKey, type BuildInfo } from "@waypoint/core";

import { checkoutPath } from "./layout.ts";

export interface Config {
  environment: "dev" | "prod";
  dataDir: string;
  baseUrl: string;
  publicBaseUrl?: string;
  /** WAYPOINT_SHARE_TOKEN_KEY: derives share-link tokens (D50). Sharing needs it too. */
  shareTokenKey?: Uint8Array;
  port: number;
  queueGiveUpHours: number;
  maxBlobBytes: number;
  maxFiles?: number;
  maxRevisionBytes?: number;
  sync: boolean;
  mcpTarballPath?: string;
  mcpLauncherPath?: string;
  mcpServerPath?: string;
  mcpSkillPath?: string;
  tursoUrl?: string;
  tursoAuthToken?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  /**
   * The bucket's S3 API endpoint: WAYPOINT_S3_ENDPOINT, else Cloudflare R2's
   * `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Requests use path-style addressing.
   */
  s3Endpoint?: string;
  /** WAYPOINT_S3_REGION, the SigV4 signing region: `auto` for R2. */
  s3Region?: string;
  /** The version and git commit this writer reports (WAYPOINT_BUILD_SHA). */
  build?: BuildInfo;
}
/** An http(s) URL without credentials, query or fragment, or an error naming `key`. */
function httpUrl(key: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be an HTTP URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${key} must be an HTTP URL without credentials, query or fragment`);
  return url;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Required, with no default: it picks the default data directory and must match the
  // environment marker in the local DB, the cloud DB and the bucket (docs/configuration.md).
  const environment = env.WAYPOINT_ENV;
  if (environment !== "dev" && environment !== "prod")
    throw new Error("WAYPOINT_ENV must be dev or prod");
  if (env.WAYPOINT_SYNC !== undefined && env.WAYPOINT_SYNC !== "on" && env.WAYPOINT_SYNC !== "off")
    throw new Error("WAYPOINT_SYNC must be on or off");
  // WAYPOINT_SYNC=off is local-only mode, in dev or prod: it never contacts Turso or the bucket,
  // so nothing is durable beyond this data directory (/status says so).
  const sync = env.WAYPOINT_SYNC !== "off";
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const number = (key: string, fallback: number): number => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const rawDir = env.WAYPOINT_DATA_DIR ?? `~/.local/share/waypoint/${environment}`;
  const dataDir = resolve(
    rawDir === "~"
      ? homedir()
      : rawDir.startsWith("~/")
        ? `${homedir()}/${rawDir.slice(2)}`
        : rawDir,
  );
  const port = number("WAYPOINT_PORT", 7410);
  if (port > 65535) throw new Error("WAYPOINT_PORT must be at most 65535");
  const baseUrl =
    env.WAYPOINT_BASE_URL ?? (sync ? required("WAYPOINT_BASE_URL") : `http://127.0.0.1:${port}`);
  httpUrl("WAYPOINT_BASE_URL", baseUrl);
  const publicBaseUrl = env.WAYPOINT_PUBLIC_BASE_URL;
  if (publicBaseUrl) httpUrl("WAYPOINT_PUBLIC_BASE_URL", publicBaseUrl);
  let shareTokenKey: Uint8Array | undefined;
  if (env.WAYPOINT_SHARE_TOKEN_KEY) {
    try {
      shareTokenKey = parseShareTokenKey(env.WAYPOINT_SHARE_TOKEN_KEY);
    } catch {
      // Never echo the value: it's a secret.
      throw new Error("WAYPOINT_SHARE_TOKEN_KEY must be 32 bytes, base64url-encoded");
    }
  }
  const queueGiveUpHours = number("WAYPOINT_QUEUE_GIVE_UP_HOURS", 72);
  const maxBlobBytes = number("WAYPOINT_MAX_BLOB_MB", 50) * 1024 * 1024;
  const maxFiles = number("WAYPOINT_MAX_FILES", 2000);
  const maxRevisionBytes = number("WAYPOINT_MAX_REVISION_MB", 500) * 1024 * 1024;
  if (!Number.isSafeInteger(maxBlobBytes)) throw new Error("WAYPOINT_MAX_BLOB_MB is too large");
  if (!Number.isSafeInteger(maxRevisionBytes))
    throw new Error("WAYPOINT_MAX_REVISION_MB is too large");
  // Any bucket name works: the environment marker in the bucket (bucket.ts, D54) and in the
  // cloud DB (guardEnvironment) keep a dev writer off prod data, not a naming rule.
  const cloud = sync ? cloudConfig(env, required) : {};
  return {
    environment,
    dataDir,
    baseUrl,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(shareTokenKey ? { shareTokenKey } : {}),
    port,
    queueGiveUpHours,
    maxBlobBytes,
    maxFiles,
    maxRevisionBytes,
    sync,
    build: buildInfo(env.WAYPOINT_BUILD_SHA),
    mcpTarballPath: env.WAYPOINT_MCP_TARBALL
      ? resolve(env.WAYPOINT_MCP_TARBALL)
      : existsSync("/app/static/waypoint-mcp.tgz")
        ? "/app/static/waypoint-mcp.tgz"
        : checkoutPath("packages/mcp/dist/waypoint-mcp.tgz"),
    mcpLauncherPath: env.WAYPOINT_MCP_LAUNCHER
      ? resolve(env.WAYPOINT_MCP_LAUNCHER)
      : existsSync("/app/static/launcher.mjs")
        ? "/app/static/launcher.mjs"
        : checkoutPath("packages/mcp/dist/launcher.mjs"),
    mcpServerPath: env.WAYPOINT_MCP_SERVER
      ? resolve(env.WAYPOINT_MCP_SERVER)
      : existsSync("/app/static/waypoint-mcp-server.mjs")
        ? "/app/static/waypoint-mcp-server.mjs"
        : checkoutPath("packages/mcp/dist/waypoint-mcp-server.mjs"),
    mcpSkillPath: env.WAYPOINT_MCP_SKILL
      ? resolve(env.WAYPOINT_MCP_SKILL)
      : existsSync("/app/static/skills/waypoint/SKILL.md")
        ? "/app/static/skills/waypoint/SKILL.md"
        : checkoutPath("skills/waypoint/SKILL.md"),
    ...cloud,
  };
}

/** Turso and the S3-compatible bucket, read only when sync is on. */
function cloudConfig(
  env: NodeJS.ProcessEnv,
  required: (key: string) => string,
): Pick<
  Config,
  | "tursoUrl"
  | "tursoAuthToken"
  | "r2AccountId"
  | "r2AccessKeyId"
  | "r2SecretAccessKey"
  | "r2Bucket"
  | "s3Endpoint"
  | "s3Region"
> {
  const tursoUrl = required("TURSO_DATABASE_URL");
  const tursoAuthToken = required("TURSO_AUTH_TOKEN");
  const rawEndpoint = env.WAYPOINT_S3_ENDPOINT;
  let s3Endpoint: string;
  let r2AccountId: string | undefined;
  if (rawEndpoint) {
    const url = httpUrl("WAYPOINT_S3_ENDPOINT", rawEndpoint);
    url.pathname = url.pathname.replace(/\/+$/, "");
    s3Endpoint = url.toString().replace(/\/$/, "");
    r2AccountId = env.R2_ACCOUNT_ID || undefined;
  } else {
    r2AccountId = required("R2_ACCOUNT_ID");
    // An account ID is a hostname label; anything else would redirect the signed requests.
    if (!/^[A-Za-z0-9-]{1,63}$/.test(r2AccountId))
      throw new Error("R2_ACCOUNT_ID must be a Cloudflare account ID");
    s3Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
  }
  const s3Region = env.WAYPOINT_S3_REGION || "auto";
  if (!/^[a-z0-9-]{1,64}$/.test(s3Region))
    throw new Error("WAYPOINT_S3_REGION must be a region name such as auto or us-east-1");
  return {
    tursoUrl,
    tursoAuthToken,
    ...(r2AccountId ? { r2AccountId } : {}),
    r2AccessKeyId: required("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    r2Bucket: required("R2_BUCKET"),
    s3Endpoint,
    s3Region,
  };
}
