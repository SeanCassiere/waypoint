// Security probes for the Folio public reader: uniform denial, the root page, hostile titles
// and paths in the shell, and worst-case CPU for a full shell request. Ported from the
// feat/ui-folio-reader security review.
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { hashShareToken, newShareToken } from "@waypoint/core";
import { encodePathSegments, publicShellCss, publicShellScript } from "@waypoint/ui";
import { beforeEach, describe, expect, it } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../apps/reader/src/app.ts";
import { deniedPage, rootPage, staticCss } from "../apps/reader/src/pages.ts";
import { waypointMigrations } from "../apps/writer/src/migrations.ts";

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
const A1 = { id: "rev_" + "0".repeat(25) + "1", pub: "a1a1a1a1a1a1" };
const A2 = { id: "rev_" + "0".repeat(25) + "2", pub: "a2a2a2a2a2a2" };
const HOSTILE_TITLE =
  `</title></h1><script>alert(1)</script><style>*{x}</style>"'><img src=x onerror=alert(1)>` +
  "  ‮⁦RTL" +
  "x".repeat(5000);
const HOSTILE_PATHS = [
  "index.html",
  `a"><script>alert(1)</script>.html`,
  "b'onmouseover='alert(1).html",
  "c</script><script>alert(2)</script>.html",
  "d<style>body{display:none}</style>.html",
  "f‮gnp.exe",
  "g%2Fh.html",
  "h#frag?q=1.html",
  "i&amp;.html",
  "dir/x‮.md",
  "j" + "z".repeat(400) + ".html",
];
let db: DatabaseSync;
let limiterCalls: number;
let queries: string[];
let failDb = false;
let failBlob: "throw" | "404" | null = null;
let linkId = "";
const follow = newShareToken();
const pinned = newShareToken();
const revoked = newShareToken();

function readerDb(): ReaderDb {
  return {
    all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      queries.push(sql);
      if (failDb) return Promise.reject(new Error("db down https://secret?token=abc"));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return Promise.resolve(db.prepare(sql).all(...args) as T[]);
    },
  };
}
async function seed(): Promise<void> {
  db = new DatabaseSync(":memory:");
  for (const m of waypointMigrations) db.exec(m.sql);
  const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
  ins(
    "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
    A.id,
    A.pub,
    HOSTILE_TITLE,
  );
  for (const r of [A1, A2])
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,?)",
      r.id,
      r.pub,
      A.id,
      "index.html",
      r === A1 ? 1 : 8.64e15 + 1, // out-of-range Date for A2 (latest)
    );
  ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", h("1"));
  for (const path of HOSTILE_PATHS)
    ins(
      "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
      A1.id,
      path,
      h("1"),
      path.endsWith(".exe") ? "application/x-msdownload" : "text/html",
    );
  let n = 0;
  for (const [token, rev, revokedAt] of [
    [follow, null, null],
    [pinned, A1.id, null],
    [revoked, A1.id, 5],
  ] as const) {
    const id = "shl_" + String(++n).padStart(26, "0");
    if (token === pinned) linkId = id;
    ins(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
      id,
      await hashShareToken(token),
      A.id,
      rev,
      null,
      revokedAt,
    );
  }
}
function makeApp() {
  return createReaderApp({
    db: readerDb,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: () => {
        if (failBlob === "throw") return Promise.reject(new Error("r2 X-Amz-Signature=1"));
        if (failBlob === "404") return Promise.resolve(new Response("nope", { status: 404 }));
        return Promise.resolve(new Response("<p>doc</p>"));
      },
    }),
    now: () => 5000,
  });
}
let app: ReturnType<typeof makeApp>;
let limiterOk = true;
const bindings = () => ({
  ...env,
  TOKEN_MISS_LIMITER: {
    limit: () => {
      limiterCalls++;
      return Promise.resolve({ success: limiterOk });
    },
  },
});
const req = (path: string, init: RequestInit = {}, ip = "1.1.1.1") =>
  app.request(
    `https://waypoint.pingstash.com${path}`,
    {
      ...init,
      headers: { "cf-connecting-ip": ip, ...Object.fromEntries(new Headers(init.headers)) },
    },
    bindings(),
  );
