// A11Y-07 (D74): from 1100 px the reader's Files panel is docked beside the document; below that
// it's a light-dismiss popover (a side sheet, a bottom sheet on phones, over a tinted scrim) that
// opens on the current file and gives focus back to the Files button. The banner spans the window.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import {
  assert,
  axe,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const HASH = "sha256:" + "7".repeat(64);
const FIXTURES = {
  // T: 12 files, the Files tree.
  tree: {
    title: "Files popover",
    col: { id: "col_" + "f".repeat(26), pub: "ffffffffffff" },
    rev: { id: "rev_" + "0".repeat(25) + "7", pub: "f7f7f7f7f7f7" },
    link: "shl_" + "0".repeat(25) + "7",
    files: [
      "index.html",
      ..."abcdefgh".split("").map((c) => `${c}.html`),
      "sub/x.html",
      "sub/y.html",
      "sub/z.html",
    ],
  },
} as const;
type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES];

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
const rect = async (page: Page, selector: string): Promise<Rect> => {
  const value = await json(
    page,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return [r.top, r.bottom, r.left, r.right, r.width, r.height]; })()`,
  );
  assert.ok(Array.isArray(value) && value.length === 6, `${selector} has a box`);
  const [top, bottom, left, right, width, height] = value.map(Number);
  return { top: top!, bottom: bottom!, left: left!, right: right!, width: width!, height: height! };
};
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);
const OPEN = `document.getElementById("files").matches(":popover-open")`;
const isOpen = async (page: Page) => (await page.evaluate(OPEN)) === true;
const active = (page: Page, selector: string) =>
  page.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`);
const autofocused = async (page: Page) =>
  json(page, `[...document.querySelectorAll("[autofocus]")].map((a) => a.dataset.p)`);
