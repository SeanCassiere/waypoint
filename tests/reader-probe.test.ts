import { createHmac } from "node:crypto";
// Adversarial review probes against the writer schema and reader app.
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createReaderApp,
  LOOKUP_TTL_MS,
  type ReaderDb,
  type ReaderEnv,
} from "../apps/reader/src/app.ts";
import { deniedPage } from "../apps/reader/src/pages.ts";
import { waypointMigrations } from "../apps/writer/src/migrations.ts";
import { hashShareToken, newShareToken } from "../packages/core/src/index.ts";
import { encodePathSegments, renderPublicShell } from "../packages/ui/src/index.ts";

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
const A = { id: "col_" + "a".repeat(26), pub: "aaaaaaaaaaaa" };
const B = { id: "col_" + "b".repeat(26), pub: "bbbbbbbbbbbb" };
const A1 = { id: "rev_" + "0".repeat(25) + "1", pub: "a1a1a1a1a1a1" };
const A2 = { id: "rev_" + "0".repeat(25) + "2", pub: "a2a2a2a2a2a2" };
const B1 = { id: "rev_" + "0".repeat(25) + "3", pub: "b1b1b1b1b1b1" };
const tokens = {
  follow: newShareToken(),
  pinned: newShareToken(),
  b: newShareToken(),
  revoked: newShareToken(),
  expired: newShareToken(),
  tomb: newShareToken(),
  crossPin: newShareToken(),
  unknown: newShareToken(),
};
let db: DatabaseSync;
let clock: number;
let points: unknown[];
let cacheStore: Map<string, Response>;
let limiterCalls: number;
let blobFetches: string[];
let queries: string[];
let dbMs = 0;
const tokenIds = new Map<string, string>();
function raw(token: string, revision: string, path: string): string {
  const id = tokenIds.get(token) ?? "shl_" + "0".repeat(26);
  const cap = createHmac("sha256", Buffer.alloc(32))
    .update(`${id}\n${revision}`)
    .digest("base64url")
    .slice(0, 22);
  return `/x/${id}.${cap}/r/${revision}/${path}`;
}

