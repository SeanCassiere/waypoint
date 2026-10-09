import { hashShareToken, newShareToken, shareShellUrl, WAYPOINT_VERSION } from "@waypoint/core";
import { iconUse, publicShellCss, publicShellScript } from "@waypoint/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.ts";
import { staticStyleHash } from "../src/csp-hashes.ts";
import { deniedPage, frameDeniedPage, rootPage, staticCss } from "../src/pages.ts";

const collection = "0123456789ab";
const firstPub = "bcdefghjkmnp";
const secondPub = "cdefghjkmnpq";
const hash = `sha256:${"a".repeat(64)}`;
const renditionHash = `sha256:${"b".repeat(64)}`;
const token = newShareToken();
const base = "https://reader.example.test";
/**
 * Whether `url` really is on `base`'s origin, by parsed origin rather than by prefix, so that
 * `…test.evil`, `…test:8080` and `…test@evil.example` (userinfo) don't pass. Unparseable is foreign.
 */
function isOwnOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
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
type FileRow = { path: string; blob_hash: string; mime: string; size?: number };
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
async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}
/** Exact policy for the root and denial pages (spec §9.2). */
const staticPolicy = `default-src 'none'; style-src ${staticStyleHash}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
/** The `/x/` denial card's policy: the same, but framable by the shell. */
const framePolicy = `default-src 'none'; style-src ${staticStyleHash}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
const staticHeaderNames = [
  "cache-control",
  "content-security-policy",
  "content-type",
  "cross-origin-opener-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-robots-tag",
];
/** Resolves a shell's file links against its URL, as the browser would. */
const resolveLinks = (html: string, page: string): string[] =>
  [...html.matchAll(/<a href="([^"]+)" data-p=/g)].map(
    (m) => new URL(m[1]!.replaceAll("&amp;", "&"), page).pathname,
  );
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
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain("Updated <time");
    expect(html).not.toContain("Snapshot from");
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'none'");
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    if (!style) throw new Error("Shell style missing");
    expect(shell.headers.get("content-security-policy")).toContain(await sha256(style));
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
    const html = await shell.text();
    expect(html).toContain("Taken <time");
    expect(html).not.toContain("Updated <time");
    expect((await app.request(await rawUrl(secondPub, "index.md"), {}, bindings)).status).toBe(404);
  });
  it("passes the link's expiry to the letterhead", async () => {
    link.expires_at = Date.now() + 6 * 86_400_000;
    const { app, bindings } = fixture();
    const expiring = await (
      await app.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    expect(expiring).toContain('class="f exp"');
    expect(expiring).toContain("Works until");
    // A new app: the first one caches the link for a few seconds.
    link.expires_at = null;
    const { app: openApp } = fixture();
    const open = await (
      await openApp.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    expect(open).toContain("No end date");
    expect(open).not.toContain('class="f exp');
  });
  it("uses identical denials for every reason within each route family", async () => {
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
    const wrongCollection = await app.request(
      shareShellUrl(base, token, "zzzzzzzzzzzz"),
      {},
      bindings,
    );
    const missingShellPath = await app.request(
      shareShellUrl(base, token, collection, undefined, "missing.md"),
      {},
      bindings,
    );
    const others = await Promise.all(
      ["/index.html", "/s", "/s/", "//", "/assets/1/x.js", "/s/wps_short/c/x/"].map(async (url) =>
        app.request(url, {}, bindings),
      ),
    );
    const bareRaw = await app.request("/x/", {}, bindings);
    const post = await app.request("/", { method: "POST" }, bindings);
    // The raw route (`/x/`) gets the framable card; everything else the full page.
    const families = [
      {
        page: frameDeniedPage,
        policy: framePolicy,
        all: [revoked, expired, tombstoned, missing, bareRaw],
      },
      {
        page: deniedPage,
        policy: staticPolicy,
        all: [unknown, wrongCollection, missingShellPath, post, ...others],
      },
    ];
    for (const { page, policy, all } of families) {
      const bodies = await Promise.all(all.map(async (response) => response.text()));
      expect(bodies).toEqual(all.map(() => page));
      for (const response of all) {
        expect(response.status).toBe(404);
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-security-policy")).toBe(policy);
        expect(response.headers.get("x-frame-options")).toBeNull();
        expect([...response.headers]).toEqual([...all[0]!.headers]);
      }
      expect([...all[0]!.headers.keys()].toSorted()).toEqual(staticHeaderNames);
    }
  });
  it("serves the bare root only at /, as a 200 with no data", async () => {
    const { app, bindings } = fixture();
    for (const method of ["GET", "HEAD"]) {
      const before = reads.length;
      const root = await app.request(`${base}/`, { method }, bindings);
      expect(root.status).toBe(200);
      expect(Object.fromEntries(root.headers)).toEqual({
        "cache-control": "public, max-age=3600",
        "content-security-policy": staticPolicy,
        "content-type": "text/html; charset=utf-8",
        "cross-origin-opener-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      });
      expect(await root.text()).toBe(method === "GET" ? rootPage : "");
      expect(reads.length).toBe(before);
    }
    expect(limiter).not.toHaveBeenCalled();
    expect(rootPage).toContain("<title>Waypoint</title>");
    expect(rootPage).toContain("<h1>This address is for shared Waypoint documents</h1>");
    expect(deniedPage).toContain("<title>Link not available · Waypoint</title>");
    expect(deniedPage).toContain("<h1>This link isn't available</h1>");
    // No data, links, inputs, scripts or style attributes; one <style> covered by one hash.
    for (const page of [rootPage, deniedPage, frameDeniedPage]) {
      expect(page).not.toMatch(/<(?:a|input|form|button|script|select|textarea|link|img)\b/i);
      expect(page).not.toMatch(/\sstyle=|\son[a-z]+=/i);
      expect(page.match(/<style>/g)).toHaveLength(1);
      expect(page).toContain(`<style>${staticCss}</style>`);
    }
    expect(await sha256(staticCss)).toBe(staticStyleHash);
  });
  it("hashes the shell's only inline style and script in a strict CSP", async () => {
    const { app, bindings } = fixture();
    const shell = await app.request(shareShellUrl(base, token, collection), {}, bindings);
    const html = await shell.text();
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain(`<style>${publicShellCss}</style>`);
    expect(html).toContain(`<script>${publicShellScript}</script>`);
    // No inline handlers, external resources or absolute URLs except the reader's own origin.
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=|<link\b|<script\s+src/i);
    const foreign = (html.match(/https?:\/\/[^"'\s<>]*/gi) ?? []).filter(
      (url) => !isOwnOrigin(url),
    );
    expect(foreign).toEqual([]);
    const lookalikes = [
      "https://reader.example.test.evil/",
      "https://reader.example.test:8080/",
      "https://reader.example.test@evil.example/",
      "https://user:pw@reader.example.test.evil/",
      "http://reader.example.test/",
    ];
    expect(lookalikes.filter(isOwnOrigin)).toEqual([]);
    expect(isOwnOrigin(`${base}/s/x`)).toBe(true);
    expect(shell.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src ${await sha256(publicShellCss)}; script-src ${await sha256(publicShellScript)}; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    expect(shell.headers.get("cache-control")).toBe("private");
    expect(shell.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(shell.headers.get("referrer-policy")).toBe("no-referrer");
    expect(shell.headers.get("x-content-type-options")).toBe("nosniff");
    // The listener trusts only the frame's own window and re-checks the payload.
    expect(publicShellScript).toContain("e.source !== frame.contentWindow");
    expect(publicShellScript).toContain('m.type !== "waypoint:location"');
  });
  it("has no revision picker and keeps every link on the served revision", async () => {
    revisions.push({
      id: "rev_two",
      public_id: secondPub,
      head_path: "index.md",
      created_at: 2000,
    });
    const { app, bindings } = fixture();
    const latest = await (
      await app.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    link.revision_id = "rev_one";
    const { app: pinnedApp } = fixture();
    const pinned = await (
      await pinnedApp.request(shareShellUrl(base, token, collection, firstPub), {}, bindings)
    ).text();
    for (const html of [latest, pinned]) {
      // The letterhead's About button (RX-01) is the shell's only button.
      const markup = html
        .replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "")
        .replace(/<button type="button" class="abt" popovertarget="about">[\s\S]*?<\/button>/, "");
      expect(markup).not.toMatch(/<select\b|<button\b|<input\b|revision|history|#\d/i);
      expect(html).not.toContain("rev_");
    }
    // Tab links are relative to the shell URL; resolve them as the browser would.
    const latestLinks = resolveLinks(latest, shareShellUrl(base, token, collection));
    expect(latestLinks.length).toBeGreaterThan(0);
    for (const href of latestLinks) {
      expect(href).not.toContain("/r/");
      expect(href.startsWith(new URL(shareShellUrl(base, token, collection)).pathname)).toBe(true);
    }
    expect(latest).toContain(`/r/${secondPub}/index.md`);
    expect(latest).not.toContain(firstPub);
    const pinnedLinks = resolveLinks(pinned, shareShellUrl(base, token, collection, firstPub));
    expect(pinnedLinks.length).toBeGreaterThan(0);
    for (const href of pinnedLinks) expect(href).toContain(`/r/${firstPub}/`);
    expect(pinned).not.toContain(secondPub);
  });
  it("shows tabs up to 8 files, a Files tree above, and a download card for binaries", async () => {
    files = [
      { path: "z.md", blob_hash: hash, mime: "text/markdown" },
      { path: "index.md", blob_hash: hash, mime: "text/markdown" },
      { path: "data/a.bin", blob_hash: hash, mime: "application/octet-stream", size: 2048 },
    ];
    const { app, bindings } = fixture();
    const tabs = await (
      await app.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    expect(tabs).toContain('<nav class="ptabs2" aria-label="Files">');
    expect([...tabs.matchAll(/data-p="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "index.md",
      "data/a.bin",
      "z.md",
    ]);
    expect(tabs).toMatch(/<a href="[^"]+\/index\.md" data-p="index\.md" aria-current="page">/);
    const binary = await (
      await app.request(
        shareShellUrl(base, token, collection, undefined, "data/a.bin"),
        {},
        bindings,
      )
    ).text();
    expect(binary).not.toContain("<iframe");
    expect(binary).toContain(
      "2.0 KB · application/octet-stream · can&#39;t be previewed in the browser",
    );
    expect(binary).toMatch(
      /<a id="doc" class="btn primary" href="[^"]*\/x\/shl_[^"]+\/data\/a\.bin" download="a\.bin">/,
    );
    expect(binary).not.toContain(`${token}/data`);
    files = Array.from({ length: 9 }, (_, i) => ({
      path: i ? `docs/part-${i}.md` : "index.md",
      blob_hash: hash,
      mime: "text/markdown",
    }));
    const tree = await (
      await app.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    expect(tree).not.toContain('<nav class="ptabs2"');
    expect(tree).toContain('<nav class="pfiles" aria-label="Files">');
    expect(tree).toContain('Files <span class="n">9</span>');
    expect(tree).toContain(
      '<details open><summary dir="auto">' + iconUse("folder") + "docs/</summary>",
    );
    files = [{ path: "index.md", blob_hash: hash, mime: "text/markdown" }];
    const single = await (
      await app.request(shareShellUrl(base, token, collection), {}, bindings)
    ).text();
    expect(single).not.toContain('aria-label="Files"');
    expect(single).toContain("<iframe");
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
    expect((await app.request("/", {}, bindings)).status).toBe(200);
    expect((await app.request("/index.html", {}, bindings)).status).toBe(404);
    expect((await app.request("/unknown", {}, bindings)).status).toBe(404);
    const health = await app.request("/healthz", {}, bindings);
    expect(await health.text()).toBe("ok");
    expect(health.headers.get("x-waypoint-version")).toBe(WAYPOINT_VERSION);
    expect(health.headers.get("x-waypoint-sha")).toBeNull();
    limiter.mockResolvedValue({ success: true });
    const deep = await app.request("/healthz/deep", {}, bindings);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("ok");
    expect(deep.headers.get("x-waypoint-version")).toBe(WAYPOINT_VERSION);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const built = await app.request("/healthz", {}, { ...bindings, WAYPOINT_BUILD_SHA: sha });
    expect(await built.text()).toBe("ok");
    expect(built.headers.get("x-waypoint-sha")).toBe(sha);
    const stray = await app.request("/healthz", {}, { ...bindings, WAYPOINT_BUILD_SHA: "<b>" });
    expect(stray.headers.get("x-waypoint-sha")).toBeNull();
    expect(reads).toContain("SELECT 1 FROM collections LIMIT 1");
    expect(await (await app.request("/robots.txt", {}, bindings)).text()).toContain("Disallow: /");
  });
  it("counts /healthz/deep toward the per-IP limiter and denies once blocked", async () => {
    const { app, bindings } = fixture();
    const ip = { headers: { "cf-connecting-ip": "192.0.2.50" } };
    const deep = await app.request("/healthz/deep", ip, bindings);
    expect(await deep.text()).toBe("ok");
    expect(limiter).toHaveBeenCalledWith({ key: "192.0.2.50" });
    limiter.mockResolvedValue({ success: false });
    const before = reads.length;
    const rejected = await app.request("/healthz/deep", ip, bindings);
    expect(rejected.status).toBe(404);
    expect(await rejected.text()).toBe(deniedPage);
    const calls = limiter.mock.calls.length;
    const blocked = await app.request("/healthz/deep", ip, bindings);
    expect(await blocked.text()).toBe(deniedPage);
    // Blocked: no limiter call, no Turso query; /healthz stays cheap and unlimited.
    expect(limiter.mock.calls.length).toBe(calls);
    expect(reads.length).toBe(before);
    expect(await (await app.request("/healthz", ip, bindings)).text()).toBe("ok");
    expect(limiter.mock.calls.length).toBe(calls);
  });
  it("sets COOP on the shell and keeps the token out of every link", async () => {
    const { app, bindings } = fixture();
    const shell = await app.request(
      shareShellUrl(base, token, collection, undefined, "other.txt"),
      {},
      bindings,
    );
    expect(shell.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const html = await shell.text();
    for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) expect(m[1]).not.toContain(token);
    expect(html).toContain('<a href="./index.md" data-p="index.md">');
  });
});