/** Polls a page expression from Node: the shell's CSP blocks Playwright's in-page polling. */
async function until(page: Page, expression: string, timeout = 5000): Promise<void> {
  const start = performance.now();
  // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
  while ((await page.evaluate(expression)) !== true) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${expression}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const NESTED =
  "button a, button button, a a, a button, button [tabindex], a [tabindex], summary a, summary button";

const scenario: ReaderScenario = {
  name: "A11Y-07 docked Files panel, side and bottom sheets, focus contract, row layout",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    const tokens = new Map<Fixture, string>();
    for (const f of Object.values(FIXTURES)) {
      const token = newShareToken();
      tokens.set(f, token);
      ins(
        "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
        f.col.id,
        f.col.pub,
        f.title,
      );
      ins(
        "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
        f.rev.id,
        f.rev.pub,
        f.col.id,
        "index.html",
      );
      for (const path of f.files)
        ins(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
          f.rev.id,
          path,
          HASH,
          "text/html",
        );
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
        f.link,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Fixtures are seeded in order.
        await hashShareToken(token),
        f.col.id,
        null,
        null,
        null,
      );
    }
    const reader = await startReader({
      db,
      blob: () => new Response("<!doctype html><title>doc</title><p>The document</p>"),
    });
    const shellBase = (f: Fixture) => `${reader.origin}/s/${tokens.get(f)}/c/${f.col.pub}/`;
    const frameBase = (f: Fixture) =>
      `${reader.origin}/x/${f.link}.${rawCap(f.link, f.rev.pub)}/r/${f.rev.pub}/`;
    const logs: string[][] = [];
    const open = async (page: Page, f: Fixture, path = "") => {
      const response = await page.goto(shellBase(f) + path);
      assert.equal(response?.status(), 200, `loads ${path || "the head"}`);
      await until(
        page,
        `[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(${JSON.stringify(frameBase(f))}))`,
      );
      // The rows' autofocus sits in the hidden popover, so nothing takes focus on load.
      assert.ok(await page.evaluate("document.activeElement === document.body"), "no load focus");
    };
    // A frame-location message from the frame's own window, as the v2 rendition sends it.
    const post = async (page: Page, f: Fixture, path: string) => {
      const frame = page.frames().find((fr) => fr.url().startsWith(frameBase(f)));
      assert.ok(frame, "frame loaded");
      const href = new URL(frameBase(f)).pathname + path;
      await frame.evaluate(
        `parent.postMessage(${JSON.stringify({ type: "waypoint:location", href })}, "*")`,
      );
      await until(
        page,
        `document.querySelector("a[aria-current]")?.dataset.p === ${JSON.stringify(path)}`,
      );
    };
    const T = FIXTURES.tree;

    // Desktop: the panel is docked, the banner spans the window, and nothing takes the focus.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      logs.push(collectConsole(page));
      await open(page, T, "sub/x.html");
      const row = await rect(page, ".prow");
      near(row.left, 0, 1, ".prow starts at the window's edge");
      near(row.width, 1280, 1, ".prow spans the window");
      near((await rect(page, ".lh")).width, 1280, 1, ".lh spans the window");
      const panel = await rect(page, "#files");
      near(panel.left, 0, 1, "panel docked at the left edge");
      near(panel.width, 300, 1, "panel width");
      near(panel.top, row.bottom + 1, 1, "panel under the banner");
      near(panel.bottom, 800, 1, "panel to the window's foot");
      near((await rect(page, "#doc")).left, 300, 1, "the document beside the panel");
      assert.equal(await isOpen(page), false, "docked, not open as a popover");
      assert.ok(await page.locator("#files .shd").isVisible(), "the Files header shows");
      assert.equal(await page.locator("#files .done").isVisible(), false, "no Done");
      assert.deepEqual(await autofocused(page), ["sub/x.html"], "autofocus set after load");
      assert.deepEqual(await axe(page, { rules: ["nested-interactive"] }), []);
      assert.equal(
        await page.evaluate(`document.querySelectorAll(${JSON.stringify(NESTED)}).length`),
        0,
      );
      assert.equal(await page.evaluate(`!!document.querySelector(".fbtn #files")`), false);
      // Every row is one line, cut with an ellipsis; its full path shows as a tooltip on hover.
      const heights = await json(
        page,
        `[...document.querySelectorAll("#files a")].map((a) => Math.round(a.getBoundingClientRect().height))`,
      );
      assert.ok(
        Array.isArray(heights) && new Set(heights).size === 1,
        `one row height ${JSON.stringify(heights)}`,
      );
      await page.hover('#files a[data-p="sub/z.html"]');
      assert.equal(
        await page.getAttribute('#files a[data-p="sub/z.html"]', "title"),
        "sub/z.html",
        "lazy title",
      );
      // In-frame navigation moves the current row and the autofocus.
      await post(page, T, "sub/y.html");
      assert.equal((await page.textContent("#files-cur .t"))?.trim(), "sub/y.html");
      assert.deepEqual(await autofocused(page), ["sub/y.html"]);
    }

    // Tablet: a side sheet over a tinted scrim. It opens on the current row, Esc and a press
    // outside close it, and focus goes back to the Files button.
    {
      const { page } = await ctx.newPage({ width: 820, height: 1180 });
      logs.push(collectConsole(page));
      await open(page, T, "sub/x.html");
      assert.equal(await page.locator("#files").isVisible(), false, "closed below 1100 px");
      assert.equal(await page.getAttribute(".fbtn", "aria-expanded"), "false");
      await page.click(".fbtn");
      assert.ok(await isOpen(page), "opens");
      assert.equal(await page.getAttribute(".fbtn", "aria-expanded"), "true");
      assert.ok(await active(page, "a[aria-current]"), "focus on the current row");
      const sheet = await rect(page, "#files");
      near(sheet.left, 0, 1, "sheet at the left edge");
      near(sheet.top, 0, 1, "sheet top");
      near(sheet.bottom, 1180, 1, "sheet bottom");
      near(sheet.width, 360, 1, "sheet width");
      assert.notEqual(
        await page.evaluate(`getComputedStyle(document.querySelector(".pop-scrim")).display`),
        "none",
        "scrim shown",
      );
      assert.deepEqual(await axe(page, { rules: ["nested-interactive"] }), []);

      await page.keyboard.press("Escape");
      assert.equal(await isOpen(page), false, "Esc closes");
      assert.ok(await active(page, ".fbtn"), "Esc returns focus to Files");
      assert.equal(await page.getAttribute(".fbtn", "aria-expanded"), "false");

      await page.click(".fbtn");
      assert.ok(await isOpen(page));
      await page.mouse.click(700, 600);
      await until(page, `!${OPEN}`, 1000);
      await until(page, `document.activeElement?.matches(".fbtn") === true`, 1000);

      // Keyboard: Enter opens on the current row; every row is in Tab order.
      await page.focus(".fbtn");
      await page.keyboard.press("Enter");
      assert.ok(await isOpen(page));
      assert.ok(await active(page, 'a[data-p="sub/x.html"]'), "Enter: focus on the current row");
      await page.keyboard.press("Tab");
      assert.ok(await active(page, 'a[data-p="sub/y.html"]'), "Tab: the next row");
      await page.keyboard.press("Escape");
      assert.equal(await isOpen(page), false);

      // In-frame navigation moves the current label and the autofocus.
      await post(page, T, "sub/y.html");
      assert.equal((await page.textContent("#files-cur .t"))?.trim(), "sub/y.html");
      assert.deepEqual(await autofocused(page), ["sub/y.html"]);

      // The current row's folder is collapsed (by hand, or above 200 files after in-frame
      // navigation): opening still expands it and focuses the row.
      await page.evaluate(
        `document.querySelectorAll("#files details").forEach((d) => d.open = false)`,
      );
      await page.click(".fbtn");
      assert.ok(
        await active(page, 'a[data-p="sub/y.html"]'),
        "collapsed: focus on the current row",
      );
      await page.click('#files a[data-p="sub/y.html"] >> xpath=ancestor::details[1]/summary');
      assert.equal(
        await page.evaluate(
          `document.querySelector('#files a[data-p="sub/y.html"]').closest("details").open`,
        ),
        false,
        "the folder collapsed by hand",
      );
      await page.keyboard.press("Escape");
      assert.equal(await isOpen(page), false);
      await page.click(".fbtn");
      assert.ok(await active(page, 'a[data-p="sub/y.html"]'), "reopened: focus on the current row");
      await page.keyboard.press("Escape");
    }

    // Tablet, on the head file: the head row (before the rule) takes focus.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.tablet });
      logs.push(collectConsole(page));
      await open(page, T);
      await page.click(".fbtn");
      assert.ok(await active(page, '#files a[data-p="index.html"]'), "focus on the head row");
      assert.ok(
        await page.evaluate(
          `document.querySelector("#files hr").previousElementSibling === document.activeElement`,
        ),
        "the head row is the link before the rule",
      );
      await page.keyboard.press("Escape");
      assert.deepEqual(await autofocused(page), ["index.html"]);
      await post(page, T, "sub/x.html");
      assert.deepEqual(await autofocused(page), ["sub/x.html"]);
      await post(page, T, "index.html");
      assert.deepEqual(await autofocused(page), ["index.html"]);
    }

    // Forced colours: a 2 px outline marks the current row.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
      logs.push(collectConsole(page));
      await open(page, T, "sub/x.html");
      assert.deepEqual(
        await json(
          page,
          `(() => { const s = getComputedStyle(document.querySelector("#files a[aria-current]"));
            return [s.outlineStyle, s.outlineWidth]; })()`,
        ),
        ["solid", "2px"],
      );
    }

    // Phone: a bottom sheet over a tinted scrim, with Done and 44 px rows.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      logs.push(collectConsole(page));
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await open(page, T, "sub/x.html");
      const url = page.url();
      const loaded = navigations;
      assert.ok((await rect(page, ".fbtn")).height >= 44, "Files button ≥ 44 px");
      await page.tap(".fbtn");
      assert.ok(await isOpen(page), "opens");
      const sheet = await rect(page, "#files");
      near(sheet.bottom, 844, 1, "sheet bottom");
      near(sheet.width, 390, 1, "sheet width");
      const scrim = (property: string) =>
        page.evaluate(`getComputedStyle(document.querySelector(".pop-scrim")).${property}`);
      assert.notEqual(await scrim("display"), "none", "scrim shown");
      assert.ok(
        !/^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(String(await scrim("backgroundColor"))),
        "scrim tinted",
      );
      assert.ok(await page.locator("#files .done").isVisible(), "Done shown");
      assert.ok((await rect(page, "#files .done")).height >= 44, "Done ≥ 44 px");
      const short = await json(
        page,
        `[...document.querySelectorAll("#files a, #files summary")]
          .filter((e) => e.getClientRects().length > 0)
          .filter((e) => e.getBoundingClientRect().height < 44)
          .map((e) => e.textContent)`,
      );
      assert.deepEqual(short, [], "rows ≥ 44 px");
      assert.deepEqual(await axe(page, { rules: ["nested-interactive"] }), []);
      assert.equal(
        await page.evaluate(`document.querySelectorAll(${JSON.stringify(NESTED)}).length`),
        0,
      );

      await page.touchscreen.tap(195, 40);
      await until(page, `!${OPEN}`);
      // Let the closing tap's click land (on the lingering scrim) before checking.
      await page.waitForTimeout(500);
      assert.equal(page.url(), url, "the scrim tap navigates nowhere");
      assert.equal(navigations, loaded, "no navigation");
      assert.ok(await active(page, ".fbtn"), "the scrim tap returns focus to Files");

      await page.tap(".fbtn");
      assert.ok(await isOpen(page));
      await page.tap("#files .done");
      assert.equal(await isOpen(page), false, "Done closes");
      assert.ok(await active(page, ".fbtn"), "Done returns focus to Files");
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
