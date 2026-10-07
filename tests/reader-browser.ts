// Real-Chromium checks for the public reader shell: CSP, the frame-location listener, token
// exposure, sandbox escapes and COOP. Ported from the feat/ui-folio-reader security review.
// Run after `pnpm build`: node --experimental-strip-types tests/reader-browser.ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";

import { serve } from "@hono/node-server";
import { chromium, type Frame, type Page } from "playwright";

import { createReaderApp, type ReaderEnv } from "../apps/reader/dist/app.js";
import { waypointMigrations } from "../apps/writer/dist/migrations.js";
import { hashShareToken, newShareToken } from "../packages/core/dist/index.js";

const env: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const COL = { id: "col_" + "a".repeat(26), pub: "aaaaaaaaaaaa" };
const REV = { id: "rev_" + "0".repeat(25) + "1", pub: "a1a1a1a1a1a1" };
const LINK = "shl_" + "0".repeat(25) + "1";
const token = newShareToken();
const cap = createHmac("sha256", Buffer.alloc(32))
  .update(`${LINK}\n${REV.pub}`)
  .digest("base64url")
  .slice(0, 22);
const FILES = ["index.html", "other.html", "a/b.html", "sp ace.html", `q"'<x>.html`, "bin.dat"];

const db = new DatabaseSync(":memory:");
for (const m of waypointMigrations) db.exec(m.sql);
const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
ins(
  "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
  COL.id,
  COL.pub,
  `Evil </title><script>window.pwned=1</script>‮Title "'`,
);
ins(
  "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,?)",
  REV.id,
  REV.pub,
  COL.id,
  "index.html",
  Date.UTC(2026, 9, 7, 22, 8),
);
ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", "sha256:" + "1".repeat(64));
for (const path of FILES)
  ins(
    "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
    REV.id,
    path,
    "sha256:" + "1".repeat(64),
    path.endsWith(".dat") ? "application/octet-stream" : "text/html",
  );
ins(
  "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
  LINK,
  await hashShareToken(token),
  COL.id,
  null,
  null,
  null,
);

// Every raw file is this hostile document: it records what it can learn about its parent.
const evilDoc = `<!doctype html><meta charset=utf-8><body>doc<script>
window.probe = { referrer: document.referrer, name: window.name, ownHref: location.href };
try { window.probe.topHref = top.location.href } catch (e) { window.probe.topHref = "blocked" }
try { window.probe.parentDoc = String(parent.document.URL) } catch (e) { window.probe.parentDoc = "blocked" }
</script>`;
const evilServer: Server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url?.startsWith("/popup")) {
    res.end(`<script>
      const r = { opener: !!opener };
      try { opener.top.location.href = "/tabnabbed"; r.nav = "attempted" } catch (e) { r.nav = "blocked" }
      document.title = JSON.stringify(r);
    </script>`);
    return;
  }
  res.end(`<title>evil</title>referer=${req.headers.referer ?? ""}`);
});
const portOf = (address: ReturnType<Server["address"]>): number => {
  if (!address || typeof address === "string") throw new Error("Server has no port");
  return address.port;
};
await new Promise<void>((resolve) => evilServer.listen(0, "127.0.0.1", resolve));
const evilPort = portOf(evilServer.address());

const app = createReaderApp({
  db: () => ({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    all: (sql, args = []) => Promise.resolve(db.prepare(sql).all(...args) as never),
  }),
  blob: () => ({
    probe: () => Promise.resolve(new Response("ok")),
    fetch: () => Promise.resolve(new Response(evilDoc)),
  }),
});
const referers: string[] = [];
const server = serve({
  fetch: (req) => {
    referers.push(req.headers.get("referer") ?? "");
    return app.fetch(req, env);
  },
  port: 0,
  hostname: "127.0.0.1",
});
await new Promise((resolve) => setTimeout(resolve, 200));
const origin = `http://127.0.0.1:${portOf(server.address())}`;
const shellBase = `${origin}/s/${token}/c/${COL.pub}/`;
const frameBase = `${origin}/x/${LINK}.${cap}/r/${REV.pub}/`;
const rel = new URL(frameBase).pathname;

const findFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.url().startsWith(frameBase));
  assert.ok(frame, "frame loaded");
  return frame;
};
// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (target: Page | Frame, expression: string): Promise<unknown> =>
  JSON.parse(String(await target.evaluate(`JSON.stringify(${expression})`)));
