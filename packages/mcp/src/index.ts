import { hostname } from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEFAULT_LIMITS,
  isWaypointError,
  withBase,
  type Limits,
  type McpStatusResponse,
  type McpVersionResponse,
} from "@waypoint/core";
import { z } from "zod";

import manifest from "../package.json" with { type: "json" };
import { ApiError, WaypointClient } from "./client.js";

const id = z.string().describe("Waypoint ID, such as col_… or rev_…");
const file = z
  .object({
    path: z.string().describe("Relative path inside the revision, using forward slashes"),
    source_path: z
      .string()
      .optional()
      .describe("Absolute path to a local file; use exactly one of source_path or content"),
    content: z
      .string()
      .optional()
      .describe("Inline UTF-8 text, at most 1 MB; use exactly one of content or source_path"),
    mime: z
      .string()
      .optional()
      .describe("MIME type; inferred from the file extension when omitted"),
  })
  .refine(
    (value) => (value.source_path === undefined) !== (value.content === undefined),
    "Exactly one of source_path or content is required",
  );
const sourceDir = z.object({
  dir: z
    .string()
    .describe(
      "Absolute local directory; symlinked root is resolved once, internal symlinks are skipped",
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Extra globs: slash-less patterns match basenames at any depth; leading / anchors to source root, trailing / matches a directory, and ./ is allowed. Dotfiles, .git, and node_modules are excluded by default",
    ),
});
const writeFields = {
  files: z
    .array(file)
    .optional()
    .describe(
      "Explicit files override source_dir on the same path; max 2,000 files, 50 MB each, 500 MB total by default",
    ),
  source_dir: sourceDir
    .optional()
    .describe(
      "Walk a local directory; dotfiles, .git, node_modules, and internal symlinks are skipped; limits apply",
    ),
  head_path: z
    .string()
    .optional()
    .describe("Entry document path; inferred from index.html, index.md, README.md, or a sole file"),
  message: z.string().optional().describe("Revision message explaining what changed"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Free-form metadata; source_host defaults to this machine and may be overridden here",
    ),
};
const createSchema = { title: z.string().describe("Collection title"), ...writeFields };
const addSchema = {
  collection_id: id.describe("Collection ID to revise"),
  ...writeFields,
  remove: z
    .array(z.string())
    .optional()
    .describe("Paths removed from the parent manifest; cannot also appear in files"),
  mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe(
      "Defaults to merge, preserving other parent files; replace uses only submitted files",
    ),
  parent_revision_id: id.optional().describe("Revision to build from; defaults to latest"),
};
export function limitsFromEnv(env: NodeJS.ProcessEnv): Limits {
  const positive = (key: string, fallback: number): number => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const maxFiles = positive("WAYPOINT_MAX_FILES", DEFAULT_LIMITS.maxFiles);
  const maxBlobBytes =
    positive("WAYPOINT_MAX_BLOB_MB", DEFAULT_LIMITS.maxBlobBytes / 1024 / 1024) * 1024 * 1024;
  const maxRevisionBytes =
    positive("WAYPOINT_MAX_REVISION_MB", DEFAULT_LIMITS.maxRevisionBytes / 1024 / 1024) *
    1024 *
    1024;
  if (!Number.isSafeInteger(maxBlobBytes) || !Number.isSafeInteger(maxRevisionBytes))
    throw new Error("Waypoint limits are too large");
  return { maxFiles, maxBlobBytes, maxRevisionBytes };
}

export interface LauncherInfo {
  version: number;
  bundleSha256: string;
  source: "fresh" | "cache" | "embedded";
}

