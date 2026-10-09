// RX-11: a Latest link whose collection has a newer revision still syncing shows a calm pending
// note under the meta row (a short pill in the meta row on phones); snapshots never do.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import {
  assert,
  collectConsole,
  cspProblems,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const HOUR = 3_600_000;
const HASH = "sha256:" + "2".repeat(64);
const COL = { id: "col_" + "y".repeat(26), pub: "yyyyyyyyyyyy" };
const REV = { id: "rev_" + "0".repeat(25) + "y", pub: "y1y1y1y1y1y1" };
const SENTENCE = "A newer version is being synced. It will appear here once it has uploaded.";

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
/** A JSON array result, as a list of values. */
async function list(page: Page, expression: string): Promise<unknown[]> {
  const value = await json(page, expression);
  if (!Array.isArray(value)) throw new Error(`${expression} is not an array`);
  return value.map((item: unknown) => item);
}
const style = (page: Page, selector: string, property: string): Promise<unknown> =>
  page.evaluate(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${property}`,
  );
/** A colour as computed through a probe element (CSSOM is allowed under the CSP). */
const colour = async (page: Page, value: string): Promise<string> =>
  String(
    await page.evaluate(`(() => { const p = document.createElement("span");
      p.style.forcedColorAdjust = "none"; p.style.color = ${JSON.stringify(value)};
      document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`),
  );
async function open(page: Page, href: string): Promise<void> {
  const response = await page.goto(href);
  assert.equal(response?.status(), 200, `loads ${href}`);
}
/** The box's fill, border and text use the pending role's tokens. */
async function pendingColours(page: Page, scheme: string): Promise<void> {
  const [background, border, text] = (
    await list(
      page,
      `(() => { const s = getComputedStyle(document.querySelector(".sync"));
      return [s.backgroundColor, s.borderTopColor, s.color]; })()`,
    )
  ).map(String);
  assert.equal(background, await colour(page, "var(--pending-bg)"), `${scheme}: pending fill`);
  assert.equal(border, await colour(page, "var(--pending-line)"), `${scheme}: pending border`);
  assert.equal(text, await colour(page, "var(--pending)"), `${scheme}: pending text`);
}

const scenario: ReaderScenario = {
  name: "RX-11 syncing note on Latest links: box on desktop, pill on phones, none on snapshots",
  async run(ctx) {
    const now = Date.now();
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Postgres 17 upgrade runbook",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,?)",
      REV.id,
      REV.pub,
      COL.id,
      "runbook.md",
      now - 2 * HOUR,
    );
    for (const path of ["runbook.md", "extensions.md", "rollback.md"])
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
        REV.id,
        path,
        HASH,
        "text/markdown",
      );
    ins(
      "INSERT INTO collection_syncing (collection_id,since,until) VALUES (?,?,?)",
      COL.id,
      now - 60_000,
      now + HOUR,
    );
    let n = 0;
    const link = async (rev: string | null) => {
      const token = newShareToken();
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,1)",
        "shl_" + String(++n).padStart(26, "y"),
        await hashShareToken(token),
        COL.id,
        rev,
        null,
        null,
        null,
      );
      return token;
    };
    const following = await link(null);
    const pinned = await link(REV.id);
    const reader = await startReader({
      db,
      blob: () => new Response("# Postgres 17 upgrade runbook\n\nThe document.\n"),
    });
    const url = `${reader.origin}/s/${following}/c/${COL.pub}/`;
    const pinnedUrl = `${reader.origin}/s/${pinned}/c/${COL.pub}/r/${REV.pub}/`;
    const logs: string[][] = [];

    // Desktop, light: the box under the meta row; the phone pill is hidden.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme: "light" });
      logs.push(collectConsole(page));
      await open(page, url);
      const sync = page.locator(".sync");
      assert.ok(await sync.isVisible(), ".sync is visible");
      assert.equal((await sync.innerText()).replace(/\s+/g, " ").trim(), SENTENCE);
      assert.equal(await page.locator(".sync svg").count(), 1, "the clock icon");
      await pendingColours(page, "light");
      assert.equal(await style(page, ".pend", "display"), "none", ".pend is hidden");
      const [syncTop, noteBottom] = (
        await list(
          page,
          `[document.querySelector(".sync").getBoundingClientRect().top,
          document.querySelector(".note").getBoundingClientRect().bottom]`,
        )
      ).map(Number);
      assert.ok(syncTop! >= noteBottom!, `.sync (${syncTop}) is below .note (${noteBottom})`);
    }

    // Desktop, dark: the dark pending tokens.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme: "dark" });
      logs.push(collectConsole(page));
      await open(page, url);
      assert.equal(await page.evaluate(`matchMedia("(prefers-color-scheme: dark)").matches`), true);
      assert.ok(await page.locator(".sync").isVisible());
      await pendingColours(page, "dark");
    }

    // Phone: the box is gone; the meta row ends with the pill, which says the whole sentence to
    // assistive technology; nothing scrolls sideways.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      logs.push(collectConsole(page));
      await open(page, url);
      assert.equal(await style(page, ".sync", "display"), "none", ".sync is hidden");
      const pend = page.locator(".pend");
      assert.ok(await pend.isVisible(), ".pend is visible");
      assert.equal(
        String(
          await page.evaluate(`(() => { const p = document.querySelector(".pend");
            return p.innerText.replace(p.querySelector(".vh").innerText, "").trim(); })()`),
        ),
        "Newer version syncing",
      );
      assert.equal(await page.locator(".pend svg").count(), 1, "the clock icon");
      const tree = await page.locator("header.lh").ariaSnapshot();
      assert.ok(
        tree
          .replace(/\s+/g, " ")
          .includes(`Newer version syncing. It will appear here once it has uploaded.`),
        `the accessibility tree has the sentence: ${tree}`,
      );
      assert.ok(
        Number(await page.evaluate("document.scrollingElement.scrollWidth")) <= 390,
        "no horizontal scroll",
      );
      assert.ok(
        Number(await page.evaluate(`document.querySelector("header.lh").scrollWidth`)) <= 390,
        "the letterhead doesn't overflow",
      );
    }

    // Pinned links never show either form.
    for (const viewport of [VIEWPORTS.desktop, { ...VIEWPORTS.phone, mobile: true }]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, one after the other.
      const { page } = await ctx.newPage(viewport);
      logs.push(collectConsole(page));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, one after the other.
      await open(page, pinnedUrl);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, one after the other.
      assert.equal(await page.locator(".sync, .pend").count(), 0, "no note on a snapshot");
    }

    // Forced colours: the box keeps a visible CanvasText border.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
      logs.push(collectConsole(page));
      await open(page, url);
      assert.equal(
        await style(page, ".sync", "borderTopColor"),
        await colour(page, "CanvasText"),
        "the border is CanvasText",
      );
      assert.ok(await page.locator(".sync svg").isVisible(), "the icon is visible");
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
