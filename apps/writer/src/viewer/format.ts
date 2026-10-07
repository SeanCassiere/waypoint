import type { RevisionChanges } from "@waypoint/core";

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function changesTitle(changes: RevisionChanges): string {
  return `${changes.added} added, ${changes.modified} modified, ${changes.removed} removed`;
}

export function shortId(id: string, keep = 10): string {
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}

/** Collection metadata shown on rows: project and tags as plain strings. */
export function projectAndTags(metadata: Record<string, unknown>): {
  project: string | null;
  tags: string[];
} {
  const project = typeof metadata.project === "string" ? metadata.project : null;
  const raw = metadata.tags;
  const tags = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter(
    (tag): tag is string => typeof tag === "string",
  );
  return { project, tags };
}

export function ext(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : name.slice(0, 6);
}
