// State shared by the baseline scenarios 00–04 (not by item scenarios): a hostile collection
// served by the reader app from source, a second origin, and one page the scenarios drive in
// turn. Ported from the feat/ui-folio-reader security review.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Frame, Page } from "playwright";

import {
  assert,
  onCleanup,
  rawCap,
  readerTestDb,
  startHttpServer,
  startReader,
  type ReaderContext,
} from "../harness.ts";

export const COL = { id: "col_" + "a".repeat(26), pub: "aaaaaaaaaaaa" };
export const REV = { id: "rev_" + "0".repeat(25) + "1", pub: "a1a1a1a1a1a1" };
export const LINK = "shl_" + "0".repeat(25) + "1";
export const FILES = [
  "index.html",
  "other.html",
  "a/b.html",
  "sp ace.html",
  `q"'<x>.html`,
  "bin.dat",
];

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (target: Page | Frame, expression: string): Promise<unknown> =>
  JSON.parse(String(await target.evaluate(`JSON.stringify(${expression})`)));
const message = (href: string) => ({ type: "waypoint:location", href });

export interface ReaderFixture {
  token: string;
  cap: string;
  evilPort: number;
  origin: string;
  shellBase: string;
  frameBase: string;
  rel: string;
  /** The Referer header of every request the reader served. */
  referers: readonly string[];
  findFrame: (page: Page) => Frame;
  json: (target: Page | Frame, expression: string) => Promise<unknown>;
  message: (href: string) => { type: string; href: string };
  state: string;
  page: Page;
  log: string[];
}

let fixtureState: Promise<ReaderFixture> | undefined;
/** Seeds the hostile collection, starts the servers and opens the shared page, once per run. */
export function fixture(ctx: ReaderContext): Promise<ReaderFixture> {
  fixtureState ??= seed(ctx);
  return fixtureState;
}

async function seed(ctx: ReaderContext): Promise<ReaderFixture> {
  const token = newShareToken();
  const cap = rawCap(LINK, REV.pub);

  const db = readerTestDb();
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
  const evilServer = await startHttpServer((req, res) => {
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
  const evilPort = evilServer.port;

  const reader = await startReader({ db, blob: () => new Response(evilDoc) });
  const origin = reader.origin;
  const shellBase = `${origin}/s/${token}/c/${COL.pub}/`;
  const frameBase = `${origin}/x/${LINK}.${cap}/r/${REV.pub}/`;
  const rel = new URL(frameBase).pathname;

  const findFrame = (page: Page): Frame => {
    const frame = page.frames().find((f) => f.url().startsWith(frameBase));
    assert.ok(frame, "frame loaded");
    return frame;
  };
  const state = `({ path: decodeURIComponent(location.pathname.split("/").slice(5).join("/")),
  current: [...document.querySelectorAll("a[aria-current]")].map((a) => a.getAttribute("data-p")) })`;

  // Opened directly, not through ctx.newPage: the runner closes those after each scenario, and
  // this page lives through 00–04. Its errors only matter through the `log` checks.
  const context = await ctx.browser.newContext();
  onCleanup(() => context.close());
  const page = await context.newPage();
  const log: string[] = [];
  page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));

  return {
    token,
    cap,
    evilPort,
    origin,
    shellBase,
    frameBase,
    rel,
    referers: reader.referers,
    findFrame,
    json,
    message,
    state,
    page,
    log,
  };
}
