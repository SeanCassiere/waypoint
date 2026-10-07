import type { Db, SyncClient } from "./db.js";

function constraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|CONSTRAINT|BATCH_STEP_ERROR/i.test(error.message);
}
function timed<T>(
  promise: Promise<T>,
  label: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
    new Promise<T>((_, reject) => {
      onAbort = () => reject(new Error("Sync loop stopped"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}
type Waiter = { resolve: () => void; reject: (error: unknown) => void };
export class SyncLoop {
  private pumpFlight: Promise<void> | undefined;
  private waiting: Waiter[] = [];
  private pullFlight: Promise<boolean> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private stopController = new AbortController();
  private nativePush: Promise<void> | undefined;
  lastPushAt: number | null = null;
  lastError: string | null = null;
  blocked = false;
  /** Last successful push or pull, for offline detection (B6b). */
  lastOkAt: number | null = null;
  /** Whether the most recent push or pull attempt failed. */
  lastAttemptFailed = false;
  constructor(
    readonly queue: Db,
    readonly client: SyncClient,
    readonly now: () => number = Date.now,
    readonly waypoint?: Db,
    readonly timeouts: { pushMs?: number; pullMs?: number; checkpointMs?: number } = {},
  ) {}
  private async pushNative(label: string): Promise<void> {
    if (this.nativePush)
      await timed(
        this.nativePush.catch(() => undefined),
        "Previous push",
        this.stopController.signal,
        this.timeouts.pushMs ?? 30_000,
      );
    const native = this.client.push();
    this.nativePush = native;
    void native.then(
      () => {
        if (this.nativePush === native) this.nativePush = undefined;
      },
      () => {
        if (this.nativePush === native) this.nativePush = undefined;
      },
    );
    await timed(native, label, this.stopController.signal, this.timeouts.pushMs ?? 30_000);
  }
  start(): void {
    this.timers.push(setInterval(() => this.triggerPush(), 60_000));
    this.timers.push(
      setInterval(() => {
        void this.pull().catch(() => undefined);
      }, 30_000),
    );
    for (const timer of this.timers) timer.unref();
    this.triggerPush();
  }
  stop(): void {
    this.stopping = true;
    this.stopController.abort();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
  async drain(): Promise<void> {
    await Promise.allSettled(
      [this.pumpFlight, this.pullFlight].filter((flight) => flight !== undefined),
    );
  }
  triggerPush(): void {
    if (!this.stopping) void this.push().catch(() => undefined);
  }
  pull(): Promise<boolean> {
    if (this.stopping) return Promise.reject(new Error("Sync loop stopped"));
    if (this.pullFlight) return this.pullFlight;
    this.pullFlight = timed(
      this.client.pull(),
      "Pull",
      this.stopController.signal,
      this.timeouts.pullMs ?? 30_000,
    )
      .then((changed) => {
        this.lastOkAt = this.now();
        this.lastAttemptFailed = false;
        return changed;
      })
      .catch((error: unknown) => {
        this.lastAttemptFailed = true;
        this.lastError = error instanceof Error ? error.message : "Pull failed";
        if (/Environment mismatch|marker is missing/.test(this.lastError)) this.blocked = true;
        throw error;
      })
      .finally(() => {
        this.pullFlight = undefined;
      });
    return this.pullFlight;
  }
  push(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("Sync loop stopped"));
    const promise = new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    if (!this.pumpFlight) this.launch();
    return promise;
  }
  private launch(): void {
    this.pumpFlight = this.pump().finally(() => {
      this.pumpFlight = undefined;
      if (this.waiting.length && !this.stopping) this.launch();
    });
  }
  private async pump(): Promise<void> {
    while (this.waiting.length && !this.stopping) {
      const batch = this.waiting.splice(0);
      try {
        await this.pushOnce();
        for (const waiter of batch) waiter.resolve();
      } catch (error) {
        for (const waiter of batch) waiter.reject(error);
      }
    }
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("Sync loop stopped"));
  }
  private async pushOnce(): Promise<void> {
    const watermark =
      (await this.queue.get<{ seq: number }>("SELECT MAX(seq) AS seq FROM unpushed"))?.seq ?? 0;
    const rows = watermark
      ? await this.queue.all<{ revision_id: string }>(
          "SELECT revision_id FROM unpushed WHERE seq<=?",
          [watermark],
        )
      : [];
    const collections = new Map<string, string>();
    if (this.waypoint)
      for (const row of rows) {
        const rev = await this.waypoint.get<{ collection_id: string }>(
          "SELECT collection_id FROM revisions WHERE id=?",
          [row.revision_id],
        );
        if (rev) collections.set(row.revision_id, rev.collection_id);
      }
    try {
      try {
        await this.pushNative("Push");
      } catch (error) {
        if (!constraint(error)) throw error;
        await this.pull();
        try {
          await this.pushNative("Push retry");
        } catch (retryError) {
          if (constraint(retryError)) this.blocked = true;
          throw retryError;
        }
      }
      await timed(
        this.client.checkpoint(),
        "Checkpoint",
        this.stopController.signal,
        this.timeouts.checkpointMs ?? 30_000,
      );
      if (this.waypoint)
        for (const row of rows) {
          const revision = await this.waypoint.get<{ collection_id: string }>(
            "SELECT collection_id FROM revisions WHERE id=?",
            [row.revision_id],
          );
          const collectionId = collections.get(row.revision_id);
          if (
            !revision ||
            !collectionId ||
            revision.collection_id !== collectionId ||
            !(await this.waypoint.get("SELECT id FROM collections WHERE id=?", [collectionId]))
          ) {
            this.blocked = true;
            throw new Error(
              `Synced revision or collection disappeared after pull: ${row.revision_id}`,
            );
          }
        }
      if (watermark) await this.queue.run("DELETE FROM unpushed WHERE seq<=?", [watermark]);
      this.lastPushAt = this.now();
      this.lastOkAt = this.lastPushAt;
      this.lastAttemptFailed = false;
      this.lastError = null;
      this.blocked = false;
    } catch (error) {
      this.lastAttemptFailed = true;
      this.lastError = error instanceof Error ? error.message : "Push failed";
      if (constraint(error) || /Environment mismatch|marker is missing/.test(this.lastError))
        this.blocked = true;
      throw error;
    }
  }
}
