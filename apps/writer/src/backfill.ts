import type { RerenderRendererStatus, RerenderStatus } from "@waypoint/core";

import type { BlobStore } from "./blob-store.ts";
import { BucketError, type Bucket } from "./bucket.ts";
import { RENDITIONS_PER_PASS } from "./committer.ts";
import { inSeries, type Db } from "./db.ts";
import type { IngestService, Renderer } from "./ingest.ts";
import {
  ensureLocalSource,
  queueRendition,
  readSource,
  renderWithTimeout,
  type RenderSourceDeps,
  type SetTimer,
} from "./render-source.ts";
import {
  compareStale,
  isStale,
  newestRenditionVersions,
  surveyStale,
  type StaleSource,
} from "./stale.ts";
import { RERENDER_PENDING_SQL } from "./status-data.ts";

/**
 * The background rerender (D89): after a renderer's version bump, the running writer re-renders
 * stale renditions itself, slowly and at low priority, so readers stop seeing the older output
 * without an operator step.
 *
 * One loop does everything in turn: surveys (stale.ts, in short read-only pages) and one source
 * at a time. It surveys every collection outside Trash at start, every 24 hours and 10 minutes
 * after a pull that changed the database; one collection after each of its commits, and after an
 * undelete, whose stale sources go to the front. Trash and purges need no hook: each source is
 * re-checked before it's rendered. The surveys run in `off` mode too, so /api/status can say how
 * many renditions are stale; only `auto` renders.
 *
 * Rendering waits for the post-start delay (`delayMs`, ended early by `startNow()`), and before
 * each source for: no ingest or blob upload in flight or in the last 5 s; fewer than one
 * committer pass (`RENDITIONS_PER_PASS`) of standalone renditions queued (sync on only: with
 * sync off there's no committer and every source is in a pending revision); and no pause (the
 * bucket account paused, standalone rendition commits failing, sync blocked, or this loop's own
 * bucket fetch failing). Renders use their own worker (`renderers`), one job at a time, closed
 * whenever the work runs out.
 *
 * Per source, the GC barrier is held only for two short sections, never across a render (a waiting
 * GC would make every new ingest queue behind it): reading the source, then storing the output and
 * queueing its rows, after checking the source is still stored or in a pending revision. The
 * committer uploads the output and commits the row later, as for the `rerender` command.
 *
 * A source that can't be rendered is recorded in `rerender_skips` at the current version:
 * `too_large` and `output_too_large` until the next version; `declined`, `timeout` and `missing`
 * tried again after 1 h, then 4 h and so on (x4), at most 7 days apart.
 */

export type RerenderMode = "auto" | "off";
export type SkipReason = "too_large" | "output_too_large" | "declined" | "timeout" | "missing";
type PauseReason = NonNullable<RerenderStatus["paused_reason"]>;

export interface BackfillClock {
  now(): number;
  setTimer: SetTimer;
}
const realClock: BackfillClock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface BackfillDeps {
  waypoint: Db;
  queue: Db;
  blobs: BlobStore;
  bucket?: Bucket | undefined;
  ingest: Pick<IngestService, "gcBarrier" | "withBlobHold" | "activity">;
  /** Absent with sync off. */
  committer?:
    | {
        wake(): void;
        readonly accountError: string | null;
        readonly renditionsRetryAt: number | null;
      }
    | undefined;
  /** Absent with sync off. */
  syncLoop?: { readonly blocked: boolean } | undefined;
  /** This loop's own renderers (one worker), at their current versions. */
  renderers: readonly Renderer[];
  /** Ends the renderers' worker; the next render starts a new one. */
  closeRenderers?: () => Promise<void>;
}

