// D74: every link with two or more files gets the Files panel. From 1100 px it's docked beside
// the document (open by default; the Files button collapses it, remembered in
// localStorage["wp:panel"]); below that it's a popover sheet that opens on the current row. Without
// script it's docked and the button is hidden. A one-file link has no panel. No storage entry ever
// holds the share token.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, collectConsole, cspProblems, type ReaderScenario } from "../harness.ts";
import { panelReader, until } from "./_panel-fixture.ts";

const WIDE = { width: 1440, height: 900 } as const;
const box = z.object({ left: z.number(), top: z.number(), width: z.number(), bottom: z.number() });
const rect = async (page: Page, selector: string) =>
  box.parse(
    await page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, bottom: r.bottom };
    })()`),
  );
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${what}: ${actual} vs ${expected}`);
const shellClass = async (page: Page) => (await page.getAttribute("#shell", "class")) ?? "";
const isOpen = async (page: Page) =>
  (await page.evaluate(`document.getElementById("files").matches(":popover-open")`)) === true;
const active = async (page: Page, selector: string) =>
  (await page.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`)) ===
  true;
const storage = z.array(z.tuple([z.string(), z.string()]));
const stored = async (page: Page) =>
  storage.parse(
    await page.evaluate(`[localStorage, sessionStorage].flatMap((s) =>
      Object.keys(s).map((k) => [k, String(s.getItem(k))]))`),
  );

const scenario: ReaderScenario = {
  name: "Files panel: docked from 1100 px, collapsible and remembered, a sheet below, no-script",
  async run(ctx) {
    const reader = await panelReader();
    const logs: string[][] = [];

    // 1440: docked beside the document, open by default; the first Tab reaches the skip link.
    // Reduced motion: geometry is read straight after each change (docking slides in 150 ms).
    const { page } = await ctx.newPage({ ...WIDE, reducedMotion: "reduce" });
    logs.push(collectConsole(page));
    await reader.open(page, `${reader.shell}docs/b.html`);
    const panel = await rect(page, "#files");
    const shell = await rect(page, "#shell");
    assert.deepEqual(
      [panel.left, panel.width, panel.top, panel.bottom],
      [0, 300, shell.top, 900],
      "docked as the shell's first column",
    );
    near((await rect(page, "#doc")).left, 300, "the document beside the panel");
    assert.equal(await isOpen(page), false, "docked without opening the popover");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
    assert.equal(await page.getAttribute(".ptog", "popovertarget"), null, "no popover invoker");
    assert.ok(await page.locator(".ptog").isVisible(), "the Files button shows");
    assert.ok(await page.evaluate(`document.activeElement === document.body`), "no load focus");
    await page.keyboard.press("Tab");
    assert.ok(await active(page, "a.skip"), "the first Tab reaches the skip link");

    // The button collapses it (the document takes the row) and docks it again, remembered.
    await page.click(".ptog");
    assert.equal(await shellClass(page), "shell closed");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
    near((await rect(page, "#doc")).left, 0, "the document takes the row");
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "closed");
    assert.equal(await isOpen(page), false, "collapsing never opens the popover");
    await reader.open(page, reader.shell);
    assert.equal(await shellClass(page), "shell closed", "collapsed after a reload");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
    await page.mouse.move(900, 500);
    await page.click(".ptog");
    assert.equal(await shellClass(page), "shell");
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "open");
    await reader.open(page, reader.shell);
    assert.equal(await shellClass(page), "shell", "docked after a reload");

    // Storage never holds the share token: one key, a fixed value.
    for (const [key, value] of await stored(page)) {
      assert.ok(!key.includes(reader.token) && !value.includes(reader.token), `${key}=${value}`);
    }
    assert.deepEqual(await stored(page), [["wp:panel", "open"]]);

    // Narrow, with the panel collapsed on desktop: the stored state doesn't apply; the button
    // opens a side sheet over a scrim, on the current row; Esc closes it and returns focus.
    await page.click(".ptog");
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "closed");
    for (const [width, height] of [
      [820, 1180],
      [390, 844],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      await page.setViewportSize({ width, height });
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      await until(page, `document.querySelector(".ptog").hasAttribute("popovertarget")`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.equal(await page.locator("#files").isVisible(), false, `${width}: closed`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      await page.click(".ptog");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.ok(await isOpen(page), `${width}: the button opens the sheet`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.ok(await active(page, '#files a[aria-current="page"]'), "focus on the current row");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      const sheet = await rect(page, "#files");
      if (width === 820) {
        near(sheet.left, 0, "side sheet at the left edge");
        near(sheet.width, 360, "side sheet width");
        near(sheet.bottom, height, "side sheet to the bottom");
      } else {
        near(sheet.width, width, "bottom sheet width");
        near(sheet.bottom, height, "bottom sheet at the bottom");
        assert.ok(sheet.top > 100, `bottom sheet top ${sheet.top}`);
      }
      assert.notEqual(
        // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
        await page.evaluate(`getComputedStyle(document.querySelector(".pop-scrim")).display`),
        "none",
        `${width}: scrim`,
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      await page.keyboard.press("Escape");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.equal(await isOpen(page), false, `${width}: Esc closes`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.ok(await active(page, ".ptog"), `${width}: focus back on the Files button`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One width at a time.
      assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
    }

    // Open at 820, widened to 1440: the sheet closes and the panel is docked (here collapsed, as
    // stored); docking it from the button works as before.
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.click(".ptog");
    assert.ok(await isOpen(page));
    await page.setViewportSize(WIDE);
    await until(page, `!document.getElementById("files").matches(":popover-open")`);
    assert.equal(await page.getAttribute(".ptog", "popovertarget"), null);
    assert.equal(await shellClass(page), "shell closed");
    await page.mouse.move(900, 500);
    await page.click(".ptog");
    assert.equal(await shellClass(page), "shell");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
    const docked = await rect(page, "#files");
    assert.deepEqual([docked.left, docked.width], [0, 300], "docked again");
    // And with the panel docked: open at 820, widened, it ends docked and open.
    await page.setViewportSize({ width: 820, height: 1180 });
    await until(page, `document.querySelector(".ptog").hasAttribute("popovertarget")`);
    await page.click(".ptog");
    assert.ok(await isOpen(page));
    await page.setViewportSize(WIDE);
    await until(page, `!document.getElementById("files").matches(":popover-open")`);
    const again = await rect(page, "#files");
    assert.deepEqual([again.left, again.width, again.bottom], [0, 300, 900], "docked, open");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");

    // One file: no panel, no Files row, no shell grid.
    await reader.open(page, reader.single);
    assert.equal(await page.locator("#shell, #files, .prow, .ptog").count(), 0);

    // Without script at 1440: docked open, and the button (which couldn't collapse it) is hidden.
    const noScript = await ctx.browser.newContext({ viewport: WIDE, javaScriptEnabled: false });
    try {
      const plain = await noScript.newPage();
      logs.push(collectConsole(plain));
      await plain.goto(`${reader.shell}docs/b.html`);
      assert.ok(await plain.locator("#files").isVisible(), "no-script: docked");
      const r = await rect(plain, "#files");
      assert.deepEqual([r.left, r.width], [0, 300]);
      assert.equal(await plain.locator(".ptog").isVisible(), false, "no-script: no button");
      assert.ok(await plain.locator('#files a[data-p="many/file-39.html"]').count());
      // Below 1100 px the button opens the sheet natively.
      await plain.setViewportSize({ width: 820, height: 1180 });
      assert.ok(await plain.locator(".ptog").isVisible(), "no-script: the button below 1100");
      await plain.click(".ptog");
      assert.ok(await isOpen(plain), "no-script: opens natively");
    } finally {
      await noScript.close();
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
