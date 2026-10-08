// A11Y-05a (FD2): one keymap. The g chords reach every top-level page, "/", "?" and Esc keep
// working with single-key shortcuts off, "/" never leaves focus nowhere, Esc that closes the
// panel sheet stops there, and every aria-keyshortcuts value is a registered key.
import type { Page } from "playwright";
import { z } from "zod";

import { ariaKeys, KEYMAP } from "../../../apps/writer/src/viewer/keymap.ts";
import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const REGISTERED = new Set(KEYMAP.flatMap(ariaKeys));
const strings = z.array(z.string());

/** Every aria-keyshortcuts token on the page is a KEYMAP key. */
async function shortcutsRegistered(page: Page, where: string): Promise<void> {
  const tokens = strings.parse(
    await page.evaluate(
      '[...document.querySelectorAll("[aria-keyshortcuts]")].flatMap((node) => node.getAttribute("aria-keyshortcuts").split(" ").filter(Boolean))',
    ),
  );
  assert.deepEqual(
    tokens.filter((token) => !REGISTERED.has(token)),
    [],
    `${where}: aria-keyshortcuts names an unregistered key`,
  );
}

async function chord(page: Page, key: string): Promise<void> {
  await page.locator("body").press("g");
  await page.locator("body").press(key);
}

/** Opens the panel sheet with "." and closes it with Esc, which must not also leave the page. */
async function escapeClosesSheet(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator("body").press(".");
  await page.locator("#shell.open").waitFor({ state: "attached" });
  await page.keyboard.press("Escape");
  await page.locator("#shell:not(.open)").waitFor({ state: "attached" });
  // A second handler on the same press would navigate; give it the chance to.
  await page.waitForTimeout(300);
  assert.equal(page.url(), url, "Esc that closes the sheet stays on the page");
}

const scenario: ViewerScenario = {
  name: "A11Y-05a: one keymap; g l and g t; / ? Esc with shortcuts off; / opens Find",
  async run(ctx) {
    const { base } = ctx.writer;
    const first = await ctx.writer.api("/api/collections", {
      title: "Keymap collection",
      files: [await ctx.writer.write("index.md", "# Keymap\n")],
    });
    const second = await ctx.writer.api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Second",
      files: [await ctx.writer.write("index.md", "# Keymap, again\n")],
    });
    const latest = new URL(first.latest_url).pathname;
    const secondPinned = new URL(second.url).pathname;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const path = () => new URL(page.url()).pathname;

    // The g chords, from Recent round the top-level pages and back.
    await page.goto(`${base}/`);
    await shortcutsRegistered(page, "/");
    await chord(page, "l");
    await page.waitForURL((url) => url.pathname === "/links");
    await chord(page, "t");
    await page.waitForURL((url) => url.pathname === "/trash");
    await chord(page, "s");
    await page.waitForURL((url) => url.pathname === "/status");
    await chord(page, "h");
    await page.waitForURL((url) => url.pathname === "/");

    // Collection keys do nothing off a collection: no toast, no navigation.
    for (const where of ["/status", "/links"]) {
      await page.goto(`${base}${where}`);
      for (const key of ["c", "s", "[", "d"]) await page.locator("body").press(key);
      await page.waitForTimeout(300);
      assert.equal(path(), where, `collection keys stay on ${where}`);
      assert.equal(
        await page.locator("[data-toast]").isVisible(),
        false,
        `collection keys show no toast on ${where}`,
      );
    }
    await page.goto(`${base}/`);

    // Typing "/" in the inline search field types it.
    const search = page.locator("header.bar [data-search] input");
    await search.click();
    await page.keyboard.type("a/");
    assert.equal(await search.inputValue(), "a/");
    assert.equal(path(), "/");
    await search.fill("");

    // With single-key shortcuts off, chords do nothing but "/", "?" and Esc still work.
    await page.evaluate('localStorage.setItem("wp:keys", "off")');
    await page.reload();
    await chord(page, "l");
    await page.waitForTimeout(300);
    assert.equal(path(), "/", "g l is off");
    await page.locator("body").press("?");
    await page.locator("#keys[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#keys:not([open])").waitFor({ state: "attached" });
    // Focus leaves the closed dialog's checkbox at the next rendering update, as it does for a
    // person between two key presses.
    await page.waitForFunction('!document.querySelector("#keys").contains(document.activeElement)');
    await page.locator("body").press("/");
    assert.equal(
      await page.evaluate(
        'document.activeElement === document.querySelector("header.bar [data-search] input")',
      ),
      true,
      "/ focuses the bar's search field",
    );
    await page.evaluate('localStorage.removeItem("wp:keys")');

    // The collection page: "h" selects History; "/" with no inline field opens Find.
    await page.goto(`${base}${latest}`);
    await shortcutsRegistered(page, "collection page");
    await page.locator("body").press("h");
    await page.locator('#tab-history[aria-selected="true"]').waitFor({ state: "attached" });
    const hasFind = (await page.locator("dialog#find").count()) > 0;
    await page.locator("body").press("/");
    if (hasFind) {
      await page.locator("dialog#find[open]").waitFor();
      await page.keyboard.press("Escape");
    } else {
      await page.waitForURL((url) => url.pathname === "/" && url.search === "?q=");
      // The search page opens with its field focused, never with nothing focused.
      await page.waitForFunction(
        'document.activeElement === document.querySelector("header.bar [data-search] input")',
      );
    }

    await page.goto(`${base}${secondPinned}changes`);
    await page.getByRole("heading", { name: /^Changes in #2/ }).waitFor();
    await shortcutsRegistered(page, "Changes page");

    // Phone: Esc closes the panel sheet and stops there, on the collection and Changes pages.
    const phone = (await ctx.newPage({ ...VIEWPORTS.phone, mobile: true })).page;
    await escapeClosesSheet(phone, `${base}${latest}`);
    await escapeClosesSheet(phone, `${base}${secondPinned}changes`);
    // With the sheet closed, Esc on the Changes page goes back to the revision.
    await phone.keyboard.press("Escape");
    await phone.waitForURL((url) => !url.pathname.endsWith("/changes"));

    // Tablet: a menu left open when the sheet opens closes first; the sheet waits for the next Esc.
    const tablet = (await ctx.newPage(VIEWPORTS.tablet)).page;
    await tablet.goto(`${base}${latest}`);
    await tablet
      .locator('[popovertarget="copy-menu"][aria-haspopup="menu"]:visible')
      .first()
      .click();
    await tablet.locator("#copy-menu:popover-open").waitFor();
    await tablet.keyboard.press(".");
    await tablet.locator("#shell.open").waitFor({ state: "attached" });
    await tablet.keyboard.press("Escape");
    await tablet.locator("#copy-menu:not(:popover-open)").waitFor({ state: "attached" });
    assert.equal(
      await tablet.locator("#shell.open").count(),
      1,
      "Esc closes the open menu before the sheet",
    );
    await tablet.keyboard.press("Escape");
    await tablet.locator("#shell:not(.open)").waitFor({ state: "attached" });
  },
};
export default scenario;