function readerDb(): ReaderDb {
  return {
    all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      queries.push(sql);
      const q0 = performance.now();
      try {
        if (!/^\s*SELECT/i.test(sql)) throw new Error("non-select: " + sql);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return Promise.resolve(db.prepare(sql).all(...args) as T[]);
      } finally {
        dbMs += performance.now() - q0;
      }
    },
  };
}
async function seed() {
  db = new DatabaseSync(":memory:");
  for (const m of waypointMigrations) db.exec(m.sql);
  const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
  for (const c of [A, B])
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      c.id,
      c.pub,
      `T ${c.pub}`,
    );
  for (const [r, c, head] of [
    [A1, A, "old-secret.html"],
    [A2, A, "index.html"],
    [B1, B, "b-only.html"],
  ] as const)
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      r.id,
      r.pub,
      c.id,
      head,
    );
  for (const c of "123456789")
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", h(c));
  const file = (rev: string, path: string, hash: string, mime: string) =>
    ins(
      "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
      rev,
      path,
      hash,
      mime,
    );
  file(A1.id, "old-secret.html", h("1"), "text/html");
  file(A1.id, "index.html", h("2"), "text/html");
  file(A2.id, "index.html", h("3"), "text/html");
  file(A2.id, "doc.md", h("4"), "text/markdown");
  file(A2.id, "café.txt", h("6"), "text/plain");
  file(B1.id, "b-only.html", h("7"), "text/html");
  file(B1.id, "index.html", h("8"), "text/html");
  ins(
    "INSERT INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,1)",
    h("4"),
    "markdown",
    1,
    h("5"),
    "text/html",
  );
  let n = 0;
  const link = async (
    token: string,
    col: string,
    rev: string | null,
    extra: { expires?: number; revoked?: number } = {},
  ) =>
    ins(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
      (() => {
        const id = "shl_" + String(++n).padStart(26, "0");
        tokenIds.set(token, id);
        return id;
      })(),
      await hashShareToken(token),
      col,
      rev,
      extra.expires ?? null,
      extra.revoked ?? null,
    );
  await link(tokens.follow, A.id, null);
  await link(tokens.pinned, A.id, A1.id);
  await link(tokens.b, B.id, null);
  await link(tokens.revoked, A.id, null, { revoked: 5 });
  await link(tokens.expired, A.id, null, { expires: 10_000 });
  await link(tokens.crossPin, A.id, B1.id); // pinned to another collection's revision
  const tombCol = { id: "col_" + "c".repeat(26), pub: "cccccccccccc" };
  ins(
    "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
    tombCol.id,
    tombCol.pub,
    "tomb",
  );
  ins(
    "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
    "rev_" + "0".repeat(25) + "9",
    "c1c1c1c1c1c1",
    tombCol.id,
    "index.html",
  );
  ins(
    "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
    "rev_" + "0".repeat(25) + "9",
    "index.html",
    h("9"),
    "text/html",
  );
  ins("INSERT INTO collection_tombstones (collection_id,deleted_at) VALUES (?,1)", tombCol.id);
  await link(tokens.tomb, tombCol.id, null);
}
function makeApp() {
  return createReaderApp({
    db: readerDb,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: (hash) => {
        blobFetches.push(hash);
        return Promise.resolve(new Response(`BLOB(${hash.slice(7, 8)})`));
      },
    }),
    cache: {
      match: (r) => Promise.resolve(cacheStore.get(r.url)?.clone()),
      put: async (r, res) => {
        cacheStore.set(r.url, new Response(await res.arrayBuffer(), res));
      },
    },
    now: () => clock,
  });
}
let app: ReturnType<typeof makeApp>;
const bindings = () => ({
  ...env,
  ACCESS_LOG: { writeDataPoint: (p: unknown) => void points.push(p) },
  TOKEN_MISS_LIMITER: {
    limit: () => {
      limiterCalls++;
      return Promise.resolve({ success: limiterCalls <= 30 });
    },
  },
});
const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`https://waypoint.pingstash.com${path}`, { headers }, bindings());
/** Share-link lookups the reader has sent to the database so far. */
const linkQueries = () => queries.filter((sql) => sql.includes("FROM share_links")).length;
async function snap(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].toSorted((a, b) => a[0].localeCompare(b[0])),
  };
}

beforeEach(async () => {
  clock = 5000;
  points = [];
  cacheStore = new Map();
  limiterCalls = 0;
  blobFetches = [];
  queries = [];
  tokenIds.clear();
  await seed();
  app = makeApp();
});