const message = (href: string) => ({ type: "waypoint:location", href });
const state = `({ path: decodeURIComponent(location.pathname.split("/").slice(5).join("/")),
  current: [...document.querySelectorAll("a[aria-current]")].map((a) => a.getAttribute("data-p")) })`;

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const log: string[] = [];
  page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  await page.goto(shellBase);
  await page.waitForTimeout(300);
  const frame = findFrame(page);

  // CSP: the shell's own script ran, injected markup didn't, nothing was refused.
  assert.doesNotMatch((await page.textContent("time")) ?? "", /UTC$/);
  assert.equal(await json(page, `"pwned" in window`), false);
  assert.equal(
    await page.textContent("h1"),
    `Evil </title><script>window.pwned=1</script>�Title "'`,
  );
  assert.deepEqual(
    log.filter((l) => /Content Security Policy|Refused|pageerror/i.test(l)),
    [],
  );
  assert.deepEqual(
    await json(
      page,
      `["sandbox", "referrerpolicy"].map((a) => document.getElementById("doc").getAttribute(a))`,
    ),
    ["allow-scripts allow-popups allow-popups-to-escape-sandbox", "no-referrer"],
  );
  // No rendered URL carries the share token (links are relative to the page itself).
  const urls = await json(
    page,
    `[...document.querySelectorAll("[href],[src]")].map((e) => e.getAttribute("href") ?? e.getAttribute("src"))`,
  );
  assert.ok(Array.isArray(urls) && urls.length >= FILES.length);
  assert.ok(!JSON.stringify(urls).includes(token));
  // The document is in an opaque origin and learns nothing about the shell.
  const probe = await json(frame, "window.probe");
  assert.deepEqual(
    { ...(probe && typeof probe === "object" ? probe : {}), ownHref: "" },
    { referrer: "", name: "", ownHref: "", topHref: "blocked", parentDoc: "blocked" },
  );
  assert.ok(!JSON.stringify(probe).includes(token));

  // Frame-location messages, posted from the frame's own window.
  const post = async (data: unknown): Promise<unknown> => {
    await page.goto(shellBase);
    await page.waitForTimeout(150);
    await findFrame(page).evaluate(`parent.postMessage(${JSON.stringify(data)}, "*")`);
    await page.waitForTimeout(100);
    return json(page, state);
  };
  const accepted: [unknown, string][] = [
    [message("other.html"), "other.html"],
    [message(`${rel}a/b.html#x`), "a/b.html"],
    [message(`${rel}q%22'%3Cx%3E.html`), `q"'<x>.html`],
    [message(`${rel}sp%20ace.html`), "sp ace.html"],
    [message(`${rel}x/../other.html`), "other.html"],
  ];
  for (const [data, path] of accepted)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each case reloads the shell.
    assert.deepEqual(await post(data), { path, current: [path] }, JSON.stringify(data));
  const ignored: unknown[] = [
    message(rel.replace(REV.pub, REV.pub + "X") + "other.html"),
    message(rel.replace(cap, cap.slice(0, -1) + "Z") + "other.html"),
    message(`${rel}../../other.html`),
    message(`${rel}%2e%2e/%2e%2e/other.html`),
    message(`${rel}a%2Fb.html`),
    message(`${rel}a%5Cb.html`),
    message(`http://127.0.0.1:${evilPort}${rel}other.html`),
    message(`//evil.example${rel}other.html`),
    message("javascript:alert(1)//other.html"),
    message(`blob:${origin}${rel}other.html`),
    message(`${rel}secret.html`),
    message(`/s/${token}/c/${COL.pub}/other.html`),
    message(`${rel}%E0%A4%A.html`),
    { type: "waypoint:locationX", href: "other.html" },
    "waypoint:location",
    message("other.html#" + "x".repeat(9000)),
  ];
  for (const data of ignored)
    assert.deepEqual(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each case reloads the shell.
      await post(data),
      { path: "", current: ["index.html"] },
      JSON.stringify(data).slice(0, 120),
    );

  // A nested frame inside the document is not the shell's frame window.
  await page.goto(shellBase);
  await page.waitForTimeout(150);
  await findFrame(page).evaluate(`new Promise((resolve) => {
    const inner = document.createElement("iframe");
    inner.srcdoc = '<script>top.postMessage({type:"waypoint:location",href:"other.html"},"*")</scr' + 'ipt>';
    inner.addEventListener("load", () => setTimeout(resolve, 100));
    document.body.append(inner);
  })`);
  await page.waitForTimeout(100);
  assert.equal(page.url(), shellBase);

  // The sandboxed document can't navigate the shell.
  await findFrame(page).evaluate(
    `try { top.location.href = ${JSON.stringify(`http://127.0.0.1:${evilPort}/topnav`)} } catch {}`,
  );
  await page.waitForTimeout(300);
  assert.equal(page.url(), shellBase);

  // A document that navigates its own frame away sends no referrer.
  await page.goto(shellBase);
  await page.waitForTimeout(150);
  await findFrame(page).evaluate(
    `location.href = ${JSON.stringify(`http://127.0.0.1:${evilPort}/framenav`)}`,
  );
  await page.waitForTimeout(300);
  const navigated = page.frames()[1];
  assert.ok(navigated);
  assert.equal(await json(navigated, "document.referrer"), "");

  // A popup that escapes the sandbox gets no opener to the shell (COOP: same-origin).
  {
    const popupContext = await browser.newContext();
    const shell = await popupContext.newPage();
    await shell.goto(shellBase);
    await shell.waitForTimeout(200);
    const popupPromise = popupContext.waitForEvent("page");
    await findFrame(shell).evaluate(
      `open(${JSON.stringify(`http://127.0.0.1:${evilPort}/popup`)})`,
    );
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await shell.waitForTimeout(500);
    assert.deepEqual(JSON.parse(await popup.title()) as unknown, { opener: false, nav: "blocked" });
    assert.equal(shell.url(), shellBase);
    await popupContext.close();
  }

  // The download card links to the capability URL, never the token.
  await page.goto(`${shellBase}bin.dat`);
  const download = (await page.getAttribute("#doc", "href")) ?? "";
  assert.ok(download.startsWith(`${frameBase}bin.dat`));
  assert.ok(!download.includes(token));
} finally {
  await browser.close();
  server.close();
  evilServer.close();
}
assert.deepEqual(
  referers.filter((r) => r.includes(token)),
  [],
);
console.log("reader browser checks passed");
