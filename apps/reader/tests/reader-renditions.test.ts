// RX-08: the raw route serves each file type's rendition (rendererFor): markdown, text and CSV.
// HTML and images are never substituted, and `?download` always gets the original.
import { hashShareToken, newShareToken } from "@waypoint/core";
import { describe, expect, it } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.ts";

const collection = "0123456789ab";
const pub = "bcdefghjkmnp";
const linkId = "shl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = newShareToken();
const base = "https://reader.example.test";
const sandbox = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
const blobHash = (n: number): string => `sha256:${String(n).repeat(64)}`;
const outputHash = (c: string): string => `sha256:${c.repeat(64)}`;
const files = [
  { path: "run.sh", blob_hash: blobHash(1), mime: "text/x-shellscript" },
  { path: "data.csv", blob_hash: blobHash(2), mime: "text/csv" },
  { path: "plain.csv", blob_hash: blobHash(3), mime: "text/csv" },
  { path: "index.md", blob_hash: blobHash(4), mime: "text/markdown" },
  { path: "page.html", blob_hash: blobHash(5), mime: "text/html" },
  { path: "pic.png", blob_hash: blobHash(6), mime: "image/png" },
];
/** Rendition rows by `source_hash renderer`; page.html's is bogus and must never be used. */
const renditions = new Map<
  string,
  { output_hash: string; output_mime: string; renderer_version: number }
>([
  [
    `${blobHash(1)} text`,
    { output_hash: outputHash("a"), output_mime: "text/html", renderer_version: 1 },
  ],
  [
    `${blobHash(2)} csv`,
    { output_hash: outputHash("b"), output_mime: "text/html", renderer_version: 1 },
  ],
  [
    `${blobHash(4)} markdown`,
    { output_hash: outputHash("c"), output_mime: "text/html", renderer_version: 3 },
  ],
  [
    `${blobHash(5)} text`,
    { output_hash: outputHash("d"), output_mime: "text/html", renderer_version: 1 },
  ],
]);
const original = new Map<string, string>([
  [blobHash(1), "#!/bin/sh\necho ok\n"],
  [blobHash(2), "a,b\n1,2\n"],
  [blobHash(3), "c,d\n3,4\n"],
  [blobHash(4), "# Notes"],
  [blobHash(5), "<!doctype html><h1>HTML stays HTML</h1>"],
  [blobHash(6), "png bytes"],
]);
const outputs = new Map<string, string>([
  [outputHash("a"), '<body class="tv">run.sh</body>'],
  [outputHash("b"), '<body class="cv">data.csv</body>'],
  [outputHash("c"), "<h1>Notes</h1>"],
  [outputHash("d"), "bogus"],
]);
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "turso://test",
  TURSO_READONLY_TOKEN: "test",
  R2_ACCOUNT_ID: "test",
  R2_READER_ACCESS_KEY_ID: "test",
  R2_READER_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "test",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
