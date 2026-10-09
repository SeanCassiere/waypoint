// RX-10: ?as=public says which revision a Latest or Only link shows, in a public-coloured band
// right after the skip link (not sticky, one line on phones), and a failed or uploading target
// gets an honest explanation instead. On the seeded demo writer: Postgres #1–#5 synced, #6 failed
// (a branch off #4), #7 uploading.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const BAND = '[role="region"][aria-label="Public preview"][data-preview-banner][data-preview-band]';
const SYNCING =
  "Public preview · A Latest link shows #5, the newest revision that has synced. Recipients see a “newer version is being synced” note until #7 finishes uploading.";

const collectionsOf = z.object({
  collections: z.array(z.object({ id: z.string(), public_id: z.string(), title: z.string() })),
});
const revisionsOf = z.object({
  revisions: z.array(
    z.object({ id: z.string(), public_id: z.string(), display_number: z.number() }),
  ),
});
const bandOf = z.object({
  next: z.boolean(),
  text: z.string(),
  height: z.number(),
  position: z.string(),
  background: z.string(),
  publicBg: z.string(),
  textHeight: z.number(),
  lineHeight: z.number(),
  start: z.number(),
  title: z.number(),
  back: z.object({ height: z.number(), href: z.string() }),
});
// The band's geometry and colours; the public background is normalised to rgb through a probe.
const BAND_STATE = `(() => {
  const band = document.querySelector(${JSON.stringify(BAND)});
  const style = getComputedStyle(band);
  const probe = document.createElement("div");
  probe.style.backgroundColor = "var(--public-bg)";
  document.body.append(probe);
  const publicBg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const t = band.querySelector(".wp-pv-t");
  const back = band.querySelector("a.wp-pv-back");
  return {
    next: document.querySelector("a.skip").nextElementSibling === band,
    text: band.innerText,
    height: band.getBoundingClientRect().height,
    position: style.position,
    background: style.backgroundColor,
    publicBg,
    textHeight: t.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(t).lineHeight),
    start: band.querySelector(".wp-pv-in > svg.ic").getBoundingClientRect().left,
    title: document.querySelector(".lh h1").getBoundingClientRect().left,
    back: { height: back.getBoundingClientRect().height, href: back.href },
  };
})()`;
/** The tab strip's file links: two or more is the case where the shell centres the current tab. */
const TABS = `document.querySelectorAll(".ptabs2 a[data-p]").length`;
/** Whether the strip's current tab is inside the strip's visible box. */
const CURRENT_TAB_SHOWN = `(() => {
  const s = document.querySelector(".ptabs2").getBoundingClientRect();
  const t = document.querySelector(".ptabs2 a[aria-current]").getBoundingClientRect();
  return t.left >= s.left - 1 && t.right <= s.right + 1;
})()`;
const bandState = async (page: Page) => bandOf.parse(await page.evaluate(BAND_STATE));
const focused = async (page: Page): Promise<string> =>
  z.string().parse(await page.evaluate("document.activeElement?.textContent?.trim() ?? ''"));
/** The URL without `?as=public`. */
const owner = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete("as");
  return url.href;
};

