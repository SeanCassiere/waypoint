// D75: the reader's Files tree is ordered and folded like the writer's (D72; the viewer's
// files-tree.ts): folders before files in name order, only the current file's folders open,
// Expand all / Collapse all, and the folders a reader opens kept for the tab in
// sessionStorage["wp:tree:<collection public ID>"], shared by every link to that collection and
// never holding a share token. A document navigating to a file opens its folders without saving
// them. Without script the folders toggle natively and there's no button.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  type ReaderScenario,
} from "../harness.ts";
import { until } from "./_panel-fixture.ts";

const HASH = "sha256:" + "7".repeat(64);
const COL = { id: "col_" + "t".repeat(26), pub: "tttttttttttt" };
const REV = { id: "rev_" + "0".repeat(25) + "t", pub: "t7t7t7t7t7t7" };
const LINKS = ["shl_" + "0".repeat(25) + "t", "shl_" + "0".repeat(25) + "u"] as const;
const FILES = [
  "index.html",
  "Zeta.html",
  "api.html",
  "ch10.html",
  "ch2.html",
  "notes/b.html",
  "notes/A.html",
  "notes/deep/x.html",
  "notes/deep/y.html",
  "Beta/c.html",
  "Beta/d.html",
  "assets/logo.html",
];
const WIDE = { width: 1440, height: 900 } as const;

const strings = z.array(z.string());
/** A folder's path: its row's text joined to its parents' (the script's key for it). */
const DIR = `(d) => { let p = ""; for (let e = d; e; e = e.parentElement.closest("#files details"))
  p = e.querySelector(":scope > summary").textContent + p; return p; }`;
/** The tree's rows in document order: folders as their path, files as their data-p. */
const rows = async (page: Page) =>
  strings.parse(
    await page.evaluate(`[...document.querySelectorAll("#files details, #files a[data-p]")]
      .map((n) => n.tagName === "DETAILS" ? (${DIR})(n) : n.dataset.p)`),
  );
const opened = async (page: Page) =>
  strings.parse(
    await page.evaluate(`[...document.querySelectorAll("#files details[open]")].map(${DIR})`),
  );
/** Waits for the toggle events (a task after each change) to have been handled. */
const settle = (page: Page) => page.evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
const summary = (page: Page, dir: string) =>
  page.locator("#files details > summary").filter({ hasText: new RegExp(`^${dir}$`) });
/** Opens a shell URL and waits for its document frame. */
async function open(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  assert.equal(response?.status(), 200, `loads ${url}`);
  await until(page, `!!document.querySelector("iframe#doc")?.src`);
}
const storage = z.array(z.tuple([z.string(), z.string()]));
const stored = async (page: Page) =>
  storage.parse(
    await page.evaluate(`[localStorage, sessionStorage].flatMap((s) =>
      Object.keys(s).map((k) => [k, String(s.getItem(k))]))`),
  );

