// VS-01b: one page frame. On the seeded demo writer (and an empty one, for the first-run Recent),
// at 1280 × 800, 820 × 1180 touch and 390 × 844 touch: every global-bar page's H1 (Recent, a
// search, Links, Status, Trash, Connect an agent, the 404, the empty Recent) starts at the frame's
// content edge (x = 92 / 32 / 16), is the one 26 px bold heading and sits at the same height (on a
// phone search, the query field above it does); Trash's narrow column starts at the frame's left
// edge; the Leaked collection's in-Trash page (no h1 in main) puts its hero there; nothing scrolls
// sideways. With classic 15 px scrollbars at 1280, the H1 stays at x = 92 on short and long pages
// alike. Tab once on Recent shows the shared skip link at the top left.
import { chromium, type Page } from "playwright";
import { z } from "zod";

import {
  assert,
  onCleanup,
  startDemoWriter,
  startWriter,
  VIEWPORTS,
  type ViewerScenario,
} from "../harness.ts";

const LEAKED = "Leaked .env in run output (do not share)";
const PAGES = ["/", "/?q=runbook", "/links", "/status", "/trash", "/mcp", "/nope"] as const;
const WIDTHS = [
  { viewport: VIEWPORTS.desktop, x: 92, frameLeft: 60 },
  { viewport: VIEWPORTS.tablet, x: 32, frameLeft: 0 },
  { viewport: VIEWPORTS.phone, x: 16, frameLeft: 0 },
] as const;

