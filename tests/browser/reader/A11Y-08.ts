// A11Y-08: a calm loading line. The shell's empty role=status line behind the transparent frame
// gets "Opening <path>…" only after 300 ms, main is busy until the frame loads (8 s at most), and
// a fast load never sets the text. Without JavaScript nothing shows and nothing is busy.
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

const hash = (c: string) => "sha256:" + c.repeat(64);
// A valid file name with no break opportunity: the line must wrap it, not run off the screen.
const LONG = `decisions_${"webhook_idempotency_".repeat(9)}final.md`;
const FILES = [
  ["slow.md", hash("1")],
  ["hang.md", hash("2")],
  ["fast.md", hash("3")],
  [LONG, hash("4")],
] as const;
const DELAY = new Map<string, number>([
  [hash("1"), 1500],
  [hash("2"), 10_000],
  [hash("4"), 1500],
]);
// The 300 ms step, with room for a busy machine: never sooner, and well before the 1.5 s load.
const STEP_MAX_MS = 900;
const COL = { id: "col_" + "k".repeat(26), pub: "kkkkkkkkkkkk" };
const REV = { id: "rev_" + "0".repeat(25) + "k", pub: "k8k8k8k8k8k8" };
const LINK = "shl_" + "0".repeat(25) + "k";

// Records, from document start, every time #loading's text or main's aria-busy changes (with
// performance.now()), so the 300 ms step and "never set" can be checked after the fact.
const RECORDER = `(() => {
  if (window !== window.top) return;
  const events = (window.__a11y08 = []);
  let text = "";
  let busy = null;
  new MutationObserver(() => {
    const line = document.getElementById("loading");
    const main = document.getElementById("main");
    const t = line ? line.textContent : "";
    const b = main ? main.getAttribute("aria-busy") : null;
    if (t !== text) events.push({ at: performance.now(), text: (text = t) });
    if (b !== busy) events.push({ at: performance.now(), busy: (busy = b) });
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;
type Event = { at: number; text?: string; busy?: string | null };

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
async function events(page: Page): Promise<Event[]> {
  const value = await json(page, "window.__a11y08");
  assert.ok(Array.isArray(value), "the recorder ran");
  return value.map((item: unknown) => {
    assert.ok(item && typeof item === "object" && "at" in item);
    const event: Event = { at: Number(item.at) };
    if ("text" in item) event.text = String(item.text);
    if ("busy" in item) event.busy = typeof item.busy === "string" ? item.busy : null;
    return event;
  });
}
const numbers = async (page: Page, expression: string): Promise<number[]> => {
  const value = await json(page, expression);
  assert.ok(Array.isArray(value), `${expression} is a list`);
  return value.map(Number);
};
const texts = async (page: Page) =>
  (await events(page)).flatMap((e) => (e.text === undefined || e.text === "" ? [] : [e.text]));
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
const text = (page: Page) => page.evaluate(`document.getElementById("loading").textContent`);
const busy = (page: Page) =>
  page.evaluate(`document.getElementById("main").getAttribute("aria-busy")`);
const loaded = (page: Page) =>
  until(page, `document.querySelector(".docwrap").hasAttribute("data-loaded")`);

const scenario: ReaderScenario = {
  name: "A11Y-08 loading line: shown after 300 ms, busy until load (8 s at most), none without JS",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    for (const [, blob] of FILES)
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", blob, 20);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Webhook idempotency research",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "slow.md",
    );
    for (const [path, blob] of FILES)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,20)",
        REV.id,
        path,
        blob,
        "text/markdown",
      );
    const token = newShareToken();
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
      blob: async (blob) => {
        const delay = DELAY.get(blob) ?? 0;
        if (delay)
          await new Promise((resolve) => {
            setTimeout(resolve, delay).unref();
          });
        return new Response("# A document\n\nIts text.\n");
      },
    });
    const shell = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const logs: string[][] = [];
    /** Opens a file's shell without waiting for the frame (DOMContentLoaded follows the script). */
    const open = async (page: Page, path: string) => {
      const response = await page.goto(shell + path, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200, `loads ${path}`);
    };

    // Desktop, slow: empty and busy at first; the line after 300 ms, under the tabs at the top
    // of the document area; cleared, hidden and not busy after load.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      logs.push(collectConsole(page));
      await page.addInitScript(RECORDER);
      await open(page, "slow.md");
      assert.equal(await text(page), "", "empty at first");
      assert.equal(await busy(page), "true", "main is busy at once");
      await page.waitForTimeout(500);
      await until(page, `document.getElementById("loading").textContent !== ""`);
      assert.equal(await text(page), "Opening slow.md…");
      assert.equal(await busy(page), "true", "still busy");
      assert.ok(await page.locator(".loading").isVisible(), "the line is visible");
      const [lineTop = NaN, mainTop = NaN, inside = 0] = await numbers(
        page,
        `(() => { const l = document.getElementById("loading").getBoundingClientRect();
          const m = document.getElementById("main").getBoundingClientRect();
          return [l.top, m.top, l.left >= m.left && l.right <= m.right && l.bottom <= m.bottom]; })()`,
      );
      assert.equal(inside, 1, "the line is inside main");
      assert.ok(lineTop - mainTop >= 0 && lineTop - mainTop <= 64, `${lineTop - mainTop} px down`);
      // The 300 ms step: the text was set no sooner than 300 ms after main became busy.
      const recorded = await events(page);
      const busyAt = recorded.find((e) => e.busy === "true")?.at ?? NaN;
      const shownAt = recorded.find((e) => e.text)?.at ?? NaN;
      assert.ok(shownAt - busyAt >= 295, `shown ${shownAt - busyAt} ms after busy`);
      assert.ok(shownAt - busyAt < STEP_MAX_MS, `shown by ${shownAt - busyAt} ms after busy`);
      await loaded(page);
      assert.equal(await text(page), "", "emptied on load");
      assert.equal(await busy(page), null, "not busy after load");
      assert.equal(
        await page.evaluate(`getComputedStyle(document.querySelector(".loading")).display`),
        "none",
      );
      assert.deepEqual(await texts(page), ["Opening slow.md…"], "one text, set once");
    }

    // Fast: the text is never set, and busy is gone after load.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      logs.push(collectConsole(page));
      await page.addInitScript(RECORDER);
      await open(page, "fast.md");
      await loaded(page);
      assert.deepEqual(await texts(page), [], "a fast load never shows the line");
      assert.equal(await busy(page), null);
    }

    // A load that never finishes: busy is dropped at 8 s, the line stays.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      logs.push(collectConsole(page));
      await open(page, "hang.md");
      await page.waitForTimeout(8300);
      assert.equal(await busy(page), null, "busy dropped after 8 s");
      assert.equal(await text(page), "Opening hang.md…", "the line stays");
      await page.close();
    }

    // Phone: the line fits the viewport width.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true, colorScheme: "dark" });
      logs.push(collectConsole(page));
      await open(page, "slow.md");
      await until(page, `document.getElementById("loading").textContent !== ""`);
      assert.ok(await page.locator(".loading").isVisible(), "the line is visible");
      const [right = NaN, scroll = NaN, client = NaN] = await numbers(
        page,
        `[document.getElementById("loading").getBoundingClientRect().right,
          document.documentElement.scrollWidth, document.documentElement.clientWidth]`,
      );
      assert.ok(right <= 390, `the line ends at ${right} px`);
      assert.ok(scroll <= client, `no horizontal scroll (${scroll} > ${client})`);
      assert.equal(
        await page.evaluate(`getComputedStyle(document.getElementById("loading")).color`),
        await page.evaluate(`(() => { const p = document.createElement("span");
          p.style.color = "var(--muted)"; document.body.append(p);
          const c = getComputedStyle(p).color; p.remove(); return c; })()`),
        "the line is --muted",
      );
      await loaded(page);
    }

    // A long file name with no break opportunity wraps inside main: nothing runs past the
    // column or the viewport, on a phone or a desktop.
    const long = async (viewport: (typeof VIEWPORTS)["phone" | "desktop"]) => {
      const { page } = await ctx.newPage(viewport);
      logs.push(collectConsole(page));
      await open(page, LONG);
      await until(page, `document.getElementById("loading").textContent !== ""`);
      const fit = await json(
        page,
        `(() => { const l = document.getElementById("loading");
          const m = document.getElementById("main").getBoundingClientRect();
          const r = l.getBoundingClientRect();
          return { text: l.textContent, inLine: l.scrollWidth <= l.clientWidth,
            inMain: r.left >= m.left && r.right <= m.right + 0.5,
            inView: r.right <= innerWidth + 0.5,
            noScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`,
      );
      assert.deepEqual(
        fit,
        { text: `Opening ${LONG}…`, inLine: true, inMain: true, inView: true, noScroll: true },
        `${viewport.width} px: the long name wraps in place`,
      );
      await loaded(page);
    };
    await long(VIEWPORTS.phone);
    await long(VIEWPORTS.desktop);

    // No JS: nothing behind the frame, never busy.
    {
      const context = await ctx.browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 1280, height: 800 },
      });
      onCleanup(() => context.close());
      const page = await context.newPage();
      ctx.watchErrors(page, "A11Y-08.ts (no JS)");
      logs.push(collectConsole(page));
      await open(page, "slow.md");
      await page.waitForTimeout(500);
      assert.equal(await page.locator("#main").getAttribute("aria-busy"), null, "never busy");
      assert.equal(await page.locator("#loading").textContent(), "", "the line is empty");
      // The empty line has no text and no fill of its own: nothing shows behind the frame.
      assert.equal(await page.locator(".loading").innerText(), "", "no text behind the frame");
      assert.deepEqual(
        await json(
          page,
          `[".loading", "#loading"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)`,
        ),
        ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
        "no fill behind the frame",
      );
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