export interface BackfillOptions {
  mode: RerenderMode;
  /** How long after `start()` rendering begins. */
  delayMs: number;
  /** How long since its latest revision before a collection without open links is settled. */
  settledMs: number;
  /** With sync off there's no committer: no backlog gate. */
  sync: boolean;
  /** Source size limits per renderer name, checked before fetching and after. */
  maxSourceBytes?: Readonly<Record<string, number>>;
  clock?: BackfillClock;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const QUIET_MS = 5_000;
export const SURVEY_INTERVAL_MS = 24 * 3_600_000;
export const PULL_SURVEY_DEBOUNCE_MS = 10 * 60_000;
const BUSY_POLL_MS = 1_000;
const BACKLOG_POLL_MS = 5_000;
const PAUSE_POLL_MS = 30_000;
const BUCKET_PAUSE_MS = 60_000;
const ACCOUNT_PAUSE_MS = 300_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RETRY_BASE_MS = 3_600_000;
const RETRY_CAP_MS = 7 * 86_400_000;
const ERROR_PAUSE_MS = 60_000;
/** The longest single sleep: the loop looks around at least this often. */
const MAX_SLEEP_MS = 3_600_000;

/** When a failing source is tried again: 1 h after the first failure, x4 after each, capped. */
export function skipRetryAt(reason: SkipReason, attempts: number, at: number): number | null {
  if (reason === "too_large" || reason === "output_too_large") return null;
  return at + Math.min(RETRY_BASE_MS * 4 ** Math.min(attempts - 1, 10), RETRY_CAP_MS);
}

interface Skip {
  reason: SkipReason;
  attempts: number;
  retryAt: number | null;
}
type Entry = StaleSource & { skip?: Skip };
const keyOf = (source: Pick<StaleSource, "renderer" | "hash">): string =>
  `${source.renderer}\0${source.hash}`;

class Stopped extends Error {}

export class RerenderBackfill {
  readonly mode: RerenderMode;
  private readonly deps: BackfillDeps;
  private readonly options: BackfillOptions;
  private readonly clock: BackfillClock;
  private readonly renderers: Map<string, Renderer>;
  private readonly log: (line: string) => void;

  private startsAt: number | null = null;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;
  /** A wake that came while the loop wasn't sleeping: its next sleep returns at once. */
  private wokenEarly = false;
  private sleeping = false;
  private idleWaiters: (() => void)[] = [];
  private stopWaiters: (() => void)[] = [];

  /** Stale sources by key; `order` is the work list, best first from `cursor`. */
  private pending = new Map<string, Entry>();
  private order: Entry[] = [];
  private cursor = 0;
  private skips = new Map<string, Skip>();
  private skipsLoaded = false;

  private surveyedAt: number | null = null;
  private fullSurveyDue = true;
  private pullSurveyAt: number | null = null;
  private scoped = new Map<string, { front: boolean }>();

  private ownPause: { reason: PauseReason; until: number } | null = null;
  private busyAt: number | null = null;
  private seen = { ingest: -1, blobs: -1 };
  private renderersOpen = false;
  private rendered = 0;
  private renderedAt: number[] = [];
  private runningSince: number | null = null;

