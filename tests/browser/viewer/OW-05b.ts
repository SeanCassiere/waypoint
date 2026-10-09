// OW-05b: /links tells the truth. A row revoked there reads Revoked with its push note, with no
// reload, and the header, the segment counts and Revoke all follow the refresh (OW-04). On a
// phone, every row's actions are 44 px controls in a 4-column grid, and nothing scrolls
// sideways. Counts need live links, which the shared writer (sync off) never has, so this
// scenario runs its own seeded demo writer: 4 live links on 3 collections, 1 paused, 1 expired,
// 1 revoked. "Design review — Sam" expires 2 h after seeding, so the counts are read, not pinned.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const LEADERSHIP = "Leadership preview";
const PAUSED = "Vendor debug";
const RULES = {
  rules: ["label-content-name-mismatch", "list", "listitem"],
  enable: ["label-content-name-mismatch"],
};
const rect = z.object({ top: z.number(), left: z.number(), height: z.number() });

/** Waits until a node's text is `text` (counts land with the refresh), then asserts it. */
async function textBecomes(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    `document.querySelector(${JSON.stringify(selector)})?.textContent === ${JSON.stringify(text)}`,
  );
  assert.equal(await page.locator(selector).textContent(), text, selector);
}
/**
 * Gives the first group header an unbroken 160-character project, then checks that no group
 * clips its content (groups hide overflow for their rounded corners).
 */
async function expectNoClippedGroup(page: Page, width: string): Promise<void> {
  const clipped = z.array(z.string()).parse(
    await page.evaluate(`(() => {
      const meta = document.querySelector(".lgrp .lgh .p");
      if (meta) meta.textContent = "${"p".repeat(160)} · now #3";
      return [...document.querySelectorAll(".lgrp")]
        .filter((group) => group.scrollWidth > group.clientWidth)
        .map((group) => group.querySelector("h2")?.textContent ?? "?");
    })()`),
  );
  assert.ok(
    (await page.locator(".lgrp .lgh .p").count()) > 0,
    `a group header shows a project or revision at ${width}`,
  );
  assert.deepEqual(clipped, [], `no group clips a long project at ${width}`);
}
/**
 * At 820, opens Extend… on an expiring live row dressed as a waiting Latest link (the longest
 * facts: "Latest · nothing synced yet" and "Opens when #3 syncs"), then checks that the row's
 * label and facts neither overflow nor run under the open popover (review r3).
 */
async function expectExtendBesideFacts(page: Page): Promise<void> {
  const rowSelector = '.lrow[data-link-status="active"]:has(details.act)';
  await page.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(`${rowSelector} .s [data-shows]`)});
    target.lastChild.textContent = "Latest · nothing synced yet";
    const waiting = document.createElement("span");
    waiting.className = "chip xs waiting";
    waiting.setAttribute("data-link-state", "waiting");
    waiting.textContent = "Opens when #3 syncs";
    target.after(waiting);
  })()`);
  const row = page.locator(rowSelector).first();
  await row.getByText("Extend…").click();
  await row.locator(".pop").waitFor();
  const layout = z
    .object({ overflowing: z.array(z.string()), underPopover: z.array(z.string()) })
    .parse(
      await page.evaluate(`(() => {
        const row = document.querySelector(${JSON.stringify(rowSelector)});
        const acts = row.querySelector(".acts").getBoundingClientRect();
        const facts = [...row.querySelectorAll(".who, .s > *")];
        return {
          overflowing: facts
            .filter((fact) => fact.scrollWidth > fact.clientWidth)
            .map((fact) => fact.textContent.trim()),
          underPopover: facts
            .filter((fact) => fact.getBoundingClientRect().right > acts.left + 0.5)
            .map((fact) => fact.textContent.trim()),
        };
      })()`),
    );
  assert.deepEqual(layout.overflowing, [], "no label or fact overflows with Extend… open at 820");
  assert.deepEqual(layout.underPopover, [], "the facts stay clear of the open Extend… at 820");
  assert.equal(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
    "no horizontal scroll with Extend… open at 820",
  );
}
/**
 * On a phone, checks that every visible `.lrow .acts` control's contents (icon and label, measured
 * with a Range, so overflow on either side of centred content counts) stay inside its borders
 * (review r4). `scrollWidth` alone misses content that spills left of a centred flex box.
 */
async function expectControlsFit(page: Page, label: string): Promise<void> {
  const spilled = z.array(z.string()).parse(
    await page.evaluate(`[...document.querySelectorAll(".lrow .acts > :is(.btn, .txtbtn), .lrow .acts > details > summary")]
      .filter((control) => control.getClientRects().length > 0)
      .filter((control) => {
        const box = control.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(control);
        const content = range.getBoundingClientRect();
        const left = box.left + control.clientLeft;
        const right = left + control.clientWidth;
        return content.left < left - 0.5 || content.right > right + 0.5;
      })
      .map((control) => control.textContent.trim())`),
  );
  assert.deepEqual(spilled, [], `every phone control's label stays inside it (${label})`);
}
const width = (cell?: { left: number; right: number }): number =>
  (cell?.right ?? 0) - (cell?.left ?? 0);
