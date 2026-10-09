// A11Y-07: the reader's Files list is a light-dismiss popover (a bottom sheet over a tinted scrim
// on phones) that opens on the current file and gives focus back to the Files button; the tab
// strip scrolls its current tab into view and marks overflowing edges; the row fits the column.
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
  // S: 7 files with long names, tabs that overflow a phone.
  tabs: {
    title: "Overflowing tabs",
    col: { id: "col_" + "g".repeat(26), pub: "gggggggggggg" },
    rev: { id: "rev_" + "0".repeat(25) + "8", pub: "g8g8g8g8g8g8" },
    link: "shl_" + "0".repeat(25) + "8",
    files: [
      "index.html",
      "shots/cart-overview-with-promotions.html",
      "shots/confirmation-screen-final.html",
      "shots/payment-details-card-entry.html",
      "shots/receipt-email-preview-long.html",
      "shots/shipping-address-autocomplete.html",
      "shots/zz-order-history-after-checkout.html",
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
  name: "A11Y-07 Files popover and phone sheet, focus contract, tab overflow, row layout",
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, seeded in order.
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
    const S = FIXTURES.tabs;

    // Desktop: an anchored panel under the Files button.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      logs.push(collectConsole(page));
      await open(page, T, "sub/x.html");
      const row = await rect(page, ".prow");
      assert.ok(row.width <= 1120, `.prow width ${row.width}`);
      near((row.left + row.right) / 2, 640, 1, ".prow centred");

      await page.click(".fbtn");
      assert.ok(await isOpen(page), "opens");
      assert.ok(await active(page, "a[aria-current]"), "focus on the current row");
      const button = await rect(page, ".fbtn");
      const panel = await rect(page, "#files");
      const gap = panel.top - button.bottom;
      assert.ok(gap >= 2 && gap <= 12, `panel ${gap}px below the button`);
      near(panel.left, button.left, 4, "panel left-aligned to the button");
      near(panel.width, 440, 1, "panel width");
      assert.equal(await page.locator("#files .shd").isVisible(), false, "no sheet header");
      assert.deepEqual(await axe(page, { rules: ["nested-interactive"] }), []);
      assert.equal(
        await page.evaluate(`document.querySelectorAll(${JSON.stringify(NESTED)}).length`),
        0,
      );
      assert.equal(await page.evaluate(`!!document.querySelector(".fbtn #files")`), false);

      await page.keyboard.press("Escape");
      assert.equal(await isOpen(page), false, "Esc closes");
      assert.ok(await active(page, ".fbtn"), "Esc returns focus to Files");

      await page.click(".fbtn");
      assert.ok(await isOpen(page));
      await page.click("h1");
      assert.equal(await isOpen(page), false, "a press outside closes");
      await until(page, `document.activeElement?.matches(".fbtn") === true`, 1000);

      await page.click(".fbtn");
      assert.ok(await isOpen(page));
      const frame = await rect(page, "#doc");
      const pressed = performance.now();
      await page.mouse.click(frame.left + frame.width / 2, frame.top + frame.height / 2);
      await until(page, `!${OPEN}`, 1000);
      const took = performance.now() - pressed;
      assert.ok(took <= 200, `a press in the document closes it (${Math.round(took)} ms)`);
      await page.waitForTimeout(50);
      assert.ok(await active(page, "#doc"), "a press in the document keeps focus there");

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

    // Desktop, on the head file: the head row (before the rule) takes focus.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
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
      await page.click(".fbtn");
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

    // Phone tabs: the current tab is scrolled into view; the strip marks its overflowing edges.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      logs.push(collectConsole(page));
      const last = S.files.at(-1)!;
      await open(page, S, last);
      const strip = await rect(page, ".ptabs2");
      const tab = await rect(page, "a[aria-current]");
      // RX-06's 44 px Download control shares the row, so a long tab can be wider than the strip
      // (by how much depends on the fonts): then it must fill the strip, otherwise show whole.
      const visible = (t: Rect) => Math.min(t.right, strip.right) - Math.max(t.left, strip.left);
      assert.ok(
        visible(tab) >= Math.min(tab.width, strip.width) - 1,
        `current tab visible: ${visible(tab)} of ${tab.width} in ${strip.width}`,
      );
      assert.ok(strip.left >= 0 && strip.right <= 390, "strip inside the viewport");
      assert.ok(
        await page.evaluate(
          `(() => { const s = document.querySelector(".ptabs2"); return s.scrollWidth > s.clientWidth; })()`,
        ),
        "the strip overflows",
      );
      assert.ok(
        Number(await page.evaluate("document.scrollingElement.scrollWidth")) <= 390,
        "the page doesn't scroll sideways",
      );
      assert.equal(await page.evaluate("document.scrollingElement.scrollTop"), 0, "no page jump");
      const more = () => page.evaluate(`document.querySelector(".ptabs2").dataset.more ?? ""`);
      assert.ok(
        String(await more())
          .split(" ")
          .includes("start"),
        "a start fade",
      );
      await page.evaluate(`document.querySelector(".ptabs2").scrollLeft = 0`);
      await until(
        page,
        `!(document.querySelector(".ptabs2").dataset.more ?? "").includes("start")`,
      );
      assert.deepEqual(String(await more()).split(" "), ["end"], "only an end fade at the start");
      // In-frame navigation to a tab out of view scrolls it into view.
      await post(page, S, S.files[5]);
      const shown = await rect(page, "a[aria-current]");
      assert.ok(
        visible(shown) >= Math.min(shown.width, strip.width) - 1,
        `followed tab visible: ${visible(shown)} of ${shown.width} in ${strip.width}`,
      );
      assert.deepEqual(await autofocused(page), [], "never autofocus on tabs");
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