const scenario: ViewerScenario = {
  name: "RX-10 public preview band names the revision; failed and uploading targets explain",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const found = collectionsOf.parse(
      await (await writer.fetch(`/api/collections?query=${encodeURIComponent(POSTGRES)}`)).json(),
    );
    const pg = found.collections.find((collection) => collection.title === POSTGRES);
    if (!pg) throw new Error("no Postgres collection on the demo writer");
    const { revisions } = revisionsOf.parse(
      await (await writer.fetch(`/api/collections/${pg.id}/revisions`)).json(),
    );
    const rev = (n: number) => {
      const revision = revisions.find((each) => each.display_number === n);
      if (!revision) throw new Error(`no Postgres #${n}`);
      return revision;
    };
    const latest = `${base}/c/${pg.public_id}/?as=public`;
    const pinned = (n: number) => `${base}/c/${pg.public_id}/r/${rev(n).public_id}/?as=public`;

    // Phone, touch: after the skip link, one 40–48 px line, a 44 px Back, the public colour.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await page.goto(latest);
      const band = await bandState(page);
      assert.ok(band.next, "the band is the skip link's next sibling");
      // A real first Tab from load, on a shell page with a tab strip: the shell centres the current
      // tab without moving the sequential focus starting point (decision d-1).
      assert.ok(Number(await page.evaluate(TABS)) >= 2, "Postgres has a tab strip");
      assert.equal(await page.evaluate(CURRENT_TAB_SHOWN), true, "the current tab is in view");
      await page.keyboard.press("Tab");
      assert.equal(await focused(page), "Skip to document");
      await page.keyboard.press("Tab");
      assert.equal(await focused(page), "Back to #7");
      assert.ok(band.height >= 40 && band.height <= 48, `a ${band.height}px phone band`);
      assert.ok(
        band.textHeight <= band.lineHeight + 1,
        `the band text takes ${band.textHeight}px (line ${band.lineHeight}px)`,
      );
      assert.ok(band.text.includes("Public preview · Latest links show #5"), band.text);
      assert.ok(band.back.height >= 44, `a ${band.back.height}px Back on touch`);
      assert.equal(owner(band.back.href), owner(page.url()));
      assert.notEqual(band.position, "sticky");
      assert.equal(band.background, band.publicBg);
      // The band and the letterhead switch to phone padding at the same width (PHONE_MAX).
      assert.ok(Math.abs(band.start - band.title) <= 2, `band ${band.start}, title ${band.title}`);
    }

    // Desktop: the full sentence, lined up with the letterhead title, the same colours in dark.
    const desktop = async (colorScheme: "light" | "dark") => {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme });
      await page.goto(latest);
      const band = await bandState(page);
      assert.ok(band.text.includes(SYNCING), band.text);
      assert.ok(Math.abs(band.start - band.title) <= 2, `band ${band.start}, title ${band.title}`);
      assert.ok(band.height >= 40, `a ${band.height}px band`);
      assert.notEqual(band.position, "sticky");
      assert.equal(band.background, band.publicBg);
      if (colorScheme === "light") {
        // The first Tab from load reaches the skip link and the second the band's Back, with the
        // current tab centred in the strip (decision d-1) and the page not scrolled.
        assert.ok(Number(await page.evaluate(TABS)) >= 2, "Postgres has a tab strip");
        assert.equal(await page.evaluate(CURRENT_TAB_SHOWN), true, "the current tab is in view");
        await page.keyboard.press("Tab");
        assert.equal(await focused(page), "Skip to document");
        await page.keyboard.press("Tab");
        assert.equal(await focused(page), "Back to #7");
        assert.equal(await page.evaluate("document.scrollingElement.scrollTop"), 0);
        assert.deepEqual(await axe(page), []);
        // Back goes to the owner's view of the revision they came from.
        await page.getByRole("link", { name: "Back to #7" }).click();
        await page.locator("[data-viewer]").waitFor();
        assert.equal(new URL(page.url()).search, "");
        assert.equal(
          await page.locator("[data-viewer]").getAttribute("data-revision"),
          rev(7).public_id,
        );
      }
    };
    await desktop("light");
    await desktop("dark");

    // An Only link's band.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.goto(pinned(3));
      const region = page.locator(BAND);
      assert.equal(await region.getAttribute("data-preview-band"), "pinned");
      assert.ok(
        (await region.innerText()).includes(
          "An Only #3 link shows this revision. It won't change.",
        ),
      );
    }

    // The failed target: facts, Retry, the Latest preview, and what a Retry can change. axe finds
    // nothing but the bar's health pill (its aria-label doesn't start with its visible text): that
    // is layout's, and OW-10b renames it and removes this filter.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.goto(pinned(6));
      await page
        .locator('[data-preview="failed"]')
        .getByText("#6 failed to upload, so no public link can show it.")
        .waitFor();
      const labels = await page.locator(".pv-facts li > b").allTextContents();
      assert.equal(labels.length, 3);
      assert.ok(labels[0]?.startsWith("Latest links show"), labels[0]);
      assert.ok(labels[1]?.startsWith("#6 · Branch off #4"), labels[1]);
      assert.ok(labels[2]?.startsWith("#7 · latest"), labels[2]);
      const retry = page.getByRole("button", { name: "Retry #6" });
      assert.equal(await retry.getAttribute("data-action"), "retry");
      assert.equal(await retry.getAttribute("data-ids"), rev(6).id);
      assert.equal(await page.locator("[data-preview-disclosure]").count(), 1);
      const violations = (await axe(page)).filter(
        (violation) =>
          violation.id !== "label-content-name-mismatch" ||
          violation.nodes.some((node) => !/^<button[^>]* class="health\b/.test(node.html)),
      );
      assert.deepEqual(violations, []);
      const preview = page.getByRole("link", { name: "Preview #5, what the public sees" });
      assert.equal(await preview.getAttribute("href"), `/c/${pg.public_id}/?as=public`);
      await preview.click();
      await page.locator(BAND).waitFor();
      assert.ok((await page.locator(BAND).innerText()).includes("shows #5"));
    }

    // The failed target on a phone: an unbroken cause wraps inside its row, with the icon on the
    // first line, and the page doesn't scroll sideways.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await page.goto(pinned(6));
      await page.locator('[data-preview="failed"]').waitFor();
      const row = await page.evaluate(`(() => {
        const li = document.querySelectorAll(".pv-facts li")[1];
        li.querySelector("span").textContent =
          "failed · https://example.com/blobs/sha256/" + "9c41".repeat(16) + "…";
        const top = (el) => el.getBoundingClientRect().top - li.getBoundingClientRect().top;
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rowRight: li.getBoundingClientRect().right,
          width: document.documentElement.clientWidth,
          icon: top(li.querySelector("svg.ic")),
          lines: li.querySelector("span").getBoundingClientRect().height,
        };
      })()`);
      const shape = z
        .object({
          overflow: z.number(),
          rowRight: z.number(),
          width: z.number(),
          icon: z.number(),
          lines: z.number(),
        })
        .parse(row);
      assert.ok(shape.overflow <= 0, `the failed page scrolls ${shape.overflow}px sideways`);
      assert.ok(shape.rowRight <= shape.width, `the cause row ends at ${shape.rowRight}px`);
      assert.ok(shape.lines > 20, `the cause wraps (${shape.lines}px)`);
      assert.ok(shape.icon <= 4, `the alert icon sits ${shape.icon}px below the row's first line`);
    }

    // The uploading target.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.goto(pinned(7));
      const main = page.locator("main");
      await main.getByText("#7 isn't public yet.").waitFor();
      assert.equal(
        await main.getByRole("link", { name: "Preview #5, what the public sees" }).count(),
        1,
      );
    }
  },
};
export default scenario;
