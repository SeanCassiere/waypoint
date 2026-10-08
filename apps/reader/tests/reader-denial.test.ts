import { readFileSync } from "node:fs";

import { hashShareToken, newShareToken, shareShellUrl } from "@waypoint/core";
import { FRAME_DENIED_BODY, FRAME_DENIED_HEADING } from "@waypoint/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.ts";
import { staticStyleHash } from "../src/csp-hashes.ts";
import { deniedPage, frameDeniedPage, rootPage, staticCss } from "../src/pages.ts";

// One fixed denial per route family (decision (d)): the raw route (`/x/`) gets the framable card,
// everything else the full page. The family comes from the requested path alone, so within a
// family every reason gets the same status, body and headers.

const base = "https://reader.example.test";
const collection = "0123456789ab";
const firstPub = "bcdefghjkmnp";
const otherPub = "cdefghjkmnpq";
const linkId = "shl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = newShareToken();
const framePolicy = `default-src 'none'; style-src ${staticStyleHash}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
const forbiddenTags = /<(?:a|input|form|button|script|select|textarea|link|img)\b/i;
const forbiddenAttributes = /\sstyle=|\son[a-z]+=/i;
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "turso://test",
  TURSO_READONLY_TOKEN: "test",
  R2_ACCOUNT_ID: "test",
  R2_READER_ACCESS_KEY_ID: "test",
  R2_READER_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "test",
  // 32 zero bytes, so the test can sign capabilities itself.
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

async function rawUrl(revision: string, path: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${linkId}\n${revision}`)),
  );
  const cap = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
    .slice(0, 22);
  return `${base}/x/${linkId}.${cap}/r/${revision}/${path}`;
}
const tamper = (url: string): string => url.replace(/\.[A-Za-z0-9_-]{22}\//, `.${"A".repeat(22)}/`);

type Options = {
  revoked?: boolean;
  expired?: boolean;
  tombstoned?: boolean;
  lookupThrows?: boolean;
  revisionsThrow?: boolean;
  blob?: "throw" | "404";
  /** Every limiter call rejects, so the first denial blocks the IP. */
  overLimit?: boolean;
};
let limiterCalls = 0;
function fixture(options: Options = {}) {
  const db: ReaderDb = {
    async all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      let rows: unknown[] = [];
      if (sql.includes("FROM share_links")) {
        if (options.lookupThrows) throw new Error("Turso down");
        rows =
          args[0] === (await hashShareToken(token)) || args[0] === linkId
            ? [
                {
                  id: linkId,
                  collection_id: "col_test",
                  revision_id: null,
                  expires_at: options.expired ? 1 : null,
                  revoked_at: options.revoked ? 1 : null,
                  public_id: collection,
                  title: "Shared",
                  deleted_at: options.tombstoned ? 1 : null,
                  pinned_public_id: null,
                  pinned_head_path: null,
                  pinned_created_at: null,
                },
              ]
            : [];
      } else if (sql.includes("FROM revisions")) {
        if (options.revisionsThrow) throw new Error("query failed");
        rows = [{ id: "rev_one", public_id: firstPub, head_path: "index.html", created_at: 1000 }];
      } else if (sql.includes("FROM revision_files") && sql.includes("path=?"))
        rows =
          args[1] === "index.html"
            ? [{ path: "index.html", blob_hash: `sha256:${"a".repeat(64)}`, mime: "text/html" }]
            : [];
      else if (sql.includes("FROM revision_files")) rows = [{ path: "index.html" }];
      // This fake is intentionally the trust boundary for typed SQL rows.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return rows.map((row) => row as T);
    },
  };
  const app = createReaderApp({
    db: () => db,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: () =>
        options.blob === "throw"
          ? Promise.reject(new Error("R2 down"))
          : Promise.resolve(
              options.blob === "404"
                ? new Response(null, { status: 404 })
                : new Response("<p>document</p>"),
            ),
    }),
  });
  const bindings = {
    ...env,
    TOKEN_MISS_LIMITER: {
      limit: () => {
        limiterCalls++;
        return Promise.resolve({ success: !options.overLimit });
      },
    },
  };
  return (url: string, method = "GET", ip = "192.0.2.1"): Promise<Response> =>
    Promise.resolve(app.request(url, { method, headers: { "cf-connecting-ip": ip } }, bindings));
}
/** Blocks the IP with one denial, then sends `url` from it. */
async function blockedThen(url: string, method: string): Promise<Response> {
  const request = fixture({ overLimit: true });
  await request(shareShellUrl(base, newShareToken(), collection));
  return request(url, method);
}

