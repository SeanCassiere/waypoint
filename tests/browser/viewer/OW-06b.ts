// OW-06b: Home and Status say the same word for the same revision. On the seeded demo writer
// (Postgres: #1–#5 synced, #6 failed on #4, #7 pending on #5, which reads uploading for about
// seven minutes after seeding and stalled after), Home's row chips, its Needs attention card,
// Status's group rows and the pill's popover agree; "stuck" appears nowhere; Retry #6 flashes and
// #6 then reads uploading everywhere. Phones get one-column cards with 44 px buttons.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const texts = z.array(z.string());
const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** The visible text of every match, trimmed and with whitespace collapsed. */
async function allText(page: Page, selector: string): Promise<string[]> {
  return texts.parse(
    await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.replace(/\\s+/g, " ").trim())`,
    ),
  );
}
/**
 * On Status, an 80-character unbroken collection title in the hero, the group header and the In
 * progress rows: the page still doesn't scroll sideways (the title wraps instead).
 */
async function unbrokenTitlesFit(page: Page, where: string): Promise<void> {
  const long = "W".repeat(80);
  const overflow = z
    .object({ hero: z.number(), wide: z.boolean(), projects: z.number(), clipped: z.number() })
    .parse(
      await page.evaluate(
        `(() => { const hero = document.querySelectorAll(".hero b"); hero.forEach((b) => { b.textContent = ${JSON.stringify(`${long} needs you.`)}; }); document.querySelectorAll(".sgrp h3 a, .srow .ct").forEach((a) => { a.textContent = ${JSON.stringify(long)}; }); document.querySelectorAll(".sgrp > header").forEach((header) => { let proj = header.querySelector(".proj"); if (!proj) { proj = document.createElement("span"); proj.className = "proj"; header.querySelector("h3").after(proj); } proj.textContent = ${JSON.stringify(`project_${"x".repeat(80)}`)}; }); const projects = [...document.querySelectorAll(".sgrp > header .proj")]; const clipped = projects.filter((proj) => { const header = proj.parentElement.getBoundingClientRect(); const box = proj.getBoundingClientRect(); return box.right > header.right + 0.5 || box.left < header.left - 0.5 || proj.scrollWidth > proj.clientWidth + 0.5; }).length; return { hero: hero.length, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth, projects: projects.length, clipped }; })()`,
      ),
    );
  assert.ok(overflow.hero > 0, `${where}: Status has a hero`);
  assert.equal(overflow.wide, false, `${where}: long unbroken titles don't scroll Status sideways`);
  assert.ok(overflow.projects > 0, `${where}: Status has a group with a project`);
  assert.equal(overflow.clipped, 0, `${where}: a long unbroken project fits its group header`);
}
async function noStuck(page: Page, where: string): Promise<void> {
  const text = z.string().parse(await page.evaluate(`document.body.textContent`));
  assert.ok(!/stuck/i.test(text), `${where}: no element says "stuck"`);
}

