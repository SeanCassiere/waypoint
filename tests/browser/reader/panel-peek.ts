// D73 in the reader (D74): with the docked Files panel collapsed, a mouse resting on the shell's
// left edge or on the Files button peeks the panel out as a floating card, as in the writer
// (tests/browser/viewer/panel-peek.ts). It waits 150 ms (a flick opens nothing), stays while the
// pointer is in it or something holds it (keyboard focus, a text selection, an open popover),
// slides away 250 ms after the pointer leaves (into the document frame too), docks in place from
// the button, and closes at once on Esc, a followed link, the window losing focus or a narrow
// layout. Touch never peeks. The strip and the card sit inside the shell, under the banner.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, collectConsole, cspProblems, type ReaderScenario } from "../harness.ts";
import { panelReader, until } from "./_panel-fixture.ts";

const WIDE = { width: 1440, height: 900 } as const;
// Init scripts run in the document frame too, which is sandboxed without storage.
const COLLAPSED = `if (window === top) localStorage.setItem("wp:panel", "closed")`;

const box = z.object({ left: z.number(), top: z.number(), width: z.number(), bottom: z.number() });
const rect = async (page: Page, selector: string) =>
  box.parse(
    await page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, bottom: r.bottom };
    })()`),
  );
const shellClass = async (page: Page) => (await page.getAttribute("#shell", "class")) ?? "";
const peeking = async (page: Page) => (await shellClass(page)).split(" ").includes("peek");
const style = async (page: Page, selector: string, property: string) =>
  z
    .string()
    .parse(
      await page.evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`,
      ),
    );
/** Rests the mouse on the left edge long enough to peek (the fake clock runs the 150 ms). */
const peekFromEdge = async (page: Page) => {
  await page.mouse.move(8, 500);
  await page.clock.runFor(160);
  assert.ok(await peeking(page), "resting on the edge peeks");
};
const away = async (page: Page) => {
  await page.mouse.move(800, 500, { steps: 4 });
  await page.clock.runFor(400);
};