  constructor(deps: BackfillDeps, options: BackfillOptions) {
    this.deps = deps;
    this.options = options;
    this.mode = options.mode;
    this.clock = options.clock ?? realClock;
    this.renderers = new Map(deps.renderers.map((renderer) => [renderer.rendererName, renderer]));
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Starts the loop: a full survey now, rendering (in `auto`) after the delay. */
  start(): void {
    if (this.loop) return;
    this.startsAt = this.clock.now() + this.options.delayMs;
    this.loop = this.run().catch((error: unknown) => {
      if (!(error instanceof Stopped))
        console.error(
          `Rerender backfill stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
  }

  /** Stops the loop; a render in flight is abandoned (its worker closed, nothing queued). */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const resolve of this.stopWaiters.splice(0)) resolve();
    this.wake();
    void this.closeRenderers();
  }

  /** Resolves once the loop has finished (after `stop()`). */
  async drain(): Promise<void> {
    await this.loop;
    await this.closeRenderers();
  }

  /** Ends the post-start delay (`POST /api/rerender/start`). */
  startNow(): void {
    const now = this.clock.now();
    if (this.startsAt !== null && this.startsAt > now) this.startsAt = now;
    this.wake();
  }

  /** A collection committed a revision, or (`front`) was restored from Trash. */
  collectionChanged(collectionId: string, options: { front?: boolean } = {}): void {
    const known = this.scoped.get(collectionId);
    this.scoped.set(collectionId, { front: Boolean(options.front) || Boolean(known?.front) });
    this.wake();
  }

  /** A pull changed the local database: survey everything again, 10 minutes from the first. */
  pullChanged(): void {
    this.pullSurveyAt ??= this.clock.now() + PULL_SURVEY_DEBOUNCE_MS;
    this.wake();
  }

  /** For tests: resolves when the loop is waiting (on a timer or a wake) or has stopped. */
  whenIdle(): Promise<void> {
    if (!this.loop) return Promise.resolve();
    if (this.stopping) return this.loop;
    if (this.sleeping) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * The `/api/status` block. `standalone` is the number of standalone queued renditions
   * (`queue.rerender_pending`), which must reach 0 before the state is `done` (sync on).
   */
  status(standalone: number): RerenderStatus {
    const now = this.clock.now();
    const surveyed = this.surveyedAt !== null;
    const perRenderer = new Map<string, RerenderRendererStatus>();
    for (const renderer of this.deps.renderers)
      perRenderer.set(renderer.rendererName, {
        renderer: renderer.rendererName,
        version: renderer.rendererVersion,
        stale: 0,
        skipped: 0,
        left: 0,
      });
    for (const entry of this.pending.values()) {
      const row = perRenderer.get(entry.renderer);
      if (!row) continue;
      row.stale++;
      if (entry.skip) row.skipped++;
      else row.left++;
    }
    const rows = [...perRenderer.values()];
    const total = (field: "stale" | "skipped" | "left"): number | null =>
      surveyed ? rows.reduce((sum, row) => sum + row[field], 0) : null;
    const left = total("left");
    const pause = this.pauseReason(now);
    const waiting = this.startsAt === null || this.startsAt > now;
    const state: RerenderStatus["state"] =
      this.mode === "off"
        ? "off"
        : waiting
          ? "waiting"
          : left === 0 && (!this.options.sync || standalone === 0)
            ? "done"
            : pause
              ? "paused"
              : "running";
    const rate = state === "running" ? this.ratePerMinute(now) : null;
    return {
      mode: this.mode,
      state,
      starts_at: this.mode === "auto" && waiting ? this.startsAt : null,
      paused_reason: state === "paused" ? pause : null,
      surveyed_at: this.surveyedAt,
      stale: total("stale"),
      skipped: total("skipped"),
      left,
      rendered: this.rendered,
      rate_per_minute: rate === null ? null : Math.round(rate * 10) / 10,
      eta_ms: rate && left !== null ? Math.round((left / rate) * 60_000) : null,
      renderers: surveyed ? rows : [],
    };
  }

  private ratePerMinute(now: number): number | null {
    this.renderedAt = this.renderedAt.filter((at) => at > now - RATE_WINDOW_MS);
    if (!this.renderedAt.length || this.runningSince === null) return null;
    const span = Math.min(RATE_WINDOW_MS, Math.max(now - this.runningSince, 60_000));
    return (this.renderedAt.length / span) * 60_000;
  }

  private pauseReason(now: number): PauseReason | null {
    if (this.deps.committer?.accountError) return "account_paused";
    if (this.deps.syncLoop?.blocked) return "sync_blocked";
    if (this.ownPause && this.ownPause.until > now) return this.ownPause.reason;
    const retryAt = this.deps.committer?.renditionsRetryAt;
    if (retryAt != null && retryAt > now) return "bucket_error";
    return null;
  }

  private wake(): void {
    const wake = this.wakeSleep;
    this.wakeSleep = undefined;
    this.sleeping = false;
    if (wake) wake();
    else this.wokenEarly = true;
  }

  /** Waits `ms` (at most), or until `wake()`. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.reject(new Stopped());
    if (this.wokenEarly) {
      this.wokenEarly = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const cancel = this.clock.setTimer(
        () => {
          if (this.wakeSleep === done) this.wake();
        },
        Math.min(Math.max(1, ms), MAX_SLEEP_MS),
      );
      const done = (): void => {
        cancel();
        resolve();
      };
      this.wakeSleep = done;
      this.sleeping = true;
      for (const waiter of this.idleWaiters.splice(0)) waiter();
    });
  }

  private checkStopped(): void {
    if (this.stopping) throw new Stopped();
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        this.checkStopped();
        // Everything a wake could signal is looked at below.
        this.wokenEarly = false;
        try {
          await this.step();
        } catch (error) {
          if (error instanceof Stopped) throw error;
          console.error(
            `Rerender backfill error: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.sleep(ERROR_PAUSE_MS);
        }
      }
    } finally {
      this.sleeping = false;
      for (const waiter of this.idleWaiters.splice(0)) waiter();
    }
  }

  /** One turn of the loop: a survey, a wait, or one source. */
  private async step(): Promise<void> {
    await this.loadSkips();
    const now = this.clock.now();
    if (
      this.fullSurveyDue ||
      (this.surveyedAt !== null && now >= this.surveyedAt + SURVEY_INTERVAL_MS) ||
      (this.pullSurveyAt !== null && now >= this.pullSurveyAt)
    ) {
      await this.fullSurvey();
      return;
    }
    const [scopedId, scoped] = this.scoped.entries().next().value ?? [];
    if (scopedId !== undefined && scoped) {
      await this.collectionSurvey(scopedId, scoped.front);
      this.scoped.delete(scopedId);
      return;
    }
    const wait = await this.gate(now);
    if (wait !== null) {
      await this.sleep(Math.min(wait, this.nextSurveyIn(now)));
      return;
    }
    const entry = this.next(now);
    if (!entry) {
      this.runningSince = null;
      await this.closeRenderers();
      await this.sleep(Math.min(this.nextRetryIn(now), this.nextSurveyIn(now)));
      return;
    }
    this.runningSince ??= now;
    try {
      await this.process(entry);
    } catch (error) {
      // Not left at the head of the list: the next survey brings it back if it's still stale.
      if (!(error instanceof Stopped)) {
        this.take(entry);
        this.remove(entry);
      }
      throw error;
    }
  }

  private nextSurveyIn(now: number): number {
    const times = [
      this.surveyedAt === null ? now : this.surveyedAt + SURVEY_INTERVAL_MS,
      this.pullSurveyAt ?? Infinity,
    ];
    return Math.max(1, Math.min(...times) - now);
  }

  private nextRetryIn(now: number): number {
    let next = Infinity;
    for (const entry of this.pending.values())
      if (entry.skip?.retryAt != null) next = Math.min(next, entry.skip.retryAt);
    return Math.max(1, next - now);
  }

  /** Null when a source may be rendered now, else how long to wait before looking again. */
  private async gate(now: number): Promise<number | null> {
    if (this.mode !== "auto") return Infinity;
    if (this.startsAt === null || this.startsAt > now) return (this.startsAt ?? now) - now;
    if (!this.hasWork(now)) return null;
    if (this.pauseReason(now)) {
      this.runningSince = null;
      return PAUSE_POLL_MS;
    }
    if (this.options.sync) {
      const backlog = (await this.deps.queue.get<{ n: number }>(RERENDER_PENDING_SQL))?.n ?? 0;
      if (backlog >= RENDITIONS_PER_PASS) {
        this.deps.committer?.wake();
        return BACKLOG_POLL_MS;
      }
    }
    const ingest = this.deps.ingest.activity();
    const blobs = this.deps.blobs.activity();
    if (
      ingest.active > 0 ||
      blobs.active > 0 ||
      ingest.started !== this.seen.ingest ||
      blobs.started !== this.seen.blobs
    ) {
      // The first look only records the counters; anything after it is someone else's work.
      if (this.seen.ingest !== -1 || ingest.active > 0 || blobs.active > 0) this.busyAt = now;
      this.seen = { ingest: ingest.started, blobs: blobs.started };
    }
    if (this.busyAt !== null && now - this.busyAt < QUIET_MS)
      return Math.min(BUSY_POLL_MS, QUIET_MS - (now - this.busyAt));
    return null;
  }

  private live(entry: Entry, now: number): boolean {
    if (this.pending.get(keyOf(entry)) !== entry) return false;
    return !entry.skip || (entry.skip.retryAt !== null && entry.skip.retryAt <= now);
  }

  private hasWork(now: number): boolean {
    return this.next(now) !== undefined;
  }

  /** The next source to render, without taking it; a finished round picks up due retries. */
  private next(now: number): Entry | undefined {
    for (;;) {
      while (this.cursor < this.order.length) {
        const entry = this.order[this.cursor]!;
        if (this.live(entry, now)) return entry;
        this.cursor++;
      }
      const due = [...this.pending.values()].filter((entry) => this.live(entry, now));
      this.order = due.toSorted(compareStale);
      this.cursor = 0;
      if (!due.length) return undefined;
    }
  }

  private take(entry: Entry): void {
    if (this.order[this.cursor] === entry) this.cursor++;
  }

  private remove(entry: Entry): void {
    if (this.pending.get(keyOf(entry)) === entry) this.pending.delete(keyOf(entry));
  }

  private async loadSkips(): Promise<void> {
    if (this.skipsLoaded) return;
    await inSeries(this.deps.renderers, async (renderer) => {
      await this.deps.queue.run(
        "DELETE FROM rerender_skips WHERE renderer=? AND renderer_version<?",
        [renderer.rendererName, renderer.rendererVersion],
      );
      for (const row of await this.deps.queue.all<{
        source_hash: string;
        reason: SkipReason;
        attempts: number;
        retry_at: number | null;
      }>(
        "SELECT source_hash,reason,attempts,retry_at FROM rerender_skips WHERE renderer=? AND renderer_version=?",
        [renderer.rendererName, renderer.rendererVersion],
      ))
        this.skips.set(keyOf({ renderer: renderer.rendererName, hash: row.source_hash }), {
          reason: row.reason,
          attempts: row.attempts,
          retryAt: row.retry_at,
        });
    });
    this.skipsLoaded = true;
  }

  private entryFor(source: StaleSource): Entry {
    const skip = this.skips.get(keyOf(source));
    return skip ? { ...source, skip } : { ...source };
  }

  private async fullSurvey(): Promise<void> {
    const started = this.clock.now();
    const wallStarted = performance.now();
    const survey = await surveyStale(this.deps.waypoint, this.deps.queue, {
      renderers: this.deps.renderers,
      now: started,
      settledMs: this.options.settledMs,
    });
    this.checkStopped();
    this.fullSurveyDue = false;
    this.pullSurveyAt = null;
    this.pending = new Map(survey.stale.map((source) => [keyOf(source), this.entryFor(source)]));
    this.order = [...this.pending.values()];
    this.cursor = 0;
    this.surveyedAt = started;
    const counts = this.deps.renderers
      .map((renderer) => {
        let stale = 0;
        for (const entry of this.pending.values())
          if (entry.renderer === renderer.rendererName) stale++;
        return `${renderer.rendererName} v${renderer.rendererVersion}: ${stale} of ${survey.sources.get(renderer.rendererName) ?? 0}`;
      })
      .join(", ");
    this.log(
      `Rerender survey: ${this.pending.size} stale (${counts}) in ${Math.round(performance.now() - wallStarted)} ms`,
    );
  }

  private async collectionSurvey(collectionId: string, front: boolean): Promise<void> {
    const survey = await surveyStale(this.deps.waypoint, this.deps.queue, {
      renderers: this.deps.renderers,
      collectionId,
      now: this.clock.now(),
      settledMs: this.options.settledMs,
    });
    this.checkStopped();
    const toFront: Entry[] = [];
    for (const source of survey.stale) {
      const key = keyOf(source);
      let entry = this.pending.get(key);
      if (!entry) {
        entry = this.entryFor(source);
        this.pending.set(key, entry);
        if (!front) this.insertSorted(entry);
      }
      if (front) toFront.push(entry);
    }
    // Restored from Trash: its sources first, in their own priority order.
    // (No spread into splice: a large collection would exceed the argument limit.)
    if (toFront.length)
      this.order = [
        ...this.order.slice(0, this.cursor),
        ...toFront,
        ...this.order.slice(this.cursor),
      ];
  }

  private insertSorted(entry: Entry): void {
    let low = this.cursor;
    let high = this.order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareStale(this.order[middle]!, entry) <= 0) low = middle + 1;
      else high = middle;
    }
    this.order.splice(low, 0, entry);
  }

