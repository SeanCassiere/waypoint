import { WaypointError } from "./errors.js";
import type { ContentHash } from "./hash.js";
import { isContentHash } from "./hash.js";
import { normalizeMime } from "./mime.js";
import { findCaseConflicts, findFileDirectoryConflicts, validatePath } from "./paths.js";

export interface ManifestEntry {
  hash: ContentHash;
  mime: string;
  size: number;
}
export interface Manifest {
  headPath: string;
  files: Record<string, ManifestEntry>;
}
export interface Limits {
  maxFiles: number;
  maxRevisionBytes: number;
  maxBlobBytes: number;
}
export const DEFAULT_LIMITS: Limits = {
  maxFiles: 2000,
  maxRevisionBytes: 500 * 1024 * 1024,
  maxBlobBytes: 50 * 1024 * 1024,
};
export interface BuildManifestInput {
  mode: "merge" | "replace";
  parent?: Manifest;
  files: Record<string, ManifestEntry>;
  remove?: string[];
  headPath?: string;
  limits?: Partial<Limits>;
}
export function buildManifest({
  mode,
  parent,
  files,
  remove = [],
  headPath,
  limits: overrides,
}: BuildManifestInput): Manifest {
  if (mode !== "merge" && mode !== "replace")
    throw new WaypointError("validation_failed", "Invalid manifest mode");
  if (mode === "merge" && !parent)
    throw new WaypointError("validation_failed", "Merge requires a parent manifest");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new WaypointError("validation_failed", "Invalid limits");
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- A null prototype keeps user paths such as __proto__ safe as keys.
  const result: Record<string, ManifestEntry> = Object.create(null);
  if (mode === "merge" && parent) {
    for (const [path, entry] of Object.entries(parent.files)) {
      const normalized = validatePath(path);
      if (normalized in result)
        throw new WaypointError("path_case_conflict", `Duplicate normalized path: ${normalized}`);
      result[normalized] = entry;
    }
  }
  const added = new Map<string, ManifestEntry>();
  for (const [path, entry] of Object.entries(files)) {
    const normalized = validatePath(path);
    if (added.has(normalized))
      throw new WaypointError("path_case_conflict", `Duplicate path: ${normalized}`);
    added.set(normalized, entry);
  }
  for (const path of remove) {
    const normalized = validatePath(path);
    if (added.has(normalized))
      throw new WaypointError("validation_failed", `Path in files and remove: ${normalized}`);
    if (!(normalized in result))
      throw new WaypointError("validation_failed", `Cannot remove missing path: ${normalized}`);
    delete result[normalized];
  }
  for (const [path, entry] of added) result[path] = entry;
  const conflicts = findCaseConflicts(Object.keys(result));
  if (conflicts.length)
    throw new WaypointError("path_case_conflict", "Paths differ only by case", {
      conflicts,
    });
  const hierarchyConflicts = findFileDirectoryConflicts(Object.keys(result));
  if (hierarchyConflicts.length)
    throw new WaypointError("path_invalid", "A file cannot also be a directory", {
      conflicts: hierarchyConflicts,
    });
  if (Object.keys(result).length > limits.maxFiles)
    throw new WaypointError("revision_too_large", "Too many files");
  let total = 0;
  for (const [path, entry] of Object.entries(result)) {
    if (!entry || typeof entry.mime !== "string")
      throw new WaypointError("validation_failed", `Invalid manifest entry: ${path}`);
    const mime = normalizeMime(entry.mime);
    if (!isContentHash(entry.hash) || !mime || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new WaypointError("validation_failed", `Invalid manifest entry: ${path}`);
    if (entry.size > limits.maxBlobBytes)
      throw new WaypointError("blob_too_large", `Blob too large: ${path}`);
    result[path] = { ...entry, mime };
    total += entry.size;
  }
  if (total > limits.maxRevisionBytes)
    throw new WaypointError("revision_too_large", "Revision too large");
  let head = headPath === undefined ? undefined : validatePath(headPath);
  if (head !== undefined && !(head in result))
    throw new WaypointError("head_path_missing", `Head path does not exist: ${head}`);
  if (head === undefined && parent?.headPath) {
    const inheritedHead = validatePath(parent.headPath);
    if (inheritedHead in result) head = inheritedHead;
  }
  if (head === undefined)
    head = ["index.html", "index.md", "README.md"].find((path) => path in result);
  if (head === undefined) {
    const paths = Object.keys(result);
    if (paths.length === 1) head = paths[0];
    else
      throw new WaypointError(
        paths.length ? "head_path_ambiguous" : "head_path_missing",
        "Cannot infer head path",
      );
  }
  if (head === undefined) throw new WaypointError("head_path_missing", "Cannot infer head path");
  return { headPath: head, files: result };
}
export function manifestsEqual(a: Manifest, b: Manifest): boolean {
  if (a.headPath !== b.headPath) return false;
  const paths = Object.keys(a.files);
  if (paths.length !== Object.keys(b.files).length) return false;
  return paths.every((path) => {
    const left = a.files[path];
    const right = b.files[path];
    return (
      right !== undefined &&
      left?.hash === right.hash &&
      left.mime === right.mime &&
      left.size === right.size
    );
  });
}
