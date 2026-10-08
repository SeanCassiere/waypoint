import { newShareToken } from "@waypoint/core";
// Worst-case CPU for a full public-reader shell request with 2,000 files. These run in the
// "timing" Vitest project (turbo's `test:timing`), alone and after every other test, so nothing
// else competes for the CPU while they measure.
import { describe, expect, it } from "vitest";

import { createReaderApp, type ReaderEnv } from "../src/app.ts";

// Workers' Free-plan limit is 10 ms per request. Locally we hold a 5 ms margin; shared CI
// runners are slower and noisier, so CI allows 8 ms, which still leaves headroom under 10 ms.
const CPU_BUDGET_MS = process.env.CI ? 8 : 5;

const env: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const h = (c: string) => `sha256:${c.repeat(64)}`;
const A = { pub: "aaaaaaaaaaaa" };
const A2 = { pub: "a2a2a2a2a2a2" };

describe("CPU budget worst cases", () => {
  // Thread CPU (what the Worker limit counts) for the whole shell request, response body
  // included, with 2,000 files. The median of seven batches of five warmed-up requests (thread
  // CPU ticks are about 1 ms, too coarse to time one request), so a garbage collection or a
  // busy neighbour landing in one or two batches doesn't decide the result.
  const shapes: [string, string[]][] = [
    ["realistic", Array.from({ length: 2000 }, (_, i) => `dir${i % 40}/file-${i}.html`)],
    [
      "repository, 10 folders deep",
      Array.from(
        { length: 2000 },
        (_, i) => `a${i % 13}/b${i % 17}/c${i % 7}/d/e/f/g/h/i/f${i}.ts`,
      ),
    ],
    [
      "512-byte CJK names with escapes",
      Array.from(
        { length: 2000 },
        (_, i) => `${String(i).padStart(4, "0")}/${"文".repeat(160)}"&.html`,
      ),
    ],
    [
      "512-byte ASCII names",
      Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")}/${"x".repeat(500)}.md`),
    ],
    [
      "each file in its own 20-level folder",
      Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")}/${"a/".repeat(20)}f`),
    ],
    [
      "250 levels deep",
      Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")}/${"a/".repeat(250)}f`),
    ],
    [
      "one folder per file",
      Array.from({ length: 2000 }, (_, i) => `d${String(i).padStart(4, "0")}/f.md`),
    ],
  ];
  for (const [name, paths] of shapes) {
    it(`serves a 2,000-file shell under 5 ms of CPU: ${name}`, async () => {
      const sorted = paths.toSorted();
      const rows = sorted.map((path) => ({ path }));
      const shareToken = newShareToken();
      const shapeApp = createReaderApp({
        db: () => ({
          all: <T>(sql: string, args: (string | number)[] = []): Promise<T[]> => {
            const result: unknown[] = sql.includes("share_links")
              ? [
                  {
                    id: "shl_" + "0".repeat(26),
                    collection_id: "c",
                    revision_id: null,
                    expires_at: null,
                    revoked_at: null,
                    public_id: A.pub,
                    title: "T",
                    deleted_at: null,
                    pinned_public_id: null,
                    pinned_head_path: null,
                    pinned_created_at: null,
                  },
                ]
              : sql.includes("FROM revisions")
                ? [{ id: "r", public_id: A2.pub, head_path: sorted[0], created_at: 1 }]
                : sql.includes("AND path=?")
                  ? [{ path: args[1], blob_hash: h("1"), mime: "text/html", size: 1 }]
                  : rows;
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return Promise.resolve(result as T[]);
          },
        }),
        blob: () => ({
          fetch: () => Promise.resolve(new Response("x")),
          probe: () => Promise.resolve(new Response("ok")),
        }),
      });
      const url = `https://reader.example.test/s/${shareToken}/c/${A.pub}/`;
      let bytes = 0;
      const one = async () => {
        const res = await shapeApp.request(url, {}, env);
        expect(res.status).toBe(200);
        bytes = (await res.arrayBuffer()).byteLength;
      };
      const batch = async (): Promise<number> => {
        const start = process.threadCpuUsage();
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential requests are the measurement.
        for (let i = 0; i < 5; i++) await one();
        const used = process.threadCpuUsage(start);
        return (used.user + used.system) / 1000 / 5;
      };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Warm-up before measuring.
      for (let i = 0; i < 5; i++) await one();
      const means: number[] = [];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Batches run one after another.
      for (let i = 0; i < 7; i++) means.push(await batch());
      const median = means.toSorted((a, b) => a - b)[3]!;
      expect(median).toBeLessThan(CPU_BUDGET_MS);
      // The file list is bounded, so the page stays small whatever the paths look like.
      expect(bytes).toBeLessThan(1_000_000);
    });
  }
});
