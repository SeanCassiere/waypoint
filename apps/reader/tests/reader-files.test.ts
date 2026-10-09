import { inferMime, newShareToken } from "@waypoint/core";
import { shellFileKind } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { createReaderApp, previewable, type ReaderEnv } from "../src/app.ts";

// RX-03: the shell's file type icons come from the stored MIME type, and the "download" kind must
// agree with what the reader actually previews (`@waypoint/ui` mirrors it without core).
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
// Every extension in core's inferMime table, plus one it doesn't know.
const EXTENSIONS =
  "html htm md markdown txt log css js mjs cjs jsx mts cts ts tsx py sh json jsonl diff patch toml ini svg png jpg jpeg gif webp avif ico pdf csv xml yaml yml wasm mp4 webm mp3 wav zip tar gz unknownext";

describe("shell file kinds", () => {
  it("call a file binary exactly when the reader can't preview it", () => {
    const types = new Set([
      ...EXTENSIONS.split(" ").map((extension) => inferMime(`dir/file.${extension}`)),
      "text/tab-separated-values",
      "application/ld+json",
      "application/x-ndjson",
      "application/vnd.apache.parquet",
      "application/octet-stream",
      "text/x-unknown",
      "image/heic",
    ]);
    expect(types.size).toBeGreaterThan(30);
    for (const mime of types)
      expect([mime, shellFileKind(mime) === "binary"]).toEqual([mime, !previewable(mime)]);
  });

  it("reads each file's type and size, and marks downloads in the list", async () => {
    const reads: string[] = [];
    const files = [
      ...Array.from({ length: 9 }, (_, i) => ({
        path: i ? `notes/n${i}.md` : "index.md",
        mime: "text/markdown",
        size: 10,
      })),
      { path: "build.tar.gz", mime: "application/gzip", size: 4_300_000 },
    ].toSorted((a, b) => (a.path < b.path ? -1 : 1));
    const app = createReaderApp({
      db: () => ({
        all: <T>(sql: string, args: (string | number)[] = []): Promise<T[]> => {
          reads.push(sql);
          const result: unknown[] = sql.includes("share_links")
            ? [
                {
                  id: "shl_" + "0".repeat(26),
                  collection_id: "c",
                  revision_id: null,
                  expires_at: null,
                  revoked_at: null,
                  public_id: "aaaaaaaaaaaa",
                  title: "Field kit",
                  deleted_at: null,
                  pinned_public_id: null,
                  pinned_head_path: null,
                  pinned_created_at: null,
                },
              ]
            : sql.includes("FROM revisions")
              ? [{ id: "r", public_id: "a2a2a2a2a2a2", head_path: "index.md", created_at: 1 }]
              : sql.includes("AND path=?")
                ? files
                    .filter((file) => file.path === args[1])
                    .map(({ path, mime, size }) => ({
                      path,
                      mime,
                      size,
                      blob_hash: `sha256:${"1".repeat(64)}`,
                    }))
                : files;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake is the typed-row boundary.
          return Promise.resolve(result as T[]);
        },
      }),
      blob: () => ({
        fetch: () => Promise.resolve(new Response("x")),
        probe: () => Promise.resolve(new Response("ok")),
      }),
    });
    const res = await app.request(
      `https://reader.example.test/s/${newShareToken()}/c/aaaaaaaaaaaa/`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(reads).toContain(
      "SELECT path,mime,size FROM revision_files WHERE revision_id=? ORDER BY path",
    );
    expect(html).toContain("build.tar.gz<small> download · 4.1 MB</small></a>");
    expect(html.split("<small>")).toHaveLength(2);
    expect(html).toContain("<title>index.md · Field kit</title>");
  });
});
