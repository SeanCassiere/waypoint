import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseShareTokenKey } from "@waypoint/core";

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
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.WAYPOINT_ENV;
  if (environment !== "dev" && environment !== "prod")
    throw new Error("WAYPOINT_ENV must be dev or prod");
  if (env.WAYPOINT_SYNC !== undefined && env.WAYPOINT_SYNC !== "on" && env.WAYPOINT_SYNC !== "off")
    throw new Error("WAYPOINT_SYNC must be on or off");
  // WAYPOINT_SYNC=off is the local development path; it never contacts Turso or R2.
  const sync = env.WAYPOINT_SYNC !== "off";
  if (!sync && environment === "prod") throw new Error("WAYPOINT_SYNC=off is only allowed in dev");
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
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("WAYPOINT_BASE_URL must be an HTTP URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("WAYPOINT_BASE_URL must be an HTTP URL without credentials, query or fragment");
  const publicBaseUrl = env.WAYPOINT_PUBLIC_BASE_URL;
  if (publicBaseUrl) {
    let publicUrl: URL;
    try {
      publicUrl = new URL(publicBaseUrl);
    } catch {
      throw new Error("WAYPOINT_PUBLIC_BASE_URL must be an HTTP URL");
    }
    if (
      !["http:", "https:"].includes(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.search ||
      publicUrl.hash
    )
      throw new Error(
        "WAYPOINT_PUBLIC_BASE_URL must be an HTTP URL without credentials, query or fragment",
      );
  }
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
  const cloud = sync
    ? {
        tursoUrl: required("TURSO_DATABASE_URL"),
        tursoAuthToken: required("TURSO_AUTH_TOKEN"),
        r2AccountId: required("R2_ACCOUNT_ID"),
        r2AccessKeyId: required("R2_ACCESS_KEY_ID"),
        r2SecretAccessKey: required("R2_SECRET_ACCESS_KEY"),
        r2Bucket: required("R2_BUCKET"),
      }
    : {};
  if (sync && cloud.r2Bucket !== `waypoint-${environment}`)
    throw new Error(`R2_BUCKET must be waypoint-${environment}`);
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
    mcpTarballPath: env.WAYPOINT_MCP_TARBALL
      ? resolve(env.WAYPOINT_MCP_TARBALL)
      : existsSync("/app/static/waypoint-mcp.tgz")
        ? "/app/static/waypoint-mcp.tgz"
        : fileURLToPath(new URL("../../../packages/mcp/dist/waypoint-mcp.tgz", import.meta.url)),
    mcpLauncherPath: env.WAYPOINT_MCP_LAUNCHER
      ? resolve(env.WAYPOINT_MCP_LAUNCHER)
      : existsSync("/app/static/launcher.mjs")
        ? "/app/static/launcher.mjs"
        : fileURLToPath(new URL("../../../packages/mcp/dist/launcher.mjs", import.meta.url)),
    mcpServerPath: env.WAYPOINT_MCP_SERVER
      ? resolve(env.WAYPOINT_MCP_SERVER)
      : existsSync("/app/static/waypoint-mcp-server.mjs")
        ? "/app/static/waypoint-mcp-server.mjs"
        : fileURLToPath(
            new URL("../../../packages/mcp/dist/waypoint-mcp-server.mjs", import.meta.url),
          ),
    mcpSkillPath: env.WAYPOINT_MCP_SKILL
      ? resolve(env.WAYPOINT_MCP_SKILL)
      : existsSync("/app/static/skills/waypoint/SKILL.md")
        ? "/app/static/skills/waypoint/SKILL.md"
        : fileURLToPath(new URL("../../../skills/waypoint/SKILL.md", import.meta.url)),
    ...cloud,
  };
}
