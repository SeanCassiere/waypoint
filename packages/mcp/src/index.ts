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
const collectionFields = {
  collection: z.string().optional().describe("Collection ID, public ID, or Waypoint URL"),
  collection_id: z.string().optional().describe("Alias for collection"),
};
const requireCollection = (value: {
  collection?: string | undefined;
  collection_id?: string | undefined;
}) => Boolean(value.collection || value.collection_id);
const addSchema = {
  ...collectionFields,
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
const addToolSchema = z.object(addSchema).refine(requireCollection, "collection is required");
const getToolSchema = z
  .object({
    ...collectionFields,
    revision_id: id.optional().describe("Specific revision; defaults to latest"),
    include_head: z
      .boolean()
      .optional()
      .describe("Include up to 64 KB of the selected head document's source text"),
  })
  .refine(requireCollection, "collection is required");
const listRevisionsToolSchema = z
  .object(collectionFields)
  .refine(requireCollection, "collection is required");
const waitToolSchema = z
  .object({
    ...collectionFields,
    after_revision_id: id.describe("Last revision already seen"),
    timeout_seconds: z
      .number()
      .min(0)
      .max(50)
      .optional()
      .describe("Long-poll duration in seconds; defaults to 30"),
  })
  .refine(requireCollection, "collection is required");
const readFileToolSchema = z
  .object({
    ...collectionFields,
    path: z.string().describe("Relative file path inside the revision"),
    revision_id: id.optional().describe("Specific revision; defaults to latest"),
  })
  .refine(requireCollection, "collection is required");
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
    schema: z.ZodRawShape | z.ZodType,
    handler: (input: unknown, signal: AbortSignal) => Promise<unknown>,
  ): void {
    server.registerTool(
      name,
      { description, inputSchema: schema },
      async (input: unknown, extra: { signal: AbortSignal }) => {
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
      },
    );
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
    addToolSchema,
    (input, signal) => {
      const args = addToolSchema.parse(input);
      return client.add(
        { ...args, collection_id: args.collection ?? args.collection_id ?? "" },
        signal,
      );
    },
  );
  register(
    "get_collection",
    "Get a collection by ID, public ID, or URL, its file manifest, and optionally the head document text.",
    getToolSchema,
    (input, signal) => {
      const args = getToolSchema.parse(input);
      const collection = args.collection ?? args.collection_id ?? "";
      return client.getCollection(collection, args.revision_id, signal, args.include_head);
    },
  );
  register(
    "search_collections",
    "List or search collection titles and metadata; find by ID or URL. Prefer the most recently updated result.",
    {
      query: z
        .string()
        .optional()
        .describe("Title or metadata value substring, collection ID, public ID, or Waypoint URL"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Top-level metadata filters; array values may contain the requested value"),
      updated_after: z
        .union([z.iso.datetime({ offset: true }), z.iso.date(), z.number()])
        .optional()
        .describe("Only collections revised after this ISO time or Unix milliseconds"),
      sort: z
        .enum(["updated", "created"])
        .optional()
        .describe("Newest updated or created first; defaults to updated"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Page size; defaults to 20, maximum 100"),
      cursor: z.string().optional().describe("Opaque next_cursor from the previous page"),
      include_deleted: z.boolean().optional().describe("Include soft-deleted collections"),
    },
    (input, signal) =>
      client.searchCollections(
        z
          .object({
            query: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            updated_after: z
              .union([z.iso.datetime({ offset: true }), z.iso.date(), z.number()])
              .optional(),
            sort: z.enum(["updated", "created"]).optional(),
            limit: z.number().optional(),
            cursor: z.string().optional(),
            include_deleted: z.boolean().optional(),
          })
          .parse(input),
        signal,
      ),
  );
  register(
    "wait_for_revision",
    "Wait for revisions newer than the one already read, then return the new revisions or changed: false on timeout.",
    waitToolSchema,
    (input, signal) => {
      const args = waitToolSchema.parse(input);
      return client.waitForRevision(
        args.collection ?? args.collection_id ?? "",
        args.after_revision_id,
        args.timeout_seconds,
        signal,
      );
    },
  );
  register(
    "list_revisions",
    "List a collection's revision history with messages, parents, display numbers, and sync states.",
    listRevisionsToolSchema,
    (input, signal) => {
      const args = listRevisionsToolSchema.parse(input);
      return client.listRevisions(args.collection ?? args.collection_id ?? "", signal);
    },
  );
  register(
    "read_file",
    "Read a source file from a revision. Text is returned up to 256 KB; binary files return metadata and a URL.",
    readFileToolSchema,
    (input, signal) => {
      const args = readFileToolSchema.parse(input);
      return client.readFile(
        args.collection ?? args.collection_id ?? "",
        args.path,
        args.revision_id,
        signal,
      );
    },
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
