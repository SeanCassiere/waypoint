import { WaypointError } from "./errors.js";

export function normalizePath(path: string): string {
  return path.normalize("NFC");
}

export function validatePath(path: string): string {
  if (!path.isWellFormed())
    throw new WaypointError("path_invalid", "Path contains malformed Unicode");
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    segments[0] === "r" ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }) ||
    new TextEncoder().encode(normalized).length > 512
  )
    throw new WaypointError("path_invalid", `Invalid path: ${path}`);
  return normalized;
}

export function findCaseConflicts(paths: Iterable<string>): [string, string][] {
  const seen = new Map<string, { spelling: string; path: string; original: string }>();
  const conflicts: [string, string][] = [];
  for (const original of paths) {
    const path = normalizePath(original);
    const segments = path.split("/");
    let parent = "";
    for (const segment of segments) {
      const key = `${parent}\u0000${segment.toLowerCase()}`;
      const prior = seen.get(key);
      if (
        prior &&
        (prior.spelling !== segment || (prior.path === path && prior.original !== original))
      ) {
        if (!conflicts.some(([a, b]) => a === prior.original && b === original))
          conflicts.push([prior.original, original]);
      } else if (!prior) seen.set(key, { spelling: segment, path, original });
      parent += `/${segment.toLowerCase()}`;
    }
  }
  return conflicts;
}

export function findFileDirectoryConflicts(paths: Iterable<string>): [string, string][] {
  const all = new Set(Array.from(paths, normalizePath));
  const conflicts: [string, string][] = [];
  for (const path of all) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (all.has(prefix)) conflicts.push([prefix, path]);
    }
  }
  return conflicts;
}
