// NAV-03: search results. Phones get the query field in the page (16 px, Enter searches, "/"
// focuses it) and the Browse chip row (44 px, scrolling sideways) instead of the sidebar; wider
// screens keep the sidebar and the bar's field. Each filter chip's × goes to the query without
// that token. The writer is shared, so this scenario finds its rows by its unique word.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, VIEWPORTS, type AxeViolation, type ViewerScenario } from "../harness.ts";

const WORD = "navthreesundew";
const PROJECTS = [
  "nav03-alpha",
  "nav03-bravo",
  "nav03-charlie",
  "nav03-delta",
  "nav03-echo",
  "nav03-foxtrot",
];

/** axe with the brief's rules on the whole page. The bar's health pill is named "Writer status:
 *  …", not by its visible text (a known label-content-name-mismatch on that one node): OW-10b
 *  fixes the pill and removes this filter. */
async function searchAxe(page: Page): Promise<AxeViolation[]> {
  const violations = await axe(page, {
    enable: ["label-content-name-mismatch"],
    rules: [
      "label-content-name-mismatch",
      "list",
      "listitem",
      "region",
      "nested-interactive",
      "link-name",
    ],
  });
  for (const violation of violations)
    if (violation.id === "label-content-name-mismatch")
      violation.nodes = violation.nodes.filter((node) => node.target.join(" ") !== ".health");
  return violations.filter((violation) => violation.nodes.length > 0);
}

const LongChip = z.object({
  page: z.number(),
  pageClient: z.number(),
  main: z.number(),
  chips: z.array(z.object({ left: z.number(), right: z.number() })),
  removes: z.array(z.object({ left: z.number(), right: z.number() })),
  viewport: z.number(),
});

/** A long free-text query and a long project name: each chip stays inside the main column (its
 *  label ends in an ellipsis) with its × in view, and the page doesn't scroll sideways. */
async function checkLongChips(page: Page, base: string, label: string): Promise<void> {
  const long =
    "a realistic long search query with many words that can easily be pasted into search";
  const q = `${long} project:"a really long project name that keeps going and going" is:shared`;
  await page.goto(`${base}/?q=${encodeURIComponent(q)}`);
  const box = LongChip.parse(
    await page.evaluate(`(() => {
      const main = document.querySelector(".home > main").getBoundingClientRect();
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - main.left, right: r.right - main.left };
      };
      return {
        page: document.documentElement.scrollWidth,
        pageClient: document.documentElement.clientWidth,
        main: main.width,
        chips: [...document.querySelectorAll("ul.fchips > li")].map(rect),
        removes: [...document.querySelectorAll("ul.fchips > li > a")].map((a) => {
          const r = a.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
        viewport: window.innerWidth,
      };
    })()`),
  );
  assert.equal(box.chips.length, 3, `${label}: three chips`);
  assert.ok(box.page <= box.pageClient, `${label}: the page doesn't scroll sideways`);
  for (const [index, chip] of box.chips.entries())
    assert.ok(
      chip.left >= -0.5 && chip.right <= box.main + 0.5,
      `${label}: chip ${index} stays inside the main column (${chip.left}–${chip.right} of ${box.main})`,
    );
  for (const [index, remove] of box.removes.entries())
    assert.ok(
      remove.left >= 0 && remove.right <= box.viewport,
      `${label}: chip ${index}'s × is in view (${remove.left}–${remove.right})`,
    );
  const removeFree = page.getByRole("link", { name: `Remove “${long}”`, exact: true });
  assert.equal(await removeFree.isVisible(), true, `${label}: the long chip's × is visible`);
}

async function isActive(page: Page, selector: string): Promise<boolean> {
  return z
    .boolean()
    .parse(
      await page.evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
      ),
    );
}