export function createServer(client: WaypointClient, launcher?: LauncherInfo): McpServer {
  const server = new McpServer({ name: "waypoint-mcp", version: manifest.version });
  function register(
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (input: unknown, signal: AbortSignal) => Promise<unknown>,
  ): void {
    server.registerTool(name, { description, inputSchema: schema }, async (input, extra) => {
      try {
        const value = await handler(input, extra.signal);
        const structuredContent =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value))
            : { result: value };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        const detail =
          error instanceof ApiError || isWaypointError(error)
            ? { code: error.code, message: error.message, details: error.details }
            : error instanceof Error
              ? { code: "client_error", message: error.message, details: {} }
              : { code: "client_error", message: String(error), details: {} };
        return {
          isError: true,
          structuredContent: detail,
          content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
        };
      }
    });
  }
  register(
    "create_collection",
    "Create a new collection and its first revision from local files or small inline text. Identical calls within 10 minutes reuse the same collection. URLs work on the tailnet immediately; give people latest_url unless they need a pinned snapshot.",
    createSchema,
    (input, signal) => client.create(z.object(createSchema).parse(input), signal),
  );
  register(
    "add_revision",
    "Add a revision to a collection. Merge mode is the default: unchanged parent files carry over; remove deletes paths. The returned latest_url works on the tailnet immediately and is usually the URL to share.",
    addSchema,
    (input, signal) => client.add(z.object(addSchema).parse(input), signal),
  );
  register(
    "get_collection",
    "Get a collection and a selected revision's full file manifest and URLs. Omit revision_id to inspect the latest revision.",
    {
      collection_id: id.describe("Collection ID"),
      revision_id: id.optional().describe("Specific revision; defaults to latest"),
    },
    (input, signal) => {
      const args = z.object({ collection_id: id, revision_id: id.optional() }).parse(input);
      return client.getCollection(args.collection_id, args.revision_id, signal);
    },
  );
  register(
    "list_collections",
    "Find collections by title substring, newest first, with each collection's latest URL.",
    {
      query: z.string().optional().describe("Case-insensitive title substring"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum results, 1–200; defaults to 50"),
      include_deleted: z
        .boolean()
        .optional()
        .describe("Include soft-deleted collections; defaults to false"),
    },
    (input, signal) =>
      client.listCollections(
        ...(() => {
          const args = z
            .object({
              query: z.string().optional(),
              limit: z.number().optional(),
              include_deleted: z.boolean().optional(),
            })
            .parse(input);
          return [args.query, args.limit, args.include_deleted, signal] as const;
        })(),
      ),
  );
  register(
    "list_revisions",
    "List a collection's revision history with messages, parents, display numbers, and sync states.",
    { collection_id: id.describe("Collection ID") },
    (input, signal) =>
      client.listRevisions(z.object({ collection_id: id }).parse(input).collection_id, signal),
  );
  register(
    "read_file",
    "Read a source file from a revision. Text is returned up to 256 KB; binary files return metadata and a URL.",
    {
      collection_id: id.describe("Collection ID"),
      path: z.string().describe("Relative file path inside the revision"),
      revision_id: id.optional().describe("Specific revision; defaults to latest"),
    },
    (input, signal) =>
      client.readFile(
        ...(() => {
          const args = z
            .object({ collection_id: id, path: z.string(), revision_id: id.optional() })
            .parse(input);
          return [args.collection_id, args.path, args.revision_id, signal] as const;
        })(),
      ),
  );
  register(
    "resolve_url",
    "Resolve a pasted Waypoint URL back to collection, revision, and file path IDs.",
    { url: z.url().describe("Waypoint URL to resolve into IDs") },
    (input, signal) => client.resolve(z.object({ url: z.url() }).parse(input).url, signal),
  );
  register(
    "waypoint_status",
    "Check writer queue counts, failed items, recent uploads and sync activity, and the last error.",
    {},
    async (_input, signal) => {
      const status = await client.status(signal);
      let latestSha256: string | null = null;
      try {
        const response = await client.fetcher(withBase(client.base, "/mcp/version"), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (response.ok) {
          const value = z.object({
            server_sha256: z.string(),
            package_sha256: z.string(),
            launcher_sha256: z.string(),
            launcher_api: z.number().int(),
          }) satisfies z.ZodType<McpVersionResponse>;
          const parsed = value.safeParse(await response.json());
          if (parsed.success) latestSha256 = parsed.data.server_sha256;
        }
      } catch {
        // Status remains useful when the version endpoint is unavailable.
      }
      const runningSha256 = launcher?.bundleSha256 ?? null;
      const result: McpStatusResponse = {
        ...status,
        mcp: {
          running_sha256: runningSha256,
          source: launcher?.source ?? "embedded",
          latest_sha256: latestSha256,
          update_available:
            latestSha256 !== null && runningSha256 !== null && latestSha256 !== runningSha256,
        },
      };
      return result;
    },
  );
  return server;
}

export async function startServer(options?: { launcher?: LauncherInfo }): Promise<void> {
  const base = process.env.WAYPOINT_URL;
  if (!base) throw new Error("WAYPOINT_URL is required");
  await createServer(
    new WaypointClient(
      base,
      process.env.WAYPOINT_SOURCE_HOST ?? hostname(),
      limitsFromEnv(process.env),
    ),
    options?.launcher,
  ).connect(new StdioServerTransport());
}

export const main = startServer;
