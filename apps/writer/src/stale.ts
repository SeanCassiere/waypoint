import { idTimestamp, isContentHash, rendererFor } from "@waypoint/core";
import { z } from "zod";

import { inSeries, type Db } from "./db.ts";

/**
 * Stale-rendition selection, shared by `waypoint-writer rerender` and the background backfill.
 *
 * A source is one `(renderer, source hash)` pair: a file blob whose MIME type picks a renderer
 * (`rendererFor`), in a committed revision or a pending (not failed) one. It is stale when its
 * newest rendition for that renderer, committed (`renditions`) or queued (`pending_renditions`),
 * is below the renderer's current version, or it has none. A newer version than current (left by
 * a newer release before a rollback) is not stale: readers serve the newest version anyway.
 *
 * Each stale source gets a priority, best first:
 * - Tier 1: in a revision pinned by an open share link, or, for a collection with an open Latest
 *   link, in the revision that link serves: the newest committed one (a queued revision isn't
 *   served until it commits, so it stays tier 2).
 * - Tier 2: in the latest revision of a collection.
 * - Tier 3: in an older revision.
 * Within a tier, sources of collections that aren't settled come before settled ones, then newer
 * revisions (by ID, UUIDv7) first. A collection is settled when its latest revision is older than
 * `settledMs` and it has no open share link, so settled never applies to tier 1; it only lowers
 * priority, never skips. A source in several revisions takes its best position.
 *
 * Collections being purged are always excluded; trashed ones unless `includeTrashed`. A trashed
 * collection's links are paused, so they don't count as open.
 *
 * The databases aren't attached and each is one serialized connection, so this reads in short
 * keyset pages on primary keys or existing indexes, with fixed-arity statements only (every
 * distinct SQL string costs a cached statement, see db.ts): no variable-length `IN (…)`.
 */

export type StaleTier = 1 | 2 | 3;

export interface RendererVersion {
  rendererName: string;
  rendererVersion: number;
}

export interface StaleSurveyOptions {
  /** The renderers to survey, each at its current version. */
  renderers: readonly RendererVersion[];
  /** One collection's revisions only (its ID, not its public ID); undefined surveys them all. */
  collectionId?: string;
  /** Include collections in Trash (the `rerender` CLI does); purging ones are always left out. */
  includeTrashed?: boolean;
  /** Now, in ms: for open share links and settled collections. */
  now: number;
  /** How long since its latest revision before a collection without open links is settled. */
  settledMs?: number;
}

export interface StaleSource {
  hash: string;
  renderer: string;
  /** The renderer's current version, which the source is below. */
  rendererVersion: number;
  /** The newest rendition version, committed or queued; null when it has none. */
  version: number | null;
  /** The MIME type to render it as: the lexicographically smallest of its in-scope types. */
  mime: string;
  /** The file's size in bytes, as recorded with the revision (0 when a manifest omits it). */
  size: number;
  tier: StaleTier;
  settled: boolean;
  /** The newest revision at the source's best position, and its collection. */
  revisionId: string;
  collectionId: string;
}

export interface StaleSurvey {
  /** In-scope sources per renderer name, stale or not (every surveyed renderer has an entry). */
  sources: Map<string, number>;
  /** Stale sources, best priority first (`compareStale`). */
  stale: StaleSource[];
}

export const DEFAULT_SETTLED_MS = 30 * 86_400_000;
const REVISION_PAGE = 1000;
const FILE_PAGE = 2000;
const MANIFEST_PAGE = 50;

/** Priority order: tier, then not settled before settled, then newer revision first. */
export function compareStale(
  left: Pick<StaleSource, "tier" | "settled" | "revisionId">,
  right: Pick<StaleSource, "tier" | "settled" | "revisionId">,
): number {
  if (left.tier !== right.tier) return left.tier - right.tier;
  if (left.settled !== right.settled) return left.settled ? 1 : -1;
  return left.revisionId > right.revisionId ? -1 : left.revisionId < right.revisionId ? 1 : 0;
}

/**
 * The newest rendition version per renderer for one source, committed or queued: two queries on
 * the primary keys' prefix, whatever the number of renderers.
 */
export async function newestRenditionVersions(
  waypoint: Db,
  queue: Db,
  hash: string,
): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  const rows = [
    ...(await waypoint.all<{ renderer: string; v: number }>(
      "SELECT renderer, MAX(renderer_version) AS v FROM renditions WHERE source_hash=? GROUP BY renderer",
      [hash],
    )),
    ...(await queue.all<{ renderer: string; v: number }>(
      "SELECT renderer, MAX(renderer_version) AS v FROM pending_renditions WHERE source_hash=? GROUP BY renderer",
      [hash],
    )),
  ];
  for (const row of rows)
    versions.set(row.renderer, Math.max(versions.get(row.renderer) ?? 0, row.v));
  return versions;
}

/** Stale when the newest version, committed or queued, is below current (or there is none). */
export function isStale(newest: number | null | undefined, current: number): boolean {
  return newest == null || newest < current;
}