const scenario: ViewerScenario = {
  name: "NAV-03 search results: removable chips, the phone field and the Browse row",
  async run(ctx) {
    const { base } = ctx.writer;
    // Two results for WORD in different projects, and enough projects that the Browse row scrolls.
    for (const [index, project] of PROJECTS.entries()) {
      const title = index < 2 ? `${WORD} plan ${index}` : `Nav03 notes ${index}`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Seeded in order, one write at a time.
      await ctx.writer.api("/api/collections", {
        title,
        metadata: { project },
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        files: [await ctx.writer.write("index.md", `# ${title}\n`)],
      });
    }
    const search = `${base}/?q=${WORD}`;

    // Phone: the field shows above the H1 with the query, 16 px, and Enter searches.
    const { page: tap } = await ctx.newPage(VIEWPORTS.phone);
    await tap.goto(search);
    const field = tap.locator("form.qfield input");
    assert.equal(await field.isVisible(), true, "390: the inline field is visible");
    assert.equal(await field.inputValue(), WORD, "390: the field holds the query");
    const size = z
      .object({ font: z.number(), height: z.number(), fieldTop: z.number(), h1Top: z.number() })
      .parse(
        await tap.evaluate(`(() => {
          const input = document.querySelector("form.qfield input");
          return {
            font: parseFloat(getComputedStyle(input).fontSize),
            height: input.getBoundingClientRect().height,
            fieldTop: input.getBoundingClientRect().top,
            h1Top: document.querySelector("#results-title").getBoundingClientRect().top,
          };
        })()`),
      );
    assert.ok(size.font >= 16, `390: the field's font is at least 16 px (${size.font})`);
    assert.ok(size.height >= 44, `390: the field is at least 44 px tall (${size.height})`);
    assert.ok(size.fieldTop < size.h1Top, "390: the field sits above the H1");
    assert.equal(await tap.locator("aside.side").isVisible(), false, "390: no sidebar");
    assert.equal(await tap.locator("nav.browse").isVisible(), true, "390: the Browse row shows");
    assert.deepEqual(await searchAxe(tap), [], `axe on /?q=${WORD} (390)`);

    // "/" with focus outside the field focuses it; Find stays closed.
    await tap.evaluate(`document.activeElement?.blur()`);
    await tap.keyboard.press("/");
    assert.equal(await isActive(tap, "form.qfield input"), true, "390: / focuses the field");
    assert.equal(await tap.locator("dialog#find[open]").count(), 0, "390: Find stays closed");

    await field.fill(`${WORD} plan 1`);
    await field.press("Enter");
    await tap.waitForURL(
      (url) =>
        url.pathname === "/" &&
        url.searchParams.get("q") === `${WORD} plan 1` &&
        !url.searchParams.has("cursor"),
    );
    assert.equal(await tap.locator("#results-title").textContent(), "1 collection");

    // Phone, Recent: the Browse row after Needs attention, 44 px chips, scrolling sideways
    // inside itself only; the sidebar is hidden.
    await tap.goto(`${base}/`);
    const browse = tap.locator("nav.browse");
    assert.equal(await browse.isVisible(), true, "390 /: the Browse row shows");
    assert.equal(await tap.locator("aside.side").isVisible(), false, "390 /: no sidebar");
    assert.equal(
      await browse.getByRole("heading", { level: 2 }).textContent(),
      "Browse",
      "390 /: the row is headed Browse",
    );
    const row = z
      .object({
        heights: z.array(z.number()),
        scroll: z.number(),
        client: z.number(),
        page: z.number(),
        pageClient: z.number(),
        beforeGroups: z.boolean(),
      })
      .parse(
        await tap.evaluate(`(() => {
          const list = document.querySelector("nav.browse ul");
          const groups = document.querySelector("[data-groups]");
          return {
            heights: [...list.querySelectorAll("a")].map((a) => a.getBoundingClientRect().height),
            scroll: list.scrollWidth,
            client: list.clientWidth,
            page: document.documentElement.scrollWidth,
            pageClient: document.documentElement.clientWidth,
            beforeGroups: Boolean(
              document.querySelector("nav.browse").compareDocumentPosition(groups) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          };
        })()`),
      );
    assert.ok(row.heights.length >= 6, "390 /: at least 6 chips");
    assert.ok(
      row.heights.every((height) => height >= 44),
      `390 /: every chip is at least 44 px tall (${row.heights.join(", ")})`,
    );
    assert.ok(row.scroll > row.client, "390 /: the row scrolls sideways");
    assert.ok(row.page <= row.pageClient, "390 /: the page doesn't scroll sideways");
    assert.equal(row.beforeGroups, true, "390 /: the row comes before the day groups");
    // Scrolled to the end, the last chip sits left of the 40 px fade, so it shows in full.
    const end = z.object({ last: z.number(), fade: z.number() }).parse(
      await tap.evaluate(`(() => {
          const list = document.querySelector("nav.browse ul");
          list.scrollLeft = list.scrollWidth;
          const box = list.getBoundingClientRect();
          const chips = list.querySelectorAll("a");
          return {
            last: chips[chips.length - 1].getBoundingClientRect().right,
            fade: box.right - 40,
          };
        })()`),
    );
    assert.ok(
      end.last <= end.fade,
      `390 /: at the end of the row the last chip clears the fade (${end.last} <= ${end.fade})`,
    );

    // Long chips truncate inside the column on a phone and on a tablet.
    await checkLongChips(tap, base, "390 long");
    const { page: tablet } = await ctx.newPage(VIEWPORTS.tablet);
    await checkLongChips(tablet, base, "820 long");

    // Desktop: the inline field is hidden, the sidebar shows, "/" focuses the bar's field.
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(search);
    assert.equal(await page.locator("form.qfield").isVisible(), false, "1280: no inline field");
    assert.equal(await page.locator("aside.side").isVisible(), true, "1280: the sidebar shows");
    assert.equal(await page.locator("nav.browse").isVisible(), false, "1280: no Browse row");
    await page.locator("#results-title").click();
    await page.keyboard.press("/");
    assert.equal(
      await isActive(page, "header.bar form.search input"),
      true,
      "1280: / focuses the bar's field",
    );
    assert.deepEqual(await searchAxe(page), [], `axe on /?q=${WORD} (1280)`);

    // Each × goes to the query without its token; the H1 follows.
    await page.goto(`${base}/?q=${encodeURIComponent(`${WORD} project:${PROJECTS[0]}`)}`);
    assert.equal(await page.locator("#results-title").textContent(), "1 collection");
    const remove = page.getByRole("link", { name: `Remove Project ${PROJECTS[0]}`, exact: true });
    assert.equal(await remove.count(), 1, "1280: the project chip's × is named Remove …");
    await remove.click();
    await page.waitForURL((url) => url.searchParams.get("q") === WORD);
    assert.equal(await page.locator("#results-title").textContent(), "2 collections");
    assert.deepEqual(
      await page.locator("ul.fchips > li").allTextContents(),
      [`“${WORD}”`],
      "1280: only the free-text chip is left",
    );
    await page.getByRole("link", { name: `Remove “${WORD}”`, exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/" && url.search === "");
  },
};
export default scenario;
