// OW-10b: the health pill says whether the collection on screen is affected. On the seeded demo
// writer (only Postgres has trouble: #6 failed on #4, #7 uploading, stalled after about seven
// minutes), Webhook's pill says "1 failed elsewhere" on a neutral pill (a ring and "1 failed"
// below 1100 px, a 44 px ring-dot count on phones), Postgres's says "#6 failed" filled, global
// pages keep "1 failed", and the popover opens with This collection, then Elsewhere on this
// writer. The pill's own box is ≥ 44 px tall under a coarse pointer at every width and
// ≥ 44 × 44 up to 760 px with any pointer.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const WEBHOOK = "Webhook idempotency research";
const POSTGRES = "Postgres 17 upgrade runbook";
const CHECKOUT = "Checkout flow screenshot audit";
const LEAKED = "Leaked .env in run output (do not share)";
const PILL = "header.bar .health";
const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const texts = z.array(z.string());

/** The pill's visible words (hidden spans don't count), whitespace collapsed. */
async function visible(page: Page): Promise<string> {
  return (await page.locator(PILL).innerText()).replace(/\s+/g, " ").trim();
}
/** A token's computed colour, through a probe element so it compares with computed styles. */
async function token(page: Page, name: string): Promise<string> {
  return z.string().parse(
    await page.evaluate(`(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(${name})";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })()`),
  );
}
const styles = z.object({
  background: z.string(),
  border: z.string(),
  color: z.string(),
  icon: z.string().nullable(),
  iconShown: z.boolean(),
  ring: z.object({ shown: z.boolean(), style: z.string(), width: z.number() }).nullable(),
});
async function pillStyles(page: Page): Promise<z.infer<typeof styles>> {
  return styles.parse(
    await page.evaluate(`(() => {
      const pill = document.querySelector(${JSON.stringify(PILL)});
      const style = getComputedStyle(pill);
      const icon = pill.querySelector("svg.ic");
      const ring = pill.querySelector(".d.ring");
      const shown = (node) => !!node && getComputedStyle(node).display !== "none" &&
        node.getBoundingClientRect().width > 0;
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        color: style.color,
        icon: icon ? getComputedStyle(icon).color : null,
        iconShown: shown(icon),
        ring: ring ? { shown: shown(ring), style: getComputedStyle(ring).borderTopStyle,
          width: parseFloat(getComputedStyle(ring).borderTopWidth) } : null,
      };
    })()`),
  );
}
async function pillBox(page: Page): Promise<z.infer<typeof box>> {
  return box.parse(await page.locator(PILL).boundingBox());
}
/** NAV-04's probe: the points 21 px above and below the pill's centre land on the pill. */
async function probeHits(page: Page, where: string): Promise<void> {
  const hits = z.array(z.boolean()).parse(
    await page.evaluate(`(() => {
      const pill = document.querySelector(${JSON.stringify(PILL)});
      const r = pill.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return [y - 21, y + 21].map((py) => pill.contains(document.elementFromPoint(x, py)));
    })()`),
  );
  assert.deepEqual(hits, [true, true], `${where}: the pill owns 21 px above and below its centre`);
}
async function headerHeight(page: Page): Promise<number> {
  return z
    .number()
    .parse(
      await page.evaluate(`document.querySelector("header.bar").getBoundingClientRect().height`),
    );
}
/** The popover's section headings and each section's rows (first line | second line). */
async function popover(page: Page): Promise<{ headings: string[]; rows: string[][] }> {
  await page.locator(PILL).click();
  await page.locator("#health-pop").waitFor({ state: "visible" });
  return z.object({ headings: texts, rows: z.array(texts) }).parse(
    await page.evaluate(`(() => {
      const sections = [...document.querySelectorAll("#health-pop .hp")];
      const clean = (node) => (node ? node.textContent.replace(/\\s+/g, " ").trim() : "");
      return {
        headings: sections.map((section) => clean(section.querySelector("h3"))),
        rows: sections.map((section) => [...section.querySelectorAll(".hrows > li")].map(
          (li) => clean(li.querySelector("b") ?? li) + (li.querySelector("small") ? " | " + clean(li.querySelector("small")) : ""))),
      };
    })()`),
  );
}
/** Opens `url` and checks the pill's scope, visible words and accessible name. */
async function pillOn(
  page: Page,
  url: string,
  scope: string | null,
  words: string,
  name: string,
): Promise<void> {
  await page.goto(url);
  assert.equal(await page.locator(PILL).getAttribute("data-scope"), scope, `${url}: the scope`);
  assert.equal(await visible(page), words, `${url}: the pill's words`);
  assert.equal(
    await page.getByRole("button", { name, exact: true }).count(),
    1,
    `${url}: the pill's name starts with its words`,
  );
}
/** The collection page a link titled `title` on `listPath` opens. */
async function hrefOf(page: Page, base: string, listPath: string, title: string): Promise<string> {
  await page.goto(`${base}${listPath}`);
  const href = await page.locator("main a", { hasText: title }).first().getAttribute("href");
  assert.ok(href, `${listPath} links ${title}`);
  return new URL(href, page.url()).href;
}