beforeEach(() => {
  limiterCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("denial pages", () => {
  it("renders the /x/ card: heading and body only, no mark, one shared <style>", () => {
    expect(frameDeniedPage).toContain(`<h1>${FRAME_DENIED_HEADING}</h1>`);
    expect(frameDeniedPage).toContain("<h1>This file can't be shown right now</h1>");
    expect(frameDeniedPage).toContain(`<p>${FRAME_DENIED_BODY}</p>`);
    expect(frameDeniedPage).toContain("<title>File not available · Waypoint</title>");
    expect(frameDeniedPage).not.toMatch(forbiddenTags);
    expect(frameDeniedPage).not.toMatch(forbiddenAttributes);
    expect(frameDeniedPage).not.toContain('class="mark"');
    expect(frameDeniedPage.match(/<style>[^<]*<\/style>/g)).toEqual([
      `<style>${staticCss}</style>`,
    ]);
  });
  it("renders the /s/ page with the new title and three next steps", () => {
    expect(deniedPage).toContain("<title>Link not available · Waypoint</title>");
    expect(deniedPage).toContain("<h1>This link isn't available</h1>");
    expect(deniedPage).toContain(
      "<p>It may have expired or been turned off by the person who shared it, or the address may be incomplete.</p>",
    );
    expect([...deniedPage.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1])).toEqual([
      "<span><b>Check the whole link.</b> Shared links are long, and chat apps sometimes cut them off or wrap them onto two lines.</span>",
      "<span><b>Opened several links that didn't work?</b> Wait a minute, then open yours again.</span>",
      "<span><b>Still not working?</b> Ask the person who shared it for a new link. Waypoint can't tell you why a link stopped working.</span>",
    ]);
    // role="list": Safari drops list semantics from a list-style:none list without it.
    expect(deniedPage).toContain('<ul class="steps" role="list">');
    expect(deniedPage).not.toContain('class="note"');
    expect(deniedPage).not.toMatch(forbiddenTags);
    expect(deniedPage).not.toMatch(forbiddenAttributes);
    expect(deniedPage.match(/<style>[^<]*<\/style>/g)).toEqual([`<style>${staticCss}</style>`]);
  });
  it("keeps the root page on the same stylesheet", () => {
    expect(rootPage.match(/<style>[^<]*<\/style>/g)).toEqual([`<style>${staticCss}</style>`]);
  });
  it("builds every denial through deniedFor() in app.ts", () => {
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(source.match(/\bdenied\(\)/g)).toHaveLength(1);
    expect(source.match(/\bframeDenied\(\)/g)).toHaveLength(1);
    expect(source).toMatch(
      /const deniedFor = \(path: string\): Response =>\s*\(?path\.startsWith\("\/x\/"\) \? frameDenied\(\) : denied\(\)\)?;/,
    );
  });
});

type Case = { name: string; run: (method: string) => Promise<Response>; method?: string };
/** A case that sends `url` to a fresh app (an empty lookup cache) built with `options`. */
const plain =
  (url: () => string | Promise<string>, options?: Options) =>
  async (method: string): Promise<Response> =>
    fixture(options)(await url(), method);
const raw = (path = "index.html", revision = firstPub) => rawUrl(revision, path);
const shell = (path?: string, revision?: string) => () =>
  shareShellUrl(base, token, collection, revision, path);

describe("denials per route family", () => {
  it("serves the /x/ card framable by the shell, with the /s/ denial's header names", async () => {
    const request = fixture();
    const card = await request(tamper(await rawUrl(firstPub, "index.html")));
    expect(card.status).toBe(404);
    expect(card.headers.get("content-security-policy")).toBe(framePolicy);
    expect(card.headers.get("cache-control")).toBe("no-store");
    expect(card.headers.get("x-frame-options")).toBeNull();
    expect(await card.text()).toBe(frameDeniedPage);
    const page = await request(shareShellUrl(base, newShareToken(), collection));
    expect([...card.headers.keys()].toSorted()).toEqual([...page.headers.keys()].toSorted());
    expect(page.headers.get("content-security-policy")).toBe(
      framePolicy.replace("frame-ancestors 'self'", "frame-ancestors 'none'"),
    );
  });

  const xCases: Case[] = [
    { name: "/x/", run: plain(() => `${base}/x/`) },
    { name: "/x/foo", run: plain(() => `${base}/x/foo`) },
    { name: "tampered capability", run: plain(async () => tamper(await raw())) },
    { name: "wrong revision", run: plain(() => raw("index.html", otherPub)) },
    { name: "revoked", run: plain(() => raw(), { revoked: true }) },
    { name: "expired", run: plain(() => raw(), { expired: true }) },
    { name: "tombstoned", run: plain(() => raw(), { tombstoned: true }) },
    { name: "missing path", run: plain(() => raw("missing.html")) },
    { name: "R2 throws", run: plain(() => raw(), { blob: "throw" }) },
    { name: "R2 404", run: plain(() => raw(), { blob: "404" }) },
    { name: "DB failure", run: plain(() => raw(), { lookupThrows: true }) },
    { name: "blocked IP", run: async (method) => blockedThen(await raw(), method) },
    { name: "onError", run: plain(() => raw(), { revisionsThrow: true }) },
  ];
  const sCases: Case[] = [
    { name: "unknown token", run: plain(() => shareShellUrl(base, newShareToken(), collection)) },
    { name: "wrong revision", run: plain(shell(undefined, otherPub)) },
    { name: "revoked", run: plain(shell(), { revoked: true }) },
    { name: "expired", run: plain(shell(), { expired: true }) },
    { name: "tombstoned", run: plain(shell(), { tombstoned: true }) },
    { name: "missing path", run: plain(shell("missing.html")) },
    { name: "DB failure", run: plain(shell(), { lookupThrows: true }) },
    { name: "blocked IP", run: (method) => blockedThen(shell()(), method) },
    { name: "onError", run: plain(shell(), { revisionsThrow: true }) },
    ...["/index.html", "/s", "/s/", "/x", `/X/${linkId}.${"A".repeat(22)}/r/${firstPub}/a`].map(
      (path) => ({ name: path, run: plain(() => `${base}${path}`) }),
    ),
    { name: "/favicon.ico", run: plain(() => `${base}/favicon.ico`) },
    { name: "POST /", run: plain(() => `${base}/`), method: "POST" },
    {
      name: "/healthz/deep over the limit",
      run: plain(() => `${base}/healthz/deep`, { overLimit: true }),
    },
    { name: "/healthz/deep blocked", run: (method) => blockedThen(`${base}/healthz/deep`, method) },
  ];
  for (const [family, cases, page] of [
    ["/x/", xCases, frameDeniedPage],
    ["/s/", sCases, deniedPage],
  ] as const)
    it(`returns one identical ${family} denial for every reason, on GET and HEAD`, async () => {
      const reference = await cases[0]!.run("GET");
      const headers = [...reference.headers];
      for (const method of ["GET", "HEAD"])
        for (const item of cases) {
          const sent = item.method ?? method;
          const response = await item.run(sent);
          expect({
            case: `${sent} ${item.name}`,
            status: response.status,
            body: await response.text(),
            headers: [...response.headers],
          }).toEqual({
            case: `${sent} ${item.name}`,
            status: 404,
            body: sent === "HEAD" ? "" : page,
            headers,
          });
        }
    });

  it("counts each deny() once toward the limiter, for both families, and never while blocked", async () => {
    const request = fixture();
    await request(tamper(await raw())); // deny: 1
    await request(shareShellUrl(base, newShareToken(), collection)); // deny: 2
    await request(`${base}/x/foo`); // deny: 3
    await request(`${base}/s/`); // deny: 4
    await request(`${base}/index.html`); // notFound: not counted
    await request(`${base}/`, "POST"); // notFound: not counted
    expect(limiterCalls).toBe(4);
    await fixture({ revisionsThrow: true })(await raw()); // onError on /x/: deny, 5
    expect(limiterCalls).toBe(5);
    const limited = fixture({ overLimit: true });
    await limited(await raw("missing.html")); // deny, then blocked: 6
    expect(limiterCalls).toBe(6);
    expect((await limited(await raw())).status).toBe(404); // blocked: not counted
    expect(await (await limited(shell()())).text()).toBe(deniedPage); // blocked: not counted
    expect(limiterCalls).toBe(6);
  });
});
