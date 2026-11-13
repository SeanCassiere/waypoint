// D73: with the docked panel collapsed, a mouse resting on the window's left edge or on the bar's
// panel button peeks the panel out as a floating card. It waits 150 ms (a flick opens nothing),
// stays while the pointer is in it or something in it is in use, slides away 250 ms after the
// pointer leaves (into the document frame too), docks in place from the button or ".", and closes
// at once on Esc, a link, the window losing focus or a narrow layout. Touch never peeks.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, type ViewerScenario } from "../harness.ts";

const WIDE = { width: 1440, height: 900 } as const;
const COLLAPSED = `localStorage.setItem("wp:panel", "closed")`;

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
  await page.mouse.move(8, 400);
  await page.clock.runFor(160);
  assert.ok(await peeking(page), "resting on the edge peeks");
};
const away = async (page: Page) => {
  await page.mouse.move(800, 500, { steps: 4 });
  await page.clock.runFor(400);
};

const scenario: ViewerScenario = {
  name: "Panel peek: left edge and button hover, holds, docking, closing, touch",
  async run(ctx) {
    const { writer } = ctx;
    const files = await Promise.all([
      writer.write("index.md", "# Peek\n\nThe head document.\n"),
      writer.write("notes.md", "# Notes\n\nAnother file.\n"),
    ]);
    const made = await writer.api("/api/collections", { title: "Panel peek", files });
    const url = `${writer.base}${new URL(made.latest_url).pathname}`;

    const { context, page } = await ctx.newPage({ ...WIDE, reducedMotion: "reduce" });
    await context.addInitScript(COLLAPSED);
    await page.clock.install();
    await page.goto(url);
    await page.mouse.move(800, 500);

    // Collapsed: the 16 px strip runs from the bar to the bottom; the panel is out of the grid.
    assert.deepEqual(await rect(page, "[data-peek-edge]"), {
      left: 0,
      top: 52,
      width: 16,
      bottom: 900,
    });
    assert.equal(await style(page, "#panel", "visibility"), "hidden");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "false");
    const main = await rect(page, "#main");
    assert.deepEqual(main, { left: 0, top: 52, width: 1440, bottom: 900 });

    // Hover intent: nothing at 100 ms, the card at 150 ms, floating 32 px under the bar and 24 px
    // above the bottom, its right corners on --rd-3 (it floats); the document doesn't move.
    await page.mouse.move(8, 400);
    await page.clock.runFor(100);
    assert.ok(!(await peeking(page)), "no peek before 150 ms");
    await page.clock.runFor(60);
    assert.ok(await peeking(page), "a resting mouse peeks the panel");
    assert.deepEqual(await rect(page, "#panel"), { left: 0, top: 84, width: 316, bottom: 876 });
    assert.equal(await style(page, "#panel", "visibility"), "visible");
    assert.equal(await style(page, "#panel", "borderTopRightRadius"), "10px");
    assert.equal(await style(page, "#panel", "borderTopLeftRadius"), "0px");
    assert.deepEqual(await rect(page, "#main"), main, "the document doesn't reflow");
    assert.equal(await page.getAttribute(".ptog", "aria-expanded"), "true");
    assert.equal(await page.evaluate(`localStorage.getItem("wp:panel")`), "closed");
    assert.deepEqual(await axe(page), [], "no axe violations while peeking");

    // In the card it stays; leaving over the document frame closes it after the 250 ms grace.
    await page.mouse.move(150, 400, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "stays while the pointer is in the card");
    await page.mouse.move(800, 400, { steps: 4 });
    await page.clock.runFor(200);
    assert.ok(await peeking(page), "still out within the grace period");
    await page.clock.runFor(100);
    assert.ok(!(await peeking(page)), "gone 250 ms after the pointer left");

    // A flick across the edge opens nothing.
    await page.mouse.move(8, 400);
    await page.clock.runFor(40);
    await page.mouse.move(700, 400);
    await page.clock.runFor(500);
    assert.ok(!(await peeking(page)), "a flick doesn't peek");

    // The panel button peeks too, and the gap between it and the card doesn't close it.
    const button = await rect(page, ".ptog");
    const bx = button.left + button.width / 2;
    const by = (button.top + button.bottom) / 2;
    await page.mouse.move(bx, by);
    await page.clock.runFor(160);
    assert.ok(await peeking(page), "resting on the panel button peeks");
    await page.mouse.move(150, 300, { steps: 6 });
    await page.clock.runFor(100);
    await page.mouse.move(bx, by, { steps: 4 });
    await page.clock.runFor(400);
    assert.ok(await peeking(page), "button ↔ card keeps it out");

    // Clicking the button docks it in place; clicking again collapses it, and the pointer still
    // on the button doesn't peek it straight back until it leaves and returns.
    await page.mouse.down();
    await page.mouse.up();
    assert.equal(await shellClass(page), "shell");
    assert.deepEqual(await rect(page, "#panel"), { left: 0, top: 52, width: 316, bottom: 900 });
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

    // "." while peeking docks it too.
    await peekFromEdge(page);
    await page.keyboard.press(".");
    assert.equal(await shellClass(page), "shell", '"." docks a peek');
    await page.keyboard.press(".");
    assert.equal(await shellClass(page), "shell closed");
    await away(page);

    // Esc closes it and hands focus from inside it to the panel button.
    await peekFromEdge(page);
    await page.mouse.move(60, 110, { steps: 4 });
    await page.locator("#tab-history").click();
    assert.ok(await peeking(page), "switching tabs keeps it out");
    await page.keyboard.press("Escape");
    assert.ok(!(await peeking(page)), "Esc closes the peek");
    assert.equal(await page.evaluate(`document.activeElement?.classList.contains("ptog")`), true);
    // Back to Files for the link check (the panel is hidden, so a script click).
    await page.evaluate(`document.querySelector("#tab-files").click()`);
    await away(page);

    // Following a file link closes it at once; the panel stays collapsed and the file opens.
    await peekFromEdge(page);
    await page.mouse.move(100, 200, { steps: 4 });
    await page.locator('#tp-files a[data-file="notes.md"]').click();
    assert.equal(await shellClass(page), "shell closed", "a link closes the peek");
    await page.waitForFunction(`document.querySelector("#shell").dataset.path === "notes.md"`);
    await away(page);

    // A text selection in the card holds it out with the pointer away; clearing it lets it go.
    await peekFromEdge(page);
    await page.mouse.move(150, 300, { steps: 4 });
    await page.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#tp-files a[data-file] .nm"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
    await page.mouse.move(800, 400, { steps: 4 });
    await page.clock.runFor(1000);
    assert.ok(await peeking(page), "a selection in the panel holds it");
    await page.evaluate(`getSelection().removeAllRanges()`);
    await page.clock.runFor(300);
    assert.ok(!(await peeking(page)), "released once the selection clears");

    // The window losing focus closes it at once.
    await peekFromEdge(page);
    await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
    assert.ok(!(await peeking(page)), "blur closes the peek");
    await away(page);

    // No peek while a dialog is open.
    await page.keyboard.press("?");
    await page.mouse.move(8, 400);
    await page.clock.runFor(400);
    assert.ok(!(await peeking(page)), "no peek behind a dialog");
    await page.keyboard.press("Escape");
    await away(page);

    // Leaving the docked layout ends the peek; the strip goes with it.
    await peekFromEdge(page);
    await page.setViewportSize({ width: 1000, height: 800 });
    // Media query change events fire in a rendering update, after the resize returns.
    await page.waitForFunction(`!document.querySelector("#shell").classList.contains("peek")`, {
      polling: 20,
      timeout: 2000,
    });
    assert.ok(!(await peeking(page)), "narrowing the window ends the peek");
    assert.equal(await style(page, "[data-peek-edge]", "display"), "none");
    await page.setViewportSize(WIDE);

    // The Changes page: Esc closes the peek and stays on the page (its own Esc leaves).
    const revision = await page.getAttribute("#shell", "data-revision");
    const changes = new URL(`r/${revision}/changes`, url).href;
    await page.goto(changes);
    await page.mouse.move(800, 500);
    await peekFromEdge(page);
    await page.mouse.move(150, 300, { steps: 4 });
    await page.keyboard.press("Escape");
    assert.ok(!(await peeking(page)), "Esc closes the peek on Changes");
    assert.equal(page.url(), changes, "and doesn't also leave the page");

    // Motion: 100 ms in, unless reduced motion.
    const moving = await ctx.newPage({ ...WIDE, reducedMotion: "no-preference" });
    await moving.context.addInitScript(COLLAPSED);
    await moving.page.clock.install();
    await moving.page.goto(url);
    assert.equal(await style(moving.page, "#panel", "transitionDuration"), "0.15s");
    await moving.page.mouse.move(8, 400);
    await moving.page.clock.runFor(160);
    assert.ok(await peeking(moving.page));
    assert.equal(await style(moving.page, "#panel", "transitionDuration"), "0.1s, 0.1s");
    assert.equal(await style(page, "#panel", "transitionDuration"), "0s", "reduced motion");

    // Touch: a tap on the edge never peeks.
    const touch = await ctx.newPage({ ...WIDE, touch: true });
    await touch.context.addInitScript(COLLAPSED);
    await touch.page.goto(url);
    await touch.page.touchscreen.tap(8, 400);
    await touch.page.waitForTimeout(400);
    assert.ok(!(await peeking(touch.page)), "touch doesn't peek");
  },
};
export default scenario;