  private async closeRenderers(): Promise<void> {
    if (!this.renderersOpen) return;
    this.renderersOpen = false;
    await this.deps.closeRenderers?.();
  }

  private async recordSkip(entry: Entry, reason: SkipReason): Promise<void> {
    const at = this.clock.now();
    const attempts = entry.skip && entry.skip.reason === reason ? entry.skip.attempts + 1 : 1;
    const skip: Skip = { reason, attempts, retryAt: skipRetryAt(reason, attempts, at) };
    await this.deps.queue.run(
      "INSERT OR REPLACE INTO rerender_skips (source_hash,renderer,renderer_version,reason,attempts,at,retry_at) VALUES (?,?,?,?,?,?,?)",
      [entry.hash, entry.renderer, entry.rendererVersion, reason, attempts, at, skip.retryAt],
    );
    const key = keyOf(entry);
    this.skips.set(key, skip);
    if (this.pending.get(key) === entry) this.pending.set(key, { ...entry, skip });
  }

  private async clearSkip(entry: Entry): Promise<void> {
    const key = keyOf(entry);
    if (!this.skips.has(key)) return;
    this.skips.delete(key);
    await this.deps.queue.run(
      "DELETE FROM rerender_skips WHERE source_hash=? AND renderer=? AND renderer_version=?",
      [entry.hash, entry.renderer, entry.rendererVersion],
    );
  }

