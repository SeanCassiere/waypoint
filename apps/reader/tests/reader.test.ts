import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashShareToken, newShareToken, shareShellUrl } from "../../../packages/core/src/index.js";
import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.js";

const collection = "0123456789ab";
const firstPub = "bcdefghjkmnp";
const secondPub = "cdefghjkmnpq";
const hash = `sha256:${"a".repeat(64)}`;
const renditionHash = `sha256:${"b".repeat(64)}`;
const token = newShareToken();
const base = "https://waypoint.pingstash.com";
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "turso://test",
  TURSO_READONLY_TOKEN: "test",
  R2_ACCOUNT_ID: "test",
  R2_READER_ACCESS_KEY_ID: "test",
  R2_READER_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "test",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
type LinkRow = {
  id: string;
  collection_id: string;
  revision_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  public_id: string;
  title: string;
  deleted_at: number | null;
};
type RevisionRow = { id: string; public_id: string; head_path: string; created_at: number };
type FileRow = { path: string; blob_hash: string; mime: string };
let link: LinkRow;
let revisions: RevisionRow[];
let files: FileRow[];
let rendition: { output_hash: string; output_mime: string; renderer_version: number } | null;
let blobMissing: boolean;
let cacheKeys: string[];
let points: { indexes: string[]; blobs: string[]; doubles: number[] }[];
let limiter: ReturnType<typeof vi.fn>;
let reads: string[];
async function rawUrl(revision: string, path: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`shl_aaaaaaaaaaaaaaaaaaaaaaaaaa\n${revision}`),
    ),
  );
  const cap = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
    .slice(0, 22);
  return `${base}/x/shl_aaaaaaaaaaaaaaaaaaaaaaaaaa.${cap}/r/${revision}/${path}`;
}
function fixture(body?: ReadableStream<Uint8Array>) {
  const db: ReaderDb = {
    async all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      reads.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("FROM share_links")) {
        const pinned = revisions.find((item) => item.id === link.revision_id);
        rows =
          (args[0] === (await hashShareToken(token)) || args[0] === link.id) && link
            ? [
                {
                  ...link,
                  pinned_public_id: pinned?.public_id ?? null,
                  pinned_head_path: pinned?.head_path ?? null,
                  pinned_created_at: pinned?.created_at ?? null,
                },
              ]
            : [];
      } else if (sql.includes("FROM revisions"))
        rows = link.revision_id
          ? revisions.filter((item) => item.id === link.revision_id)
          : revisions.slice(-1);
      else if (sql.includes("FROM revision_files") && sql.includes("path=?"))
        rows = files.filter((item) => item.path === args[1]);
      else if (sql.includes("FROM revision_files")) rows = files;
      else if (sql.includes("FROM renditions")) rows = rendition ? [rendition] : [];
      // This fake is intentionally the trust boundary for typed SQL rows.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return rows.map((row) => row as T);
    },
  };
  const cache = {
    match(request: Request): Promise<Response | undefined> {
      cacheKeys.push(request.url);
      return Promise.resolve(undefined);
    },
    put(request: Request): Promise<void> {
      cacheKeys.push(request.url);
      return Promise.resolve();
    },
  };
  const app = createReaderApp({
    db: () => db,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: (value) =>
        Promise.resolve(
          value === renditionHash && blobMissing
            ? new Response(null, { status: 404 })
            : new Response(
                body ??
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(value === renditionHash ? "rendered" : "source"),
                      );
                      controller.close();
                    },
                  }),
              ),
        ),
    }),
    cache,
  });
  const bindings = {
    ...env,
    ACCESS_LOG: {
      writeDataPoint: (point: (typeof points)[number]) => {
        points.push(point);
      },
    },
    TOKEN_MISS_LIMITER: { limit: limiter },
  };
  return { app, bindings };
}
beforeEach(() => {
  link = {
    id: "shl_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    collection_id: "col_test",
    revision_id: null,
    expires_at: null,
    revoked_at: null,
    public_id: collection,
    title: "Shared <title>",
    deleted_at: null,
  };
  revisions = [{ id: "rev_one", public_id: firstPub, head_path: "index.md", created_at: 1000 }];
  files = [
    { path: "index.md", blob_hash: hash, mime: "text/markdown" },
    { path: "other.txt", blob_hash: hash, mime: "text/plain" },
  ];
  rendition = { output_hash: renditionHash, output_mime: "text/html", renderer_version: 2 };
  blobMissing = false;
  cacheKeys = [];
  points = [];
  limiter = vi.fn<(input: { key: string }) => Promise<{ success: boolean }>>(() =>
    Promise.resolve({ success: true }),
  );
  reads = [];
});
describe("public reader", () => {
  it("follows the newest cloud revision and pins iframe URLs", async () => {
    const { app, bindings } = fixture();
    const shell = await app.request(shareShellUrl(base, token, collection), {}, bindings);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain(`/r/${firstPub}/index.md`);
    expect(html).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain("Revision picker");
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'none'");
    const style = html.match(/<style>(.*?)<\/style>/)?.[1];
    if (!style) throw new Error("Shell style missing");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style)),
    );
    expect(shell.headers.get("content-security-policy")).toContain(
      `'sha256-${btoa(String.fromCharCode(...digest))}'`,
    );
    revisions.push({
      id: "rev_two",
      public_id: secondPub,
      head_path: "index.md",
      created_at: 2000,
    });
    const next = await app.request(shareShellUrl(base, token, collection), {}, bindings);
    expect(await next.text()).toContain(`/r/${secondPub}/index.md`);
    const old = await app.request(await rawUrl(firstPub, "index.md"), {}, bindings);
    expect(old.status).toBe(404);
    expect(reads.some((sql) => sql.includes("ORDER BY id DESC LIMIT 1"))).toBe(true);
  });
  it("enforces pinned revision scope and shows snapshot date", async () => {
    link.revision_id = "rev_one";
    revisions.push({
      id: "rev_two",
      public_id: secondPub,
      head_path: "index.md",
      created_at: 2000,
    });
    const { app, bindings } = fixture();
    expect((await app.request(shareShellUrl(base, token, collection), {}, bindings)).status).toBe(
      404,
    );
    const shell = await app.request(shareShellUrl(base, token, collection, firstPub), {}, bindings);
    expect(await shell.text()).toContain("Snapshot from");
    expect((await app.request(await rawUrl(secondPub, "index.md"), {}, bindings)).status).toBe(404);
  });
  it("uses identical denials for revoked, expired, tombstoned and missing paths", async () => {
    const { app, bindings } = fixture();
    const path = await rawUrl(firstPub, "index.md");
    link.revoked_at = 1;
    const revoked = await app.request(path, {}, bindings);
    link.revoked_at = null;
    link.expires_at = 1;
    const expired = await app.request(path, {}, bindings);
    link.expires_at = null;
    link.deleted_at = 1;
    const tombstoned = await app.request(path, {}, bindings);
    link.deleted_at = null;
    const missing = await app.request(await rawUrl(firstPub, "missing.txt"), {}, bindings);
    const unknown = await app.request(
      shareShellUrl(base, newShareToken(), collection),
      {},
      bindings,
    );
    for (const response of [revoked, expired, tombstoned, missing, unknown]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(
        "<!doctype html><title>Not found</title><h1>Not found</h1>",
      );
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("private");
      expect([...response.headers]).toEqual([...revoked.headers]);
    }
  });
  it("serves renditions, falls back to source, caches by hash and logs no token", async () => {
    const { app, bindings } = fixture();
    const path = await rawUrl(firstPub, "index.md");
    const rendered = await app.request(path, {}, bindings);
    expect(await rendered.text()).toBe("rendered");
    expect(rendered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(rendered.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms",
    );
    expect(rendered.headers.get("cache-control")).toBe("private, no-cache");
    expect(rendered.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(rendered.headers.get("referrer-policy")).toBe("no-referrer");
    expect(rendered.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cacheKeys.every((key) => !key.includes(token))).toBe(true);
    expect(cacheKeys.some((key) => key.includes(renditionHash))).toBe(true);
    expect(JSON.stringify(points)).not.toContain(token);
    const unchanged = await app.request(
      path,
      { headers: { "if-none-match": `"${renditionHash}"` } },
      bindings,
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("cache-control")).toBe("private, no-cache");
    blobMissing = true;
    expect(await (await app.request(path, {}, bindings)).text()).toBe("source");
  });
  it("returns a large body as a stream before the source closes", async () => {
    rendition = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new Uint8Array(2 * 1024 * 1024));
      },
    });
    const { app, bindings } = fixture(body);
    const response = await app.request(await rawUrl(firstPub, "index.md"), {}, bindings);
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    const part = await response.body?.getReader().read();
    const chunk: unknown = part?.value;
    expect(chunk instanceof Uint8Array ? chunk.byteLength : null).toBe(2 * 1024 * 1024);
    controller?.close();
  });
  it("counts unknown tokens, applies the limiter, and hides other routes", async () => {
    const { app, bindings } = fixture();
    limiter.mockResolvedValue({ success: false });
    const bad = await app.request(
      shareShellUrl(base, newShareToken(), collection),
      { headers: { "cf-connecting-ip": "192.0.2.1" } },
      bindings,
    );
    expect(bad.status).toBe(404);
    expect(reads.some((sql) => sql.includes("FROM share_links"))).toBe(true);
    expect(limiter).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(
      (await app.request(shareShellUrl(base, newShareToken(), collection), {}, env)).status,
    ).toBe(404);
    expect((await app.request("/", {}, bindings)).status).toBe(404);
    expect((await app.request("/unknown", {}, bindings)).status).toBe(404);
    expect(await (await app.request("/healthz", {}, bindings)).text()).toBe("ok");
    const deep = await app.request("/healthz/deep", {}, bindings);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("ok");
    expect(reads).toContain("SELECT 1 FROM collections LIMIT 1");
    expect(await (await app.request("/robots.txt", {}, bindings)).text()).toContain("Disallow: /");
  });
});
