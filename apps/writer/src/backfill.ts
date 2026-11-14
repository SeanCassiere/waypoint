import type { RerenderRendererStatus, RerenderStatus } from "@waypoint/core";

import type { BlobStore } from "./blob-store.ts";
import { BucketError, type Bucket } from "./bucket.ts";
import { RENDITIONS_PER_PASS } from "./committer.ts";
import { inSeries, type Db, type DbHandle } from "./db.ts";
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
  type StalePosition,
  type StaleSource,
  type StaleSurvey,
  type StaleSurveyOptions,
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
 * queueing its rows. The queue transaction that inserts the rows first checks that the source is
 * still stored, or still in the pending revision of a live collection it was found in beforehand
 * (a few indexed lookups, never a scan of every pending revision: ingest waits for the queue
 * connection); a purge or Drop prunes queued rows in a queue transaction too, and those run one at
 * a time, so neither can leave rows for a source it removed. The committer uploads the output and
 * commits the row later, as for the `rerender` command.
 *
 * Each work-list entry keeps its best position per collection: a one-collection survey replaces
 * that collection's, and the entry takes the best of those whose collection is still live. A
 * survey stops between pages when the loop is stopped, so shutdown never waits for a full one.
 *
 * A source that can't be rendered is recorded in `rerender_skips` at the current version:
 * `too_large` and `output_too_large` until the next version; `declined`, `timeout` and `missing`
 * tried again after 1 h, then 4 h and so on (x4), at most 7 days apart.
 *
 * A stale source someone opens through the writer goes first (`promote()`, "T0"): the request
 * serves the older rendition as it is and only notes the source, in a small bounded set, most
 * recently opened first. Picking the next source looks there before the work list; everything
 * else stays as it is (the delay, the gates, the skips, and the re-check that drops a source no
 * live collection has). A noted source no survey has listed yet waits there for one; nothing
 * starts a survey for it.
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
/** Pending revisions per page when looking for one that has a source (manifests can be large). */
const PENDING_REVISION_PAGE = 50;
/** How many times a source whose reference went away is looked for again before it's dropped. */
const REFERENCE_ATTEMPTS = 3;
/** The longest single sleep: the loop looks around at least this often. */
const MAX_SLEEP_MS = 3_600_000;
/** How many opened sources (`promote()`) are remembered; the one opened longest ago goes first. */
export const PROMOTED_MAX = 32;

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
type Entry = StaleSource & {
  skip?: Skip;
  /** The best position in each collection with the source, from the latest survey of each. */
  positions: Map<string, StalePosition>;
};
/**
 * Where a source was found in a live collection: a pending revision, or a committed one
 * (`revisionId` null), whose source has a `blobs` row.
 */
