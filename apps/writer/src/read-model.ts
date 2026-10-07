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
  type CollectionSummary,
  type CollectionDetail,
  type RevisionSummary,
  type RevisionDetail,
  type ListRevisionsResponse,
  type ResolveResponse,
} from "@waypoint/core";
import { z } from "zod";

import type { Db } from "./db.js";
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
  sync_state?: SyncState | undefined;
  display_number?: number | undefined;
}
export class ReadModel {
  constructor(
    readonly waypoint: Db,
    readonly queue: Db,
    readonly baseUrl: string,
  ) {}
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
  async fileCounts(revisionIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!revisionIds.length) return counts;
    const placeholders = revisionIds.map(() => "?").join(",");
    const [committed, pending] = await Promise.all([
      this.waypoint.all<{ revision_id: string; count: number }>(
        `SELECT revision_id,COUNT(*) AS count FROM revision_files WHERE revision_id IN (${placeholders}) GROUP BY revision_id`,
        revisionIds,
      ),
      this.queue.all<{ id: string; manifest_json: string }>(
        `SELECT id,manifest_json FROM pending_revisions WHERE id IN (${placeholders})`,
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
  async listRevisions(collectionId: string): Promise<ListRevisionsResponse> {
    const collection = await this.collection(collectionId);
    if (!collection) throw new WaypointError("collection_not_found", "Collection not found");
    return {
      revisions: (await this.revisions(collectionId)).map((row) =>
        this.summaryFor(row, collection),
      ),
    };
  }
  async listCollections(
    query = "",
    limit = 50,
    includeDeleted = false,
  ): Promise<CollectionSummary[]> {
    const [committed, pending, tombstones, committedRevisions, pendingRevisions, unpushed] =
      await Promise.all([
        this.waypoint.all<CollectionRow>("SELECT * FROM collections"),
        this.queue.all<CollectionRow>("SELECT * FROM pending_collections"),
        this.waypoint.all<{ collection_id: string; deleted_at: number }>(
          "SELECT collection_id,deleted_at FROM collection_tombstones",
        ),
        this.waypoint.all<RevisionRow>("SELECT * FROM revisions"),
        this.queue.all<RevisionRow>("SELECT * FROM pending_revisions"),
        this.queue.all<{ revision_id: string }>("SELECT revision_id FROM unpushed"),
      ]);
    const map = new Map(committed.map((x) => [x.id, x]));
    for (const row of pending) map.set(row.id, row);
    const deleted = new Map(tombstones.map((row) => [row.collection_id, row.deleted_at]));
    const pendingIds = new Set(pendingRevisions.map((row) => row.id));
    const unpushedIds = new Set(unpushed.map((row) => row.revision_id));
    const allRevisions = new Map<string, RevisionRow>();
    for (const row of pendingRevisions)
      allRevisions.set(row.id, { ...row, sync_state: row.state ?? "pending" });
    for (const row of committedRevisions)
      allRevisions.set(row.id, {
        ...row,
        sync_state: pendingIds.has(row.id) || unpushedIds.has(row.id) ? "committed" : "synced",
      });
    const grouped = new Map<string, RevisionRow[]>();
    for (const row of allRevisions.values()) {
      const group = grouped.get(row.collection_id) ?? [];
      group.push(row);
      grouped.set(row.collection_id, group);
    }
    const result: CollectionSummary[] = [];
    for (const row of map.values()) {
      const deletedAt = row.deleted_at ?? deleted.get(row.id) ?? null;
      if (
        (!includeDeleted && deletedAt !== null) ||
        !row.title.toLowerCase().includes(query.toLowerCase())
      )
        continue;
      const revisions = (grouped.get(row.id) ?? []).toSorted((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const latest = revisions.findLast((revision) => revision.sync_state !== "failed");
      const numbers = displayNumbers(revisions.map((revision) => parseId(revision.id, "rev")));
      result.push({
        id: row.id,
        public_id: row.public_id,
        title: row.title,
        metadata: metadata(row.metadata),
        created_at: row.created_at,
        deleted: deletedAt !== null,
        latest_revision: latest
          ? this.summaryFor({ ...latest, display_number: numbers[latest.id] }, row)
          : null,
        latest_url: latestCollectionUrl(this.baseUrl, row.public_id),
      });
    }
    return result
      .toSorted((a, b) =>
        (b.latest_revision?.id ?? "") > (a.latest_revision?.id ?? "")
          ? 1
          : (b.latest_revision?.id ?? "") < (a.latest_revision?.id ?? "")
            ? -1
            : 0,
      )
      .slice(0, limit);
  }
  async getCollection(id: string): Promise<CollectionDetail> {
    const row = await this.collection(id);
    if (!row) throw new WaypointError("collection_not_found", "Collection not found");
    const latest = await this.latest(id);
    const detail = latest ? await this.getRevision(latest.id) : null;
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