const manifestFiles = z.object({
  files: z.record(
    z.string(),
    z.object({ hash: z.string(), mime: z.string(), size: z.number().optional() }),
  ),
});
/** A pending revision's files; an unreadable manifest has none. */
export function manifestEntries(
  manifestJson: string,
): { hash: string; mime: string; size: number }[] {
  let json: unknown;
  try {
    json = JSON.parse(manifestJson);
  } catch {
    return [];
  }
  const parsed = manifestFiles.safeParse(json);
  if (!parsed.success) return [];
  return Object.values(parsed.data.files)
    .filter((entry) => isContentHash(entry.hash))
    .map((entry) => ({ hash: entry.hash, mime: entry.mime, size: entry.size ?? 0 }));
}

interface CollectionState {
  trashed: boolean;
  /** Newest committed or pending (not failed) revision ID. */
  latest?: string;
  /** Newest committed revision ID: what a Latest link serves. */
  latestCommitted?: string;
  /** An open share link of any kind. */
  linked: boolean;
  /** An open Latest link. */
  followsLatest: boolean;
}

type Candidate = Omit<StaleSource, "version">;

function settledAt(state: CollectionState, cutoff: number): boolean {
  if (state.linked || state.latest === undefined) return false;
  try {
    return idTimestamp(state.latest) < cutoff;
  } catch {
    return false;
  }
}

/**
 * Surveys sources and returns the stale ones in priority order, with in-scope counts. Read-only.
 * A source's priority comes from the revisions this survey saw: scoped to one collection, only
 * that collection's.
 */
