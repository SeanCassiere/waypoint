// RX-09: section links in the writer. Opening a document URL with #heading lands on the heading,
// keeps the fragment in the address bar and fetches the document once, with no extra history
// entry; a Contents link updates it, a file switch drops it, and an invalid fragment is dropped.
import type { Frame, Page } from "playwright";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const para = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Paragraph ${i + 1}: retries reuse the same key, so the receiver can drop repeats.`,
  ).join("\n\n");
// Four h2s, so the rendition has a Contents block; enough text after the last one to scroll it
// to the top.
const INDEX = [
  "# Webhook idempotency research",
  `## Background\n\n${para(8)}`,
  `## Recommendation\n\n${para(8)}`,
  `## Suggested delivery contract\n\n${para(8)}`,
  `## Open questions\n\n${para(40)}`,
].join("\n\n");
const HEADING = "open-questions";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = async (page: Page) => String(await page.evaluate("location.hash"));
/** Whether a frame shows a raw document. */
const isDoc = (f: Frame) => f.url().includes("/raw/r/");

/** The document frame once it has loaded `path`. */
async function docFrame(page: Page, path: string): Promise<Frame> {
  await page.waitForFunction(
    `(() => { const w = document.querySelector("[data-docwrap]");
      const f = document.querySelector("[data-frame]");
      return w.hasAttribute("data-loaded") && f.contentWindow.location.pathname.endsWith(${JSON.stringify(`/${path}`)}); })()`,
  );
  const frame = page.frames().find((f) => new URL(f.url()).pathname.endsWith(`/${path}`));
  assert.ok(frame, `the frame shows ${path}`);
  await frame.waitForLoadState("load");
  return frame;
}

const scenario: ViewerScenario = {
  name: "RX-09 section links in the writer: open at #heading, Contents updates it, switches drop it",
  async run(ctx) {
    const { base } = ctx.writer;
    const created = await ctx.writer.api("/api/collections", {
      title: "Section links",
      head_path: "index.md",
      files: [
        await ctx.writer.write("index.md", INDEX),
        await ctx.writer.write("notes/b.md", "# Notes B\n\nB.\n"),
      ],
    });
    const latest = new URL(created.latest_url).pathname;

    /** Opens `url` on a fresh page and checks it lands on the heading, in one request, in place. */
    const openAtHeading = async (url: string) => {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      const raw: string[] = [];
      page.on("request", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.includes("/raw/r/")) raw.push(pathname);
      });
      // Read at commit, before the frame's load hands over the fragment: an entry added there
      // (a plain `src` assignment would add one) must show up in the comparison below.
      await page.goto(`${base}${url}`, { waitUntil: "commit" });
      const length = Number(await page.evaluate("history.length"));
      await page.waitForLoadState("load");
      const frame = await docFrame(page, "index.md");
      await pause(500);
      assert.equal(await hashOf(page), `#${HEADING}`, `${url}: the bar keeps it`);
      const top = Number(
        await frame.evaluate(
          `document.getElementById(${JSON.stringify(HEADING)}).getBoundingClientRect().top`,
        ),
      );
      assert.ok(top >= -2 && top <= 120, `${url}: heading at the top: ${top}`);
      assert.equal(
        raw.filter((p) => p.endsWith("/index.md")).length,
        1,
        `${url}: one raw request for index.md`,
      );
      assert.equal(Number(await page.evaluate("history.length")), length, `${url}: no entry`);
      return { page, frame };
    };

    // By the file's own URL: then a Contents link updates the bar and a file switch drops it.
    {
      const { page, frame } = await openAtHeading(`${latest}index.md#${HEADING}`);
      await frame
        .locator("details.toc")
        .getByRole("link", { name: "Recommendation", exact: true })
        .click();
      await page.waitForFunction(`location.hash === "#recommendation"`);
      await page.locator('#tp-files a[data-file="notes/b.md"]').click();
      await page.waitForURL(`**${latest}notes/b.md`);
      await docFrame(page, "notes/b.md");
      assert.equal(await hashOf(page), "", "a file switch drops the fragment");
    }

    // By the head file's bare URL.
    await openAtHeading(`${latest}#${HEADING}`);

    // A fragment that fails the pattern is dropped and never reaches the frame.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.goto(`${base}${latest}index.md#a'b`);
      const frame = await docFrame(page, "index.md");
      await page.waitForFunction(`location.hash === ""`);
      await pause(300);
      assert.equal(await hashOf(page), "", "the bar drops it");
      assert.ok(!frame.url().includes("#"), `the frame has no fragment: ${frame.url()}`);
    }

    // The frame finished loading before the deferred client script bound (no further load):
    // a valid section is still kept and opened, an invalid one still dropped.
    const loadsFirst = async (url: string) => {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      const raw: string[] = [];
      page.on("request", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.includes("/raw/r/")) raw.push(pathname);
      });
      let frameLoaded = false;
      await page.route("**/assets/viewer/*.js", async (route) => {
        const doc =
          page.frames().find(isDoc) ??
          (await page
            .waitForEvent("framenavigated", { predicate: isDoc, timeout: 10_000 })
            .catch(() => undefined));
        await doc?.waitForLoadState("load");
        frameLoaded = Boolean(doc);
        await route.continue();
      });
      await page.goto(`${base}${url}`);
      const frame = await docFrame(page, "index.md");
      assert.ok(frameLoaded, `${url}: the frame loaded before the client script`);
      await pause(500);
      return { page, frame, raw };
    };
    {
      const { page, frame, raw } = await loadsFirst(`${latest}index.md#${HEADING}`);
      assert.equal(await hashOf(page), `#${HEADING}`, "loaded first: the bar keeps it");
      const top = Number(
        await frame.evaluate(
          `document.getElementById(${JSON.stringify(HEADING)}).getBoundingClientRect().top`,
        ),
      );
      assert.ok(top >= -2 && top <= 120, `loaded first: heading at the top: ${top}`);
      assert.equal(
        raw.filter((p) => p.endsWith("/index.md")).length,
        1,
        "loaded first: one raw request for index.md",
      );
    }
    {
      const { page, frame } = await loadsFirst(`${latest}index.md#a'b`);
      assert.equal(await hashOf(page), "", "loaded first: the bar drops an invalid fragment");
      assert.ok(!frame.url().includes("#"), `loaded first: no fragment: ${frame.url()}`);
    }

    // A file switch before the first load supersedes the opening section.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.route("**/raw/r/**/index.md", async (route) => {
        await pause(1500);
        await route.continue().catch(() => undefined);
      });
      await page.goto(`${base}${latest}index.md#${HEADING}`, { waitUntil: "domcontentloaded" });
      await page.locator('#tp-files a[data-file="notes/b.md"]').click();
      const frame = await docFrame(page, "notes/b.md");
      await pause(300);
      assert.ok(
        String(await page.evaluate("location.pathname")).endsWith(`${latest}notes/b.md`),
        "an early switch: the bar shows notes/b.md",
      );
      assert.equal(await hashOf(page), "", "an early switch drops the opening section");
      assert.ok(!frame.url().includes("#"), `an early switch: no fragment: ${frame.url()}`);
    }
  },
};
export default scenario;
