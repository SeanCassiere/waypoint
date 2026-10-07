import { encodePath, validatePath } from "@waypoint/core";

export function shellPath(
  collectionPublicId: string,
  revisionPublicId: string,
  path: string,
  pinned: boolean,
  headPath?: string,
  search = "",
  hash = "",
): string {
  const base = `/c/${collectionPublicId}/${pinned ? `r/${revisionPublicId}/` : ""}`;
  const file = path && (pinned || path !== headPath) ? encodePath(path) : "";
  return `${base}${file}${search}${hash}`;
}

export function rawPath(revisionPublicId: string, path: string): string {
  return `/raw/r/${revisionPublicId}/${encodePath(path)}`;
}

export function pathFromRaw(pathname: string, revisionPublicId: string): string | null {
  const prefix = `/raw/r/${revisionPublicId}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (/%(?:2f|5c)/i.test(encoded)) return null;
  try {
    return validatePath(encoded.split("/").map(decodeURIComponent).join("/"));
  } catch {
    return null;
  }
}