const number = async (page: Page, selector: string): Promise<number> =>
  Number(await page.locator(selector).textContent());

const scenario: ViewerScenario = {
  name: "OW-05b /links: a row revoke updates in place; the phone action grid",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(`${base}/links`);
    const head = '[data-refresh="links-head"] b';
    const live = await number(page, '[data-count-of="active"]');
    const revoked = await number(page, '[data-count-of="revoked"]');
    const bold = (await page.locator(head).textContent()) ?? "";
    const links = Number(/^(\d+) links? on /.exec(bold)?.[1]);
    assert.equal(links, live, `the header counts the Live segment's links: ${bold}`);
    assert.ok(live >= 3, `the seeded live links: ${live}`);
    assert.deepEqual(await axe(page, RULES), [], "axe on /links");
    // Sections named by their h2 (the collection titles), rows as list items.
    assert.ok(
      (await page.getByRole("region", { name: "Q4 onboarding revamp" }).count()) === 1,
      "Q4 onboarding's group is a section named by its heading",
    );

    // Revoke Leadership preview (Q4 onboarding's only live link): no reload; the row reads
    // Revoked with its push note; the counts, the header and Revoke all follow the refresh.
    await page.evaluate("window.__ow05 = 1");
    const row = page.locator(".lrow", { hasText: LEADERSHIP });
    const revoke = row.getByRole("button", { name: "Revoke…" });
    assert.equal(
      await revoke.getAttribute("aria-describedby"),
      await row.locator(".who").getAttribute("id"),
      "Revoke… is described by the row's label",
    );
    await revoke.click();
    await page.locator("#confirm [data-confirm-ok]").click();
    await page.locator(".lrow[data-refreshed]", { hasText: LEADERSHIP }).waitFor();
    assert.equal(await page.evaluate("window.__ow05"), 1, "no reload");
    assert.equal(await row.getAttribute("data-link-status"), "revoked");
    assert.equal(await row.locator("[data-link-state]").textContent(), "Revoked");
    assert.equal(await row.locator(".acts").count(), 0, "the row has no actions left");
    assert.match(
      (await row.locator("[data-stops]").textContent()) ?? "",
      /^(Revoked, not yet pushed\. Public access continues until it syncs\.|Public access stops within seconds\.)$/,
    );
    await textBecomes(page, '[data-count-of="active"]', String(live - 1));
    await textBecomes(page, '[data-count-of="revoked"]', String(revoked + 1));
    await page.waitForFunction(
      `document.querySelector(${JSON.stringify(head)})?.textContent.startsWith(${JSON.stringify(`${live - 1} link`)})`,
    );
    const after = (await page.locator(head).textContent()) ?? "";
    // Q4 onboarding had only that live link.
    if (live === 4) assert.equal(after, "3 links on 2 collections");
    else assert.ok(after.startsWith(`${live - 1} link`), after);
    if (live - 1 >= 2)
      await textBecomes(
        page,
        "[data-refresh=links-foot] [data-action=revoke-all]",
        `Revoke all ${live - 1} live links…`,
      );

    // A long unbroken project wraps inside its group header: nothing is clipped (review r1).
    await expectNoClippedGroup(page, "1280");

    // Revoking a paused link drops its restore note: a revoked link never works again (review r1).
    await page.goto(`${base}/links?state=paused`);
    const pausedRow = page.locator(".lrow", { hasText: PAUSED });
    assert.match((await pausedRow.textContent()) ?? "", /Restoring asks before it works again\./);
    await pausedRow.getByRole("button", { name: "Revoke…" }).click();
    await page.locator("#confirm [data-confirm-ok]").click();
    await page.locator('.lrow[data-link-status="revoked"]', { hasText: PAUSED }).waitFor();
    assert.equal(await pausedRow.locator("[data-link-state]").textContent(), "Revoked");
    assert.doesNotMatch(
      (await pausedRow.textContent()) ?? "",
      /Restoring asks|while the collection is in Trash/,
      "a revoked paused row has no restore note",
    );

    // 820: an open Extend… keeps to its popover's width; the row's facts keep their room.
    const { page: tablet } = await ctx.newPage(VIEWPORTS.tablet);
    await tablet.goto(`${base}/links`);
    await expectExtendBesideFacts(tablet);

    // Phone: each live row's four controls share one row of a 4-column grid, each 44 px tall.
    const { page: phone } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    await phone.goto(`${base}/links`);
    const heights = z
      .array(z.number())
      .parse(
        await phone.evaluate(
          `[...document.querySelectorAll(".lrow .acts > :is(.btn, .txtbtn), .lrow .acts > details > summary")].filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().height)`,
        ),
      );
    assert.ok(heights.length >= 4, `controls on the phone: ${heights.length}`);
    for (const height of heights) assert.ok(height >= 44, `a control is ${height} px tall`);
    // An expiring live row: Copy URL, Open, Extend… and Revoke….
    const acts = '.lrow[data-link-status="active"]:has(details.act) .acts';
    assert.equal(
      await phone.evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(acts)})).gridTemplateColumns.split(" ").length`,
      ),
      4,
      "a 4-column grid",
    );
    const cells = z.array(rect).parse(
      await phone.evaluate(`[...document.querySelector(${JSON.stringify(acts)}).querySelectorAll(":scope > :is(.btn, .txtbtn), :scope > details > summary")].map((control) => {
        const box = control.getBoundingClientRect();
        return { top: box.top, left: box.left, height: box.height };
      })`),
    );
    assert.equal(cells.length, 4, "Copy URL, Open, Extend… and Revoke…");
    for (const cell of cells)
      assert.ok(Math.abs(cell.top - (cells[0]?.top ?? 0)) <= 1, "the four controls share a row");
    for (let index = 1; index < cells.length; index++)
      assert.ok((cells[index]?.left ?? 0) > (cells[index - 1]?.left ?? 0), "in order");
    assert.equal(
      await phone.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      "no horizontal scroll",
    );
    await expectNoClippedGroup(phone, "390");
    assert.deepEqual(await axe(phone, RULES), [], "axe on /links at 390");
    // Labels fit their quarter-row cells, here and in a wider font (CI's fonts are wider than
    // the dev machine's): they may wrap, but never cross a control's border.
    await expectControlsFit(phone, "390");
    await phone.addStyleTag({
      content:
        '.lrow .acts, .lrow .acts * { font-family: "DejaVu Sans", Verdana, sans-serif !important; letter-spacing: 0.08em !important; }',
    });
    await expectControlsFit(phone, "390, wider font");
    for (const height of z
      .array(z.number())
      .parse(
        await phone.evaluate(
          `[...document.querySelectorAll(".lrow .acts > :is(.btn, .txtbtn), .lrow .acts > details > summary")].filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().height)`,
        ),
      ))
      assert.ok(height >= 44, `a control is ${height} px tall in a wider font`);
    assert.equal(
      await phone.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      "no horizontal scroll in a wider font",
    );

    // A link whose URL can't be derived shows LinkUrlActions' "URL unavailable" chip in place of
    // Copy URL and Open (review r2). The seeded links all have URLs, so swap that markup into an
    // expiring live row: the chip takes their two cells, nothing overflows its cell, and the
    // three controls still share one row, each 44 px tall.
    const missing = z
      .object({
        overflowing: z.array(z.string()),
        cells: z.array(rect.extend({ right: z.number() })),
        acts: z.object({ left: z.number(), right: z.number() }),
      })
      .parse(
        await phone.evaluate(`(() => {
          const acts = [...document.querySelectorAll(${JSON.stringify(acts)})].at(-1);
          const id = acts.closest(".lrow").querySelector(".who").id;
          const why = document.createElement("details");
          why.className = "why";
          why.setAttribute("data-url-missing", "");
          why.innerHTML = '<summary class="chip xs" aria-describedby="' + id + '">URL unavailable</summary><p class="note">URL unavailable.</p>';
          acts.querySelector("[data-copy-url]").replaceWith(why);
          acts.querySelector("[data-open-url]").remove();
          const controls = [...acts.querySelectorAll(":scope > :is(.btn, .txtbtn), :scope > details > summary")];
          const box = acts.getBoundingClientRect();
          return {
            overflowing: controls
              .filter((node) => node.scrollWidth > node.clientWidth)
              .map((node) => node.textContent.trim()),
            cells: controls.map((node) => {
              const cell = node.getBoundingClientRect();
              return { top: cell.top, left: cell.left, right: cell.right, height: cell.height };
            }),
            acts: { left: box.left, right: box.right },
          };
        })()`),
      );
    assert.deepEqual(missing.overflowing, [], "no control overflows its cell at 390");
    assert.equal(missing.cells.length, 3, "URL unavailable, Extend… and Revoke…");
    for (const cell of missing.cells) {
      assert.ok(cell.height >= 44, `a control is ${cell.height} px tall`);
      assert.ok(Math.abs(cell.top - (missing.cells[0]?.top ?? 0)) <= 1, "one row");
      assert.ok(
        cell.left >= missing.acts.left - 0.5 && cell.right <= missing.acts.right + 0.5,
        "inside the actions grid",
      );
    }
    assert.ok(width(missing.cells[0]) > 1.5 * width(missing.cells[1]), "the chip spans two cells");
    assert.equal(
      await phone.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      "no horizontal scroll with URL unavailable",
    );
  },
};
export default scenario;
