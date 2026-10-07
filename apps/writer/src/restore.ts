import { isContentHash, parseId, publicIdFor, validatePath } from "@waypoint/core";
import { z } from "zod";

import type { Bucket } from "./bucket.js";
import type { Db, DbHandle } from "./db.js";
import { SyncLoop } from "./sync-loop.js";

const collectionSchema = z.object({
  id: z.string(),
  public_id: z.string(),
  title: z.string(),
  metadata: z.string(),
  created_at: z.number(),
});
const tombstoneSchema = z.object({
  collection_id: z.string(),
  deleted_at: z.number(),
  note: z.string().nullable(),
});
const snapshotSchema = z.object({
  format_version: z.literal(1).optional(),
  updated_at: z.number().optional(),
  collection: collectionSchema,
  tombstone: tombstoneSchema.nullable(),
  share_links: z
    .array(
      z.object({
        id: z.string(),
        token_hash: z.string(),
        collection_id: z.string(),
        revision_id: z.string().nullable(),
        label: z.string().nullable(),
        expires_at: z.number().nullable(),
        revoked_at: z.number().nullable(),
        created_at: z.number(),
      }),
    )
    .optional(),
});
const revisionSchema = z.object({
  id: z.string(),
  public_id: z.string(),
  collection_id: z.string(),
  parent_revision_id: z.string().nullable(),
  head_path: z.string(),
  message: z.string().nullable(),
  metadata: z.string(),
  created_at: z.number(),
});
const fileSchema = z.object({
  hash: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
});
const renditionSchema = z.object({
  source_hash: z.string(),
  renderer: z.string(),
  renderer_version: z.number(),
  output_hash: z.string(),
  output_mime: z.string(),
  created_at: z.number(),
  output_size: z.number().int().nonnegative().optional(),
});
const manifestSchema = z.object({
  format_version: z.literal(1).optional(),
  revision: revisionSchema,
  files: z.record(z.string(), fileSchema),
  renditions: z.array(renditionSchema),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type DrManifest = z.infer<typeof manifestSchema>;
async function json(bucket: Bucket, key: string): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await bucket.get(key)) {
    if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
    else throw new Error(`Invalid bucket body: ${key}`);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
async function validSnapshot(bucket: Bucket, key: string): Promise<Snapshot> {
  const value = snapshotSchema.parse(await json(bucket, key));
  parseId(value.collection.id, "col");
  if (value.collection.public_id !== (await publicIdFor(parseId(value.collection.id, "col"))))
    throw new Error(`Invalid collection public ID in ${key}`);
  if (value.tombstone && value.tombstone.collection_id !== value.collection.id)
    throw new Error(`Invalid tombstone in ${key}`);
  if (key !== `collections/${value.collection.id}.json`)
    throw new Error(`Collection key mismatch: ${key}`);
  for (const link of value.share_links ?? []) {
    parseId(link.id, "shl");
    if (link.collection_id !== value.collection.id || !isContentHash(link.token_hash))
      throw new Error(`Invalid share link in ${key}`);
    if (link.revision_id) parseId(link.revision_id, "rev");
  }
  return value;
}
async function validManifest(bucket: Bucket, key: string): Promise<DrManifest> {
  const value = manifestSchema.parse(await json(bucket, key));
  const rev = value.revision;
  parseId(rev.id, "rev");
  parseId(rev.collection_id, "col");
  if (rev.parent_revision_id) parseId(rev.parent_revision_id, "rev");
  if (rev.public_id !== (await publicIdFor(parseId(rev.id, "rev"))))
    throw new Error(`Invalid revision public ID in ${key}`);
  if (key !== `manifests/${rev.id}.json`) throw new Error(`Revision key mismatch: ${key}`);
  validatePath(rev.head_path);
  for (const [path, file] of Object.entries(value.files)) {
    validatePath(path);
    if (!isContentHash(file.hash)) throw new Error(`Invalid file hash in ${key}`);
  }
  for (const rendition of value.renditions)
    if (!isContentHash(rendition.source_hash) || !isContentHash(rendition.output_hash))
      throw new Error(`Invalid rendition hash in ${key}`);
  return value;
}
async function insertSnapshot(
  tx: DbHandle,
  row: Snapshot,
  mode: "from-bucket" | "merge",
): Promise<number> {
  const col = row.collection;
  const existed = await tx.get("SELECT id FROM collections WHERE id=?", [col.id]);
  const result = await tx.run(
    "INSERT OR IGNORE INTO collections (id,public_id,title,metadata,created_at) VALUES (?,?,?,?,?)",
    [col.id, col.public_id, col.title, col.metadata, col.created_at],
  );
  if (row.tombstone && (mode === "from-bucket" || !existed))
    await tx.run(
      "INSERT OR IGNORE INTO collection_tombstones (collection_id,deleted_at,note) VALUES (?,?,?)",
      [row.tombstone.collection_id, row.tombstone.deleted_at, row.tombstone.note],
    );
  return result.changes;
}
async function insertManifest(tx: DbHandle, item: DrManifest): Promise<number> {
  const rev = item.revision;
  for (const file of Object.values(item.files))
    await tx.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,?)", [
      file.hash,
      file.size,
      rev.created_at,
    ]);
  for (const rendition of item.renditions) {
    await tx.run("INSERT OR IGNORE INTO blobs (hash,size,uploaded_at) VALUES (?,?,?)", [
      rendition.output_hash,
      rendition.output_size ?? 0,
      rendition.created_at,
    ]);
    await tx.run(
      "INSERT OR IGNORE INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,?)",
      [
        rendition.source_hash,
        rendition.renderer,
        rendition.renderer_version,
        rendition.output_hash,
        rendition.output_mime,
        rendition.created_at,
      ],
    );
  }
  const result = await tx.run(
    "INSERT OR IGNORE INTO revisions (id,public_id,collection_id,parent_revision_id,head_path,message,metadata,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      rev.id,
      rev.public_id,
      rev.collection_id,
      rev.parent_revision_id,
      rev.head_path,
      rev.message,
      rev.metadata,
      rev.created_at,
    ],
  );
  for (const [path, file] of Object.entries(item.files))
    await tx.run(
      "INSERT OR IGNORE INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
      [rev.id, path, file.hash, file.mime, file.size],
    );
  return result.changes;
}
export async function restore(
  waypoint: Db,
  bucket: Bucket,
  sync: SyncLoop,
  mode: "from-bucket" | "merge",
): Promise<{ collections: number; revisions: number; ignored: number }> {
  if (
    mode === "from-bucket" &&
    ((await waypoint.get("SELECT 1 FROM collections LIMIT 1")) ||
      (await waypoint.get("SELECT 1 FROM revisions LIMIT 1")))
  )
    throw new Error("Restore requires an empty cloud DB");
  const collectionIds = new Set<string>();
  const shareLinks: Snapshot["share_links"] = [];
  let collections = 0;
  let batch: Snapshot[] = [];
  const flushSnapshots = async () => {
    if (!batch.length) return;
    const ready = batch;
    batch = [];
    await waypoint.transaction(async (tx) => {
      for (const row of ready) collections += await insertSnapshot(tx, row, mode);
    });
  };
  for await (const page of bucket.listPages("collections/"))
    for (const key of page) {
      const row = await validSnapshot(bucket, key);
      collectionIds.add(row.collection.id);
      shareLinks.push(...(row.share_links ?? []));
      batch.push(row);
      if (batch.length >= 100) await flushSnapshots();
    }
  await flushSnapshots();
  const valid = new Set<string>();
  let revisions = 0,
    ignored = 0;
  let manifestBatch: DrManifest[] = [];
  const flushManifests = async () => {
    if (!manifestBatch.length) return;
    const ready = manifestBatch;
    manifestBatch = [];
    await waypoint.transaction(async (tx) => {
      for (const item of ready) revisions += await insertManifest(tx, item);
    });
  };
  const deferred: DrManifest[] = [];
  const consume = async (item: DrManifest): Promise<boolean> => {
    const rev = item.revision;
    if (!collectionIds.has(rev.collection_id)) return false;
    if (rev.parent_revision_id && !valid.has(rev.parent_revision_id)) return false;
    const outputs = [];
    for (const rendition of item.renditions) {
      if (await bucket.head(`blobs/sha256/${rendition.output_hash.slice(7)}`))
        outputs.push(rendition);
      else console.warn(`Restore skipped missing rendition output ${rendition.output_hash}`);
    }
    valid.add(rev.id);
    manifestBatch.push({ ...item, renditions: outputs });
    if (manifestBatch.length >= 100) await flushManifests();
    return true;
  };
  for await (const page of bucket.listPages("manifests/"))
    for (const key of page) {
      const item = await validManifest(bucket, key);
      if (!(await consume(item))) deferred.push(item);
    }
  let unresolved = deferred;
  while (unresolved.length) {
    const next: DrManifest[] = [];
    for (const item of unresolved) if (!(await consume(item))) next.push(item);
    if (next.length === unresolved.length) {
      ignored += next.length;
      break;
    }
    unresolved = next;
  }
  await flushManifests();
  await waypoint.transaction(async (tx) => {
    for (const link of shareLinks) {
      if (
        link.revision_id &&
        !(await tx.get("SELECT 1 FROM revisions WHERE id=? AND collection_id=?", [
          link.revision_id,
          link.collection_id,
        ]))
      )
        continue;
      await tx.run(
        "INSERT OR IGNORE INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [
          link.id,
          link.token_hash,
          link.collection_id,
          link.revision_id,
          link.label,
          link.expires_at,
          link.revoked_at,
          link.created_at,
        ],
      );
      if (mode === "merge" && link.revoked_at !== null)
        await tx.run("UPDATE share_links SET revoked_at=COALESCE(revoked_at,?) WHERE id=?", [
          link.revoked_at,
          link.id,
        ]);
      // An extension on either side survives: keep the later expiry (null, never expires,
      // only when both sides are null). Revocation above is unaffected.
      if (mode === "merge" && link.expires_at !== null)
        await tx.run(
          "UPDATE share_links SET expires_at=? WHERE id=? AND (expires_at IS NULL OR expires_at<?)",
          [link.expires_at, link.id, link.expires_at],
        );
    }
  });
  await sync.push();
  return { collections, revisions, ignored };
}
