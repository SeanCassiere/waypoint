import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  parseWriterUrl,
  latestCollectionUrl,
  pinnedRevisionUrl,
  rawUrl,
  displayNumbers,
  parseId,
  isContentHash,
  validatePath,
  WaypointError,
  type Manifest,
  type SyncState,
  type CollectionDetail,
  type RevisionSummary,
  type RevisionDetail,
  type ListRevisionsResponse,
  type ResolveResponse,
  type CollectionSearchResult,
  type SearchCollectionsResponse,
  type RevisionChanges,
} from "@waypoint/core";
import { z } from "zod";

import type { Db } from "./db.ts";
import { liveLinkWhere, pausedLinkWhere, trashedPendingIds } from "./shares.ts";
function parseManifest(json: string): Manifest {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || !("headPath" in parsed) || !("files" in parsed))
    throw new Error("Invalid stored manifest");
  const headPath = parsed.headPath;
  const entries = parsed.files;
  if (
    typeof headPath !== "string" ||
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries)
  )
    throw new Error("Invalid stored manifest");
  const files: Manifest["files"] = {};
  Object.setPrototypeOf(files, null);
  const pairs: [string, unknown][] = Object.entries(entries);
  for (const [path, value] of pairs) {
    if (
      !value ||
      typeof value !== "object" ||
      !("hash" in value) ||
      !("mime" in value) ||
      !("size" in value)
    )
      throw new Error("Invalid stored manifest entry");
    if (
      typeof value.hash !== "string" ||
      !isContentHash(value.hash) ||
      typeof value.mime !== "string" ||
      typeof value.size !== "number"
    )
      throw new Error("Invalid stored manifest entry");
    files[validatePath(path)] = { hash: value.hash, mime: value.mime, size: value.size };
  }
  return { headPath: validatePath(headPath), files };
}
const metadataSchema = z.record(z.string(), z.unknown());
function metadata(text: string): Record<string, unknown> {
  return metadataSchema.parse(JSON.parse(text) as unknown);
}
export interface CollectionRow {
  id: string;
  public_id: string;
  title: string;
  metadata: string;
  created_at: number;
  deleted_at?: number | null;
}
export interface RevisionRow {
  id: string;
  public_id: string;
  collection_id: string;
  parent_revision_id: string | null;
  head_path: string;
  message: string | null;
  metadata: string;
  created_at: number;
  manifest_json?: string;
  state?: "pending" | "failed";
  last_error?: string | null;
  error_kind?: string | null;
  sync_state?: SyncState | undefined;
  display_number?: number | undefined;
}
export interface SearchOptions {
  query?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  updated_after?: number | undefined;
  sort?: "updated" | "created" | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  include_deleted?: boolean | undefined;
  /** Viewer search tokens (B6). */
  only_deleted?: boolean | undefined;
  /** Also count live collections per metadata.project from the rows already loaded. */
  projects?: boolean | undefined;
  tags?: string[] | undefined;
  host?: string | undefined;
  shared?: boolean | undefined;
  unsynced?: boolean | undefined;
  pending?: boolean | undefined;
}
function containsValue(value: unknown, query: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(query);
  if (Array.isArray(value)) return value.some((part) => containsValue(part, query));
  if (value && typeof value === "object")
    return Object.values(value).some((part) => containsValue(part, query));
  return (
    (typeof value === "number" || typeof value === "boolean") &&
    String(value).toLowerCase().includes(query)
  );
}
function deepEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(actual) && Array.isArray(expected))
    return (
      actual.length === expected.length &&
      actual.every((value, index) => deepEqual(value, expected[index]))
    );
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const entries = Object.entries(actual);
    const expectedEntries = new Map(Object.entries(expected));
    return (
      entries.length === expectedEntries.size &&
      entries.every(
        ([key, value]) => expectedEntries.has(key) && deepEqual(value, expectedEntries.get(key)),
      )
    );
  }
  return false;
}
function equalsFilter(actual: unknown, expected: unknown): boolean {
  return (
    deepEqual(actual, expected) ||
    (Array.isArray(actual) && actual.some((value) => deepEqual(value, expected)))
  );
}
function decodeCursor(value: string): {
  last: [number, number, string];
  snapshotId: string;
} {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("last" in parsed) || !("snapshotId" in parsed))
      throw new Error("cursor");
    const cursor = parsed;
    if (
      !Array.isArray(cursor.last) ||
      typeof cursor.last[0] !== "number" ||
      typeof cursor.last[1] !== "number" ||
      typeof cursor.last[2] !== "string" ||
      typeof cursor.snapshotId !== "string"
    )
      throw new Error("cursor");
    return {
      last: [cursor.last[0], cursor.last[1], cursor.last[2]],
      snapshotId: cursor.snapshotId,
    };
  } catch {
    throw new WaypointError("validation_failed", "Invalid cursor");
  }
}
function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}
function diffManifests(
  parent: ReadonlyMap<string, string> | undefined,
  child: ReadonlyMap<string, string>,
): RevisionChanges {
  const changes = { added: 0, modified: 0, removed: 0 };
  for (const [path, hash] of child) {
    const before = parent?.get(path);
    if (before === undefined) changes.added++;
    else if (before !== hash) changes.modified++;
  }
  for (const path of parent?.keys() ?? []) if (!child.has(path)) changes.removed++;
  return changes;
}
function hashesOf(manifest: Manifest): Map<string, string> {
  return new Map(Object.entries(manifest.files).map(([path, entry]) => [path, entry.hash]));
}
export function sourceHost(metadataJson: string | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    if (parsed && typeof parsed === "object" && "source_host" in parsed) {
      const host = parsed.source_host;
      if (typeof host === "string" && host.trim()) return host.trim().slice(0, 120);
    }
  } catch {
    return null;
  }
  return null;
}
function ranked(map: Map<string, number>): { value: string; count: number }[] {
  return [...map]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
export interface Facets {
  projects: { value: string; count: number }[];
  tags: { value: string; count: number }[];
  hosts: { value: string; count: number; last_written_at: number }[];
}
/** collectionsById's entry: display fields plus the live rule's two Trash facts (OW-05). */
export interface CollectionFacts {
  id: string;
  public_id: string;
  title: string;
  deleted: boolean;
  tombstoned: boolean;
  pendingTrashed: boolean;
}
/** A collection's public links (B4, OW-05): `active` live links, `paused` links in Trash. */
export interface ShareSummary {
  active: number;
  follows_latest: boolean;
  paused: number;
}
/** About 150 bytes each: a few MB at most. */
export const CHANGE_CACHE_SIZE = 20_000;
export class ReadModel {
  readonly revisionEvents = new EventEmitter().setMaxListeners(220);
  private readonly searchSnapshots = new Map<
    string,
    { results: CollectionSearchResult[]; sort: "updated" | "created"; createdAt: number }
  >();
  notifyRevision(collectionId: string): void {
    this.revisionEvents.emit("revision", collectionId);
  }
  /** Change counts of committed revisions, least recently used first (see changesFor). */
  private readonly changeCache = new Map<string, RevisionChanges>();
  readonly waypoint: Db;
  readonly queue: Db;
  readonly baseUrl: string;
  constructor(waypoint: Db, queue: Db, baseUrl: string) {
    this.waypoint = waypoint;
    this.queue = queue;
    this.baseUrl = baseUrl;
  }
  private cacheChanges(id: string, changes: RevisionChanges): void {
    this.changeCache.delete(id);
    this.changeCache.set(id, { ...changes });
    for (const key of this.changeCache.keys()) {
      if (this.changeCache.size <= CHANGE_CACHE_SIZE) break;
      this.changeCache.delete(key);
    }
  }
  async collection(id: string): Promise<CollectionRow | undefined> {
    const pending = await this.queue.get<CollectionRow>(
      "SELECT * FROM pending_collections WHERE id=?",
      [id],
    );
    if (pending) return pending;
    const committed = await this.waypoint.get<CollectionRow>(
      "SELECT * FROM collections WHERE id=?",
      [id],
    );
    if (!committed) return undefined;
    const tombstone = await this.waypoint.get<{ deleted_at: number }>(
      "SELECT deleted_at FROM collection_tombstones WHERE collection_id=?",
      [id],
    );
    return { ...committed, deleted_at: tombstone?.deleted_at ?? null };
  }
  async collectionByPublicId(publicId: string): Promise<CollectionRow | undefined> {
    const normalized = publicId.toLowerCase();
    const row =
      (await this.queue.get<CollectionRow>("SELECT * FROM pending_collections WHERE public_id=?", [
        normalized,
      ])) ??
      (await this.waypoint.get<CollectionRow>("SELECT * FROM collections WHERE public_id=?", [
        normalized,
      ]));
    return row ? this.collection(row.id) : undefined;
  }
  async deletedCollections(): Promise<CollectionRow[]> {
    const [pending, committed] = await Promise.all([
      this.queue.all<CollectionRow>(
        "SELECT * FROM pending_collections WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      ),
      this.waypoint.all<CollectionRow>(
        "SELECT c.*,t.deleted_at FROM collections c JOIN collection_tombstones t ON t.collection_id=c.id ORDER BY t.deleted_at DESC",
      ),
    ]);
    return [...pending, ...committed].toSorted((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0));
  }
  /** Revisions (with sync state and display numbers) for many collections in three queries. */
  async revisionIndex(collectionIds: string[]): Promise<Map<string, RevisionRow[]>> {
    const index = new Map<string, RevisionRow[]>();
    if (!collectionIds.length) return index;
    const marks = placeholders(collectionIds);
    const [committed, pending, unpushed] = await Promise.all([
      this.waypoint.all<RevisionRow>(
        `SELECT id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at FROM revisions WHERE collection_id IN (${marks})`,
        collectionIds,
      ),
      this.queue.all<RevisionRow>(
        `SELECT id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at,state FROM pending_revisions WHERE collection_id IN (${marks})`,
        collectionIds,
      ),
      this.queue.all<{ revision_id: string }>("SELECT revision_id FROM unpushed"),
    ]);
    const unpushedIds = new Set(unpushed.map((row) => row.revision_id));
    const pendingIds = new Set(pending.map((row) => row.id));
    const merged = new Map<string, RevisionRow>();
    for (const row of pending) merged.set(row.id, { ...row, sync_state: row.state ?? "pending" });
    for (const row of committed)
      merged.set(row.id, {
        ...row,
        sync_state: unpushedIds.has(row.id) || pendingIds.has(row.id) ? "committed" : "synced",
      });
    for (const row of [...merged.values()].toSorted((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const list = index.get(row.collection_id) ?? [];
      list.push(row);
      index.set(row.collection_id, list);
    }
    for (const list of index.values()) {
      const numbers = displayNumbers(list.map((row) => parseId(row.id, "rev")));
      for (const row of list) row.display_number = numbers[row.id];
    }
    return index;
  }
  /**
   * Title, public ID and Trash state for many collections in two queries. `deleted` is the
   * displayed state (a pending row wins over the committed one); `tombstoned` and
   * `pendingTrashed` are the live rule's two Trash facts, kept apart (OW-05): a tombstone still
   * hides the collection from the reader while a pending row says it's restored.
   */
  async collectionsById(collectionIds: string[]): Promise<Map<string, CollectionFacts>> {
    const found = new Map<string, CollectionFacts>();
    if (!collectionIds.length) return found;
    const marks = placeholders(collectionIds);
    const [committed, pending] = await Promise.all([
      this.waypoint.all<{
        id: string;
        public_id: string;
        title: string;
        deleted_at: number | null;
      }>(
        `SELECT c.id,c.public_id,c.title,t.deleted_at FROM collections c LEFT JOIN collection_tombstones t ON t.collection_id=c.id WHERE c.id IN (${marks})`,
        collectionIds,
      ),
      this.queue.all<{ id: string; public_id: string; title: string; deleted_at: number | null }>(
        `SELECT id,public_id,title,deleted_at FROM pending_collections WHERE id IN (${marks})`,
        collectionIds,
      ),
    ]);
    for (const row of committed)
      found.set(row.id, {
        id: row.id,
        public_id: row.public_id,
        title: row.title,
        deleted: row.deleted_at != null,
        tombstoned: row.deleted_at != null,
        pendingTrashed: false,
      });
    for (const row of pending)
      found.set(row.id, {
        id: row.id,
        public_id: row.public_id,
        title: row.title,
        deleted: row.deleted_at != null,
        tombstoned: found.get(row.id)?.tombstoned ?? false,
        pendingTrashed: row.deleted_at != null,
      });
    return found;
  }
  private facetCache: { at: number; value: Facets } | undefined;
  /** Projects, tags and writing hosts with counts (B6), cached for 30 s. */
  async facets(now = Date.now()): Promise<Facets> {
    if (this.facetCache && now - this.facetCache.at < 30_000) return this.facetCache.value;
    const [committed, pending, tombstones, revisions, queued] = await Promise.all([
      this.waypoint.all<{ id: string; metadata: string }>("SELECT id,metadata FROM collections"),
      this.queue.all<{ id: string; metadata: string; deleted_at: number | null }>(
        "SELECT id,metadata,deleted_at FROM pending_collections",
      ),
      this.waypoint.all<{ collection_id: string }>(
        "SELECT collection_id FROM collection_tombstones",
      ),
      this.waypoint.all<{ metadata: string; created_at: number }>(
        "SELECT metadata,created_at FROM revisions",
      ),
      this.queue.all<{ metadata: string; created_at: number }>(
        "SELECT metadata,created_at FROM pending_revisions",
      ),
    ]);
    const gone = new Set(tombstones.map((row) => row.collection_id));
    const projects = new Map<string, number>();
    const tags = new Map<string, number>();
    const live = [
      ...committed.filter((row) => !gone.has(row.id)),
      ...pending.filter((row) => row.deleted_at === null),
    ];
    for (const row of live) {
      let meta: Record<string, unknown>;
      try {
        meta = metadata(row.metadata);
      } catch {
        continue;
      }
      if (typeof meta.project === "string" && meta.project)
        projects.set(meta.project, (projects.get(meta.project) ?? 0) + 1);
      for (const tag of Array.isArray(meta.tags) ? meta.tags : [meta.tags])
        if (typeof tag === "string" && tag) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const hosts = new Map<string, { count: number; last: number }>();
    for (const row of [...revisions, ...queued]) {
      const host = sourceHost(row.metadata);
      if (!host) continue;
      const entry = hosts.get(host) ?? { count: 0, last: 0 };
      entry.count++;
      entry.last = Math.max(entry.last, row.created_at);
      hosts.set(host, entry);
    }
    const result: Facets = {
      projects: ranked(projects),
      tags: ranked(tags),
      hosts: [...hosts]
        .map(([host, entry]) => ({ value: host, count: entry.count, last_written_at: entry.last }))
        .toSorted((a, b) => b.last_written_at - a.last_written_at),
    };
    this.facetCache = { at: now, value: result };
    return result;
  }
  /**
   * Live and paused link counts per collection (B4, OW-05), under the reader's rule: one query,
   * plus the pending-trashed query when `trashedPending` isn't passed. Entries only where a
   * count is above 0; `follows_latest` when a live Latest link exists.
   */
  async shareSummary(
    collectionIds?: string[],
    options: { now?: number; trashedPending?: readonly string[] | undefined } = {},
  ): Promise<Map<string, ShareSummary>> {
    const summary = new Map<string, ShareSummary>();
    if (collectionIds && !collectionIds.length) return summary;
    const now = options.now ?? Date.now();
    const pending = options.trashedPending ?? (await trashedPendingIds({ queue: this.queue }));
    const live = liveLinkWhere(now, pending);
    const paused = pausedLinkWhere(now, pending);
    const rows = await this.waypoint.all<{
      collection_id: string;
      revision_id: string | null;
      live: number;
    }>(
      `SELECT s.collection_id,s.revision_id,CASE WHEN ${live.sql} THEN 1 ELSE 0 END AS live FROM share_links s WHERE ((${live.sql}) OR (${paused.sql}))${collectionIds ? ` AND s.collection_id IN (${placeholders(collectionIds)})` : ""}`,
      [...live.args, ...live.args, ...paused.args, ...(collectionIds ?? [])],
    );
    for (const row of rows) {
      const current = summary.get(row.collection_id) ?? {
        active: 0,
        follows_latest: false,
        paused: 0,
      };
      if (row.live) {
        current.active++;
        if (row.revision_id === null) current.follows_latest = true;
      } else current.paused++;
      summary.set(row.collection_id, current);
    }
    return summary;
  }
  /** Revision and newest-revision file counts for Trash rows; four queries for any number. */
  async trashDetails(
    collectionIds: string[],
  ): Promise<Map<string, { revisions: number; files: number; latest: string | null }>> {
    const details = new Map<string, { revisions: number; files: number; latest: string | null }>();
    if (!collectionIds.length) return details;
    const marks = placeholders(collectionIds);
    const [committed, pending] = await Promise.all([
      this.waypoint.all<{ id: string; collection_id: string }>(
        `SELECT id,collection_id FROM revisions WHERE collection_id IN (${marks})`,
        collectionIds,
      ),
      this.queue.all<{ id: string; collection_id: string; state: string }>(
        `SELECT id,collection_id,state FROM pending_revisions WHERE collection_id IN (${marks})`,
        collectionIds,
      ),
    ]);
    for (const id of collectionIds) {
      const ids = new Set([
        ...committed.filter((row) => row.collection_id === id).map((row) => row.id),
        ...pending.filter((row) => row.collection_id === id).map((row) => row.id),
      ]);
      const failed = new Set(pending.filter((row) => row.state === "failed").map((row) => row.id));
      const sorted = [...ids].toSorted();
      details.set(id, {
        revisions: ids.size,
        files: 0,
        latest: sorted.findLast((rev) => !failed.has(rev)) ?? sorted.at(-1) ?? null,
      });
    }
    const counts = await this.fileCounts(
      [...details.values()].flatMap((detail) => (detail.latest ? [detail.latest] : [])),
    );
    for (const detail of details.values())
      if (detail.latest) detail.files = counts.get(detail.latest) ?? 0;
    return details;
  }
  async fileCounts(revisionIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!revisionIds.length) return counts;
    const marks = placeholders(revisionIds);
    const [committed, pending] = await Promise.all([
      this.waypoint.all<{ revision_id: string; count: number }>(
        `SELECT revision_id,COUNT(*) AS count FROM revision_files WHERE revision_id IN (${marks}) GROUP BY revision_id`,
        revisionIds,
      ),
      this.queue.all<{ id: string; manifest_json: string }>(
        `SELECT id,manifest_json FROM pending_revisions WHERE id IN (${marks})`,
        revisionIds,
      ),
    ]);
    for (const row of committed) counts.set(row.revision_id, row.count);
    for (const row of pending)
      counts.set(row.id, Object.keys(parseManifest(row.manifest_json).files).length);
    return counts;
  }
  async revisions(collectionId: string): Promise<RevisionRow[]> {
    const committed = await this.waypoint.all<RevisionRow>(
      "SELECT * FROM revisions WHERE collection_id=?",
      [collectionId],
    );
    const pending = await this.queue.all<RevisionRow>(
      "SELECT * FROM pending_revisions WHERE collection_id=?",
      [collectionId],
    );
    const unpushed = await this.queue.all<{ revision_id: string }>(
      "SELECT revision_id FROM unpushed",
    );
    const ids = new Set(unpushed.map((x) => x.revision_id));
    const pendingIds = new Set(pending.map((x) => x.id));
    const mergedById = new Map<string, RevisionRow>();
    for (const r of pending) mergedById.set(r.id, { ...r, sync_state: r.state ?? "pending" });
    for (const r of committed)
      mergedById.set(r.id, {
        ...r,
        sync_state:
          ids.has(r.id) || pendingIds.has(r.id) ? ("committed" as const) : ("synced" as const),
      });
    const merged = [...mergedById.values()].toSorted((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const numbers = displayNumbers(merged.map((x) => parseId(x.id, "rev")));
    for (const revision of merged) revision.display_number = numbers[revision.id];
    return merged;
  }
  async revision(id: string): Promise<(RevisionRow & { manifest: Manifest }) | undefined> {
    const committed = await this.waypoint.get<RevisionRow>("SELECT * FROM revisions WHERE id=?", [
      id,
    ]);
    if (!committed) {
      const pending = await this.queue.get<RevisionRow>(
        "SELECT * FROM pending_revisions WHERE id=?",
        [id],
      );
      return pending
        ? {
            ...pending,
            sync_state: pending.state ?? "pending",
            manifest: parseManifest(pending.manifest_json ?? ""),
          }
        : undefined;
    }
    const rows = await this.waypoint.all<{
      path: string;
      blob_hash: string;
      mime: string;
      size: number;
    }>("SELECT * FROM revision_files WHERE revision_id=?", [id]);
    const files: Manifest["files"] = {};
    Object.setPrototypeOf(files, null);
    for (const row of rows) {
      if (!isContentHash(row.blob_hash)) throw new Error("Invalid stored blob hash");
      Object.defineProperty(files, row.path, {
        value: { hash: row.blob_hash, mime: row.mime, size: row.size },
        enumerable: true,
      });
    }
    const unpushed = await this.queue.get("SELECT revision_id FROM unpushed WHERE revision_id=?", [
      id,
    ]);
    const pending = await this.queue.get("SELECT id FROM pending_revisions WHERE id=?", [id]);
    return {
      ...committed,
      sync_state: unpushed || pending ? "committed" : "synced",
      manifest: { headPath: committed.head_path, files },
    };
  }
  /** The manifest of a revision row from {@link revisions}; at most one query. */
  async manifestOf(row: RevisionRow): Promise<Manifest> {
    if (row.manifest_json !== undefined) return parseManifest(row.manifest_json);
    const rows = await this.waypoint.all<{
      path: string;
      blob_hash: string;
      mime: string;
      size: number;
    }>("SELECT path,blob_hash,mime,size FROM revision_files WHERE revision_id=?", [row.id]);
    const files: Manifest["files"] = {};
    Object.setPrototypeOf(files, null);
    for (const file of rows) {
      if (!isContentHash(file.blob_hash)) throw new Error("Invalid stored blob hash");
      Object.defineProperty(files, file.path, {
        value: { hash: file.blob_hash, mime: file.mime, size: file.size },
        enumerable: true,
      });
    }
    if (!rows.length) {
      const pending = await this.queue.get<{ manifest_json: string }>(
        "SELECT manifest_json FROM pending_revisions WHERE id=?",
        [row.id],
      );
      if (pending) return parseManifest(pending.manifest_json);
    }
    return { headPath: row.head_path, files };
  }
  /**
   * Change counts against each revision's parent (B2). Committed revisions use one grouped
   * join of revision_files against the parent's; queued revisions are diffed in memory from their manifests.
   * At most three queries regardless of how many revisions are passed.
   *
   * The self-join reads every file of each revision and its parent, so callers pass only the
   * revisions they show. Counts of committed revisions never change once their parent is
   * committed too, so they're kept in a bounded in-memory cache and cost no query afterwards.
   */
  async changesFor(
    rows: readonly Pick<
      RevisionRow,
      "id" | "parent_revision_id" | "sync_state" | "manifest_json"
    >[],
  ): Promise<Map<string, RevisionChanges>> {
    const result = new Map<string, RevisionChanges>();
    if (!rows.length) return result;
    const queued = (row: Pick<RevisionRow, "sync_state">) =>
      row.sync_state === "pending" || row.sync_state === "failed";
    const committed: string[] = [];
    for (const row of rows) {
      if (queued(row)) continue;
      const cached = this.changeCache.get(row.id);
      if (cached) result.set(row.id, { ...cached });
      else committed.push(row.id);
    }
    const pending = rows.filter(queued);
    const manifests = new Map<string, Map<string, string>>();
    for (const row of pending)
      if (row.manifest_json !== undefined)
        manifests.set(row.id, hashesOf(parseManifest(row.manifest_json)));
    const missing = pending.filter((row) => !manifests.has(row.id)).map((row) => row.id);
    const [grouped, loaded] = await Promise.all([
      committed.length
        ? this.waypoint.all<{
            id: string;
            files: number;
            added: number;
            modified: number;
            parent_files: number;
            settled: number;
          }>(
            // One join of each revision's files against its parent's; removed files follow from
            // the parent's file count (removed = parent files − files the two share).
            `WITH t AS (SELECT r.id AS id,r.parent_revision_id AS parent,COUNT(*) AS files,SUM(CASE WHEN p.path IS NULL THEN 1 ELSE 0 END) AS added,SUM(CASE WHEN p.path IS NOT NULL AND p.blob_hash<>f.blob_hash THEN 1 ELSE 0 END) AS modified FROM revisions r JOIN revision_files f ON f.revision_id=r.id LEFT JOIN revision_files p ON p.revision_id=r.parent_revision_id AND p.path=f.path WHERE r.id IN (${placeholders(committed)}) GROUP BY r.id) SELECT t.id AS id,t.files AS files,t.added AS added,t.modified AS modified,(SELECT COUNT(*) FROM revision_files q WHERE q.revision_id=t.parent) AS parent_files,CASE WHEN t.parent IS NULL OR EXISTS (SELECT 1 FROM revisions q WHERE q.id=t.parent) THEN 1 ELSE 0 END AS settled FROM t`,
            committed,
          )
        : Promise.resolve([]),
      missing.length
        ? this.queue.all<{ id: string; manifest_json: string }>(
            `SELECT id,manifest_json FROM pending_revisions WHERE id IN (${placeholders(missing)})`,
            missing,
          )
        : Promise.resolve([]),
    ]);
    for (const row of grouped) {
      const changes = {
        added: row.added,
        modified: row.modified,
        removed: Math.max(0, row.parent_files - (row.files - row.added)),
      };
      result.set(row.id, changes);
      // Final once the parent is committed too: neither revision's files change after that.
      if (row.settled) this.cacheChanges(row.id, changes);
    }
    for (const row of loaded) manifests.set(row.id, hashesOf(parseManifest(row.manifest_json)));
    const parentIds = [
      ...new Set(
        pending.flatMap((row) =>
          row.parent_revision_id && !manifests.has(row.parent_revision_id)
            ? [row.parent_revision_id]
            : [],
        ),
      ),
    ];
    if (parentIds.length) {
      const [files, queuedParents] = await Promise.all([
        this.waypoint.all<{ revision_id: string; path: string; blob_hash: string }>(
          `SELECT revision_id,path,blob_hash FROM revision_files WHERE revision_id IN (${placeholders(parentIds)})`,
          parentIds,
        ),
        this.queue.all<{ id: string; manifest_json: string }>(
          `SELECT id,manifest_json FROM pending_revisions WHERE id IN (${placeholders(parentIds)})`,
          parentIds,
        ),
      ]);
      // A committed parent can still have a queue row until cleanup; the committed files win.
      for (const row of queuedParents)
        manifests.set(row.id, hashesOf(parseManifest(row.manifest_json)));
      const committedParents = new Map<string, Map<string, string>>();
      for (const file of files) {
        const map = committedParents.get(file.revision_id) ?? new Map<string, string>();
        map.set(file.path, file.blob_hash);
        committedParents.set(file.revision_id, map);
      }
      for (const [id, map] of committedParents) manifests.set(id, map);
    }
    for (const row of pending) {
      const own = manifests.get(row.id);
      if (!own) continue;
      result.set(
        row.id,
        diffManifests(
          row.parent_revision_id ? manifests.get(row.parent_revision_id) : undefined,
          own,
        ),
      );
    }
    return result;
  }
  async latest(collectionId: string): Promise<RevisionRow | undefined> {
    return (await this.revisions(collectionId)).findLast((r) => r.sync_state !== "failed");
  }
  private async summary(row: RevisionRow): Promise<RevisionSummary> {
    const collection = await this.collection(row.collection_id);
    if (!collection) throw new WaypointError("not_found", "Collection not found");
    return this.summaryFor(row, collection);
  }
  private summaryFor(row: RevisionRow, collection: CollectionRow): RevisionSummary {
    return {
      id: row.id,
      public_id: row.public_id,
      collection_id: row.collection_id,
      parent_revision_id: row.parent_revision_id,
      display_number: row.display_number ?? 0,
      head_path: row.head_path,
      message: row.message,
      metadata: metadata(row.metadata),
      created_at: row.created_at,
      sync_state: row.sync_state ?? "synced",
      url: pinnedRevisionUrl(this.baseUrl, collection.public_id, row.public_id),
    };
  }
  async listRevisions(
    collectionId: string,
    options: { changes?: boolean } = {},
  ): Promise<ListRevisionsResponse> {
    const collection = await this.collection(collectionId);
    if (!collection) throw new WaypointError("collection_not_found", "Collection not found");
    const rows = await this.revisions(collectionId);
    const changes = options.changes ? await this.changesFor(rows) : undefined;
    return {
      revisions: rows.map((row) => ({
        ...this.summaryFor(row, collection),
        ...(changes ? { changes: changes.get(row.id) } : {}),
      })),
    };
  }
  async searchCollections(
    options: SearchOptions = {},
  ): Promise<SearchCollectionsResponse & { projects?: { value: string; count: number }[] }> {
    const query = options.query?.trim().toLowerCase() ?? "";
    const limit = options.limit ?? 20;
    const sort = options.sort ?? "updated";
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !["updated", "created"].includes(sort)
    )
      throw new WaypointError("validation_failed", "Invalid search options");
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    if (cursor) {
      const snapshot = this.searchSnapshots.get(cursor.snapshotId);
      if (!snapshot || Date.now() - snapshot.createdAt > 10 * 60_000)
        throw new WaypointError("validation_failed", "Search cursor expired; start a new search");
      const position = snapshot.results.findIndex((item) => item.id === cursor.last[2]);
      if (position < 0) throw new WaypointError("validation_failed", "Invalid cursor");
      return this.searchPage(
        snapshot.results.slice(position + 1),
        limit,
        cursor.snapshotId,
        snapshot.sort,
      );
    }
    const snapshotNow = Date.now();
    const ceilingIds = new Set<string>();
    const ceilingRevisionIds = new Set<string>();
    let exactId: string | undefined;
    if (query.startsWith("col_")) exactId = query;
    else if (/^[0-9a-hjkmnp-tv-z]{12}$/i.test(query))
      exactId = (await this.collectionByPublicId(query))?.id;
    else if (/^https?:\/\//i.test(query) || query.startsWith("/")) {
      try {
        exactId = (await this.resolve(query)).collection_id;
      } catch (error) {
        if (!(error instanceof WaypointError)) throw error;
      }
    }
    // The bundled Turso engine supports json_tree (verified against @tursodatabase/database).
    // Only leaf values are searched, so a metadata key by itself cannot match.
    // SQLite lower() is ASCII-only; non-ASCII terms use the value walk below.
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const filter =
      query && !exactId && Buffer.byteLength(query, "utf8") === query.length
        ? " WHERE lower(title) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_tree(metadata) j WHERE j.type IN ('text','integer','real','true','false') AND lower(CAST(CASE WHEN j.type IN ('true','false') THEN j.type ELSE j.value END AS TEXT)) LIKE ? ESCAPE '\\')"
        : "";
    const args = filter ? [pattern, pattern] : [];
    const [committed, pending, tombstones, committedRevisions, pendingRevisions, unpushed] =
      await Promise.all([
        this.waypoint.all<CollectionRow>(
          `SELECT id,public_id,title,metadata,created_at FROM collections${filter}`,
          args,
        ),
        this.queue.all<CollectionRow>(
          `SELECT id,public_id,title,metadata,created_at,deleted_at FROM pending_collections${filter}`,
          args,
        ),
        this.waypoint.all<{ collection_id: string; deleted_at: number }>(
          "SELECT collection_id,deleted_at FROM collection_tombstones",
        ),
        this.waypoint.all<RevisionRow>(
          "SELECT id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at FROM revisions",
        ),
        this.queue.all<RevisionRow>(
          "SELECT id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at,state FROM pending_revisions",
        ),
        this.queue.all<{ revision_id: string }>("SELECT revision_id FROM unpushed"),
      ]);
    const ceiling = [...committed, ...pending, ...committedRevisions, ...pendingRevisions].reduce(
      (max, row) => Math.max(max, row.created_at),
      snapshotNow,
    );
    const rows = new Map(committed.map((row) => [row.id, row]));
    for (const row of pending) rows.set(row.id, row);
    for (const row of rows.values()) if (row.created_at === ceiling) ceilingIds.add(row.id);
    const deleted = new Map(tombstones.map((row) => [row.collection_id, row.deleted_at]));
    const pendingIds = new Set(pendingRevisions.map((row) => row.id));
    const unpushedIds = new Set(unpushed.map((row) => row.revision_id));
    const revisions = new Map<string, RevisionRow>();
    for (const row of [...pendingRevisions, ...committedRevisions])
      if (row.created_at === ceiling) ceilingRevisionIds.add(row.id);
    for (const row of pendingRevisions)
      if (
        row.created_at < ceiling ||
        (row.created_at === ceiling && ceilingRevisionIds.has(row.id))
      )
        revisions.set(row.id, { ...row, sync_state: row.state ?? "pending" });
    for (const row of committedRevisions)
      if (
        row.created_at < ceiling ||
        (row.created_at === ceiling && ceilingRevisionIds.has(row.id))
      )
        revisions.set(row.id, {
          ...row,
          sync_state: pendingIds.has(row.id) || unpushedIds.has(row.id) ? "committed" : "synced",
        });
    const shared = options.shared
      ? new Set(
          [...(await this.shareSummary())].flatMap(([id, share]) => (share.active > 0 ? [id] : [])),
        )
      : null;
    const grouped = new Map<string, RevisionRow[]>();
    for (const row of revisions.values()) {
      const group = grouped.get(row.collection_id) ?? [];
      group.push(row);
      grouped.set(row.collection_id, group);
    }
    const results: CollectionSearchResult[] = [];
    for (const row of rows.values()) {
      if (row.created_at > ceiling || (row.created_at === ceiling && !ceilingIds.has(row.id)))
        continue;
      const isDeleted = (row.deleted_at ?? deleted.get(row.id) ?? null) !== null;
      if (isDeleted && !options.include_deleted && !options.only_deleted) continue;
      if (options.only_deleted && !isDeleted) continue;
      if (shared && !shared.has(row.id)) continue;
      const meta = metadata(row.metadata);
      if (
        options.metadata &&
        !Object.entries(options.metadata).every(([key, value]) => equalsFilter(meta[key], value))
      )
        continue;
      const match = !query
        ? null
        : row.id.toLowerCase() === query ||
            row.public_id.toLowerCase() === query ||
            row.id === exactId
          ? "id"
          : row.title.toLowerCase().includes(query)
            ? "title"
            : containsValue(meta, query)
              ? "metadata"
              : undefined;
      if (match === undefined) continue;
      const history = (grouped.get(row.id) ?? []).toSorted((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const latest = history.findLast((revision) => revision.sync_state !== "failed");
      const updatedAt = latest?.created_at ?? row.created_at;
      if (options.tags?.length) {
        const tags = meta.tags;
        const list = (Array.isArray(tags) ? tags : [tags]).map((tag) => String(tag).toLowerCase());
        if (!options.tags.every((tag) => list.includes(tag.toLowerCase()))) continue;
      }
      if (options.host) {
        const wanted = options.host.toLowerCase();
        const hosts = [
          ...history.map((revision) => sourceHost(revision.metadata)),
          sourceHost(row.metadata),
        ];
        if (!hosts.some((host) => host?.toLowerCase() === wanted)) continue;
      }
      if (options.unsynced && !history.some((revision) => revision.sync_state !== "synced"))
        continue;
      if (options.pending && !history.some((revision) => revision.sync_state === "pending"))
        continue;
      if (options.updated_after !== undefined && (!latest || updatedAt <= options.updated_after))
        continue;
      const numbers = displayNumbers(history.map((revision) => parseId(revision.id, "rev")));
      results.push({
        id: row.id,
        public_id: row.public_id,
        title: row.title,
        metadata: meta,
        created_at: row.created_at,
        updated_at: updatedAt,
        deleted: isDeleted,
        revision_count: history.length,
        latest_revision: latest
          ? {
              id: latest.id,
              display_number: numbers[latest.id] ?? 0,
              message: latest.message,
              created_at: latest.created_at,
              sync_state: latest.sync_state ?? "synced",
              head_path: latest.head_path,
              file_count: 0,
              source_host: sourceHost(latest.metadata),
            }
          : null,
        latest_url: latestCollectionUrl(this.baseUrl, row.public_id),
        match,
        queue: {
          pending: history.filter((revision) => revision.sync_state === "pending").length,
          failed: history.filter((revision) => revision.sync_state === "failed").length,
        },
      });
    }
    results.sort((a, b) => {
      const rank = (a.match === "id" ? 1 : 0) - (b.match === "id" ? 1 : 0);
      if (rank) return -rank;
      const av = sort === "created" ? a.created_at : a.updated_at;
      const bv = sort === "created" ? b.created_at : b.updated_at;
      return bv - av || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
    });
    const snapshotId = randomUUID();
    if (results.length > limit) {
      for (const [id, snapshot] of this.searchSnapshots)
        if (Date.now() - snapshot.createdAt > 10 * 60_000) this.searchSnapshots.delete(id);
      this.searchSnapshots.set(snapshotId, { results, sort, createdAt: Date.now() });
      if (this.searchSnapshots.size > 32)
        this.searchSnapshots.delete(this.searchSnapshots.keys().next().value ?? "");
    }
    const page = await this.searchPage(results, limit, snapshotId, sort);
    if (!options.projects || query) return page;
    // Projects facet for Recent: counted from rows this search already loaded (no queries).
    const projects = new Map<string, number>();
    for (const row of rows.values()) {
      if ((row.deleted_at ?? deleted.get(row.id) ?? null) !== null) continue;
      try {
        const project = metadata(row.metadata).project;
        if (typeof project === "string" && project)
          projects.set(project, (projects.get(project) ?? 0) + 1);
      } catch {
        continue;
      }
    }
    return { ...page, projects: ranked(projects) };
  }
  private async searchPage(
    results: CollectionSearchResult[],
    limit: number,
    snapshotId: string,
    sort: "updated" | "created",
  ): Promise<SearchCollectionsResponse> {
    const page = results.slice(0, limit).map((item) => ({
      ...item,
      latest_revision: item.latest_revision ? { ...item.latest_revision } : null,
    }));
    // File counts and change summaries are fetched once for the page, regardless of its size.
    const ids = page.flatMap((item) => (item.latest_revision ? [item.latest_revision.id] : []));
    const [committedCounts, queued] = ids.length
      ? await Promise.all([
          this.waypoint.all<{ revision_id: string; count: number }>(
            `SELECT revision_id,COUNT(*) AS count FROM revision_files WHERE revision_id IN (${placeholders(ids)}) GROUP BY revision_id`,
            ids,
          ),
          this.queue.all<{
            id: string;
            parent_revision_id: string | null;
            manifest_json: string;
            state: "pending" | "failed";
          }>(
            `SELECT id,parent_revision_id,manifest_json,state FROM pending_revisions WHERE id IN (${placeholders(ids)})`,
            ids,
          ),
        ])
      : [[], []];
    const counts = new Map(committedCounts.map((row) => [row.revision_id, row.count]));
    const queuedById = new Map(queued.map((row) => [row.id, row]));
    for (const row of queued)
      counts.set(row.id, Object.keys(parseManifest(row.manifest_json).files).length);
    const changes = await this.changesFor(
      ids.map((id) => {
        const row = queuedById.get(id);
        return row
          ? { ...row, sync_state: row.state }
          : { id, parent_revision_id: null, sync_state: "synced" as const };
      }),
    );
    const shares = await this.shareSummary(page.map((item) => item.id));
    for (const item of page) item.share = shares.get(item.id) ?? null;
    for (const item of page)
      if (item.latest_revision) {
        item.latest_revision.file_count =
          counts.get(item.latest_revision.id) ?? item.latest_revision.file_count;
        item.latest_revision.changes = changes.get(item.latest_revision.id) ?? null;
      }
    const last = page.at(-1);
    return {
      collections: page,
      next_cursor:
        results.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                last: [
                  last.match === "id" ? 1 : 0,
                  sort === "created" ? last.created_at : last.updated_at,
                  last.id,
                ],
                snapshotId,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async getCollection(id: string, revisionId?: string): Promise<CollectionDetail> {
    const row = await this.collection(id);
    if (!row) throw new WaypointError("collection_not_found", "Collection not found");
    const latest = await this.latest(id);
    const detail = revisionId
      ? await this.getRevision(revisionId)
      : latest
        ? await this.getRevision(latest.id)
        : null;
    if (detail && detail.collection_id !== id)
      throw new WaypointError("not_found", "Revision does not belong to collection");
    return {
      id: row.id,
      public_id: row.public_id,
      title: row.title,
      metadata: metadata(row.metadata),
      created_at: row.created_at,
      deleted: row.deleted_at != null,
      latest_revision: latest ? await this.summary(latest) : null,
      latest_url: latestCollectionUrl(this.baseUrl, row.public_id),
      revision: detail,
    };
  }
  async getRevision(id: string): Promise<RevisionDetail> {
    const row = await this.revision(id);
    if (!row) throw new WaypointError("not_found", "Revision not found");
    const numbers = displayNumbers(
      (await this.revisions(row.collection_id)).map((x) => parseId(x.id, "rev")),
    );
    const summary = await this.summary({ ...row, display_number: numbers[id] });
    return {
      ...summary,
      files: Object.entries(row.manifest.files)
        .map(([path, entry]) => ({
          path,
          hash: entry.hash,
          mime: entry.mime,
          size: entry.size,
          url: rawUrl(this.baseUrl, row.public_id, path),
        }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  }
  async rendition(hash: string): Promise<{ hash: string; mime: string } | undefined> {
    const pending = await this.queue.all<{
      output_hash: string;
      output_mime: string;
      renderer_version: number;
    }>(
      "SELECT output_hash,output_mime,renderer_version FROM pending_renditions WHERE source_hash=?",
      [hash],
    );
    const committed = await this.waypoint.all<{
      output_hash: string;
      output_mime: string;
      renderer_version: number;
    }>("SELECT output_hash,output_mime,renderer_version FROM renditions WHERE source_hash=?", [
      hash,
    ]);
    const newest = [...pending, ...committed].toSorted(
      (a, b) => b.renderer_version - a.renderer_version,
    )[0];
    return newest ? { hash: newest.output_hash, mime: newest.output_mime } : undefined;
  }
  async file(id: string, path: string): Promise<{ hash: string; mime: string; size: number }> {
    const revision = await this.revision(id);
    const entry = revision?.manifest.files[path];
    if (!entry) throw new WaypointError("not_found", "File not found");
    return entry;
  }
  async resolve(url: string): Promise<ResolveResponse> {
    const parsed = parseWriterUrl(url);
    if (parsed.kind === "raw") {
      const rev =
        (await this.queue.get<RevisionRow>("SELECT * FROM pending_revisions WHERE public_id=?", [
          parsed.revisionPublicId,
        ])) ??
        (await this.waypoint.get<RevisionRow>("SELECT * FROM revisions WHERE public_id=?", [
          parsed.revisionPublicId,
        ]));
      if (!rev) throw new WaypointError("not_found", "Revision not found");
      return { collection_id: rev.collection_id, revision_id: rev.id, path: parsed.path };
    }
    const col = await this.collectionByPublicId(parsed.collectionPublicId);
    if (!col) throw new WaypointError("not_found", "Collection not found");
    if (parsed.kind === "latest")
      return { collection_id: col.id, ...(parsed.path ? { path: parsed.path } : {}) };
    const rev =
      (await this.queue.get<RevisionRow>("SELECT * FROM pending_revisions WHERE public_id=?", [
        parsed.revisionPublicId,
      ])) ??
      (await this.waypoint.get<RevisionRow>("SELECT * FROM revisions WHERE public_id=?", [
        parsed.revisionPublicId,
      ]));
    if (!rev || rev.collection_id !== col.id)
      throw new WaypointError("not_found", "Revision not found");
    return {
      collection_id: col.id,
      revision_id: rev.id,
      ...(parsed.path ? { path: parsed.path } : {}),
    };
  }
}
