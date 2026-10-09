// NAV-02: Find on every page. "/" opens the Find dialog where no search field shows (and focuses
// the bar's field where one does); grouped suggestions with ↑ ↓ wrapping, a status count, filter
// chips, the Files row, pasting a URL; a phone top sheet with touch-sized controls; and a real
// search page at an empty /?q=.
import type { Page, Route } from "playwright";
import { z } from "zod";

import { assert, axe, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const rect = z.object({ top: z.number(), width: z.number(), height: z.number() });
const heights = z.array(z.number());

async function isActive(page: Page, selector: string): Promise<boolean> {
  return z
    .boolean()
    .parse(
      await page.evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
      ),
    );
}

/** Find is fresh: an empty field, no list, no count and no pressed chip. */
async function fresh(page: Page, where: string): Promise<void> {
  const state = z
    .object({ value: z.string(), list: z.boolean(), expanded: z.string(), status: z.string() })
    .parse(
      await page.evaluate(`(() => {
        const input = document.querySelector("#find input");
        return {
          value: input.value,
          list: document.querySelector("#find-suggest").hidden,
          expanded: input.getAttribute("aria-expanded"),
          status: document.querySelector("#find [data-search-status]").textContent,
        };
      })()`),
    );
  assert.deepEqual(
    state,
    { value: "", list: true, expanded: "false", status: "" },
    `${where}: Find reopens empty`,
  );
  assert.equal(
    await page.locator('#find [data-token][aria-pressed="true"]').count(),
    0,
    `${where}: no chip stays pressed`,
  );
}

/** The suggestion fetch (`GET /api/collections?query=…`). */
function suggestApi(url: URL): boolean {
  return url.pathname === "/api/collections";
}

/** Types into Find's field the way a keystroke does: a new value and an input event. */
function typeIn(page: Page, value: string): Promise<unknown> {
  return page.evaluate(`(() => {
    const input = document.querySelector("#find input");
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

/** A long unbroken query wraps inside All results: no sideways scroll, clear of the keycap. */
async function longQuery(page: Page, where: string): Promise<void> {
  const query = `quillwort${"z".repeat(100)}`;
  await typeIn(page, query);
  await page
    .locator("#find-suggest")
    .getByRole("option", { name: `All results for “${query}”`, exact: true })
    .waitFor({ state: "visible" });
  const fit = z.object({ overflow: z.number(), gap: z.number() }).parse(
    await page.evaluate(`(() => {
        const body = document.querySelector("#find .find-body");
        const text = document.querySelector("#find-suggest-all span").getBoundingClientRect();
        const kbd = document.querySelector("#find-suggest-all kbd").getBoundingClientRect();
        // A hidden keycap (touch) has no box; the text then only has to fit the option.
        const end = kbd.width ? kbd.left : document.querySelector("#find-suggest-all").getBoundingClientRect().right;
        return { overflow: body.scrollWidth - body.clientWidth, gap: end - text.right };
      })()`),
  );
  assert.equal(fit.overflow, 0, `${where}: a long query doesn't scroll Find sideways`);
  assert.ok(fit.gap >= 0, `${where}: a long query stays clear of the keycap (${fit.gap})`);
}

/** A long unbroken collection title wraps in the Files row: Find doesn't scroll sideways. */
async function longTitle(page: Page, where: string): Promise<void> {
  const fit = z.object({ body: z.number(), row: z.number() }).parse(
    await page.evaluate(`(() => {
        const row = document.querySelector("#find .find-files");
        row.querySelector("b").textContent = "Hornwort${"x".repeat(100)}";
        const body = document.querySelector("#find .find-body");
        return { body: body.scrollWidth - body.clientWidth, row: row.scrollWidth - row.clientWidth };
      })()`),
  );
  assert.deepEqual(fit, { body: 0, row: 0 }, `${where}: a long title doesn't scroll Find sideways`);
}

/** The button's icon is drawn inside the button's box (not knocked out of it by another rule). */
async function iconInside(page: Page, button: string, where: string): Promise<void> {
  const box = z.object({ button: z.array(z.number()), icon: z.array(z.number()) }).parse(
    await page.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(button)});
        const edges = (r) => [r.left, r.top, r.right, r.bottom];
        return {
          button: edges(button.getBoundingClientRect()),
          icon: edges(button.querySelector("svg.ic").getBoundingClientRect()),
        };
      })()`),
  );
  const [bl = 0, bt = 0, br = 0, bb = 0] = box.button;
  const [il = 0, it = 0, ir = 0, ib = 0] = box.icon;
  assert.ok(
    ir > il && ib > it && il >= bl && it >= bt && ir <= br && ib <= bb,
    `${where}: the icon (${box.icon.join(",")}) is inside its button (${box.button.join(",")})`,
  );
}

async function axeClean(page: Page, where: string): Promise<void> {
  assert.deepEqual(await axe(page, { include: "#find" }), [], `axe on #find (${where})`);
}

