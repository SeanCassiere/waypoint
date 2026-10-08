import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BlobStore } from "../src/blob-store.ts";
import { parseMultipart } from "../src/multipart.ts";
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function request(parts: Array<[string, string | File]>): Request {
  const form = new FormData();
  for (const [name, value] of parts) form.append(name, value);
  return new Request("http://localhost/api/collections", { method: "POST", body: form });
}
async function tempFilesGone(dir: string, deadline: number): Promise<boolean> {
  if (!(await readdir(dir)).some((name) => name.startsWith(".blob-"))) return true;
  if (Date.now() >= deadline) return false;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return tempFilesGone(dir, deadline);
}
describe("streaming multipart limits", () => {
  it("rejects missing meta, file count, file size and total file size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-multipart-"));
    try {
      const store = new BlobStore(dir, 3);
      await expect(
        parseMultipart(
          new Request("http://localhost/api/collections", {
            method: "POST",
            headers: { "content-type": "multipart/form-data" },
            body: "bad",
          }),
          store,
        ),
      ).rejects.toMatchObject({ code: "validation_failed" });
      await expect(
        parseMultipart(request([["file:a.txt", new File(["a"], "a.txt")]]), store),
      ).rejects.toMatchObject({ code: "validation_failed" });
      await expect(
        parseMultipart(
          request([
            ["meta", "{}"],
            ["file:a.txt", new File(["abcd"], "a.txt")],
          ]),
          store,
        ),
      ).rejects.toMatchObject({ code: "blob_too_large" });
      await expect(
        parseMultipart(
          request([
            ["meta", "{}"],
            ["file:a.txt", new File(["a"], "a.txt")],
            ["file:b.txt", new File(["b"], "b.txt")],
          ]),
          store,
          { maxFiles: 1, maxRevisionBytes: 10 },
        ),
      ).rejects.toMatchObject({ code: "revision_too_large" });
      await expect(
        parseMultipart(
          request([
            ["meta", "{}"],
            ["file:a.txt", new File(["ab"], "a.txt")],
            ["file:b.txt", new File(["cd"], "b.txt")],
          ]),
          store,
          { maxFiles: 2, maxRevisionBytes: 3 },
        ),
      ).rejects.toMatchObject({ code: "revision_too_large" });
      // Rejection can settle before the aborted temp file's unlink lands; on a busy machine that
      // takes a while, so poll for up to 5 s (as #25 did for the network test).
      expect(await tempFilesGone(dir, Date.now() + 5000)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
  it("streams a 200 MB upload with bounded RSS growth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "waypoint-multipart-large-"));
    const boundary = "waypoint-test-boundary";
    const header = encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{"title":"Large"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file:large.bin"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = encode(`\r\n--${boundary}--\r\n`);
    const chunk = new Uint8Array(1024 * 1024);
    let step = -1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === -1) controller.enqueue(header);
        else if (step < 200) controller.enqueue(chunk);
        else if (step === 200) controller.enqueue(footer);
        else controller.close();
        step++;
      },
    });
    const options: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    };
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const result = await parseMultipart(
        new Request("http://localhost/api/collections", options),
        new BlobStore(dir, 201 * 1024 * 1024),
        { maxFiles: 1, maxRevisionBytes: 201 * 1024 * 1024 },
      );
      expect(result.files).toHaveLength(1);
      expect(peak - baseline).toBeLessThan(160 * 1024 * 1024);
    } finally {
      clearInterval(sample);
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
