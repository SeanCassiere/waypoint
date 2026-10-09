// RX-01: one letterhead for every link state. The mode pill, relative times computed once at load
// (short forms on phones), the link's own expiry (ink and a clock under 24 hours, never amber),
// "Read-only" kept on phones inside the About button, About as an anchored popover or a bottom
// sheet, absolute UTC without JavaScript, and never the link's label.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import {
  assert,
  collectConsole,
  cspProblems,
  onCleanup,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LABEL = "PRIVATE-LABEL-RX01";
const HASH = "sha256:" + "1".repeat(64);
const COL = { id: "col_" + "r".repeat(26), pub: "rrrrrrrrrrrr" };
const REV = { id: "rev_" + "0".repeat(25) + "r", pub: "r1r1r1r1r1r1" };
const LONG = { id: "col_" + "s".repeat(26), pub: "ssssssssssss" };
const LONG_REV = { id: "rev_" + "0".repeat(25) + "s", pub: "s1s1s1s1s1s1" };
const LONG_TITLE = (
  "Quarterly infrastructure capacity planning review for the payments, search and notification " +
  "platforms, draft for leadership sign-off with cost model, rollout schedule and open risks"
)
  .padEnd(190, ".")
  .slice(0, 190);

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
/** Visible text, whitespace-normalised: hidden long/short forms are display:none. */
const text = async (page: Page, selector: string): Promise<string> =>
  (await page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim();
const OPEN = `document.getElementById("about").matches(":popover-open")`;
const isOpen = async (page: Page) => (await page.evaluate(OPEN)) === true;
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
/** The computed colour of a token, through a probe element (CSSOM is allowed under the CSP). */
const tokenColour = (page: Page, token: string) =>
  page.evaluate(`(() => { const p = document.createElement("span");
    p.style.color = "var(${token})"; document.querySelector(".note").append(p);
    const colour = getComputedStyle(p).color; p.remove(); return colour; })()`);
async function open(page: Page, href: string): Promise<void> {
  const response = await page.goto(href);
  assert.equal(response?.status(), 200, `loads ${href}`);
}
// Weekday, date, 24 h time, then a required zone token (whatever Intl gives; never pinned).
const ZONED = /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} \S+$/;