/** The suggestions for "quillwort": a "Collections" group of two options, each marked. */
async function quillworts(page: Page, list: string, where: string): Promise<void> {
  await page.locator(list).waitFor({ state: "visible", timeout: 1000 });
  const group = page.locator(list).getByRole("group", { name: "Collections", exact: true });
  assert.equal(await group.getByRole("option").count(), 2, `${where}: two Collections options`);
  for (const option of await group.getByRole("option").all())
    assert.equal(await option.locator("mark").count(), 1, `${where}: the match is marked`);
  assert.equal(
    await page
      .locator(list)
      .getByRole("group", { name: "All results", exact: true })
      .getByRole("option", { name: "All results for “quillwort”", exact: true })
      .count(),
    1,
    `${where}: All results`,
  );
}

const scenario: ViewerScenario = {
  name: "NAV-02 Find: the dialog everywhere, grouped suggestions, chips, phone sheet, /?q=",
  async run(ctx) {
    const { base } = ctx.writer;
    const plan = await ctx.writer.api("/api/collections", {
      title: "Quillwort plan",
      metadata: { project: "botany" },
      files: [await ctx.writer.write("index.md", "# Quillwort plan\n")],
    });
    const notes = await ctx.writer.api("/api/collections", {
      title: "Quillworts notes",
      files: [await ctx.writer.write("index.md", "# Quillworts notes\n")],
    });
    const planPath = new URL(plan.latest_url).pathname;

    // Desktop, a collection page: "/" opens Find over the page, from wherever focus was.
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(`${base}${planPath}`);
    // History first, so the Files row below has a tab to switch to.
    await page.locator("body").press("h");
    await page.locator('#tab-history[aria-selected="true"]').waitFor({ state: "attached" });
    const url = page.url();
    await page.locator("a.pill.rev").first().focus();
    await page.keyboard.press("/");
    await page.locator("dialog#find[open]").waitFor();
    assert.equal(await isActive(page, "#find input"), true, "/ focuses Find's input");
    assert.equal(page.url(), url, "/ stays on the page");

    await page.keyboard.type("quillwort");
    await quillworts(page, "#find-suggest", "Find");
    await page.waitForFunction(
      `document.querySelector("#find [data-search-status]").textContent === "2 collections"`,
    );
    const input = page.locator("#find input");
    const activeOption = () => input.getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    assert.equal(await activeOption(), "find-suggest-0", "↓ selects the first option");
    await page.keyboard.press("ArrowUp");
    assert.equal(await activeOption(), "find-suggest-all", "↑ from the first wraps to All results");
    await page.keyboard.press("ArrowDown");
    assert.equal(await activeOption(), "find-suggest-0", "↓ from All results wraps to the first");
    await axeClean(page, "1280");

    await page.keyboard.press("Escape");
    await page.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await page.waitForFunction(
      `document.activeElement === document.querySelector("a.pill.rev")`,
      undefined,
      { timeout: 1000 },
    );

    // Esc cleared the field without an input event; the old list and count went with it, so
    // ↓ ↵ on the empty field can't open the old first option.
    await page.keyboard.press("/");
    await page.locator("dialog#find[open]").waitFor();
    await fresh(page, "after Esc");

    // Typing in Find never fires single-key shortcuts.
    await page.keyboard.type("sd");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("dialog#share[open]").count(), 0, "s in Find doesn't share");
    assert.equal(page.url(), url, "d in Find doesn't open Changes");

    // The Files row: closes Find and shows the Files tab, on the same page.
    const files = page.locator("#find").getByRole("link", { name: "Open Files", exact: true });
    assert.equal(await files.count(), 1, "the Files row's link is named Open Files");
    await files.click();
    await page.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await page.locator("#tp-files").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, planPath, "Open Files stays on the page");

    // Filter chips toggle their token and keep focus in the input; ⇧↵ runs the full search.
    await page.goto(`${base}${planPath}`);
    await page.locator("body").press("/");
    await page.locator("dialog#find[open]").waitFor();
    const failed = page.locator('#find [data-token="is:failed"]');
    await failed.click();
    assert.equal(await failed.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await page.keyboard.press("/");
    await page.locator("dialog#find[open]").waitFor();
    await fresh(page, "a chip, then Esc");
    await failed.click();
    assert.match(await input.inputValue(), /is:failed$/, "the chip adds its token");
    assert.equal(await failed.getAttribute("aria-pressed"), "true");
    assert.equal(await isActive(page, "#find input"), true, "the chip keeps focus in the input");
    await failed.click();
    assert.equal(await input.inputValue(), "", "a second press removes it");
    assert.equal(await failed.getAttribute("aria-pressed"), "false");
    await page.keyboard.type("quillwort");
    await page.keyboard.press("Shift+Enter");
    await page.waitForURL((next) => next.pathname === "/" && next.search === "?q=quillwort");

    // Only the current text's results and count show. Hold the responses to control their order.
    await page.goto(`${base}${planPath}`);
    const holding = new Set<string>();
    const held = new Map<string, Route>();
    const waiting = new Map<string, (route: Route) => void>();
    await page.route(suggestApi, async (route) => {
      const query = new URL(route.request().url()).searchParams.get("query") ?? "";
      if (!holding.has(query)) return route.continue();
      held.set(query, route);
      waiting.get(query)?.(route);
    });
    /** The held request for this text, once it has been made. */
    const heldRoute = (query: string): Promise<Route> =>
      new Promise((resolve) => {
        const route = held.get(query);
        if (route) resolve(route);
        else waiting.set(query, resolve);
      });
    const statusText = () => page.locator("#find [data-search-status]").textContent();
    await page.locator("body").press("/");
    await page.locator("dialog#find[open]").waitFor();
    // A response that arrives after the next keystroke is dropped.
    holding.add("quillwort");
    holding.add("quillworts");
    await typeIn(page, "quillwort");
    const older = await heldRoute("quillwort");
    await typeIn(page, "quillworts");
    const olderDone = page.waitForResponse((response) => response.request() === older.request());
    await older.continue();
    await olderDone;
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator("#find-suggest").isHidden(),
      true,
      "a stale response is dropped",
    );
    assert.equal(await statusText(), "", "a stale response announces nothing");
    await (await heldRoute("quillworts")).continue();
    await page.locator("#find-suggest").waitFor({ state: "visible" });
    assert.equal(await page.locator("#find-suggest a[role=option]").count(), 1, "quillworts: one");
    await page.waitForFunction(
      `document.querySelector("#find [data-search-status]").textContent === "1 collection"`,
    );
    // A count still waiting for its 300 ms is cancelled by the next keystroke: type again the
    // moment the results render (before their count's timer can fire), and hold the new response.
    // Reopened at once after Esc, before its queued close event: that event must not reset the
    // reopened dialog and its new text (the results would then never render).
    await page.keyboard.press("Escape");
    await page.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await page.keyboard.press("/");
    await page.locator("dialog#find[open]").waitFor();
    holding.delete("quillwort");
    held.clear();
    await page.evaluate(`new Promise((resolve, reject) => {
      const input = document.querySelector("#find input");
      const list = document.querySelector("#find-suggest");
      // Bounded, so a regression fails here instead of hanging the suite.
      const giveUp = setTimeout(() => {
        observer.disconnect();
        reject(new Error("the quillwort results never rendered"));
      }, 5000);
      const observer = new MutationObserver(() => {
        if (list.hidden) return;
        observer.disconnect();
        clearTimeout(giveUp);
        input.value = "quillworts";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        resolve(undefined);
      });
      observer.observe(list, { attributes: true, attributeFilter: ["hidden"] });
      input.value = "quillwort";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })`);
    const newer = await heldRoute("quillworts");
    await page.waitForTimeout(400);
    assert.equal(await statusText(), "", "the earlier text's count isn't announced");
    await newer.continue();
    await page.waitForFunction(
      `document.querySelector("#find [data-search-status]").textContent === "1 collection"`,
    );
    await page.unroute(suggestApi);
    // The same count for new text is announced again: the shown one is cleared at the keystroke.
    await typeIn(page, "quillworts");
    assert.equal(await statusText(), "", "a keystroke clears the shown count");
    await page.waitForFunction(
      `document.querySelector("#find [data-search-status]").textContent === "1 collection"`,
    );
    await longQuery(page, "1280");
    for (const { width, height } of [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.phone]) {
      await page.setViewportSize({ width, height });
      await longTitle(page, String(width));
    }
    await page.setViewportSize(VIEWPORTS.desktop);

    // Pasting another collection's URL jumps to it.
    await page.goto(notes.latest_url);
    await page.locator("body").press("/");
    await page.locator("dialog#find[open]").waitFor();
    await input.fill(plan.latest_url);
    await page.keyboard.press("Enter");
    await page.waitForURL((next) => next.pathname === planPath);

    // Recent: "/" focuses the bar's field, which shows the same grouped suggestions.
    await page.goto(`${base}/`);
    // The bar's other "lg" icon, the ⋯ More button (hidden on phones), sits in its button too.
    await iconInside(page, 'header.bar button[aria-label="More"]', "1280 More button");
    await page.locator("body").press("/");
    assert.equal(await isActive(page, "header.bar [data-search] input"), true, "/ focuses the bar");
    assert.equal(await page.locator("dialog#find[open]").count(), 0, "no dialog over a field");
    await page.keyboard.type("quillwort");
    await quillworts(page, "#suggest", "the bar");
    // Esc in the bar keeps its behaviour: the first press closes the list and keeps the text
    // and focus; the next blurs the field.
    const bar = page.locator("header.bar [data-search] input");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#suggest").isHidden(), true, "Esc closes the bar's list");
    assert.equal(await bar.inputValue(), "quillwort", "Esc in the bar keeps the text");
    assert.equal(await isActive(page, "header.bar [data-search] input"), true, "and focus");
    await page.keyboard.press("Escape");
    assert.equal(
      await isActive(page, "header.bar [data-search] input"),
      false,
      "a second Esc blurs the bar's field",
    );
    // The blur's delayed close (100 ms, so a press on an option lands first) runs before refilling.
    await page.waitForTimeout(200);
    await bar.fill("quillwort");
    await quillworts(page, "#suggest", "the bar again");
    const first = page.locator("#suggest [role=option]").first();
    const href = await first.getAttribute("href");
    await first.click();
    await page.waitForURL((next) => next.pathname === href);

    // An empty /?q= is a search page with its field focused.
    await page.goto(`${base}/?q=`);
    assert.equal(await page.locator("h1").textContent(), "Search");
    assert.equal(await page.title(), "Search · Waypoint");
    await page.waitForFunction(
      `document.activeElement?.matches("[data-search] input") && document.activeElement.offsetParent !== null`,
    );

    // Phone: the Find button opens a full-width sheet at the top with touch-sized controls.
    const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    const tap = phone.page;
    await tap.goto(`${base}/`);
    const findButton = tap.getByRole("button", { name: "Find", exact: true });
    await iconInside(tap, 'button[aria-label="Find"]', "390 Find button");
    await findButton.tap();
    await tap.locator("dialog#find[open]").waitFor();
    // The entrance animates (150 ms); wait for it to finish.
    await tap.waitForFunction(`document.querySelector("#find").getAnimations().length === 0`);
    const sheet = rect.parse(
      await tap.evaluate(`(() => {
        const box = document.querySelector("#find").getBoundingClientRect();
        return { top: box.top, width: box.width, height: box.height };
      })()`),
    );
    assert.equal(sheet.top, 0, "the sheet is at the top");
    assert.equal(sheet.width, 390, "the sheet is full width");
    assert.equal(
      await tap.evaluate(`getComputedStyle(document.querySelector("#find input")).fontSize`),
      "17px",
      "the input is 17 px",
    );
    assert.ok(
      ((await tap.locator(".find-cancel").boundingBox())?.height ?? 0) >= 44,
      "Cancel is at least 44 px tall",
    );
    for (const height of heights.parse(
      await tap.evaluate(
        `[...document.querySelectorAll("#find [data-token]")].map((b) => b.getBoundingClientRect().height)`,
      ),
    ))
      assert.ok(height >= 44, `a token chip is ${height} px tall`);
    assert.equal(await tap.locator(".find-hints").isVisible(), false, "no key hints on touch");
    await tap.keyboard.type("quillwort");
    await quillworts(tap, "#find-suggest", "phone Find");
    for (const height of heights.parse(
      await tap.evaluate(
        `[...document.querySelectorAll("#find-suggest [role=option]")].map((o) => o.getBoundingClientRect().height)`,
      ),
    ))
      assert.ok(height >= 52, `an option row is ${height} px tall`);
    await axeClean(tap, "390");
    await longQuery(tap, "390");
    await tap.locator(".find-cancel").tap();
    await tap.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await tap.waitForFunction(
      `document.activeElement?.getAttribute("aria-label") === "Find"`,
      undefined,
      { timeout: 1000 },
    );
    // A tap on the dimmed page closes Find and does nothing else: aim it at a Recent row below
    // the sheet, whose link would otherwise take the click the tap synthesises.
    await findButton.tap();
    await tap.locator("dialog#find[open]").waitFor();
    await tap.waitForFunction(`document.querySelector("#find").getAnimations().length === 0`);
    const under = z
      .object({ x: z.number(), y: z.number() })
      .nullable()
      .parse(
        await tap.evaluate(`(() => {
          const below = document.querySelector("#find").getBoundingClientRect().bottom + 8;
          for (const link of document.querySelectorAll('main a[href*="/c/"]')) {
            const r = link.getBoundingClientRect();
            const y = r.top + r.height / 2;
            if (r.width > 0 && y > below && y < innerHeight - 8) return { x: r.left + r.width / 2, y };
          }
          return null;
        })()`),
      );
    assert.ok(under, "a Recent row lies under the dimmed page");
    const before = tap.url();
    await tap.touchscreen.tap(under.x, under.y);
    await tap.locator("dialog#find:not([open])").waitFor({ state: "attached" });
    await tap.waitForTimeout(300);
    assert.equal(tap.url(), before, "a tap on the dimmed page doesn't open the row under it");

    // Phone, an empty /?q=: the in-page field shows and has focus.
    await tap.goto(`${base}/?q=`);
    assert.equal(await tap.locator("h1").textContent(), "Search");
    assert.equal(await tap.title(), "Search · Waypoint");
    assert.equal(await tap.locator("form.search-page input").isVisible(), true);
    await tap.waitForFunction(
      `document.activeElement === document.querySelector("form.search-page input")`,
    );
  },
};
export default scenario;
