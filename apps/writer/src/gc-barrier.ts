/** A writer-preferring barrier for local blob decisions and garbage collection. */
export class GcBarrier {
  private readers = 0;
  private writer = false;
  private waitingWriters = 0;
  private readWaiters: Array<() => void> = [];
  private writeWaiters: Array<() => void> = [];

  private async enterRead(): Promise<void> {
    if (!this.writer && this.waitingWriters === 0) {
      this.readers++;
      return;
    }
    await new Promise<void>((resolve) => this.readWaiters.push(resolve));
  }
  private leaveRead(): void {
    this.readers--;
    if (this.readers === 0) {
      const next = this.writeWaiters.shift();
      if (next) {
        this.writer = true;
        next();
      }
    }
  }
  private async enterWrite(): Promise<void> {
    this.waitingWriters++;
    if (this.writer || this.readers > 0)
      await new Promise<void>((resolve) => this.writeWaiters.push(resolve));
    this.waitingWriters--;
    this.writer = true;
  }
  private leaveWrite(): void {
    const next = this.writeWaiters.shift();
    if (next) {
      this.writer = true;
      next();
    } else {
      this.writer = false;
      const readers = this.readWaiters.splice(0);
      this.readers += readers.length;
      for (const resolve of readers) resolve();
    }
  }
  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.enterRead();
    try {
      return await fn();
    } finally {
      this.leaveRead();
    }
  }
  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.enterWrite();
    try {
      return await fn();
    } finally {
      this.leaveWrite();
    }
  }
}
