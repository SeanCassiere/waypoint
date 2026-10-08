// RX-07: one fixed denial per route family. A denied file inside the shell's frame shows the
// `/x/` card (framable by the shell only), and a denied share link shows the full page with three
// next steps.
import { hashShareToken, newShareToken } from "@waypoint/core";
import { FRAME_DENIED_BODY, FRAME_DENIED_HEADING } from "@waypoint/ui";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startHttpServer,
  startReader,
  type ReaderScenario,
} from "../harness.ts";

const COL = { id: "col_" + "b".repeat(26), pub: "bbbbbbbbbbbb" };
const REV = { id: "rev_" + "0".repeat(25) + "7", pub: "b7b7b7b7b7b7" };
const LINK = "shl_" + "0".repeat(25) + "7";
const HASH = "sha256:" + "7".repeat(64);

const scenario: ReaderScenario = {
  name: "RX-07 denial card in the frame, framable only by the shell; /s/ denial page",
  async run(ctx) {
    const token = newShareToken();
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Denial states",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "index.html",
    );
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    ins(
      "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
      REV.id,
      "index.html",
      HASH,
      "text/html",
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
    const reader = await startReader({
      db,
      blob: () => new Response("<!doctype html><title>doc</title><p>The document</p>"),
    });
    const live = `${reader.origin}/x/${LINK}.${rawCap(LINK, REV.pub)}/r/${REV.pub}/index.html`;
    const tampered = live.replace(/\.[A-Za-z0-9_-]{22}\//, `.${"A".repeat(22)}/`);
    assert.notEqual(tampered, live);

    // In the shell's frame: the card renders under the shell, not a browser error page.
    const { page } = await ctx.newPage();
    const log = collectConsole(page);
    await page.goto(`${reader.origin}/s/${token}/c/${COL.pub}/`);
    await page.waitForFunction(
      `[...document.querySelectorAll("iframe")].some((f) => f.src === ${JSON.stringify(live)})`,
    );
    const loaded = page.waitForEvent("framenavigated", (f) => f.url() === tampered);
    await page.evaluate(`document.getElementById("doc").src = ${JSON.stringify(tampered)}`);
    const frame = await loaded;
    await frame.waitForLoadState("load");
    assert.equal(frame.url(), tampered);
    assert.equal((await frame.textContent("h1"))?.trim(), FRAME_DENIED_HEADING);
    assert.equal(FRAME_DENIED_HEADING, "This file can't be shown right now");
    assert.ok((await frame.textContent("body"))?.includes(FRAME_DENIED_BODY));
    assert.equal(await frame.locator(".mark, a, button, input, script").count(), 0);
    // Styled by the static stylesheet (its hash is in the card's CSP).
    assert.equal(
      await frame.evaluate(`getComputedStyle(document.querySelector("main.card")).borderTopStyle`),
      "solid",
    );
    assert.equal((await page.textContent("h1"))?.trim(), "Denial states", "the shell stays");
    assert.deepEqual(cspProblems(log), []);

    // From another origin, `frame-ancestors 'self'` keeps the card out of the frame.
    const other = await startHttpServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><iframe src="${tampered}"></iframe>`);
    });
    const { page: framing } = await ctx.newPage();
    await framing.goto(`${other.origin}/`);
    const outer = await (await framing.waitForSelector("iframe")).contentFrame();
    assert.ok(outer, "the framing page has its frame");
    await framing.waitForLoadState("load");
    // Wait for the frame's navigation to settle, so an empty, not-yet-navigated frame can't pass.
    for (let i = 0; i < 50 && !outer.url().startsWith("chrome-error://"); i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls one frame's URL until it settles.
      await framing.waitForTimeout(100);
    }
    assert.ok(
      outer.url().startsWith("chrome-error://"),
      `the card must not render in a foreign frame (${outer.url()})`,
    );

    // A denied share link, top level: the full page with three next steps and nothing to click.
    const { page: denied } = await ctx.newPage();
    const response = await denied.goto(`${reader.origin}/s/${newShareToken()}/c/${COL.pub}/`);
    assert.equal(response?.status(), 404);
    assert.equal(await denied.title(), "Link not available · Waypoint");
    assert.equal((await denied.textContent("h1"))?.trim(), "This link isn't available");
    assert.equal(await denied.locator("li").count(), 3);
    assert.equal(await denied.getByRole("list").getByRole("listitem").count(), 3);
    assert.equal(await denied.locator("a, button, input").count(), 0);
    assert.deepEqual(await denied.locator("li b").allTextContents(), [
      "Check the whole link.",
      "Opened several links that didn't work?",
      "Still not working?",
    ]);
    assert.equal(
      await denied.evaluate(`getComputedStyle(document.querySelector(".steps")).borderTopStyle`),
      "solid",
    );
    // The step bullets stay visible in forced-colours mode (drawn with a border, which maps to
    // CanvasText, not a background, which maps to Canvas).
    await denied.emulateMedia({ forcedColors: "active" });
    const bullet = `getComputedStyle(document.querySelector(".steps li"), "::before")`;
    assert.equal(await denied.evaluate(`${bullet}.borderTopWidth`), "3px");
    assert.notEqual(
      await denied.evaluate(`${bullet}.borderTopColor`),
      await denied.evaluate(`getComputedStyle(document.body).backgroundColor`),
      "forced-colours bullet differs from the page",
    );
  },
};
export default scenario;