const scenario: ReaderScenario = {
  name: "RX-01 letterhead states, relative times, expiry, About popover and sheet, phone forms",
  async run(ctx) {
    const now = Date.now();
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    const collection = (col: typeof COL, title: string) =>
      ins(
        "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
        col.id,
        col.pub,
        title,
      );
    const revision = (rev: typeof REV, col: typeof COL, files: readonly string[]) => {
      ins(
        "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,?)",
        rev.id,
        rev.pub,
        col.id,
        files[0]!,
        now - 2 * HOUR,
      );
      for (const path of files)
        ins(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
          rev.id,
          path,
          HASH,
          "text/markdown",
        );
    };
    collection(COL, "Webhook idempotency research");
    revision(REV, COL, ["index.md", "checklist.md", "sources.md"]);
    collection(LONG, LONG_TITLE);
    revision(LONG_REV, LONG, ["index.md"]);
    let n = 0;
    const link = async (col: typeof COL, rev: string | null, expiresAt: number | null) => {
      const token = newShareToken();
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,label,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,1)",
        "shl_" + String(++n).padStart(26, "x"),
        await hashShareToken(token),
        col.id,
        rev,
        LABEL,
        expiresAt,
        null,
      );
      return token;
    };
    const six = await link(COL, null, now + 6 * DAY + HOUR);
    const plain = await link(COL, null, null);
    const pinned = await link(COL, REV.id, null);
    const soon = await link(COL, null, now + 5 * HOUR);
    const long = await link(LONG, null, null);
    const reader = await startReader({
      db,
      blob: () => new Response("# Webhook idempotency research\n\nThe document.\n"),
    });
    const url = (token: string, col = COL) => `${reader.origin}/s/${token}/c/${col.pub}/`;
    const pinnedUrl = `${url(pinned)}r/${REV.pub}/`;

    const logs: string[][] = [];
    const bodies: Promise<string>[] = [];
    const watch = (page: Page) => {
      logs.push(collectConsole(page));
      page.on("response", (response) => bodies.push(response.text().catch(() => "")));
    };

    // Desktop, following, expires in 6 days.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      watch(page);
      await open(page, url(six));
      assert.equal(await text(page, ".mode"), "Latest version");
      assert.match(
        await text(page, ".note"),
        /^Latest version\s*Updated \d+ (?:hour|minute)s? ago\s*Link expires in 6 days$/,
      );
      const title = String(await page.getAttribute("time[data-t=rel]", "title"));
      assert.match(title, ZONED, "the relative time's title is the full local time with a zone");
      assert.ok(await page.locator(".ro").isVisible(), ".ro visible");
      assert.equal(await text(page, ".ro"), "Read-only");
      assert.equal(
        await page.getByRole("button", { name: "About this link", exact: true }).count(),
        1,
        "the button is named About this link",
      );
      assert.equal(await page.locator(".exp svg").count(), 0, "no clock for 6 days");
      assert.equal(
        await page.evaluate(`getComputedStyle(document.querySelector(".exp")).color`),
        await tokenColour(page, "--muted"),
        "the 6-day expiry is muted",
      );

      await page.click(".abt");
      assert.ok(await isOpen(page), "About opens");
      const about = await text(page, "#about");
      for (const part of [
        "Shows the latest version",
        "Works until",
        "That's in 6 days.",
        "You can read and download the 3 files in this version.",
        "Shared from Waypoint",
      ])
        assert.ok(about.includes(part), `About says ${part}: ${about}`);
      const button = await rect(page, ".abt");
      const box = await rect(page, "#about > .mbox");
      near(box.right, button.right, 2, "About's right edge under the button's");
      const gap = box.top - button.bottom;
      assert.ok(gap >= 4 && gap <= 10, `About ${gap}px below the button`);
      near(box.width, 372, 1, "About width");

      await page.keyboard.press("Escape");
      assert.equal(await isOpen(page), false, "Esc closes");
      await page.click(".abt");
      assert.ok(await isOpen(page));
      await page.click("h1");
      assert.equal(await isOpen(page), false, "a press on the title closes");
      await page.click(".abt");
      assert.ok(await isOpen(page));
      const frame = await rect(page, "#doc");
      const pressed = performance.now();
      await page.mouse.click(frame.left + frame.width / 2, frame.top + frame.height / 2);
      await until(page, `!${OPEN}`, 1000);
      const took = performance.now() - pressed;
      assert.ok(took <= 200, `a press in the document closes it (${Math.round(took)} ms)`);
    }

    // Desktop, under 24 hours: ink, weight 600 and the clock; never amber.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      watch(page);
      await open(page, url(soon));
      // Floored: 5 hours less the seconds since seeding.
      assert.match(await text(page, ".exp.soon"), /^Link expires in [45] hours$/);
      const style = await json(
        page,
        `(() => { const s = getComputedStyle(document.querySelector(".exp.soon"));
          return [s.color, s.fontWeight]; })()`,
      );
      const ink = await tokenColour(page, "--ink");
      assert.deepEqual(style, [ink, "600"], "ink at weight 600");
      assert.notEqual(ink, await tokenColour(page, "--pending"), "not the pending colour");
      assert.equal(await page.locator(".exp.soon svg").count(), 1, "the clock");
    }

    // Desktop, pinned.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      watch(page);
      await open(page, pinnedUrl);
      assert.match(
        await text(page, ".note"),
        /^Snapshot\s*Taken \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}\s*won't change$/,
      );
      assert.match(
        String(await page.getAttribute("time[data-t=date]", "title")),
        ZONED,
        "the pinned time's title is the full local time with a zone",
      );
      await page.click(".abt");
      assert.ok((await text(page, "#about")).includes("A fixed snapshot"));
    }

    // Phone: "Read-only" in a 32 px button with a 44 px hit area; short forms; About as a sheet.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      watch(page);
      await open(page, url(six));
      const button = page.locator(".abt");
      assert.ok(await button.isVisible(), "the button is visible");
      const visible = await page.evaluate(`(() => { const b = document.querySelector(".abt");
        return b.innerText.replace(b.querySelector(".vh").innerText, "").trim(); })()`);
      assert.equal(visible, "Read-only", "the button reads Read-only");
      assert.equal(
        await page.getByRole("button", { name: "Read-only, about this link", exact: true }).count(),
        1,
        "the button is named Read-only, about this link",
      );
      const box = await rect(page, ".abt");
      near(box.height, 32, 1, "button height");
      for (const y of [box.top - 5, box.bottom + 5])
        assert.ok(
          // oxlint-disable-next-line eslint/no-await-in-loop -- Two points, checked in order.
          await page.evaluate(
            `document.elementFromPoint(${box.left + box.width / 2}, ${y})?.closest(".abt") !== null`,
          ),
          `a press at y=${y} hits the button`,
        );
      assert.equal(
        await page.evaluate(`getComputedStyle(document.querySelector(".ro")).display`),
        "none",
      );
      assert.equal(await text(page, ".mode"), "Latest");
      assert.ok((await rect(page, ".note")).height <= 24, ".note is one line");
      const note = await text(page, ".note");
      assert.match(note, /Updated \d+ (?:hr\.|min\.) ago/);
      assert.match(note, /Expires in 6 days/);

      await page.tap(".abt");
      assert.ok(await isOpen(page), "About opens");
      const sheet = await rect(page, "#about");
      near(sheet.bottom, 844, 1, "sheet bottom");
      near(sheet.width, 390, 1, "sheet width");
      assert.ok(await page.locator("#about .full").isVisible(), "the full title");
      assert.equal(await text(page, "#about .full"), "Webhook idempotency research");
      assert.notEqual(
        await page.evaluate(`getComputedStyle(document.querySelector(".pop-scrim")).display`),
        "none",
        "the scrim",
      );
      await page.touchscreen.tap(195, 40);
      await until(page, `!${OPEN}`);
    }

    // Phone: the same letterhead height for following and pinned; a long title takes two lines.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      watch(page);
      await open(page, url(plain));
      const following = await rect(page, "header.lh");
      await open(page, pinnedUrl);
      const snapshot = await rect(page, "header.lh");
      near(snapshot.height, following.height, 1, "letterhead height, following vs pinned");
      await open(page, url(long, LONG));
      const h1 = await rect(page, "h1");
      const line = Number(
        await page.evaluate(
          `parseFloat(getComputedStyle(document.querySelector("h1")).lineHeight)`,
        ),
      );
      assert.ok(
        h1.height <= 2 * line + 1 && h1.height > 1.5 * line,
        `h1 is two lines (${h1.height})`,
      );
      assert.ok((await rect(page, ".note")).height <= 24, ".note is one line");
    }

    // No JavaScript: absolute UTC, and About still opens (popovertarget).
    {
      const context = await ctx.browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 1280, height: 800 },
      });
      onCleanup(() => context.close());
      const page = await context.newPage();
      ctx.watchErrors(page, "RX-01.ts (no JS)");
      watch(page);
      await open(page, url(six));
      const note = await text(page, ".note");
      assert.match(note, /Updated \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
      assert.match(note, /Link expires \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
      await page.click(".abt");
      assert.ok(await page.locator("#about").isVisible(), "About opens without JS");
      assert.match(await text(page, "#about"), /Works until \d{1,2} [A-Z][a-z]{2} \d{4}, .* UTC/);
    }

    for (const body of await Promise.all(bodies))
      assert.ok(!body.includes(LABEL), "no response shows the link's label");
    assert.ok(bodies.length > 0);
    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
