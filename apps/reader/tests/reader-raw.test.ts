// RX-05: the raw route serves CSV and TSV as plain text, so the sandboxed frame shows their text
// instead of a blocked download. Every other type keeps its header.
// RX-06: `?download` on the raw route serves the stored file as an attachment.
import { hashShareToken, newShareToken, shareShellUrl } from "@waypoint/core";
import { describe, expect, it } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.ts";
import { frameDeniedPage } from "../src/pages.ts";

const collection = "0123456789ab";
const pub = "bcdefghjkmnp";
const linkId = "shl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = newShareToken();
const base = "https://reader.example.test";
const blobHash = (n: number): string => `sha256:${String(n).repeat(64)}`;
const renditionHash = `sha256:${"b".repeat(64)}`;
const files = [
  { path: "data.csv", blob_hash: blobHash(1), mime: "text/csv" },
  { path: "table.tsv", blob_hash: blobHash(2), mime: "text/tab-separated-values" },
  { path: "index.md", blob_hash: blobHash(3), mime: "text/markdown" },
  { path: "notes.txt", blob_hash: blobHash(4), mime: "text/plain" },
  { path: "pic.png", blob_hash: blobHash(5), mime: "image/png" },
];
const blobs = new Map<string, string>([
  [blobHash(1), "region,requests\neu-west,1200\n"],
  [blobHash(2), "region\trequests\neu-west\t1200\n"],
  [blobHash(3), "# Notes"],
  [blobHash(4), "plain notes"],
  [blobHash(5), "png bytes"],
  [renditionHash, "<h1>Notes</h1>"],
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
function fixture(options: { revoked?: boolean } = {}) {
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
                  revoked_at: options.revoked ? 1 : null,
                  public_id: collection,
                  title: "CSV",
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
      else if (sql.includes("FROM renditions"))
        rows =
          args[0] === blobHash(3)
            ? [{ output_hash: renditionHash, output_mime: "text/html", renderer_version: 2 }]
            : [];
      // This fake is intentionally the trust boundary for typed SQL rows.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return rows.map((row) => row as T);
    },
  };
  const app = createReaderApp({
    db: () => db,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: (hash) =>
        Promise.resolve(
          blobs.has(hash) ? new Response(blobs.get(hash)) : new Response(null, { status: 404 }),
        ),
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
  return { app, bindings };
}
describe("raw route content types (RX-05)", () => {
  it("serves CSV and TSV as plain text with the raw route's usual headers", async () => {
    const { app, bindings } = fixture();
    for (const [path, hash] of [
      ["data.csv", blobHash(1)],
      ["table.tsv", blobHash(2)],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two files, checked in order.
      const response = await app.request(await rawUrl(path), {}, bindings);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("etag")).toBeNull();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two files, checked in order.
      expect(await response.text()).toBe(blobs.get(hash));
    }
  });
  it("keeps every other type's header, including the markdown 304", async () => {
    const { app, bindings } = fixture();
    const markdownUrl = await rawUrl("index.md");
    const markdown = await app.request(markdownUrl, {}, bindings);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(markdown.headers.get("etag")).toBe(`"${renditionHash}"`);
    expect(await markdown.text()).toBe("<h1>Notes</h1>");
    const unchanged = await app.request(
      markdownUrl,
      { headers: { "if-none-match": `"${renditionHash}"` } },
      bindings,
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const notes = await app.request(await rawUrl("notes.txt"), {}, bindings);
    expect(notes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await notes.text()).toBe("plain notes");
    const pic = await app.request(await rawUrl("pic.png"), {}, bindings);
    expect(pic.headers.get("content-type")).toBe("image/png");
  });
  it("frames CSV in the shell rather than showing the download card", async () => {
    const { app, bindings } = fixture();
    const shell = await app.request(
      shareShellUrl(base, token, collection, undefined, "data.csv"),
      {},
      bindings,
    );
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('<iframe id="doc"');
    expect(html).not.toContain("can&#39;t be previewed in the browser");
  });
});
/** A raw URL with its capability's first character changed. */
const tamper = (url: string): string =>
  url.replace(
    /(\/x\/shl_[a-z0-9]{26}\.)(.)/,
    (_, head: string, c: string) => head + (c === "A" ? "B" : "A"),
  );
describe("raw route downloads (RX-06)", () => {
  const sandbox = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
  it("serves the stored markdown, not its rendition, as an attachment", async () => {
    const { app, bindings } = fixture();
    const response = await app.request(`${await rawUrl("index.md")}?download`, {}, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Notes");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''index.md",
    );
    expect(response.headers.get("content-security-policy")).toBe(sandbox);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBeNull();
  });
  it("keeps the original type: CSV as text/csv, images as themselves", async () => {
    const { app, bindings } = fixture();
    const csv = await app.request(`${await rawUrl("data.csv")}?download`, {}, bindings);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''data.csv");
    expect(await csv.text()).toBe(blobs.get(blobHash(1)));
    const pic = await app.request(`${await rawUrl("pic.png")}?download`, {}, bindings);
    expect(pic.headers.get("content-type")).toBe("image/png");
    expect(pic.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''pic.png");
  });
  it("skips the whole ETag and 304 branch", async () => {
    const { app, bindings } = fixture();
    const url = `${await rawUrl("index.md")}?download`;
    for (const etag of [`"${renditionHash}"`, `"${blobHash(3)}"`]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two validators, checked in order.
      const response = await app.request(url, { headers: { "if-none-match": etag } }, bindings);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''index.md",
      );
      expect(response.headers.get("etag")).toBeNull();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two validators, checked in order.
      expect(await response.text()).toBe("# Notes");
    }
  });
  it("denies exactly as without the query", async () => {
    const revoked = fixture({ revoked: true });
    const live = fixture();
    const url = await rawUrl("index.md");
    const plain = await revoked.app.request(url, {}, revoked.bindings);
    expect(plain.status).toBe(404);
    for (const [app, bindings, target] of [
      [revoked.app, revoked.bindings, `${url}?download`],
      [live.app, live.bindings, `${tamper(url)}?download`],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two denials, checked in order.
      const response = await app.request(target, {}, bindings);
      expect(response.status).toBe(404);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two denials, checked in order.
      expect(await response.text()).toBe(frameDeniedPage);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect([...response.headers]).toEqual([...plain.headers]);
    }
  });
  it("ignores ?download on the shell, whose controls point at /x/ without the token", async () => {
    const { app, bindings } = fixture();
    for (const path of ["index.md", "data.csv"]) {
      const url = shareShellUrl(base, token, collection, undefined, path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two shells, checked in order.
      const shell = await app.request(`${url}?download`, {}, bindings);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(shell.headers.get("content-disposition")).toBeNull();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two shells, checked in order.
      const html = await shell.text();
      const hrefs = [...html.matchAll(/<a class="btn dlb[^"]*" href="([^"]*)"/g)].map((m) => m[1]!);
      expect(hrefs).toHaveLength(1);
      for (const href of hrefs) {
        expect(href.startsWith(`${base}/x/shl_`)).toBe(true);
        expect(href.endsWith(`/${path}?download`)).toBe(true);
        expect(href).not.toContain(token);
      }
    }
  });
});