const scenario: ReaderScenario = {
  name: "Files tree: writer's order, folded, Expand all, remembered per collection, no token",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Tree fixture",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "index.html",
    );
    for (const path of FILES)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
        REV.id,
        path,
        HASH,
        "text/html",
      );
    // Two links to the same collection: the saved folders follow the collection, not the link.
    const tokens = [newShareToken(), newShareToken()];
    for (const [i, link] of LINKS.entries())
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,NULL,NULL,NULL,1)",
        link,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two links, seeded in order.
        await hashShareToken(tokens[i]!),
        COL.id,
      );
    const reader = await startReader({
      db,
      blob: () => new Response("<!doctype html><title>doc</title><p>A document.</p>"),
    });
    const shells = tokens.map((token) => `${reader.origin}/s/${token}/c/${COL.pub}/`);
    const frameBase = `${reader.origin}/x/${LINKS[0]}.${rawCap(LINKS[0], REV.pub)}/r/${REV.pub}/`;
    const logs: string[][] = [];
    const { page } = await ctx.newPage({ ...WIDE, reducedMotion: "reduce" });
    logs.push(collectConsole(page));

    // The writer's order (D72): head first, then folders before files at every level, by name
    // (case-insensitive, numbers as numbers); a one-file folder shows as its file, among them.
    await open(page, shells[0]!);
    assert.deepEqual(await rows(page), [
      "index.html",
      "assets/logo.html",
      "Beta/",
      "Beta/c.html",
      "Beta/d.html",
      "notes/",
      "notes/deep/",
      "notes/deep/x.html",
      "notes/deep/y.html",
      "notes/A.html",
      "notes/b.html",
      "api.html",
      "ch2.html",
      "ch10.html",
      "Zeta.html",
    ]);
    assert.equal(await page.getAttribute("#shell", "data-collection"), COL.pub);
    assert.deepEqual(await opened(page), [], "every folder starts collapsed at the head");
    const all = page.locator("#files [data-tree-all]");
    assert.equal(await all.textContent(), "Expand all");
    assert.ok(await all.isVisible(), "script shows Expand all");

    // Expand all opens every folder and turns into Collapse all; a hand toggle flips it back.
    await all.click();
    await settle(page);
    assert.deepEqual(await opened(page), ["Beta/", "notes/", "notes/deep/"]);
    assert.equal(await all.textContent(), "Collapse all");
    await summary(page, "Beta/").click();
    await settle(page);
    assert.equal(await all.textContent(), "Expand all");
    await all.click();
    await all.click();
    await settle(page);
    assert.deepEqual(await opened(page), [], "Collapse all closes every folder");

    // A file's page opens only its folders.
    await open(page, `${shells[0]}notes/deep/x.html`);
    assert.deepEqual(await opened(page), ["notes/", "notes/deep/"]);
    await open(page, shells[0]!);
    assert.deepEqual(await opened(page), [], "folders opened for a file aren't kept");

    // The document navigating to a file opens its folders and shows the row, without keeping them.
    const frame = page.frames().find((f) => f.url().startsWith(frameBase));
    assert.ok(frame, "frame loaded");
    const href = `${frameBase}notes/deep/y.html`;
    await frame.evaluate(
      `parent.postMessage(${JSON.stringify({ type: "waypoint:location", href })}, "*")`,
    );
    await until(page, `location.pathname.endsWith("/notes/deep/y.html")`);
    await settle(page);
    assert.deepEqual(await opened(page), ["notes/", "notes/deep/"]);
    assert.ok(await page.locator('#files a[aria-current="page"]').isVisible());
    await open(page, shells[0]!);
    assert.deepEqual(await opened(page), []);

    // Remembered for the tab: a folder opened by hand is still open on the next page, and after
    // Collapse all nothing reopens; Enter on a folder row counts too.
    await summary(page, "Beta/").click();
    await settle(page);
    await open(page, `${shells[0]}api.html`);
    assert.deepEqual(await opened(page), ["Beta/"]);
    await all.click();
    await all.click();
    await settle(page);
    await open(page, shells[0]!);
    assert.deepEqual(await opened(page), []);
    await summary(page, "Beta/").press("Enter");
    await settle(page);
    await open(page, shells[0]!);
    assert.deepEqual(await opened(page), ["Beta/"]);
    // A saved folder doesn't close the current file's folders.
    await open(page, `${shells[0]}notes/deep/x.html`);
    assert.deepEqual(await opened(page), ["Beta/", "notes/", "notes/deep/"]);
    // Another link to the same collection, in the same tab, shares them.
    await open(page, shells[1]!);
    assert.deepEqual(await opened(page), ["Beta/"], "kept per collection, not per link");

    // Storage: the collection's public ID names the entry; no key or value holds a share token
    // or a link's ID.
    const entries = await stored(page);
    for (const [key, value] of entries)
      for (const secret of [...tokens, ...LINKS])
        assert.ok(!key.includes(secret) && !value.includes(secret), `${key}=${value}`);
    assert.deepEqual(
      entries.filter(([key]) => key.startsWith("wp:tree:")),
      [[`wp:tree:${COL.pub}`, '["Beta/"]']],
    );

    // A new tab starts collapsed.
    const fresh = await ctx.newPage(WIDE);
    logs.push(collectConsole(fresh.page));
    await open(fresh.page, shells[0]!);
    assert.deepEqual(await opened(fresh.page), []);

    // On a phone the sheet opens on the current row with its folders open.
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `${shells[0]}notes/A.html`);
    await page.click(".ptog");
    assert.ok(
      await page.evaluate(`document.activeElement?.getAttribute("data-p") === "notes/A.html"`),
      "focus on the current row",
    );
    assert.ok(await all.isVisible(), "Expand all in the sheet");

    // Without script the folders still toggle natively, and there's no button.
    const plain = await ctx.browser.newContext({ viewport: WIDE, javaScriptEnabled: false });
    try {
      const nojs = await plain.newPage();
      logs.push(collectConsole(nojs));
      await nojs.goto(shells[0]!);
      assert.equal(await nojs.locator("#files [data-tree-all]").isVisible(), false);
      assert.equal(await nojs.locator('#files a[data-p="notes/A.html"]').isVisible(), false);
      await summary(nojs, "notes/").click();
      assert.ok(await nojs.locator('#files a[data-p="notes/A.html"]').isVisible());
    } finally {
      await plain.close();
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
