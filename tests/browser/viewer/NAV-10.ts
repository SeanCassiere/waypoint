// NAV-10: Compare is a mode of the History list. Runs alone, on its own writer: #1, #2 on #1,
// #3 on #1, #4 on #2, so the latest line is #4 #2 #1 and #3 is a branch off #1.
import type { BrowserContext, Page } from "playwright";

import { assert, startWriter, type ViewerScenario, type WriteResult } from "../harness.ts";

const pinned = (result: WriteResult): string => new URL(result.url).pathname;
const pubOf = (result: WriteResult): string => /\/r\/([^/]+)\//.exec(result.url)?.[1] ?? "";
/** Whether #n's compare box has focus. */
const focusedOn = (target: Page, n: number) =>
  target.evaluate(
    `document.activeElement === document.querySelector('#tp-history li.rv[data-n="${n}"] input[name=r]')`,
  );

const scenario: ViewerScenario = {
  name: "NAV-10 Compare as a History mode: ticks, ordered pairs, no-script form, touch sizes",
  async run(ctx) {
    const writer = await startWriter();
    const { base } = writer;
    /** The revision's internal ID, from its shell (the write result carries only URLs). */
    const revisionId = async (result: WriteResult): Promise<string> => {
      const html = await (await writer.fetch(pinned(result))).text();
      const id = /data-revision-id="([^"]+)"/.exec(html)?.[1];
      if (!id) throw new Error(`no revision id at ${pinned(result)}`);
      return id;
    };
    const one = await writer.api("/api/collections", {
      title: "NAV-10 compare",
      files: [await writer.write("index.md", "# One\n")],
    });
    const reviseIn = async (collectionId: string, parent: WriteResult, message: string) =>
      writer.api(`/api/collections/${collectionId}/revisions`, {
        message,
        parent_revision_id: await revisionId(parent),
        files: [await writer.write("index.md", `# ${message}\n`)],
      });
    const revise = async (parent: WriteResult, message: string) =>
      reviseIn(one.collection_id, parent, message);
    const two = await revise(one, "Two");
    const three = await revise(one, "Three");
    const four = await revise(two, "Four");
    const col = /\/c\/([^/]+)\//.exec(one.url)?.[1] ?? "";

    const { page } = await ctx.newPage();
    const history = page.locator("#tp-history");
    const box = (n: number) => page.locator(`#tp-history li.rv[data-n="${n}"] input[name=r]`);
    const status = page.locator("[data-compare-status]");
    const go = page.locator("button[data-compare-go]");
    const open = history.locator("[data-compare-open]");
    const statusIs = async (text: string) =>
      assert.equal((await status.textContent())?.trim(), text);

    // Compare… pre-ticks the parent and the revision, focuses the revision's box, and hides
    // the row actions; the row links go inert.
    await page.goto(`${base}${pinned(two)}?panel=history`);
    await history.waitFor({ state: "visible" });
    await open.click();
    await box(2).waitFor({ state: "visible" });
    assert.equal(await box(1).isChecked(), true);
    assert.equal(await box(2).isChecked(), true);
    assert.equal(await box(3).isChecked(), false);
    assert.equal(
      await page.evaluate(
        `document.activeElement === document.querySelector('#tp-history li.rv[data-n="2"] input[name=r]')`,
      ),
      true,
    );
    await statusIs("#1 → #2 · 1 step on the latest line.");
    const inert = await page.evaluate(
      `[...document.querySelectorAll("#tp-history a.rvl")].every((link) => link.inert || link.closest("[inert]") !== null)`,
    );
    assert.equal(inert, true);
    assert.equal(await history.locator(".rv .acts").first().isVisible(), false);
    const changesButton = history.locator(".rv .acts a", { hasText: "Changes from #1" });
    assert.equal(await changesButton.count(), 1);
    assert.equal(await changesButton.isVisible(), false);
    assert.match(page.url(), /[?&]compare=1/);

    // A third tick drops the earliest; the footer follows the lineage.
    await box(4).check();
    assert.equal(await box(1).isChecked(), false);
    await statusIs(
      "#2 → #4 · 1 step on the latest line. #3 is a branch off #1, so it isn't included.",
    );
    assert.equal(
      (await page.locator('#tp-history li.rv[data-n="3"] [data-cmp-note]').textContent())?.trim(),
      "Not included: a branch",
    );
    assert.equal(
      await page.locator('#tp-history li.rv[data-n="3"] [data-cmp-note]').isVisible(),
      true,
    );
    await box(1).check();
    assert.equal(await box(2).isChecked(), false);
    assert.ok(
      (await status.textContent())?.trim().startsWith("#1 → #4 · 2 steps on the latest line."),
    );
    assert.equal((await go.textContent())?.trim(), "Compare #1 → #4");
    // Ticked rows take the selection background.
    const background = await page.evaluate(`(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--sel-bg)";
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const row = document.querySelector('#tp-history li.rv[data-n="4"]');
      return [getComputedStyle(row).backgroundColor, want];
    })()`);
    assert.ok(Array.isArray(background) && background[0] === background[1], String(background));

    // The native GET opens the ordered pair.
    await go.click();
    await page.waitForURL((url) => url.pathname.endsWith(`/r/${pubOf(four)}/changes`));
    assert.equal(new URL(page.url()).search, `?base=${pubOf(one)}`);
    await page.getByRole("heading", { name: "Changes from #1 to #4" }).waitFor();

    // Cancel leaves the mode: no ticks, links live again, focus back on Compare…, URL clean.
    await page.goto(`${base}${pinned(two)}?panel=history`);
    await history.waitFor({ state: "visible" });
    await open.click();
    await box(2).waitFor({ state: "visible" });
    await history.locator("[data-compare-cancel]").click();
    assert.equal(await box(2).isVisible(), false);
    assert.equal(await page.locator("#tp-history input[name=r]:checked").count(), 0);
    assert.equal(
      await page.evaluate(
        `[...document.querySelectorAll("#tp-history a.rvl")].some((link) => link.inert)`,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(`document.activeElement?.matches("#tp-history [data-compare-open]")`),
      true,
    );
    assert.doesNotMatch(page.url(), /compare=/);

    // One tick: the button waits.
    await open.click();
    await box(1).waitFor({ state: "visible" });
    await box(1).uncheck();
    await statusIs("Tick one more revision.");
    assert.equal(await go.isDisabled(), true);

    // A repeated r= (a doubled or hand-edited URL) ticks one box, and reloading it doesn't trip
    // the client (the runner fails on any page error).
    const reload = (...picks: WriteResult[]) =>
      page.goto(
        `${base}${pinned(two)}?panel=history&compare=1${picks.map((pick) => `&r=${pubOf(pick)}`).join("")}`,
      );
    await reload(two, two);
    await box(2).waitFor({ state: "visible" });
    await statusIs("Tick one more revision.");
    await reload(one, two, one);
    await box(2).waitFor({ state: "visible" });
    await statusIs("#1 → #2 · 1 step on the latest line.");
    assert.equal(await go.isDisabled(), false);
    await box(4).check();
    assert.equal(await box(1).isChecked(), false);
    assert.equal(await box(2).isChecked(), true);

    // Without script: the same form submits natively, and the server orders or sends it back.
    // Below 1100 px the compare mode shows the panel sheet itself (nothing else opens it).
    const noScriptForm = async (context: BrowserContext, at: string): Promise<void> => {
      const plain = await context.newPage();
      await plain.goto(`${base}/c/${col}/r/${pubOf(two)}/?panel=history&compare=1`);
      const plainBox = (n: number) =>
        plain.locator(`#tp-history li.rv[data-n="${n}"] input[name=r]`);
      assert.equal(await plainBox(1).isVisible(), true, `${at}: the ticks show without script`);
      await plainBox(1).check();
      await plainBox(4).check();
      await plain.locator("button[data-compare-go]").click();
      await plain.waitForURL((url) => url.pathname.endsWith(`/r/${pubOf(four)}/changes`));
      assert.equal(new URL(plain.url()).search, `?base=${pubOf(one)}`);
      await plain.goto(`${base}/c/${col}/r/${pubOf(two)}/?panel=history&compare=1`);
      await plainBox(4).check();
      await plain.locator("button[data-compare-go]").click();
      await plain.waitForURL(/err=pick2/);
      const back = plain.locator("[data-compare-status]");
      assert.equal(await back.isVisible(), true, `${at}: the pick2 status shows`);
      assert.equal((await back.textContent())?.trim(), "Pick two revisions.");
      assert.equal(await plainBox(4).isChecked(), true);
      assert.equal(await plainBox(4).isVisible(), true, `${at}: the picks show again`);
    };
    const sizes = [
      { width: 1280, height: 800 },
      { width: 820, height: 1180 },
      { width: 390, height: 844 },
    ];
    for (const viewport of sizes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One context at a time.
      const noScript = await ctx.browser.newContext({ javaScriptEnabled: false, viewport });
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One context at a time.
        await noScriptForm(noScript, `${viewport.width}px`);
      } finally {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One context at a time.
        await noScript.close();
      }
    }

    // Phone, touch: 44 px targets in the History sheet; the footer stays in view.
    const phone = await ctx.newPage({ width: 390, height: 844, touch: true, mobile: true });
    await phone.page.goto(`${base}${pinned(three)}`);
    await phone.page.locator(".tabbar").getByRole("button", { name: "History" }).click();
    const sheet = phone.page.locator("#tp-history");
    await sheet.waitFor({ state: "visible" });
    const compareLink = sheet.locator("[data-compare-open]");
    assert.ok(((await compareLink.boundingBox())?.height ?? 0) >= 44, "Compare… is 44 px tall");
    await compareLink.click();
    await sheet.locator("label.pick").first().waitFor({ state: "visible" });
    for (const label of await sheet.locator("label.pick").all())
      // oxlint-disable-next-line eslint/no-await-in-loop -- One box at a time.
      assert.ok(((await label.boundingBox())?.height ?? 0) >= 44, "each tick is 44 px tall");
    const phoneGo = phone.page.locator("button[data-compare-go]");
    assert.ok(((await phoneGo.boundingBox())?.height ?? 0) >= 44, "Compare is 44 px tall");
    await phone.page.evaluate(
      `(() => { const body = document.querySelector("#tp-history"); body.scrollTop = body.scrollHeight; })()`,
    );
    const goBox = await phoneGo.boundingBox();
    assert.ok(goBox !== null && goBox.y >= 0 && goBox.y + goBox.height <= 844, String(goBox?.y));
    assert.ok(goBox !== null && goBox.width >= 300, `full width: ${String(goBox?.width)}`);

    // An older revision's own page pre-ticks rows below History's first page (50): Compare…
    // opens the mode with the page running down to them (History open, focus on the current
    // revision's box), and Show all keeps the mode and ticks. #1..#54 linear, #55 on #1 and #56
    // on #54, so #55 and #56 meet only at #1, below the first page.
    const long = await writer.api("/api/collections", {
      title: "NAV-10 long",
      files: [await writer.write("index.md", "# 1\n")],
    });
    const longRevs = [long];
    for (let n = 2; n <= 54; n += 1) {
      const parent = longRevs.at(-1);
      if (!parent) throw new Error("no parent");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision builds on the one before.
      longRevs.push(await reviseIn(long.collection_id, parent, `${n}`));
    }
    const longRev = (n: number): WriteResult => {
      const rev = longRevs[n - 1];
      if (!rev) throw new Error(`no #${n}`);
      return rev;
    };
    longRevs.push(await reviseIn(long.collection_id, longRev(1), "55"));
    longRevs.push(await reviseIn(long.collection_id, longRev(54), "56"));
    await page.goto(`${base}${pinned(longRev(3))}?panel=history`);
    await history.waitFor({ state: "visible" });
    assert.equal(await box(3).count(), 0, "#3 is below the first page outside the mode");
    await open.click();
    await page.waitForURL(/[?&]compare=1/);
    await box(3).waitFor({ state: "visible" });
    assert.equal(await box(2).isChecked(), true);
    assert.equal(await box(3).isChecked(), true);
    await statusIs("#2 → #3 · 1 step on the latest line.");
    assert.equal(await focusedOn(page, 3), true, "focus on #3's box after loading the mode");
    assert.equal(await box(1).count(), 0);
    await history.getByRole("link", { name: "Show all 56" }).click();
    await page.waitForURL(/[?&]history=all/);
    await box(1).waitFor({ state: "visible" });
    assert.equal(await box(2).isChecked(), true, "Show all keeps the ticks");
    assert.equal(await box(3).isChecked(), true);
    await box(1).check();
    assert.equal(await box(2).isChecked(), false);
    await statusIs("#1 → #3 · 2 steps on the latest line.");

    // Two branches on the first page that meet below it are still branches (the client's
    // lineage gets the meeting point from the server).
    await page.goto(`${base}${pinned(longRev(56))}?panel=history`);
    await history.waitFor({ state: "visible" });
    assert.equal(await box(1).count(), 0, "#1 is below the first page");
    await open.click();
    await box(55).check();
    assert.equal(await box(54).isChecked(), false);
    await statusIs("#55 and #56 are on different branches. Both build on #1.");

    // Narrow, from the keyboard: the loaded page opens the History sheet and focuses the box.
    const narrowEntry = async (viewport: { width: number; height: number }): Promise<void> => {
      const at = `${viewport.width}px`;
      const narrow = await ctx.newPage({ ...viewport, touch: true, mobile: viewport.width < 600 });
      const narrowHistory = narrow.page.locator("#tp-history");
      const narrowBox = (n: number) =>
        narrow.page.locator(`#tp-history li.rv[data-n="${n}"] input[name=r]`);
      await narrow.page.goto(`${base}${pinned(longRev(3))}?panel=history`);
      await narrow.page.locator("body").press(".");
      await narrowHistory.waitFor({ state: "visible" });
      await narrowHistory.locator("[data-compare-open]").focus();
      await narrow.page.keyboard.press("Enter");
      await narrow.page.waitForURL(/[?&]compare=1/);
      await narrowBox(3).waitFor({ state: "visible" });
      assert.equal(await narrowBox(2).isChecked(), true, `${at}: #2 ticked`);
      assert.equal(await narrowBox(3).isChecked(), true, `${at}: #3 ticked`);
      assert.equal(await focusedOn(narrow.page, 3), true, `${at}: focus on #3's box`);
    };
    for (const viewport of [
      { width: 820, height: 1180 },
      { width: 390, height: 844 },
    ])
      // oxlint-disable-next-line eslint/no-await-in-loop -- One size at a time.
      await narrowEntry(viewport);
  },
};
export default scenario;
