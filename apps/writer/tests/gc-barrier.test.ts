import { describe, expect, it } from "vitest";

import { GcBarrier } from "../src/gc-barrier.ts";

const noop = (): void => undefined;
function gate(): { promise: Promise<void>; open: () => void } {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, open: () => release() };
}
describe("GC barrier handoff", () => {
  it("transfers the writer lock before waking queued writers and readers", async () => {
    const barrier = new GcBarrier();
    const first = gate();
    const writer = gate();
    const events: string[] = [];
    let started: (() => void) | undefined;
    const readerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const activeReader = barrier.read(async () => {
      events.push("reader1");
      started?.();
      await first.promise;
    });
    await readerStarted;
    const write1 = barrier.write(async () => {
      events.push("writer1");
      await writer.promise;
    });
    const write2 = barrier.write(() => {
      events.push("writer2");
      return Promise.resolve();
    });
    const read2 = barrier.read(() => {
      events.push("reader2");
      return Promise.resolve();
    });
    first.open();
    await activeReader;
    await Promise.resolve();
    expect(events).toEqual(["reader1", "writer1"]);
    writer.open();
    await Promise.all([write1, write2, read2]);
    expect(events).toEqual(["reader1", "writer1", "writer2", "reader2"]);
  });
});