  /** In at least one collection outside Trash and not being purged, committed or queued. */
  private async inLiveCollection(entry: Entry): Promise<boolean> {
    const { waypoint, queue } = this.deps;
    const live = async (collectionId: string): Promise<boolean> =>
      !(await queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [collectionId])) &&
      !(await waypoint.get("SELECT 1 FROM collection_tombstones WHERE collection_id=?", [
        collectionId,
      ])) &&
      !(await queue.get("SELECT 1 FROM pending_collections WHERE id=? AND deleted_at IS NOT NULL", [
        collectionId,
      ]));
    const committed = await waypoint.all<{ collection_id: string }>(
      "SELECT DISTINCT r.collection_id FROM revision_files f JOIN revisions r ON r.id=f.revision_id WHERE f.blob_hash=?",
      [entry.hash],
    );
    for (const row of committed)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stops at the first live collection.
      if (await live(row.collection_id)) return true;
    const pendingIn = await this.pendingCollection(entry);
    return pendingIn !== null && (await live(pendingIn));
  }

  /**
   * A pending revision with the source: the one the survey saw first (with sync off, every
   * source is only in pending revisions), else any. Null when none has it.
   */
  private async pendingCollection(entry: Entry): Promise<string | null> {
    const known = await this.deps.queue.get<{ collection_id: string; manifest_json: string }>(
      "SELECT collection_id,manifest_json FROM pending_revisions WHERE id=? AND state='pending'",
      [entry.revisionId],
    );
    if (known && known.manifest_json.includes(`"${entry.hash}"`)) return known.collection_id;
    const any = await this.deps.queue.get<{ collection_id: string }>(
      "SELECT p.collection_id FROM pending_revisions p, json_each(p.manifest_json,'$.files') f WHERE p.state='pending' AND json_extract(f.value,'$.hash')=? LIMIT 1",
      [entry.hash],
    );
    return any?.collection_id ?? null;
  }

  /** Races `work` against `stop()`. */
  private async untilStopped<T>(work: Promise<T>): Promise<T> {
    if (this.stopping) throw new Stopped();
    let onStop: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          onStop = () => reject(new Stopped());
          this.stopWaiters.push(onStop);
        }),
      ]);
    } finally {
      this.stopWaiters = this.stopWaiters.filter((waiter) => waiter !== onStop);
    }
  }

  private async process(entry: Entry): Promise<void> {
    const { waypoint, queue, blobs, ingest } = this.deps;
    const renderer = this.renderers.get(entry.renderer);
    if (!renderer) {
      this.take(entry);
      this.remove(entry);
      return;
    }
    // 1. Still stale, and still in a live collection (Trash and purges drop it here).
    const versions = await newestRenditionVersions(waypoint, queue, entry.hash);
    if (!isStale(versions.get(entry.renderer), entry.rendererVersion)) {
      this.take(entry);
      this.remove(entry);
      await this.clearSkip(entry);
      return;
    }
    if (!(await this.inLiveCollection(entry))) {
      this.take(entry);
      this.remove(entry);
      return;
    }
    const limit = this.options.maxSourceBytes?.[entry.renderer];
    if (limit !== undefined && entry.size > limit) {
      this.take(entry);
      await this.recordSkip(entry, "too_large");
      return;
    }
    // 2. Fetch outside the barrier, as the viewer does.
    const deps: RenderSourceDeps = {
      waypoint,
      queue,
      blobs,
      bucket: this.deps.bucket,
      background: true,
    };
    const fetched = await ensureLocalSource(deps, entry.hash);
    if (fetched.status === "fetch_failed") {
      const error = fetched.error;
      if (error instanceof BucketError && error.kind !== "permanent") {
        // Not this source's fault: pause, and try the same source again afterwards.
        this.ownPause = {
          reason: error.kind === "account" ? "account_paused" : "bucket_error",
          until: this.clock.now() + (error.kind === "account" ? ACCOUNT_PAUSE_MS : BUCKET_PAUSE_MS),
        };
        console.error(`Rerender paused: could not fetch ${entry.hash}: ${error.message}`);
        return;
      }
      this.take(entry);
      await this.recordSkip(entry, "missing");
      return;
    }
    this.take(entry);
    if (fetched.status === "missing") {
      await this.recordSkip(entry, "missing");
      return;
    }
    // 3. Read the source inside the barrier.
    const source = await ingest.gcBarrier.read(() =>
      ingest.withBlobHold(async (hold) => {
        hold(entry.hash);
        if (!(await blobs.has(entry.hash))) return null;
        return readSource(blobs, entry.hash);
      }),
    );
    if (!source) {
      // Collected since the fetch: no longer needed. A later survey adds it back if it is.
      this.remove(entry);
      return;
    }
    if (limit !== undefined && source.byteLength > limit) {
      await this.recordSkip(entry, "too_large");
      return;
    }
    // 4. Render outside the barrier, on this loop's own worker.
    this.renderersOpen = true;
    const rendered = await this.untilStopped(
      renderWithTimeout(
        renderer,
        source,
        entry.mime,
        this.options.timeoutMs ?? 30_000,
        this.clock.setTimer,
      ),
    );
    if (rendered.status === "timeout") {
      // The worker may still be busy with it: start the next source on a fresh one.
      await this.closeRenderers();
      await this.recordSkip(entry, "timeout");
      return;
    }
    if (rendered.status === "declined") {
      await this.recordSkip(entry, "declined");
      return;
    }
    // Stopping: the output is dropped, and the next start renders the source again.
    this.checkStopped();
    // 5. Store and queue inside the barrier, if the source is still stored or queued.
    const queued = await ingest.gcBarrier.read(() =>
      ingest.withBlobHold(async (hold) => {
        hold(entry.hash);
        const stored = await waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [entry.hash]);
        if (!stored && (await this.pendingCollection(entry)) === null) return null;
        return queueRendition(
          deps,
          renderer,
          entry.hash,
          rendered.rendition,
          this.clock.now(),
          hold,
        );
      }),
    );
    if (queued === null) {
      this.remove(entry);
      return;
    }
    if (queued.status === "output_too_large") {
      await this.recordSkip(entry, "output_too_large");
      return;
    }
    this.remove(entry);
    await this.clearSkip(entry);
    this.rendered++;
    this.renderedAt.push(this.clock.now());
    // 6. The committer uploads it and commits the row.
    this.deps.committer?.wake();
  }
}
