import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  DEFAULT_LIMITS,
  WaypointError,
  findCaseConflicts,
  findFileDirectoryConflicts,
  hashBytes,
  inferMime,
  normalizeMime,
  validatePath,
  type Limits,
} from "@waypoint/core";

export interface FileInput {
  path: string;
  source_path?: string | undefined;
  content?: string | undefined;
  mime?: string | undefined;
}
export interface SourceDir {
  dir: string;
  exclude?: string[] | undefined;
}
export interface PreparedFile {
  path: string;
  hash: string;
  mime: string;
  size: number;
  sourcePath?: string;
  bytes?: Uint8Array<ArrayBuffer>;
}
const INLINE_LIMIT = 1024 * 1024;

function matchSegment(glob: string, value: string): boolean {
  const escaped = glob
    .replace(/[|\\{}()[\]^$+.]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function globMatch(pattern: string, path: string): boolean {
  const anchored = pattern
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .startsWith("/");
  const normalized = pattern
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\//, "")
    .replace(/\/$/, "/**");
  if (!normalized.includes("/") && anchored) return matchSegment(normalized, path);
  if (!normalized.includes("/"))
    return path.split("/").some((part) => matchSegment(normalized, part));
  const segments = normalized.split("/");
  const parts = path.split("/");
  const match = (i: number, j: number): boolean => {
    if (i === segments.length) return j === parts.length;
    if (segments[i] === "**") return match(i + 1, j) || (j < parts.length && match(i, j + 1));
    return (
      j < parts.length && matchSegment(segments[i] ?? "", parts[j] ?? "") && match(i + 1, j + 1)
    );
  };
  return match(0, 0) || (normalized.endsWith("/**") && path === normalized.slice(0, -3));
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Tool call aborted");
}

export async function walkSourceDir(
  source: SourceDir,
  limits: Limits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<FileInput[]> {
  if (!isAbsolute(source.dir))
    throw new WaypointError("validation_failed", "source_dir.dir must be absolute");
  const rootPath = await realpath(source.dir);
  const root = await lstat(rootPath);
  if (!root.isDirectory())
    throw new WaypointError("validation_failed", "source_dir.dir must be a real directory");
  const files: FileInput[] = [];
  const normalizedPaths = new Set<string>();
  async function visit(dir: string): Promise<void> {
    checkAbort(signal);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      checkAbort(signal);
      const full = join(dir, entry.name);
      const path = relative(rootPath, full).split(sep).join("/");
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink())
        continue;
      if (source.exclude?.some((pattern) => globMatch(pattern, path))) continue;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        let normalized: string;
        try {
          normalized = validatePath(path);
        } catch (error) {
          throw new WaypointError("path_invalid", `Invalid source_dir filename: ${path}`, {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        if (normalizedPaths.has(normalized))
          throw new WaypointError(
            "path_case_conflict",
            `Source files normalize to the same path: ${normalized}`,
          );
        normalizedPaths.add(normalized);
        files.push({ path: normalized, source_path: full });
        if (files.length > limits.maxFiles)
          throw new WaypointError(
            "revision_too_large",
            `More than ${limits.maxFiles} files in source_dir`,
          );
      }
    }
  }
  await visit(rootPath);
  return files;
}

export async function prepareFiles(
  explicit: FileInput[] = [],
  source?: SourceDir,
  limits: Limits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<PreparedFile[]> {
  const entries = new Map<string, FileInput>();
  for (const file of source ? await walkSourceDir(source, limits, signal) : [])
    entries.set(validatePath(file.path), file);
  const explicitPaths = new Set<string>();
  for (const file of explicit) {
    const path = validatePath(file.path);
    if (explicitPaths.has(path))
      throw new WaypointError("validation_failed", `Duplicate explicit path: ${path}`);
    explicitPaths.add(path);
    entries.set(path, file);
  }
  const paths = [...entries.keys()];
  if (paths.length > limits.maxFiles)
    throw new WaypointError("revision_too_large", `More than ${limits.maxFiles} files`);
  if (findCaseConflicts(paths).length)
    throw new WaypointError("path_case_conflict", "Paths differ only by case");
  if (findFileDirectoryConflicts(paths).length)
    throw new WaypointError("path_invalid", "A file cannot also be a directory");
  let total = 0;
  const sized = new Map<string, { size: number; bytes?: Uint8Array<ArrayBuffer> }>();
  for (const [path, file] of entries) {
    checkAbort(signal);
    if ((file.source_path === undefined) === (file.content === undefined))
      throw new WaypointError(
        "validation_failed",
        `Exactly one of source_path or content is required: ${path}`,
      );
    let size: number;
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (file.content !== undefined) {
      bytes = new TextEncoder().encode(file.content);
      size = bytes.byteLength;
      if (size > INLINE_LIMIT)
        throw new WaypointError("blob_too_large", `Inline content exceeds 1 MB: ${path}`);
    } else {
      const sourcePath = file.source_path ?? "";
      if (!isAbsolute(sourcePath))
        throw new WaypointError("validation_failed", `source_path must be absolute: ${path}`);
      const stat = await lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new WaypointError(
          "validation_failed",
          `source_path must be a real file: ${sourcePath}`,
        );
      size = stat.size;
    }
    if (size > limits.maxBlobBytes)
      throw new WaypointError(
        "blob_too_large",
        `File exceeds ${limits.maxBlobBytes} bytes: ${path}`,
      );
    total += size;
    if (total > limits.maxRevisionBytes)
      throw new WaypointError(
        "revision_too_large",
        `Revision exceeds ${limits.maxRevisionBytes} bytes`,
      );
    sized.set(path, { size, ...(bytes ? { bytes } : {}) });
  }
  const prepared: PreparedFile[] = [];
  for (const [path, file] of entries) {
    checkAbort(signal);
    const mime = normalizeMime(file.mime ?? inferMime(path));
    const { size, bytes } = sized.get(path)!;
    let hash: string;
    if (bytes !== undefined) {
      hash = await hashBytes(bytes);
    } else {
      const sourcePath = file.source_path ?? "";
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(sourcePath)) {
        checkAbort(signal);
        const data: unknown = chunk;
        if (!(data instanceof Uint8Array)) throw new Error("Invalid file stream chunk");
        digest.update(data);
      }
      hash = `sha256:${digest.digest("hex")}`;
    }
    prepared.push({
      path,
      hash,
      mime,
      size,
      ...(bytes ? { bytes } : { sourcePath: file.source_path ?? "" }),
    });
  }
  return prepared;
}
