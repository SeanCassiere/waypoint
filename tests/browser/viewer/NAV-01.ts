// NAV-01: one global bar on every page outside a collection. Recent, Public links and Trash tabs
// with the current one marked and counts that mean "live now", the field at the same x on every
// page, ⋯ trimmed to three items, and on phones a "Go to" sheet from the current page's name.
// Counts need committed links, which the shared writer (sync off) never has, so this scenario runs
// its own seeded demo writer: 4 live links, 2 collections in Trash, 1 link paused on one of them.
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  axe,
  startDemoWriter,
  VIEWPORTS,
  type PageOptions,
  type ViewerScenario,
} from "../harness.ts";

const strings = z.array(z.string());

/** axe on `include`, minus the health pill's name mismatch (its aria-label doesn't start with its
 *  visible text). That markup is components.tsx's; OW-10b renames the pill and removes this filter. */
async function axeClean(page: Page, include: string): Promise<void> {
  const violations = (await axe(page, { include })).filter(
    (violation) =>
      violation.id !== "label-content-name-mismatch" ||
      violation.nodes.some((node) => !/^<button[^>]* class="health\b/.test(node.html)),
  );
  assert.deepEqual(violations, [], `axe on ${include}`);
}

/** The hrefs of the links in `selector` that have aria-current="page". */
async function current(page: Page, selector: string): Promise<string[]> {
  return strings.parse(
    await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(`${selector} [aria-current="page"]`)})].map((a) => a.getAttribute("href"))`,
    ),
  );
}

/** One desktop page's bar: three tabs, the seeded counts, `tab` current (or none). Returns the
 *  search field's left x. */
async function checkBar(page: Page, url: string, tab: string | null): Promise<number> {
  await page.goto(url);
  const where = new URL(url).pathname;
  const main = page.getByRole("navigation", { name: "Main" });
  assert.equal(await main.getByRole("link").count(), 3, `${where}: three tabs`);
  const links = main.getByRole("link", { name: "Public links 4", exact: true });
  assert.equal(await links.count(), 1, `${where}: Public links 4`);
  assert.equal(await links.getAttribute("title"), "4 live public links");
  const trash = main.getByRole("link", { name: "Trash 2, 1 public link paused", exact: true });
  assert.equal(await trash.count(), 1, `${where}: Trash 2, 1 public link paused`);
  assert.deepEqual(await current(page, "nav.gnav"), tab ? [tab] : [], `${where}: current tab`);
  const field = z.object({ left: z.number(), offset: z.number() }).parse(
    await page.evaluate(`(() => {
      const bar = document.querySelector("header.bar").getBoundingClientRect();
      const field = document.querySelector("header.bar form.search").getBoundingClientRect();
      return { left: field.left, offset: field.top + field.height / 2 - (bar.top + bar.height / 2) };
    })()`),
  );
  // Without a doctype a form gets a bottom margin; the field must stay on the bar's centre line.
  assert.ok(Math.abs(field.offset) <= 1, `${where}: the field is ${field.offset} px off centre`);
  return field.left;
}

const scenario: ViewerScenario = {
  name: "NAV-01 global bar: labelled tabs, live counts, you-are-here, the phone Go to sheet",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;

    // Desktop: the same counts and the same field position on every page that shares the bar.
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const tabs = [
      ["/", "/"],
      ["/links", "/links"],
      ["/trash", "/trash"],
      ["/status", null],
      ["/mcp", null],
      ["/no-such-page", null],
    ] as const;
    const lefts: number[] = [];
    for (const [path, tab] of tabs) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const left = await checkBar(page, `${base}${path}`, tab);
      if (path !== "/no-such-page") lefts.push(left);
    }
    const [first = 0] = lefts;
    for (const left of lefts)
      assert.ok(Math.abs(left - first) <= 1, `the field moved: ${lefts.join(", ")}`);

    // ⋯ on /status: exactly Status (current), Connect an agent and Keyboard shortcuts.
    await page.goto(`${base}/status`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const more = page.locator("#home-more");
    await more.locator(".mi").first().waitFor();
    const items = strings.parse(
      await page.evaluate(
        `[...document.querySelectorAll("#home-more .mi")].map((mi) => mi.innerText.replace(/\\s+/g, " ").trim())`,
      ),
    );
    assert.deepEqual(items, ["Status g s", "Connect an agent", "Keyboard shortcuts ?"]);
    assert.deepEqual(await current(page, "#home-more"), ["/status"]);
    await page.keyboard.press("Escape");

    await page.goto(`${base}/`);
    assert.deepEqual(await current(page, "nav.gnav"), ["/"]);
    assert.equal(await page.locator("header.bar form.search > svg.ic").count(), 1);
    await axeClean(page, "header.bar");

    // Forced colours drop backgrounds and shadows: the current tab is underlined, and keyboard
    // focus on it still shows the shared focus outline.
    const forced = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
    await forced.page.goto(`${base}/links`);
    const look = z.object({ line: z.string(), outline: z.string(), width: z.number() });
    const style = async () =>
      look.parse(
        await forced.page.evaluate(`(() => {
          const style = getComputedStyle(document.querySelector('nav.gnav [aria-current="page"]'));
          return { line: style.textDecorationLine, outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        })()`),
      );
    const rest = await style();
    assert.equal(rest.line, "underline", "forced colours: the current tab is underlined");
    assert.equal(rest.outline, "none", "forced colours: no outline until focused");
    // Tab from Recent to the current tab (Public links), so focus comes from the keyboard.
    await forced.page.locator('nav.gnav a[href="/"]').focus();
    await forced.page.keyboard.press("Tab");
    assert.equal(
      await forced.page.evaluate(
        `document.activeElement === document.querySelector('nav.gnav [aria-current="page"]')`,
      ),
      true,
      "Tab reaches the current tab",
    );
    const focus = await style();
    assert.equal(focus.outline, "solid", "forced colours: the focused current tab has an outline");
    assert.ok(focus.width >= 2, "forced colours: the focus outline is the shared 2 px ring");

    // Phone: the switcher replaces the tabs and opens the Go to sheet at the bottom.
    const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    const tap = phone.page;
    await tap.goto(`${base}/`);
    assert.equal(await tap.locator("nav.gnav").isVisible(), false);
    assert.equal(await tap.locator('[popovertarget="home-more"]').isVisible(), false);
    const where = tap.getByRole("button", { name: "Recent, go to another page", exact: true });
    assert.equal(await where.isVisible(), true);
    await axeClean(tap, "header.bar");
    const find = tap.getByRole("link", { name: "Find", exact: true });
    assert.ok(((await find.boundingBox())?.height ?? 0) >= 44, "Find is at least 44 px tall");
    await where.tap();
    await tap.waitForFunction(`document.getElementById("go-to").matches(":popover-open")`);
    const sheet = tap.getByRole("navigation", { name: "Go to" });
    // The sheet's entrance animates from below; wait for it to settle at the viewport bottom.
    await tap.waitForFunction(
      `Math.abs(document.querySelector("#go-to > .mbox").getBoundingClientRect().bottom - 844) <= 1`,
    );
    assert.deepEqual(
      strings.parse(
        await tap.evaluate(
          `[...document.querySelectorAll("#go-to a.mi")].map((a) => a.firstChild.textContent.trim())`,
        ),
      ),
      ["Recent", "Public links", "Trash", "Status", "Connect an agent"],
    );
    assert.deepEqual(await current(tap, "#go-to"), ["/"]);
    assert.equal(await sheet.getByRole("link", { name: "Public links 4", exact: true }).count(), 1);
    await axeClean(tap, "#go-to");
    await sheet.getByRole("link", { name: /^Trash/ }).tap();
    await tap.waitForURL((url) => url.pathname === "/trash");
    assert.equal(
      await tap.getByRole("button", { name: "Trash, go to another page", exact: true }).count(),
      1,
      "the switcher reads Trash",
    );

    // Keyboard at 390: Enter opens the sheet, Tab reaches its first item (Recent, the current
    // page). Focus there must show its own outline beside the current-item marker, in light, dark
    // and forced colours (which drop the marker's bar, so the item is underlined instead).
    const sheetItem = z.object({ outline: z.string(), width: z.number(), line: z.string() });
    const sheetFocus = async (mode: PageOptions, label: string) => {
      const keys = await ctx.newPage({ ...VIEWPORTS.phone, touch: false, ...mode });
      await keys.page.goto(`${base}/`);
      await keys.page.locator("header.bar button.where").focus();
      await keys.page.keyboard.press("Enter");
      await keys.page.waitForFunction(`document.getElementById("go-to").matches(":popover-open")`);
      await keys.page.keyboard.press("Tab");
      assert.equal(
        await keys.page.evaluate(
          `document.activeElement === document.querySelector('#go-to a.mi[aria-current="page"]')`,
        ),
        true,
        `${label}: Tab after opening Go to reaches Recent, the current item`,
      );
      const item = sheetItem.parse(
        await keys.page.evaluate(`(() => {
          const style = getComputedStyle(document.activeElement);
          return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), line: style.textDecorationLine };
        })()`),
      );
      assert.equal(item.outline, "solid", `${label}: the focused current item has an outline`);
      assert.ok(item.width >= 2, `${label}: the focus outline is at least 2 px`);
      return item;
    };
    await sheetFocus({ colorScheme: "light" }, "light");
    await sheetFocus({ colorScheme: "dark" }, "dark");
    const forcedItem = await sheetFocus({ forcedColors: "active" }, "forced colours");
    assert.equal(forcedItem.line, "underline", "forced colours: the current item is underlined");
  },
};
export default scenario;