const scenario: ReaderScenario = {
  name: "Reader panel peek: left edge and button hover, holds, docking, closing, touch",
  async run(ctx) {
    const reader = await panelReader();
    const url = reader.shell;
    const logs: string[][] = [];

    const { context, page } = await ctx.newPage({ ...WIDE, reducedMotion: "reduce" });
    logs.push(collectConsole(page));
    await context.addInitScript(COLLAPSED);
    await page.clock.install();
    await reader.open(page, url);
    await page.mouse.move(800, 500);

    // Collapsed: the 16 px strip runs from the banner to the bottom; the panel is out of the grid.
    const top = (await rect(page, "#shell")).top;
    assert.ok(top > 60, `the shell starts under the banner (${top})`);
    assert.deepEqual(await rect(page, "#shell > .peek-edge"), {
      left: 0,
      top,
      width: 16,
      bottom: 900,
    });
    assert.equal(await style(page, "#files", "visibility"), "hidden");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
    const main = await rect(page, "#main");
    assert.deepEqual(main, { left: 0, top, width: 1440, bottom: 900 });

    // Hover intent: nothing at 100 ms, the card at 150 ms, floating 32 px under the banner and
    // 24 px above the bottom, its right corners on --rd-3 (it floats); the document doesn't move.
    await page.mouse.move(8, 500);
    await page.clock.runFor(100);
    assert.ok(!(await peeking(page)), "no peek before 150 ms");
    await page.clock.runFor(60);
    assert.ok(await peeking(page), "a resting mouse peeks the panel");
    assert.deepEqual(await rect(page, "#files"), {
      left: 0,
      top: top + 32,
      width: 300,
      bottom: 876,
    });
    assert.equal(await style(page, "#files", "visibility"), "visible");
    assert.equal(await style(page, "#files", "borderTopRightRadius"), "10px");
    assert.equal(await style(page, "#files", "borderTopLeftRadius"), "0px");
    assert.deepEqual(await rect(page, "#main"), main, "the document doesn't reflow");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "closed");
    assert.equal(
      await page.evaluate(`document.getElementById("files").matches(":popover-open")`),
      false,
      "a peek isn't the popover",
    );
    assert.deepEqual(await axe(page), [], "no axe violations while peeking");

    // In the card it stays; leaving over the document frame closes it after the 250 ms grace.
    await page.mouse.move(150, 500, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "stays while the pointer is in the card");
    await page.mouse.move(800, 500, { steps: 4 });
    await page.clock.runFor(200);
    assert.ok(await peeking(page), "still out within the grace period");
    await page.clock.runFor(100);
    assert.ok(!(await peeking(page)), "gone 250 ms after the pointer left");

    // A flick across the edge opens nothing.
    await page.mouse.move(8, 500);
    await page.clock.runFor(40);
    await page.mouse.move(700, 500);
    await page.clock.runFor(500);
    assert.ok(!(await peeking(page)), "a flick doesn't peek");

    // The Files button peeks too, and the gap between it and the card doesn't close it.
    const button = await rect(page, ".ptog");
    const bx = button.left + button.width / 2;
    const by = (button.top + button.bottom) / 2;
    await page.mouse.move(bx, by);
    await page.clock.runFor(160);
    assert.ok(await peeking(page), "resting on the Files button peeks");
    await page.mouse.move(150, top + 200, { steps: 6 });
    await page.clock.runFor(100);
    await page.mouse.move(bx, by, { steps: 4 });
    await page.clock.runFor(400);
    assert.ok(await peeking(page), "button ↔ card keeps it out");

    // Clicking the button docks it in place; clicking again collapses it, and the pointer still
    // on the button doesn't peek it straight back until it leaves and returns.
    await page.mouse.down();
    await page.mouse.up();
    assert.equal(await shellClass(page), "shell");
    assert.deepEqual(await rect(page, "#files"), { left: 0, top, width: 300, bottom: 900 });
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "open");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
    await page.mouse.down();
    await page.mouse.up();
    await page.clock.runFor(500);
    assert.equal(await shellClass(page), "shell closed", "collapsing under the pointer");
    await away(page);
    await page.mouse.move(bx, by, { steps: 4 });
    await page.clock.runFor(160);
    assert.ok(await peeking(page), "peeks again after leaving and coming back");
    await away(page);

    // Esc closes it and hands focus from inside it to the Files button.
    await peekFromEdge(page);
    await page.mouse.move(60, top + 200, { steps: 4 });
    await page.locator("#files summary").first().click();
    assert.ok(await peeking(page), "folding a folder keeps it out");
    await page.keyboard.press("Escape");
    assert.ok(!(await peeking(page)), "Esc closes the peek");
    assert.equal(await page.evaluate(`document.activeElement?.classList.contains("ptog")`), true);
    await away(page);

    // Keyboard focus in the card holds it with the pointer away; leaving the card lets it go.
    await peekFromEdge(page);
    await page.evaluate(
      `document.querySelector("#files a[aria-current]").focus({ focusVisible: true })`,
    );
    await page.mouse.move(800, 500, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "keyboard focus in the panel holds it");
    await page.evaluate(`document.activeElement.blur()`);
    await page.clock.runFor(300);
    assert.ok(!(await peeking(page)), "released once focus leaves");

    // A text selection in the card holds it out with the pointer away; clearing it lets it go.
    await peekFromEdge(page);
    await page.mouse.move(150, top + 200, { steps: 4 });
    await page.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#files a[data-p] b"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
    await page.mouse.move(800, 500, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "a selection in the panel holds it");
    await page.evaluate(`getSelection().removeAllRanges()`);
    await page.clock.runFor(300);
    assert.ok(!(await peeking(page)), "released once the selection clears");

    // An open popover (About) holds it; Esc closes the popover first, then the grace runs out.
    await peekFromEdge(page);
    await page.evaluate(`document.getElementById("about").showPopover()`);
    await page.mouse.move(800, 600, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "an open popover holds it");
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(`document.getElementById("about").matches(":popover-open")`),
      false,
    );
    assert.ok(await peeking(page), "the first Esc closes only the popover");
    await page.clock.runFor(300);
    assert.ok(!(await peeking(page)), "released once the popover closed");

    // The window losing focus closes it at once.
    await peekFromEdge(page);
    await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
    assert.ok(!(await peeking(page)), "blur closes the peek");
    await away(page);

    // Leaving the docked layout ends the peek; the strip goes with it.
    await peekFromEdge(page);
    await page.setViewportSize({ width: 1000, height: 800 });
    // Media query change events fire in a rendering update, after the resize returns.
    await until(page, `!document.querySelector("#shell").classList.contains("peek")`, 2000);
    assert.equal(await style(page, "#shell > .peek-edge", "display"), "none");
    assert.equal(await page.locator("#files").isVisible(), false, "and no sheet opens");
    await page.setViewportSize(WIDE);

    // Following a file link closes it at once; the panel stays collapsed and the file opens.
    await page.mouse.move(800, 500);
    await peekFromEdge(page);
    await page.mouse.move(100, top + 120, { steps: 4 });
    const notes = page.locator('#files a[data-p="notes.html"]');
    const target = new URL(String(await notes.getAttribute("href")), page.url()).href;
    await notes.click();
    await page.waitForURL(target);
    assert.equal(await shellClass(page), "shell closed", "the next page keeps it collapsed");
    assert.equal(await page.getAttribute("#files a[aria-current]", "data-p"), "notes.html");

    // Motion: 100 ms in, unless reduced motion.
    const moving = await ctx.newPage({ ...WIDE, reducedMotion: "no-preference" });
    logs.push(collectConsole(moving.page));
    await moving.context.addInitScript(COLLAPSED);
    await moving.page.clock.install();
    await reader.open(moving.page, url);
    assert.equal(await style(moving.page, "#files", "transitionDuration"), "0.15s");
    await moving.page.mouse.move(8, 500);
    await moving.page.clock.runFor(160);
    assert.ok(await peeking(moving.page));
    assert.equal(await style(moving.page, "#files", "transitionDuration"), "0.1s, 0.1s");
    assert.equal(await style(page, "#files", "transitionDuration"), "0s", "reduced motion");

    // Touch: a tap on the edge never peeks.
    const touch = await ctx.newPage({ ...WIDE, touch: true });
    logs.push(collectConsole(touch.page));
    await touch.context.addInitScript(COLLAPSED);
    await reader.open(touch.page, url);
    await touch.page.touchscreen.tap(8, 500);
    await touch.page.waitForTimeout(400);
    assert.ok(!(await peeking(touch.page)), "touch doesn't peek");

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