function cap(id: string, revision: string): string {
  return createHmac("sha256", Buffer.alloc(32))
    .update(`${id}\n${revision}`)
    .digest("base64url")
    .slice(0, 22);
}
const rawPath = (revision: string, path: string, id = linkId) =>
  `/x/${id}.${cap(id, revision)}/r/${revision}/${path}`;
async function snap(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].toSorted((a, b) => a[0].localeCompare(b[0])),
  };
}
const b64sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

beforeEach(async () => {
  limiterCalls = 0;
  queries = [];
  failDb = false;
  failBlob = null;
  limiterOk = true;
  await seed();
  app = makeApp();
});

describe("uniform denial", () => {
  it("is byte-identical in body and headers for every reason, GET and HEAD", async () => {
    const cases: [string, RequestInit?][] = [
      [`/s/${newShareToken()}/c/${A.pub}/`],
      [`/s/${revoked}/c/${A.pub}/`],
      [`/s/${pinned}/c/zzzzzzzzzzzz/`],
      [`/s/${pinned}/c/${A.pub}/`], // pinned without rpub
      [`/s/${pinned}/c/${A.pub}/r/${A2.pub}/`],
      [`/s/${pinned}/c/${A.pub}/r/${A1.pub}/missing.html`],
      [`/s/${pinned}/c/${A.pub}/r/${A1.pub}/a%2Fb.html`],
      [`/s/${pinned}/c/${A.pub}/r/${A1.pub}/%E0%A4%A`],
      [rawPath(A1.pub, "%2e%2e/index.html")],
      [rawPath(A1.pub, "index.html").replace(/\.[^/]{22}\//, ".AAAAAAAAAAAAAAAAAAAAAA/")],
      [rawPath(A1.pub, "index.html") + "X"],
      [rawPath(A2.pub, "index.html")],
      [`/x/${linkId}.${cap(linkId, A1.pub)}/r/${A1.pub}X/index.html`],
      ["/index.html"],
      ["//"],
      ["/%2F"],
      ["/s"],
      ["/s/"],
      ["/x/"],
      ["/favicon.ico"],
      ["/__internal/blob/" + h("1")],
      ["/", { method: "POST" }],
      ["/", { method: "OPTIONS" }],
      [`/s/${pinned}/c/${A.pub}/r/${A1.pub}/`, { method: "POST" }],
      ["/healthz", { method: "DELETE" }],
    ];
    const reference = await snap(await req(cases[0]![0]));
    expect(reference.status).toBe(404);
    expect(reference.body).toBe(deniedPage);
    for (const [path, init] of cases) {
      const got = await snap(await req(path, init));
      expect({ path, ...got }).toEqual({ path, ...reference });
      // HEAD answers like GET, without a body; cases with their own method are done.
      if (init?.method) continue;
      const head = await snap(await req(path, { method: "HEAD" }));
      expect({ path, ...head }).toEqual({ path, ...reference, body: "" });
    }
  });
  it("is identical for DB failure, R2 failure, R2 404 and a blocked IP", async () => {
    const reference = await snap(await req(`/s/${newShareToken()}/c/${A.pub}/`));
    failDb = true;
    expect(await snap(await req(`/s/${pinned}/c/${A.pub}/r/${A1.pub}/`, {}, "2.2.2.2"))).toEqual(
      reference,
    );
    failDb = false;
    failBlob = "throw";
    expect(await snap(await req(rawPath(A1.pub, "index.html"), {}, "3.3.3.3"))).toEqual(reference);
    failBlob = "404";
    expect(await snap(await req(rawPath(A1.pub, "index.html"), {}, "3.3.3.4"))).toEqual(reference);
    failBlob = null;
    // Block an IP, then a valid request from it gets the same denial.
    limiterOk = false;
    await req(`/s/${newShareToken()}/c/${A.pub}/`, {}, "9.9.9.9");
    limiterOk = true;
    const before = queries.length;
    expect(await snap(await req(`/s/${pinned}/c/${A.pub}/r/${A1.pub}/`, {}, "9.9.9.9"))).toEqual(
      reference,
    );
    expect(queries.length).toBe(before);
  });
  it("serves the root only at exactly / without DB or limiter, HEAD = GET headers", async () => {
    const get = await snap(await req("/"));
    const head = await snap(await req("/", { method: "HEAD" }));
    const query = await snap(await req("/?x=%3Cscript%3E"));
    expect(get.status).toBe(200);
    expect(get.body).toBe(rootPage);
    expect(head).toEqual({ ...get, body: "" });
    expect(query).toEqual(get);
    expect(queries).toEqual([]);
    expect(limiterCalls).toBe(0);
    expect(Object.fromEntries(get.headers)["cache-control"]).toBe("public, max-age=3600");
    expect(Object.fromEntries(get.headers)["content-security-policy"]).toContain(b64sha(staticCss));
    expect(Object.fromEntries(get.headers)["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
  it("lists every non-denial unauthenticated URL", async () => {
    const non: string[] = [];
    for (const path of ["/", "/healthz", "/healthz/deep", "/robots.txt", "/index.html"]) {
      const res = await req(path);
      if ((await res.text()) !== deniedPage) non.push(`${path} ${res.status}`);
    }
    // Besides /s/ and /x/: the root page and the operational endpoints (docs/public-reader.md).
    expect(non).toEqual(["/ 200", "/healthz 200", "/healthz/deep 200", "/robots.txt 200"]);
  });
});

describe("shell markup under hostile titles and paths", () => {
  for (const file of HOSTILE_PATHS) {
    it(`stays inert for ${JSON.stringify(file.slice(0, 40))}`, async () => {
      const res = await req(`/s/${pinned}/c/${A.pub}/r/${A1.pub}/${encodePathSegments(file)}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(b64sha(publicShellCss));
      expect(csp).toContain(b64sha(publicShellScript));
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("cache-control")).toBe("private");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      // Exactly one style and one script element, both the hashed bodies.
      expect(html.match(/<script\b/gi)).toHaveLength(1);
      expect(html.match(/<style\b/gi)).toHaveLength(1);
      expect(html.match(/<\/script/gi)).toHaveLength(1);
      expect(html.match(/<\/style/gi)).toHaveLength(1);
      expect(html).toContain(`<style>${publicShellCss}</style>`);
      expect(html).toContain(`<script>${publicShellScript}</script>`);
      // No raw quote breaking out of any attribute, no event handlers or style attributes.
      const markup = html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
      for (const tag of markup.match(/<[a-z][^>]*>/gi) ?? []) {
        expect(tag).not.toMatch(/\son[a-z]+\s*=|\sstyle\s*=/i);
        const attrs = tag.replace(/^<[a-z0-9]+/i, "").replace(/\/?>$/, "");
        const stripped = attrs.replace(/\s[a-z-]+(?:="[^"]*")?/gi, "");
        expect({ tag: tag.slice(0, 80), stripped }).toEqual({
          tag: tag.slice(0, 80),
          stripped: "",
        });
      }
      // The token never appears in the iframe or download URL.
      const frame = html.match(/id="doc"[^>]*(?:src|href)="([^"]+)"/)?.[1] ?? "";
      expect(frame).toMatch(/^https:\/\/waypoint\.pingstash\.com\/x\/shl_/);
      expect(frame).not.toContain(pinned);
    });
  }
  it("latest link with an out-of-range timestamp denies instead of 500", async () => {
    const res = await req(`/s/${follow}/c/${A.pub}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(deniedPage);
  });
});