const scenario: ViewerScenario = {
  name: "OW-06b Home and Status say the same word for the same revision",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const postgresRow = "li.item";

    // Home: the row chips give #7's word w; the card's strip says the same.
    await page.goto(`${base}/`);
    const rowChips = (
      await page
        .locator(postgresRow, { hasText: POSTGRES })
        .first()
        .locator(".meta .chip.xs")
        .allTextContents()
    ).map((text) => text.trim());
    assert.ok(rowChips.includes("#6 failed"), `Home row chips: ${rowChips.join(" | ")}`);
    const seven = rowChips.find((text) => /^#7 (uploading|stalled)$/.test(text));
    assert.ok(seven, `Home row chips name #7: ${rowChips.join(" | ")}`);
    const w = seven.slice("#7 ".length);
    const card = page.locator(".attn .ag[data-attn-collection]", { hasText: POSTGRES });
    assert.equal(await card.count(), 1, "one Needs attention card for Postgres");
    const strip = (await allText(page, ".attn .ag .lin2 .sc")).filter((t) => /^#[67] /.test(t));
    assert.ok(strip.includes(`#7 ${w}`), `Home strip says #7 ${w}: ${strip.join(" | ")}`);
    assert.ok(strip.includes("#6 failed"), `Home strip says #6 failed: ${strip.join(" | ")}`);
    const lines = card.locator('.lin2[role="group"][aria-label="Revision lines"]');
    assert.equal(await lines.count(), 1, "the strip is a group named Revision lines");
    const retry = card.locator('button[data-action="retry"]');
    assert.equal((await retry.textContent())?.trim(), "Retry #6");
    assert.equal(await retry.getAttribute("data-n"), "6");
    assert.equal(await retry.getAttribute("data-title"), POSTGRES);
    const pub = await card.getAttribute("data-attn-collection");
    assert.equal(
      await card.getByRole("link", { name: "Details" }).getAttribute("href"),
      `/status#attn-${pub}`,
    );
    await noStuck(page, "Home");

    // Status: the group row and the pill's popover, in one page load.
    await page.goto(`${base}/status`);
    const group = page.locator(`section.sgrp#attn-${pub}`);
    assert.equal(await group.count(), 1, "Status has the Postgres group");
    const rowWords = await allText(page, `section.sgrp#attn-${pub} .srow .h .sc`);
    assert.ok(rowWords.includes(`#7 ${w}`), `Status rows say #7 ${w}: ${rowWords.join(" | ")}`);
    assert.ok(rowWords.includes("#6 failed"), `Status rows say #6 failed: ${rowWords.join(" | ")}`);
    const statusStrip = await allText(page, `section.sgrp#attn-${pub} .lin2 .sc`);
    assert.ok(statusStrip.includes(`#7 ${w}`), `Status strip: ${statusStrip.join(" | ")}`);
    const sixButtons = z
      .array(z.array(z.string().nullable()))
      .parse(
        await page.evaluate(
          `[...document.querySelectorAll("section.sgrp#attn-${pub} .srow")].filter((row) => row.querySelector(".h .sc").textContent.trim() === "#6 failed").flatMap((row) => [...row.querySelectorAll('button[data-action="retry"], button[data-action="drop"]')]).map((el) => [el.textContent.trim(), el.getAttribute("data-n"), el.getAttribute("data-title")])`,
        ),
      );
    assert.deepEqual(sixButtons, [
      ["Retry #6", "6", POSTGRES],
      ["Drop #6…", "6", POSTGRES],
    ]);
    await page.locator('header.bar [popovertarget="health-pop"]').click();
    const pop = page.locator("#health-pop");
    await pop.waitFor({ state: "visible" });
    const rows = z
      .array(z.tuple([z.string(), z.string()]))
      .parse(
        await page.evaluate(
          `[...document.querySelectorAll("#health-pop dt")].map((dt) => [dt.textContent.trim(), dt.nextElementSibling.textContent.replace(/\\s+/g, " ").trim()])`,
        ),
      );
    const row = (name: string) => rows.find(([dt]) => dt === name)?.[1];
    assert.ok(row("Failed")?.includes(`${POSTGRES} #6`), `popover Failed: ${row("Failed")}`);
    if (w === "stalled")
      assert.ok(row("Stalled")?.includes(`${POSTGRES} #7`), `popover Stalled: ${row("Stalled")}`);
    else {
      assert.equal(row("Stalled"), undefined, "nothing stalled in the popover");
      assert.ok(
        row("Uploading")?.startsWith("1 revision"),
        `popover Uploading: ${row("Uploading")}`,
      );
    }
    await noStuck(page, "Status");

    // Phones: the card is one column; Retry and Details are two 44 px buttons side by side.
    {
      const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await phone.page.goto(`${base}/`);
      const phoneCard = phone.page.locator(".attn .ag", { hasText: POSTGRES });
      const buttons = await Promise.all(
        [
          phoneCard.locator('button[data-action="retry"]'),
          phoneCard.getByRole("link", { name: "Details" }),
        ].map(async (target) => box.parse(await target.boundingBox())),
      );
      const [retryBox, detailsBox] = buttons;
      assert.ok(retryBox && detailsBox, "both buttons have boxes");
      for (const [name, at] of [
        ["Retry", retryBox],
        ["Details", detailsBox],
      ] as const)
        assert.ok(at.height >= 44, `${name} is ${at.height}px tall`);
      assert.ok(Math.abs(retryBox.y - detailsBox.y) < 1, "Retry and Details side by side");
      assert.ok(retryBox.x + retryBox.width <= detailsBox.x + 0.5, "Retry left of Details");
      const tracks = z
        .string()
        .parse(
          await phone.page.evaluate(
            `getComputedStyle(document.querySelector(".attn .ag .lin2")).gridTemplateColumns`,
          ),
        );
      assert.equal(tracks.split(" ").length, 1, `the strip is one column: ${tracks}`);
      const overflow = z
        .boolean()
        .parse(
          await phone.page.evaluate(
            `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
          ),
        );
      assert.equal(overflow, false, "Home doesn't scroll sideways on a phone");
      // Status: the three stat cards stack, and nothing scrolls sideways.
      await phone.page.goto(`${base}/status`);
      const stats = z
        .string()
        .parse(
          await phone.page.evaluate(
            `getComputedStyle(document.querySelector("main .grid3")).gridTemplateColumns`,
          ),
        );
      assert.equal(stats.split(" ").length, 1, `the stat cards stack: ${stats}`);
      const statusOverflow = z
        .boolean()
        .parse(
          await phone.page.evaluate(
            `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
          ),
        );
      assert.equal(statusOverflow, false, "Status doesn't scroll sideways on a phone");
      await unbrokenTitlesFit(phone.page, "390 px");
      const tablet = await ctx.newPage({ ...VIEWPORTS.tablet, mobile: true });
      await tablet.page.goto(`${base}/status`);
      await unbrokenTitlesFit(tablet.page, "820 px");
    }

    // Retry #6 on Home: the flash names it, and after the reload #6 is uploading everywhere.
    await page.goto(`${base}/`);
    await Promise.all([
      page.waitForEvent("load"),
      card.locator('button[data-action="retry"]').click(),
    ]);
    const flash = page.locator('[data-toast-slot="success"][role=status]');
    await flash.waitFor({ state: "visible" });
    assert.equal(
      (await flash.locator(".tt").textContent())?.trim(),
      `Retrying #6 of “${POSTGRES}”`,
    );
    const after = z
      .string()
      .parse(await page.evaluate(`document.querySelector("main").textContent`));
    assert.ok(
      !after.includes("#6 stalled") && !after.includes("#6 failed"),
      "Home: #6 isn't stalled or failed",
    );
    const chipsAfter = (
      await page
        .locator(postgresRow, { hasText: POSTGRES })
        .first()
        .locator(".meta .chip.xs")
        .allTextContents()
    ).map((text) => text.trim());
    assert.ok(
      chipsAfter.includes("#6 uploading"),
      `Home chips after Retry: ${chipsAfter.join(" | ")}`,
    );
    await noStuck(page, "Home after Retry");
    await page.goto(`${base}/status`);
    const statusAfter = await allText(page, "main .srow .h .sc");
    assert.ok(
      statusAfter.includes("#6 uploading"),
      `Status after Retry: ${statusAfter.join(" | ")}`,
    );
    assert.ok(
      !statusAfter.includes("#6 failed") && !statusAfter.includes("#6 stalled"),
      `Status after Retry: ${statusAfter.join(" | ")}`,
    );
    await noStuck(page, "Status after Retry");
  },
};
export default scenario;