export async function surveyStale(
  waypoint: Db,
  queue: Db,
  options: StaleSurveyOptions,
): Promise<StaleSurvey> {
  const scoped = options.collectionId;
  const current = new Map(
    options.renderers.map((renderer) => [renderer.rendererName, renderer.rendererVersion]),
  );
  const cutoff = options.now - (options.settledMs ?? DEFAULT_SETTLED_MS);

  // Collections in scope, by ID. Purging ones (and trashed ones unless included) are absent.
  const purging = new Set(
    (await queue.all<{ collection_id: string }>("SELECT collection_id FROM pending_purges")).map(
      (row) => row.collection_id,
    ),
  );
  const committedCollections =
    scoped === undefined
      ? await waypoint.all<{ id: string; trashed: number }>(
          "SELECT c.id, t.collection_id IS NOT NULL AS trashed FROM collections c LEFT JOIN collection_tombstones t ON t.collection_id = c.id",
        )
      : await waypoint.all<{ id: string; trashed: number }>(
          "SELECT c.id, t.collection_id IS NOT NULL AS trashed FROM collections c LEFT JOIN collection_tombstones t ON t.collection_id = c.id WHERE c.id=?",
          [scoped],
        );
  const pendingCollections =
    scoped === undefined
      ? await queue.all<{ id: string; trashed: number }>(
          "SELECT id, deleted_at IS NOT NULL AS trashed FROM pending_collections",
        )
      : await queue.all<{ id: string; trashed: number }>(
          "SELECT id, deleted_at IS NOT NULL AS trashed FROM pending_collections WHERE id=?",
          [scoped],
        );
  const collections = new Map<string, CollectionState>();
  for (const row of [...committedCollections, ...pendingCollections]) {
    const known = collections.get(row.id);
    collections.set(row.id, {
      trashed: Boolean(row.trashed) || (known?.trashed ?? false),
      linked: false,
      followsLatest: false,
    });
  }
  for (const id of purging) collections.delete(id);
  if (!options.includeTrashed)
    for (const [id, state] of collections) if (state.trashed) collections.delete(id);
  const inScope = (collectionId: string): CollectionState | undefined =>
    scoped !== undefined && collectionId !== scoped ? undefined : collections.get(collectionId);

  // Revisions in scope, oldest first, and each collection's latest.
  const committed: [id: string, collectionId: string][] = [];
  const revisionCollection = new Map<string, string>();
  const noteRevision = (id: string, collectionId: string, isCommitted: boolean): boolean => {
    const state = inScope(collectionId);
    if (!state) return false;
    revisionCollection.set(id, collectionId);
    if (state.latest === undefined || id > state.latest) state.latest = id;
    if (isCommitted && (state.latestCommitted === undefined || id > state.latestCommitted))
      state.latestCommitted = id;
    return true;
  };
  for (let after = "", more = true; more;) {
    const page =
      scoped === undefined
        ? await waypoint.all<{ id: string; collection_id: string }>(
            "SELECT id, collection_id FROM revisions WHERE id > ? ORDER BY id LIMIT ?",
            [after, REVISION_PAGE],
          )
        : await waypoint.all<{ id: string; collection_id: string }>(
            "SELECT id, collection_id FROM revisions WHERE collection_id=? AND id > ? ORDER BY id LIMIT ?",
            [scoped, after, REVISION_PAGE],
          );
    for (const row of page)
      if (noteRevision(row.id, row.collection_id, true))
        committed.push([row.id, row.collection_id]);
    more = page.length === REVISION_PAGE;
    after = page.at(-1)?.id ?? after;
  }
  const pendingPage = (
    after: string,
    limit: number,
    manifests: boolean,
  ): Promise<{ id: string; collection_id: string; manifest_json?: string }[]> => {
    const columns = manifests ? "id, collection_id, manifest_json" : "id, collection_id";
    return scoped === undefined
      ? queue.all(
          `SELECT ${columns} FROM pending_revisions WHERE state='pending' AND id > ? ORDER BY id LIMIT ?`,
          [after, limit],
        )
      : queue.all(
          `SELECT ${columns} FROM pending_revisions WHERE collection_id=? AND state='pending' AND id > ? ORDER BY id LIMIT ?`,
          [scoped, after, limit],
        );
  };
  for (let after = "", more = true; more;) {
    const page = await pendingPage(after, REVISION_PAGE, false);
    for (const row of page) noteRevision(row.id, row.collection_id, false);
    more = page.length === REVISION_PAGE;
    after = page.at(-1)?.id ?? after;
  }

  // Open share links (tier 1 inputs). A trashed collection's links are paused.
  const pinned = new Set<string>();
  const links =
    scoped === undefined
      ? await waypoint.all<{ collection_id: string; revision_id: string | null }>(
          "SELECT collection_id, revision_id FROM share_links WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          [options.now],
        )
      : await waypoint.all<{ collection_id: string; revision_id: string | null }>(
          "SELECT collection_id, revision_id FROM share_links WHERE collection_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          [scoped, options.now],
        );
  for (const link of links) {
    const state = inScope(link.collection_id);
    if (!state || state.trashed) continue;
    state.linked = true;
    if (link.revision_id === null) state.followsLatest = true;
    else if (revisionCollection.get(link.revision_id) === link.collection_id)
      pinned.add(link.revision_id);
  }

  // Files, keeping each source's best position.
  const candidates = new Map<string, Candidate>();
  const add = (
    revisionId: string,
    collectionId: string,
    file: { hash: string; mime: string; size: number },
  ): void => {
    const renderer = rendererFor(file.mime);
    if (renderer === null) return;
    const rendererVersion = current.get(renderer);
    if (rendererVersion === undefined) return;
    const state = collections.get(collectionId);
    if (!state) return;
    const latest = revisionId === state.latest;
    const served = state.followsLatest && revisionId === state.latestCommitted;
    const tier: StaleTier = pinned.has(revisionId) || served ? 1 : latest ? 2 : 3;
    const position = { tier, settled: tier !== 1 && settledAt(state, cutoff), revisionId };
    const key = `${renderer}\0${file.hash}`;
    const known = candidates.get(key);
    if (!known) {
      candidates.set(key, {
        hash: file.hash,
        renderer,
        rendererVersion,
        mime: file.mime,
        size: file.size,
        ...position,
        collectionId,
      });
      return;
    }
    if (file.mime < known.mime) known.mime = file.mime;
    if (file.size > known.size) known.size = file.size;
    if (compareStale(position, known) < 0) Object.assign(known, position, { collectionId });
  };
  await inSeries(committed, async ([revisionId, collectionId]) => {
    for (let after = "", more = true; more;) {
      const page = await waypoint.all<{
        path: string;
        blob_hash: string;
        mime: string;
        size: number;
      }>(
        "SELECT path, blob_hash, mime, size FROM revision_files WHERE revision_id=? AND path > ? ORDER BY path LIMIT ?",
        [revisionId, after, FILE_PAGE],
      );
      for (const row of page)
        add(revisionId, collectionId, { hash: row.blob_hash, mime: row.mime, size: row.size });
      more = page.length === FILE_PAGE;
      after = page.at(-1)?.path ?? after;
    }
  });
  for (let after = "", more = true; more;) {
    const page = await pendingPage(after, MANIFEST_PAGE, true);
    for (const row of page)
      if (inScope(row.collection_id))
        for (const entry of manifestEntries(row.manifest_json ?? ""))
          add(row.id, row.collection_id, entry);
    more = page.length === MANIFEST_PAGE;
    after = page.at(-1)?.id ?? after;
  }

  // Versions, two short queries per distinct hash.
  const sources = new Map(options.renderers.map((renderer) => [renderer.rendererName, 0]));
  const byHash = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) {
    sources.set(candidate.renderer, (sources.get(candidate.renderer) ?? 0) + 1);
    const list = byHash.get(candidate.hash);
    if (list) list.push(candidate);
    else byHash.set(candidate.hash, [candidate]);
  }
  const stale: StaleSource[] = [];
  await inSeries(byHash, async ([hash, list]) => {
    const versions = await newestRenditionVersions(waypoint, queue, hash);
    for (const candidate of list) {
      const version = versions.get(candidate.renderer) ?? null;
      if (isStale(version, candidate.rendererVersion)) stale.push({ ...candidate, version });
    }
  });
  return { sources, stale: stale.toSorted(compareStale) };
}