describe("adversarial reader probes", () => {
  it("checks expiry on each request and sees revocation after the lookup TTL", async () => {
    clock = 9_999;
    expect((await get(`/s/${tokens.expired}/c/${A.pub}/`)).status).toBe(200);
    clock = 10_000;
    expect((await get(`/s/${tokens.expired}/c/${A.pub}/`)).status).toBe(404);
    expect((await get(`/s/${tokens.follow}/c/${A.pub}/`)).status).toBe(200);
    db.prepare("UPDATE share_links SET revoked_at=1 WHERE token_hash=?").run(
      await hashShareToken(tokens.follow),
    );
    clock += LOOKUP_TTL_MS - 1;
    expect((await get(`/s/${tokens.follow}/c/${A.pub}/`)).status).toBe(200);
    clock += 2;
    expect((await get(`/s/${tokens.follow}/c/${A.pub}/`)).status).toBe(404);
  });
  it("denies a revoked link on shell and raw routes once the 5 s lookup TTL passes", async () => {
    expect(LOOKUP_TTL_MS).toBe(5_000);
    const shell = `/s/${tokens.follow}/c/${A.pub}/`;
    const file = raw(tokens.follow, A2.pub, "index.html");
    expect((await get(shell)).status).toBe(200);
    expect((await get(file)).status).toBe(200);
    const before = linkQueries();
    // Within the TTL, repeat requests are served from the isolate cache: no Turso lookups.
    clock += 2_000;
    for (let i = 0; i < 5; i++) {
      expect((await get(shell)).status).toBe(200);
      expect((await get(file)).status).toBe(200);
    }
    expect(linkQueries()).toBe(before);
    db.prepare("UPDATE share_links SET revoked_at=? WHERE token_hash=?").run(
      clock,
      await hashShareToken(tokens.follow),
    );
    // The entries were cached at 5000 ms, so they expire at 10 000 ms.
    clock = 5_000 + LOOKUP_TTL_MS;
    expect((await get(shell)).status).toBe(404);
    expect((await get(file)).status).toBe(404);
    // A denial is never cached: each later request re-queries and stays denied.
    const denied = linkQueries();
    expect((await get(shell)).status).toBe(404);
    expect(linkQueries()).toBe(denied + 1);
  });
  it("never caches a miss, so a link that reaches the cloud later works at once", async () => {
    const late = newShareToken();
    const shell = `/s/${late}/c/${A.pub}/`;
    expect((await get(shell)).status).toBe(404);
    db.prepare(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
    ).run("shl_" + "9".repeat(26), await hashShareToken(late), A.id, null, null, null);
    expect((await get(shell)).status).toBe(200);
  });
  it("accepts normalized Unicode paths and rejects a tampered capability", async () => {
    const nfd = encodeURIComponent("café.txt".normalize("NFD"));
    expect((await get(raw(tokens.follow, A2.pub, nfd))).status).toBe(200);
    const valid = raw(tokens.follow, A2.pub, "index.html");
    expect((await get(valid)).status).toBe(200);
    expect(
      (await get(valid.replace(/\.([A-Za-z0-9_-]{22})\//, ".AAAAAAAAAAAAAAAAAAAAAA/"))).status,
    ).toBe(404);
  });
  it("serves rendition 304 without fetching R2 again and keeps headers", async () => {
    const path = raw(tokens.follow, A2.pub, "doc.md");
    const first = await get(path);
    expect(await first.text()).toBe("BLOB(5)");
    const prior = blobFetches.length;
    const second = await get(path, { "if-none-match": first.headers.get("etag") ?? "" });
    expect(second.status).toBe(304);
    expect(blobFetches.length).toBe(prior);
    expect(second.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(second.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  it("keeps collections and pinned revisions isolated", async () => {
    const cases = [
      `/s/${tokens.follow}/c/${B.pub}/`,
      `/s/${tokens.follow}/c/${A.pub}/r/${B1.pub}/`,
      `/s/${tokens.follow}/c/${A.pub}/b-only.html`,
      raw(tokens.follow, B1.pub, "b-only.html"),
      raw(tokens.follow, A1.pub, "old-secret.html"),
      `/s/${tokens.pinned}/c/${A.pub}/`,
      `/s/${tokens.pinned}/c/${A.pub}/r/${A2.pub}/`,
      raw(tokens.pinned, A2.pub, "index.html"),
      `/s/${tokens.crossPin}/c/${A.pub}/r/${B1.pub}/`,
      raw(tokens.crossPin, B1.pub, "b-only.html"),
    ];
    for (const path of cases) expect((await get(path)).status).toBe(404);
    expect((await get(raw(tokens.pinned, A1.pub, "old-secret.html"))).status).toBe(200);
    expect(blobFetches).not.toContain(h("7"));
  });
  it("returns identical denials for unknown, revoked, expired, tombstoned and malformed paths", async () => {
    clock = 20_000;
    const cases = [
      `/s/${tokens.unknown}/c/${A.pub}/`,
      `/s/${tokens.revoked}/c/${A.pub}/`,
      `/s/${tokens.expired}/c/${A.pub}/`,
      `/s/${tokens.tomb}/c/cccccccccccc/`,
      raw(tokens.follow, A1.pub, "old-secret.html"),
      raw(tokens.follow, A2.pub, "missing.html"),
      raw(tokens.follow, A2.pub, "a%2Fb"),
      `/s/`,
      `/index.html`,
      `/assets/1/x.js`,
    ];
    const reference = await snap(await get(cases[0]!));
    expect(reference.status).toBe(404);
    expect(reference.body).toBe(deniedPage);
    for (const path of cases) expect(await snap(await get(path))).toEqual(reference);
    expect(limiterCalls).toBe(9);
    // The bare root is the one non-share page: a 200 that differs from every denial.
    const root = await snap(await get("/"));
    expect(root.status).toBe(200);
    expect(root.body).not.toBe(reference.body);
    expect(root.body).not.toMatch(/wps_|shl_|sha256:|T aaaa/);
    expect(limiterCalls).toBe(9);
  });
  it("keeps the share token out of raw iframe URLs and analytics", async () => {
    const shell = await get(`/s/${tokens.follow}/c/${A.pub}/`);
    const html = await shell.text();
    const frame = html.match(/<iframe[^>]+src="([^"]+)"/)?.[1];
    expect(frame).toContain(`/x/${tokenIds.get(tokens.follow)}.`);
    expect(frame).not.toContain(tokens.follow);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    const content = await get(raw(tokens.follow, A2.pub, "doc.md"));
    expect(content.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await content.text()).toBe("BLOB(5)");
    for (const token of Object.values(tokens)) expect(JSON.stringify(points)).not.toContain(token);
    for (const key of cacheStore.keys()) expect(key).not.toContain(tokens.follow);
  });
  it("serves 100 valid raw requests from one IP without touching the limiter", async () => {
    const path = raw(tokens.follow, A2.pub, "index.html");
    for (let i = 0; i < 100; i++)
      expect((await get(path, { "cf-connecting-ip": "192.0.2.10" })).status).toBe(200);
    expect(limiterCalls).toBe(0);
  });
  it("blocks after denials, without DB or R2 access, and keeps 404s uniform", async () => {
    const headers = { "cf-connecting-ip": "192.0.2.11" };
    const unknown = `/s/${tokens.unknown}/c/${A.pub}/`;
    const ordinary = await snap(await get(unknown, headers));
    for (let i = 1; i < 31; i++) await get(unknown, headers);
    expect(limiterCalls).toBe(31);
    const priorQueries = queries.length;
    const priorBlobs = blobFetches.length;
    // An IP can lose access to a valid link for 60 seconds, but only after
    // more than 30 denials. The blocked check runs before the DB and R2.
    const blocked = await snap(await get(raw(tokens.follow, A2.pub, "index.html"), headers));
    expect(blocked).toEqual(ordinary);
    expect(queries.length).toBe(priorQueries);
    expect(blobFetches.length).toBe(priorBlobs);
    expect(limiterCalls).toBe(31);
    clock += 60_001;
    expect((await get(raw(tokens.follow, A2.pub, "index.html"), headers)).status).toBe(200);
    expect(limiterCalls).toBe(31);
  });
  it("renders 2000 files with bounded shell overhead", async () => {
    const insert = db.prepare(
      "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
    );
    for (let i = 0; i < 2000; i++)
      insert.run(A2.id, `dir${i % 40}/file-${i}.html`, h("3"), "text/html");
    const shell = await (await get(`/s/${tokens.follow}/c/${A.pub}/`)).text();
    expect((shell.match(/<a href=/g) ?? []).length).toBeGreaterThan(2000);
    // Large manifests collapse folders, so the shell stays one cheap pass over the paths.
    expect(shell).toContain('<summary>Files <span class="n">(2003)</span>');
    expect(shell).not.toContain("<details open><summary>dir");
    // Time the Worker CPU work that scales with file count: the whole shell document.
    // The end-to-end request includes fake SQLite and Hono/Vitest scheduling overhead.
    const paths = Array.from({ length: 2000 }, (_, i) => ({ path: `dir${i % 40}/file-${i}.html` }));
    const prefix = `https://waypoint.pingstash.com/s/${tokens.follow}/c/${A.pub}/`;
    const render = () =>
      renderPublicShell({
        title: "T",
        files: paths,
        head: "index.html",
        current: "dir7/file-7.html",
        fileHref: (path) => prefix + encodePathSegments(path),
        frameBase: "https://waypoint.pingstash.com/x/shl_x.cap/r/a2a2a2a2a2a2/",
        updatedAt: 1,
        snapshotAt: null,
      });
    // CPU time of this thread (what the Worker CPU limit counts), not wall time, which other
    // processes on a busy machine inflate. Warm isolates serve most requests, so measure after a
    // short warm-up: the mean of 10 renders, as before, in milliseconds.
    for (let i = 0; i < 5; i++) render();
    const cpu = process.threadCpuUsage();
    for (let i = 0; i < 10; i++) render();
    const used = process.threadCpuUsage(cpu);
    const overhead = (used.user + used.system) / 1000 / 10;
    expect(overhead).toBeLessThan(5);
  });
});