interface Reference {
  revisionId: string | null;
}
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
  /** Aborts the survey in flight (`stop()`). */
  private surveyAbort: AbortController | undefined;

  /** Stale sources by key; `order` is the work list, best first from `cursor`. */
  private pending = new Map<string, Entry>();
  private order: Entry[] = [];
  private cursor = 0;
  private skips = new Map<string, Skip>();
  private skipsLoaded = false;
  /** Keys of sources opened while stale (`promote()`), most recently opened last. */
  private promoted = new Set<string>();

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
    this.surveyAbort?.abort();
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

  /**
   * The writer served a file whose newest rendition (`version`, null for none) is below its
   * renderer's current version: render that source before the rest (T0). Synchronous bookkeeping
   * on the request path: no database, no survey, no wake (whatever the loop is waiting for, the
   * delay or a gate, still applies). A no-op in `off` mode. Opening a source again only moves it
   * up; at most `PROMOTED_MAX` are remembered.
   */
  promote(hash: string, renderer: string, version: number | null): void {
    if (this.mode !== "auto" || this.stopping) return;
    const current = this.renderers.get(renderer);
    if (!current || !isStale(version, current.rendererVersion)) return;
    const key = keyOf({ renderer, hash });
    this.promoted.delete(key);
    this.promoted.add(key);
    if (this.promoted.size > PROMOTED_MAX)
      this.promoted.delete(this.promoted.values().next().value!);
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

  /**
   * The next source to render, without taking it: the most recently opened one (`promote()`) that
   * is in the work list and not waiting on a skip, else the work list's; a finished round picks up
   * due retries.
   */
  private next(now: number): Entry | undefined {
    for (const key of [...this.promoted].toReversed()) {
      const entry = this.pending.get(key);
      if (entry && this.live(entry, now)) return entry;
    }
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

  /**
   * Marks the source as started. An opened one keeps its place in the work list, where it no
   * longer counts once it's rendered, skipped or dropped (a new entry or none under its key).
   */
  private take(entry: Entry): void {
    this.promoted.delete(keyOf(entry));
    if (this.order[this.cursor] === entry) this.cursor++;
  }

  private remove(entry: Entry): void {
    this.promoted.delete(keyOf(entry));
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
    const positions = new Map(
      source.positions ?? [
        [
          source.collectionId,
          { tier: source.tier, settled: source.settled, revisionId: source.revisionId },
        ],
      ],
    );
    return skip ? { ...source, positions, skip } : { ...source, positions };
  }

  /** A survey with per-collection positions, abandoned between pages by `stop()`. */
  private async survey(
    options: Pick<StaleSurveyOptions, "collectionId" | "now">,
  ): Promise<StaleSurvey> {
    this.checkStopped();
    const abort = new AbortController();
    this.surveyAbort = abort;
    try {
      return await surveyStale(this.deps.waypoint, this.deps.queue, {
        ...options,
        renderers: this.deps.renderers,
        settledMs: this.options.settledMs,
        positions: true,
        signal: abort.signal,
      });
    } catch (error) {
      if (this.stopping) throw new Stopped();
      throw error;
    } finally {
      if (this.surveyAbort === abort) this.surveyAbort = undefined;
    }
  }

  private async fullSurvey(): Promise<void> {
    const started = this.clock.now();
    const wallStarted = performance.now();
    const survey = await this.survey({ now: started });
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
    const survey = await this.survey({ collectionId, now: this.clock.now() });
    this.checkStopped();
    const added: Entry[] = [];
    const changed = new Set<Entry>();
    const toFront: Entry[] = [];
    const seen = new Set<string>();
    for (const source of survey.stale) {
      const key = keyOf(source);
      seen.add(key);
      let entry = this.pending.get(key);
      if (!entry) {
        entry = this.entryFor(source);
        this.pending.set(key, entry);
        if (!front) added.push(entry);
      } else {
        // This collection's position is new; the others stand until their collection's next survey.
        entry.positions.set(
          collectionId,
          source.positions?.get(collectionId) ?? {
            tier: source.tier,
            settled: source.settled,
            revisionId: source.revisionId,
          },
        );
        changed.add(entry);
      }
      if (front) toFront.push(entry);
    }
    // Sources this collection no longer has stale: its old position no longer counts.
    for (const entry of this.pending.values())
      if (!seen.has(keyOf(entry)) && entry.positions.delete(collectionId)) changed.add(entry);
    // Each changed entry takes its best position among collections still live.
    const live = new Map<string, boolean>([[collectionId, true]]);
    await inSeries(changed, async (entry) => {
      await inSeries([...entry.positions.keys()], async (id) => {
        if (!live.has(id)) live.set(id, await this.collectionLive(id));
        if (!live.get(id)) entry.positions.delete(id);
      });
      let best: [string, StalePosition] | undefined;
      for (const [id, position] of entry.positions)
        if (!best || compareStale(position, best[1]) < 0) best = [id, position];
      // None left: process() re-checks the source and drops it if it's no longer wanted.
      if (best) Object.assign(entry, best[1], { collectionId: best[0] });
    });
    this.checkStopped();
    // Re-position: restored from Trash, its sources first in their own priority order; anything
    // else that's new or moved goes where its (new) position puts it.
    const first = new Set(toFront);
    const moving = new Set<Entry>([...toFront, ...added, ...changed]);
    const rest = this.order.slice(this.cursor).filter((entry) => !moving.has(entry));
    const sorted = [...added, ...[...changed].filter((entry) => !first.has(entry))].toSorted(
      compareStale,
    );
    const merged: Entry[] = [];
    let index = 0;
    for (const entry of rest) {
      while (index < sorted.length && compareStale(sorted[index]!, entry) < 0)
        merged.push(sorted[index++]!);
      merged.push(entry);
    }
    while (index < sorted.length) merged.push(sorted[index++]!);
    // (No spread into splice: a large collection would exceed the argument limit.)
    this.order = [...this.order.slice(0, this.cursor), ...toFront, ...merged];
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

  /** Outside Trash and not being purged. `queue` is the queue database or a transaction's handle. */
  private async collectionLive(
    collectionId: string,
    queue: DbHandle = this.deps.queue,
  ): Promise<boolean> {
    const { waypoint } = this.deps;
    return (
      !(await queue.get("SELECT 1 FROM pending_purges WHERE collection_id=?", [collectionId])) &&
      !(await waypoint.get("SELECT 1 FROM collection_tombstones WHERE collection_id=?", [
        collectionId,
      ])) &&
      !(await queue.get("SELECT 1 FROM pending_collections WHERE id=? AND deleted_at IS NOT NULL", [
        collectionId,
      ]))
    );
  }

  /** The collection of one pending revision, if it's still pending and has the source. */
  private async pendingCollectionWith(
    queue: DbHandle,
    revisionId: string,
    hash: string,
  ): Promise<string | undefined> {
    const row = await queue.get<{ collection_id: string }>(
      "SELECT p.collection_id FROM pending_revisions p, json_each(p.manifest_json,'$.files') f WHERE p.id=? AND p.state='pending' AND json_extract(f.value,'$.hash')=? LIMIT 1",
      [revisionId, hash],
    );
    return row?.collection_id;
  }

  /**
   * Where the source is in at least one collection outside Trash and not being purged: through a
   * committed revision (`revisionId` null), or the pending revision returned. Null when nowhere.
   * Pending revisions are looked through in short pages, never in one long statement or inside a
   * transaction: with sync off every stored source is in one, and the queue connection is
   * ingest's too.
   */
  private async liveReference(entry: Entry): Promise<Reference | null> {
    const { waypoint, queue } = this.deps;
    const committed = await waypoint.all<{ collection_id: string }>(
      "SELECT DISTINCT r.collection_id FROM revision_files f JOIN revisions r ON r.id=f.revision_id WHERE f.blob_hash=?",
      [entry.hash],
    );
    for (const row of committed)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stops at the first live collection.
      if (await this.collectionLive(row.collection_id)) return { revisionId: null };
    // The pending revision the survey saw it in, the usual answer, before all of them.
    const known = await this.pendingCollectionWith(queue, entry.revisionId, entry.hash);
    if (known !== undefined && (await this.collectionLive(known)))
      return { revisionId: entry.revisionId };
    // `instr` passes over manifests without the source cheaply; the rest are confirmed one by one.
    for (let after = "", more = true; more;) {
      this.checkStopped();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Pages, until a live collection.
      const page = await queue.all<{ id: string; at: number }>(
        "SELECT id,instr(manifest_json,?) AS at FROM pending_revisions WHERE state='pending' AND id>? ORDER BY id LIMIT ?",
        [`"${entry.hash}"`, after, PENDING_REVISION_PAGE],
      );
      for (const row of page) {
        if (!row.at || row.id === entry.revisionId) continue;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Stops at the first live collection.
        const collectionId = await this.pendingCollectionWith(queue, row.id, entry.hash);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Stops at the first live collection.
        if (collectionId !== undefined && (await this.collectionLive(collectionId)))
          return { revisionId: row.id };
      }
      more = page.length === PENDING_REVISION_PAGE;
      after = page.at(-1)?.id ?? after;
    }
    return null;
  }

  /**
   * Whether the reference `liveReference` found still holds: the source is committed (a `blobs`
   * row), or still in that one pending revision, in a live collection. A few indexed lookups and
   * one manifest, however many revisions are pending: `queue` is, for the check that decides, the
   * handle of the transaction that queues the rows, which ingest waits for.
   */
  private async stillReferenced(queue: DbHandle, hash: string, ref: Reference): Promise<boolean> {
    if (await this.deps.waypoint.get("SELECT 1 FROM blobs WHERE hash=?", [hash])) return true;
    if (ref.revisionId === null) return false;
    const collectionId = await this.pendingCollectionWith(queue, ref.revisionId, hash);
    return collectionId !== undefined && (await this.collectionLive(collectionId, queue));
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
    let ref = await this.liveReference(entry);
    if (!ref) {
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
    // 5. Store and queue inside the barrier, if the reference found in step 1 still holds: looked
    // at first, so a source gone by now stores nothing, and again in the queue transaction that
    // queues the rows, so a purge or Drop since can't leave rows behind. Both checks look at that
    // one reference only; when it's gone, the source is looked for again outside the barrier and
    // the transaction, a few times, and dropped when no live collection has it. An output stored
    // for a source that went in between stays on disk unreferenced, like an upload nothing used:
    // an upload of the same bytes may be under way outside the barrier, so it isn't deleted here.
    let queued: Awaited<ReturnType<typeof queueRendition>> | null = null;
    for (let attempt = 1; ; attempt++) {
      const current = ref;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Retries, one at a time.
      queued = await ingest.gcBarrier.read(() =>
        ingest.withBlobHold(async (hold) => {
          hold(entry.hash);
          if (!(await this.stillReferenced(queue, entry.hash, current))) return null;
          return queueRendition(
            deps,
            renderer,
            entry.hash,
            rendered.rendition,
            this.clock.now(),
            hold,
            (tx) => this.stillReferenced(tx, entry.hash, current),
          );
        }),
      );
      if (queued !== null && queued.status !== "source_gone") break;
      if (attempt >= REFERENCE_ATTEMPTS) break;
      this.checkStopped();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Retries, one at a time.
      const found = await this.liveReference(entry);
      if (!found) break;
      ref = found;
    }
    if (queued === null || queued.status === "source_gone") {
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