const heading = z.object({
  left: z.number(),
  top: z.number(),
  size: z.string(),
  weight: z.string(),
  scroll: z.number(),
});
/** The page's h1 inside main: its box, its computed font, and the document's scroll width. */
async function h1Of(page: Page): Promise<z.infer<typeof heading>> {
  return heading.parse(
    await page.evaluate(`(() => {
      const h1 = document.querySelector("main h1");
      const r = h1.getBoundingClientRect();
      const s = getComputedStyle(h1);
      return { left: r.left, top: r.top, size: s.fontSize, weight: s.fontWeight,
        scroll: document.documentElement.scrollWidth };
    })()`),
  );
}
const box = z.object({ left: z.number(), width: z.number() });
async function boxOf(page: Page, selector: string): Promise<z.infer<typeof box>> {
  return box.parse(
    await page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { left: r.left, width: r.width };
    })()`),
  );
}
const vertical = z.object({ top: z.number(), bottom: z.number() });
async function topOf(page: Page, selector: string): Promise<z.infer<typeof vertical>> {
  return vertical.parse(
    await page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    })()`),
  );
}
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is within ${tolerance} of ${expected}`,
  );

const scenario: ViewerScenario = {
  name: "VS-01b one page frame: every page H1 at the frame edge, narrow columns aligned to it",
  async run(ctx) {
    // The empty writer has no collections, so its Recent is the first-run page (NAV-06).
    const [writer, empty] = await Promise.all([startDemoWriter(), startWriter()]);
    const { base } = writer;
    const urls = [
      ...PAGES.map((path) => ({ path, url: `${base}${path}` })),
      { path: "/ (empty)", url: `${empty.base}/` },
    ];

    const { page: desk } = await ctx.newPage(VIEWPORTS.desktop);
    await desk.goto(`${base}/trash`);
    const leaked =
      (await desk.locator("li.item.trash", { hasText: LEAKED }).getAttribute("data-pub")) ?? "";
    assert.ok(leaked, "Leaked is in Trash");

    for (const { viewport, x, frameLeft } of WIDTHS) {
      const where = `${viewport.width}px`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
      const { page } = await ctx.newPage(viewport);
      const tops: { path: string; top: number }[] = [];
      for (const { path, url } of urls) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
        await page.goto(url);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
        const h1 = await h1Of(page);
        near(h1.left, x, 0.5, `${where} ${path}: the H1's left edge`);
        assert.equal(h1.size, "26px", `${where} ${path}: the H1 is 26 px`);
        assert.equal(h1.weight, "700", `${where} ${path}: the H1 is bold`);
        assert.equal(h1.scroll, viewport.width, `${where} ${path}: no horizontal scroll`);
        if (path.startsWith("/?q=") && viewport.width <= 760) {
          // Below 761 px a search shows its own query field first, then the H1 (NAV-03's
          // normative phone layout), so there the field takes the frame's top position.
          // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
          const field = await topOf(page, "main form.qfield");
          assert.ok(field.bottom <= h1.top, `${where} ${path}: the query field sits above the H1`);
          tops.push({ path: `${path} (query field)`, top: field.top });
        } else tops.push({ path, top: h1.top });
      }
      const [first] = tops;
      for (const { path, top } of tops)
        near(top, first!.top, 2, `${where} ${path}: the H1's top matches ${first!.path}`);

      if (viewport.width === 1280) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
        await page.goto(`${base}/trash`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
        const column = await boxOf(page, "main.wrap.narrow");
        assert.ok(column.width <= 760 + 64, `/trash: the narrow column is ${column.width} px`);
        near(column.left, 60, 0.5, "/trash: the narrow column starts at the frame's left edge");
      }

      // The in-Trash collection page: its title is in the bar, so main has a hero, not an h1.
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
      await page.goto(`${base}/c/${leaked}/`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
      const h1s = await page.locator("main h1").count();
      assert.equal(h1s, 0, `${where}: no h1 in the in-Trash main`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
      const main = await boxOf(page, "main.wrap.narrow");
      near(main.left, frameLeft, 0.5, `${where} in-Trash: main starts at the frame's left edge`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
      const hero = await boxOf(page, "main .hero");
      near(hero.left, x, 0.5, `${where} in-Trash: the hero starts at the frame's content edge`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at this width.
      const scroll = await page.evaluate("document.documentElement.scrollWidth");
      assert.equal(scroll, viewport.width, `${where} in-Trash: no horizontal scroll`);
    }

    // Classic scrollbars (desktop Chrome on Linux and Windows): Playwright's headless Chromium
    // hides them, so this browser keeps them. A long page's scrollbar narrows the body by 15 px;
    // the frame's left margin is measured against 100vw, so the H1 doesn't move.
    const classic = await chromium.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: true,
      args: ["--no-sandbox"],
      ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    onCleanup(() => classic.close());
    const bars = await classic.newPage({ viewport: { width: 1280, height: 800 } });
    const gutters: number[] = [];
    for (const { path, url } of urls) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await bars.goto(url);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const h1 = await h1Of(bars);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const width = await bars.evaluate("document.documentElement.clientWidth");
      const gutter = 1280 - Number(width);
      gutters.push(gutter);
      near(h1.left, 92, 0.5, `classic scrollbars ${path} (scrollbar ${gutter} px): the H1's left`);
      assert.ok(h1.scroll <= Number(width), `classic scrollbars ${path}: no horizontal scroll`);
    }
    await bars.goto(`${base}/c/${leaked}/`);
    near((await boxOf(bars, "main .hero")).left, 92, 0.5, "classic scrollbars in-Trash: the hero");
    assert.ok(
      gutters.some((gutter) => gutter > 0) && gutters.includes(0),
      `classic scrollbars: some pages scroll and some don't (scrollbars ${gutters.join(", ")})`,
    );
    await classic.close();

    // The skip link is the shared rule's (the writer's duplicate is gone): top left, ink on paper.
    await desk.goto(`${base}/`);
    await desk.keyboard.press("Tab");
    const skip = z
      .object({
        focused: z.boolean(),
        left: z.number(),
        top: z.number(),
        decoration: z.string(),
        background: z.string(),
        ink: z.string(),
      })
      .parse(
        await desk.evaluate(`(() => {
          const a = document.querySelector("a.skip");
          const r = a.getBoundingClientRect();
          const s = getComputedStyle(a);
          const probe = document.createElement("span");
          probe.style.color = "var(--ink)";
          document.body.append(probe);
          const ink = getComputedStyle(probe).color;
          probe.remove();
          return { focused: document.activeElement === a, left: r.left, top: r.top,
            decoration: s.textDecorationLine, background: s.backgroundColor, ink };
        })()`),
      );
    assert.ok(skip.focused, "Tab focuses the skip link first");
    near(skip.left, 8, 0.5, "the skip link's left");
    near(skip.top, 8, 0.5, "the skip link's top");
    assert.equal(skip.decoration, "none", "the skip link isn't underlined");
    assert.equal(skip.background, skip.ink, "the skip link has an ink background");
  },
};
export default scenario;