/** The raw capability URL under `env`'s all-zero key (see reader.test.ts). */
async function rawUrl(path: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${linkId}\n${pub}`)),
  );
  const cap = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
    .slice(0, 22);
  return `${base}/x/${linkId}.${cap}/r/${pub}/${path}`;
}
function fixture(options: { missingOutputs?: boolean } = {}) {
  const queries: { sql: string; args: (string | number)[] }[] = [];
  const db: ReaderDb = {
    async all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      let rows: unknown[] = [];
      if (sql.includes("FROM share_links"))
        rows =
          args[0] === (await hashShareToken(token)) || args[0] === linkId
            ? [
                {
                  id: linkId,
                  collection_id: "col_test",
                  revision_id: null,
                  expires_at: null,
                  revoked_at: null,
                  public_id: collection,
                  title: "Renditions",
                  deleted_at: null,
                  pinned_public_id: null,
                  pinned_head_path: null,
                  pinned_created_at: null,
                },
              ]
            : [];
      else if (sql.includes("FROM revisions"))
        rows = [{ id: "rev_one", public_id: pub, head_path: "index.md", created_at: 1000 }];
      else if (sql.includes("FROM revision_files") && sql.includes("path=?"))
        rows = files.filter((item) => item.path === args[1]);
      else if (sql.includes("FROM revision_files")) rows = files;
      else if (sql.includes("FROM renditions")) {
        queries.push({ sql, args });
        const row = renditions.get(`${String(args[0])} ${String(args[1])}`);
        rows = row ? [row] : [];
      }
      // This fake is intentionally the trust boundary for typed SQL rows.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return rows.map((row) => row as T);
    },
  };
  const app = createReaderApp({
    db: () => db,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: (hash) => {
        const body = original.get(hash) ?? (options.missingOutputs ? undefined : outputs.get(hash));
        return Promise.resolve(
          body === undefined ? new Response(null, { status: 404 }) : new Response(body),
        );
      },
    }),
    cache: {
      match: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    },
  });
  const bindings = {
    ...env,
    ACCESS_LOG: { writeDataPoint: () => {} },
    TOKEN_MISS_LIMITER: { limit: () => Promise.resolve({ success: true }) },
  };
  return { app, bindings, queries };
}

describe("raw route renditions by type (RX-08)", () => {
  it("serves a script's text rendition with an ETag and a 304", async () => {
    const { app, bindings, queries } = fixture();
    const url = await rawUrl("run.sh");
    const response = await app.request(url, {}, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<body class="tv">run.sh</body>');
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("etag")).toBe(`"${outputHash("a")}"`);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-security-policy")).toBe(sandbox);
    expect(queries).toEqual([
      {
        sql: "SELECT output_hash,output_mime,renderer_version FROM renditions WHERE source_hash=? AND renderer=? ORDER BY renderer_version DESC LIMIT 1",
        args: [blobHash(1), "text"],
      },
    ]);
    const unchanged = await app.request(
      url,
      { headers: { "if-none-match": `"${outputHash("a")}"` } },
      bindings,
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(`"${outputHash("a")}"`);
  });

  it("serves CSV renditions, and CSV without one as plain text", async () => {
    const { app, bindings, queries } = fixture();
    const data = await app.request(await rawUrl("data.csv"), {}, bindings);
    expect(await data.text()).toBe('<body class="cv">data.csv</body>');
    expect(data.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(queries.at(-1)?.args).toEqual([blobHash(2), "csv"]);
    const plain = await app.request(await rawUrl("plain.csv"), {}, bindings);
    expect(await plain.text()).toBe("c,d\n3,4\n");
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(plain.headers.get("etag")).toBe(`"${blobHash(3)}"`);
  });

  it("keeps markdown's behaviour", async () => {
    const { app, bindings, queries } = fixture();
    const markdown = await app.request(await rawUrl("index.md"), {}, bindings);
    expect(await markdown.text()).toBe("<h1>Notes</h1>");
    expect(markdown.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(markdown.headers.get("etag")).toBe(`"${outputHash("c")}"`);
    expect(queries.at(-1)?.args).toEqual([blobHash(4), "markdown"]);
  });

  it("never substitutes HTML or images, and doesn't look them up", async () => {
    const { app, bindings, queries } = fixture();
    const page = await app.request(await rawUrl("page.html"), {}, bindings);
    expect(await page.text()).toBe("<!doctype html><h1>HTML stays HTML</h1>");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("etag")).toBeNull();
    const pic = await app.request(await rawUrl("pic.png"), {}, bindings);
    expect(await pic.text()).toBe("png bytes");
    expect(pic.headers.get("content-type")).toBe("image/png");
    expect(queries).toEqual([]);
  });

  it("falls back to the original when the rendition blob is missing", async () => {
    const { app, bindings } = fixture({ missingOutputs: true });
    const response = await app.request(await rawUrl("run.sh"), {}, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("#!/bin/sh\necho ok\n");
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("etag")).toBe(`"${blobHash(1)}"`);
  });

  it("downloads the original, with no lookup and no ETag", async () => {
    const { app, bindings, queries } = fixture();
    const download = await app.request(
      `${await rawUrl("run.sh")}?download`,
      { headers: { "if-none-match": `"${outputHash("a")}"` } },
      bindings,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("#!/bin/sh\necho ok\n");
    expect(download.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''run.sh");
    expect(download.headers.get("etag")).toBeNull();
    expect(queries).toEqual([]);
  });
});