const scenario: ViewerScenario = {
  name: "OW-10b the health pill says whether this collection is affected",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const webhook = await hrefOf(page, base, "/", WEBHOOK);
    const postgres = await hrefOf(page, base, "/", POSTGRES);
    const checkout = await hrefOf(page, base, "/", CHECKOUT);
    const leaked = await hrefOf(page, base, "/trash", LEAKED);

    // Global pages: the writer-wide pill, named by its words.
    await pillOn(page, `${base}/`, null, "1 failed", "1 failed: writer status");
    await pillOn(page, `${base}/status`, null, "1 failed", "1 failed: writer status");
    await page.locator(PILL).click();
    assert.equal(await page.locator("#health-pop .hp").count(), 0, "/status: OW-06b's popover");
    await page.keyboard.press("Escape");

    // Webhook, 1280: neutral, "1 failed elsewhere", a red alert icon.
    await page.goto(webhook);
    assert.equal(await visible(page), "1 failed elsewhere");
    assert.equal(await page.locator(PILL).getAttribute("data-scope"), "elsewhere");
    assert.equal(
      await page
        .getByRole("button", { name: "1 failed elsewhere: writer status", exact: true })
        .count(),
      1,
    );
    const away = await pillStyles(page);
    assert.equal(away.background, await token(page, "--surface"), "elsewhere: surface fill");
    assert.equal(away.border, await token(page, "--rule-2"), "elsewhere: --rule-2 border");
    assert.equal(away.color, await token(page, "--ink-2"), "elsewhere: --ink-2 words");
    assert.equal(away.icon, await token(page, "--failed"), "elsewhere: a red icon");
    assert.ok(away.iconShown, "elsewhere at 1280: the icon shows");
    assert.equal(away.ring?.shown, false, "elsewhere at 1280: no ring");

    // Its popover: This collection, then Elsewhere on this writer.
    const pop = await popover(page);
    assert.deepEqual(pop.headings, ["This collection", "Elsewhere on this writer"]);
    assert.deepEqual(pop.rows[0], ["All 3 revisions synced | Public links see #3, the latest."]);
    const elsewhere = pop.rows[1] ?? [];
    assert.equal(elsewhere[0], `${POSTGRES} #6 failed | Branch off #4 · readable here only`);
    assert.ok(
      elsewhere.length === 1 ||
        (elsewhere[1] ?? "").startsWith(`${POSTGRES} #7 stalled | No upload progress for `),
      `elsewhere rows: ${elsewhere.join(" / ")}`,
    );
    const failedLink = page.locator("#health-pop .hp").nth(1).getByRole("link", { name: POSTGRES });
    assert.ok(
      (await failedLink.first().getAttribute("href"))?.includes("/r/"),
      "the title links #6",
    );
    const retry = page.locator("#health-pop").getByRole("button", { name: "Retry #6" });
    assert.equal(await retry.getAttribute("data-n"), "6");
    assert.equal(await retry.getAttribute("data-title"), POSTGRES);
    assert.equal(
      await page.locator("#health-pop").getByRole("link", { name: "Open Status" }).count(),
      1,
    );
    const footer = (await page.locator("#health-pop .hpw").innerText()).replace(/\s+/g, " ");
    assert.ok(/^Last cloud sync .+ · 127\.0\.0\.1 · dev · Status$/.test(footer), footer);
    await page.keyboard.press("Escape");
    await page.locator("#health-pop").waitFor({ state: "hidden" });
    assert.ok(
      await page.evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(PILL)})`,
      ),
      "Esc returns focus to the pill",
    );

    // Changes, Gallery and the in-Trash page are scoped the same way.
    const latest = await page.evaluate(`document.querySelector("[data-latest]")?.dataset.latest`);
    assert.ok(typeof latest === "string", "the shell names its latest revision");
    const pub = new URL(webhook).pathname.split("/")[2];
    const awayName = "1 failed elsewhere: writer status";
    const changes = `${base}/c/${pub}/r/${latest}/changes`;
    await pillOn(page, changes, "elsewhere", "1 failed elsewhere", awayName);
    await pillOn(page, leaked, "elsewhere", "1 failed elsewhere", awayName);
    await page.goto(checkout);
    const gallery = await page.locator('a[href*="gallery/"]').first().getAttribute("href");
    assert.ok(gallery, "Checkout links its gallery");
    await page.goto(new URL(gallery, page.url()).href);
    assert.equal(await page.locator(PILL).getAttribute("data-scope"), "elsewhere", "gallery");

    // Postgres, 1280: filled red, "#6 failed", and its own rows.
    await page.goto(postgres);
    assert.equal(await visible(page), "#6 failed");
    assert.equal(await page.locator(PILL).getAttribute("data-scope"), "here");
    assert.equal(
      await page
        .getByRole("button", { name: "#6 failed: this collection and writer status", exact: true })
        .count(),
      1,
    );
    const here = await pillStyles(page);
    assert.equal(here.background, await token(page, "--failed-bg"), "here: filled red");
    assert.ok(here.iconShown && here.ring === null, "here: the alert icon, no ring");
    const own = await popover(page);
    assert.deepEqual(own.headings, ["This collection", "Elsewhere on this writer"]);
    const rows = own.rows[0] ?? [];
    assert.ok(
      rows[0]?.startsWith("#6 failed to sync | Branch off #4. The bucket didn't accept"),
      rows[0],
    );
    assert.ok(
      /^#7 (uploading \| Started |stalled \| No upload progress for )/.test(rows[1] ?? ""),
      rows[1],
    );
    assert.equal(rows[2], "#5 synced | Other machines see #5. No public links.");
    assert.deepEqual(own.rows[1], ["Everything else is synced"]);
    const ownRetry = page
      .locator("#health-pop .hp")
      .first()
      .getByRole("button", { name: "Retry #6" });
    assert.equal(await ownRetry.getAttribute("data-n"), "6");
    assert.equal(await ownRetry.getAttribute("data-title"), POSTGRES);
    assert.equal(
      await page.locator("#health-pop").getByRole("link", { name: "History" }).getAttribute("href"),
      "?panel=history",
    );
    assert.ok(!/stuck/i.test(await page.locator("#health-pop").innerText()), 'no "stuck"');
    await page.keyboard.press("Escape");

    // The "not public yet" preview of #6 has no panel: its popover's History follows the link
    // to the collection page with the History tab open.
    {
      await page.goto(webhook);
      const sixHref = z
        .string()
        .parse(
          await page
            .locator("#health-pop .hp")
            .nth(1)
            .locator("a", { hasText: POSTGRES })
            .first()
            .getAttribute("href"),
        );
      assert.ok(sixHref.includes("/r/"), "Webhook's popover links #6");
      await page.goto(`${new URL(sixHref, base).href}?as=public`);
      assert.equal(
        await page.locator("body").getAttribute("data-page"),
        "not-public",
        "#6 previews as not public",
      );
      assert.equal(await page.locator("#panel").count(), 0, "the preview has no panel");
      await page.locator(PILL).click();
      await page.locator("#health-pop").waitFor({ state: "visible" });
      await Promise.all([
        page.waitForURL(/[?&]panel=history/),
        page.locator("#health-pop").getByRole("link", { name: "History" }).click(),
      ]);
      await page.locator("#panel").waitFor({ state: "attached" });
      assert.ok(!page.url().includes("as=public"), `History leaves the preview: ${page.url()}`);
      assert.equal(
        await page.locator('#panel [role=tab][data-tab="history"]').getAttribute("aria-selected"),
        "true",
        "History opens on its tab",
      );
    }

    // 1280 with touch: the pill's own box is 44 px tall and the bar keeps its height (measured
    // against the same page without touch).
    await page.goto(webhook);
    const wideHeight = await headerHeight(page);
    {
      const touch = await ctx.newPage({ ...VIEWPORTS.desktop, touch: true });
      await touch.page.goto(webhook);
      assert.ok((await pillBox(touch.page)).height >= 44, "1280 touch: a 44 px pill");
      await probeHits(touch.page, "1280 touch");
      assert.equal(await headerHeight(touch.page), wideHeight, "1280 touch: the bar's height");
    }

    // 820: a ring and "1 failed"; with touch, 44 px tall and the bar unchanged.
    {
      const mouse = await ctx.newPage({ ...VIEWPORTS.tablet, touch: false });
      await mouse.page.goto(webhook);
      const mouseHeight = await headerHeight(mouse.page);
      const { page: tablet } = await ctx.newPage(VIEWPORTS.tablet);
      await tablet.goto(webhook);
      assert.equal(await visible(tablet), "1 failed", "820: the mid words");
      const ring = await pillStyles(tablet);
      assert.ok(ring.ring?.shown && !ring.iconShown, "820: the ring, not the icon");
      assert.equal(ring.ring.width, 2, "820: a 2 px ring");
      assert.equal(
        await tablet
          .getByRole("button", { name: "1 failed elsewhere: writer status", exact: true })
          .count(),
        1,
      );
      assert.ok((await pillBox(tablet)).height >= 44, "820 touch: a 44 px pill");
      await probeHits(tablet, "820 touch");
      assert.equal(await headerHeight(tablet), mouseHeight, "820 touch: the bar's height");
    }

    // 700 with a fine pointer: still a 44 × 44 box.
    {
      const { page: narrow } = await ctx.newPage({ width: 700, height: 900 });
      await narrow.goto(webhook);
      const size = await pillBox(narrow);
      assert.ok(size.width >= 44 && size.height >= 44, `700 mouse: ${size.width}×${size.height}`);
    }

    // Phones: a 44 × 44 ring-dot count; tapping it opens the sheet with both sections.
    {
      const { page: phone } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await phone.goto(webhook);
      assert.equal(await visible(phone), "1", "390: the count");
      assert.ok((await pillStyles(phone)).ring?.shown, "390: the ring");
      const size = await pillBox(phone);
      assert.ok(size.width >= 44 && size.height >= 44, `390: ${size.width}×${size.height}`);
      await phone.locator(PILL).tap();
      await phone.locator("#health-pop").waitFor({ state: "visible" });
      assert.deepEqual(await phone.locator("#health-pop .hp h3").allTextContents(), [
        "This collection",
        "Elsewhere on this writer",
      ]);
      await phone.goto(postgres);
      assert.equal(await visible(phone), "#6", "390 Postgres: #6");
      const pg = await pillStyles(phone);
      assert.ok(pg.iconShown && pg.ring === null, "390 Postgres: the alert icon");
      const pgSize = await pillBox(phone);
      assert.ok(
        pgSize.width >= 44 && pgSize.height >= 44,
        `390 Postgres: ${pgSize.width}×${pgSize.height}`,
      );
    }

    // Dark: the elsewhere pill stays neutral.
    {
      const { page: dark } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme: "dark" });
      await dark.goto(webhook);
      const looks = await pillStyles(dark);
      assert.equal(looks.background, await token(dark, "--surface"), "dark: surface fill");
      assert.equal(looks.border, await token(dark, "--rule-2"), "dark: --rule-2 border");
      assert.equal(looks.color, await token(dark, "--ink-2"), "dark: --ink-2 words");
      assert.equal(looks.icon, await token(dark, "--failed"), "dark: a red icon");
    }

    // Forced colours: the ring is a border, so it stays.
    {
      const { page: forced } = await ctx.newPage({ ...VIEWPORTS.tablet, forcedColors: "active" });
      await forced.goto(webhook);
      const ring = await pillStyles(forced);
      assert.ok(ring.ring?.shown, "forced colours: the ring shows");
      assert.equal(ring.ring.style, "solid", "forced colours: a solid ring");
      assert.ok(ring.ring.width >= 1, "forced colours: the ring has width");
    }
  },
};
export default scenario;
