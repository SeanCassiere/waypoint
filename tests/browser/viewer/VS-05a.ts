// VS-05a: one button size family (32 px, small 28 px) on a mouse; 44 px buttons and 16 px fields
// on touch; and phone sheets that sit on the iOS keyboard (--kb from visualViewport, set only
// while a dialog is open) with their footer pinned to the sheet's bottom edge.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const box = z.object({ width: z.number(), height: z.number() });
const probesOf = z.object({
  btn: box,
  sm: box,
  txt: box,
  icon: box,
  field: z.string(),
  area: z.string(),
  select: z.string(),
  check: z.string(),
  checkParent: z.string(),
  kb: z.string(),
});
// Injects one of each control into <main> and measures it.
const PROBES = `(() => {
  const host = document.createElement("div");
  host.innerHTML = '<button class="btn">x</button><button class="btn sm">x</button>' +
    '<button class="txtbtn">x</button><a class="iconbtn" href="#">x</a>' +
    '<label class="fl">L<input></label><span class="cb"><input type="checkbox"></span>' +
    '<label class="fl">L<textarea></textarea></label><label class="fl">L<select></select></label>';
  document.querySelector("main").prepend(host);
  const size = (el) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
  const result = {
    btn: size(host.querySelector(".btn:not(.sm)")),
    sm: size(host.querySelector(".btn.sm")),
    txt: size(host.querySelector(".txtbtn")),
    icon: size(host.querySelector(".iconbtn")),
    field: getComputedStyle(host.querySelector(".fl input")).fontSize,
    area: getComputedStyle(host.querySelector(".fl textarea")).fontSize,
    select: getComputedStyle(host.querySelector(".fl select")).fontSize,
    check: getComputedStyle(host.querySelector("[type=checkbox]")).fontSize,
    checkParent: getComputedStyle(host.querySelector(".cb")).fontSize,
    kb: getComputedStyle(document.documentElement).getPropertyValue("--kb"),
  };
  host.remove();
  return result;
})()`;

async function probes(page: Page): Promise<z.infer<typeof probesOf>> {
  return probesOf.parse(await page.evaluate(PROBES));
}

// A fake visualViewport, kept on window.__vv so the test can play the keyboard.
const FAKE_VIEWPORT = `(() => {
  const vv = new EventTarget();
  Object.assign(vv, { height: 844, width: 390, offsetTop: 0 });
  window.__vv = vv;
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
})()`;
const KB = `getComputedStyle(document.documentElement).getPropertyValue("--kb")`;
const sheetOf = z.object({
  bottom: z.number(),
  height: z.number(),
  ftPosition: z.string(),
  ftBottom: z.number(),
  innerBottom: z.number(),
  field: z.string(),
  buttons: z.array(z.number()),
});
const SHEET = (selector: string) => `(() => {
  const dialog = document.querySelector(${JSON.stringify(selector)});
  const rect = dialog.getBoundingClientRect();
  const ft = dialog.querySelector(".ft");
  return {
    bottom: rect.bottom,
    height: rect.height,
    ftPosition: getComputedStyle(ft).position,
    ftBottom: ft.getBoundingClientRect().bottom,
    innerBottom: rect.bottom - parseFloat(getComputedStyle(dialog).borderBottomWidth),
    field: getComputedStyle(dialog.querySelector("input:not([type=checkbox]):not([type=radio])")).fontSize,
    buttons: [...ft.querySelectorAll(".btn")].map((button) => button.getBoundingClientRect().height),
  };
})()`;

/** The keyboard comes up: the visual viewport shrinks to 508 px. */
async function keyboardUp(page: Page): Promise<void> {
  await page.evaluate(`window.__vv.height = 508; window.__vv.dispatchEvent(new Event("resize"))`);
}
async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(`window.__vv.height = 844; window.__vv.dispatchEvent(new Event("resize"))`);
}

const scenario: ViewerScenario = {
  name: "VS-05a 28/32 px buttons, 44 px on touch, 16 px phone fields, sheets on the keyboard",
  async run(ctx) {
    const { base } = ctx.writer;
    const made = await ctx.writer.api("/api/collections", {
      title: "Control sizes",
      files: [await ctx.writer.write("index.md", "# Control sizes\n")],
    });
    const collection = `${base}${new URL(made.latest_url).pathname}`;

    // Mouse: the size family, desktop field density, and no --kb.
    const desktop = await ctx.newPage(VIEWPORTS.desktop);
    let desktopCheck = "";
    for (const url of [`${base}/`, collection]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await desktop.page.goto(url);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const got = await probes(desktop.page);
      assert.equal(got.btn.height, 32, `${url}: .btn`);
      assert.equal(got.sm.height, 28, `${url}: .btn.sm`);
      assert.ok(parseFloat(got.field) < 16, `${url}: a ${got.field} field on a mouse`);
      // .fl textarea sets font: 12.5px mono; a mouse keeps it.
      assert.equal(got.area, "12.5px", `${url}: the .fl textarea on a mouse`);
      assert.ok(parseFloat(got.select) < 16, `${url}: a ${got.select} select on a mouse`);
      assert.equal(got.kb, "", `${url}: --kb on a mouse`);
      desktopCheck = got.check;
    }
    // Opening a dialog on a mouse never sets --kb either.
    await desktop.page.evaluate(`document.getElementById("details").showModal()`);
    assert.equal(await desktop.page.evaluate(KB), "");
    const desktopTitle = await desktop.page.evaluate(
      `getComputedStyle(document.querySelector("#details input[name=title]")).fontSize`,
    );
    assert.ok(parseFloat(String(desktopTitle)) < 16, `a ${String(desktopTitle)} title field`);
    const METADATA = `getComputedStyle(document.querySelector("#details textarea")).fontSize`;
    assert.equal(await desktop.page.evaluate(METADATA), "12.5px", "the metadata JSON on a mouse");

    // Touch phone: 44 px controls, 16 px fields, checkboxes left alone.
    const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    for (const url of [`${base}/`, collection]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await phone.page.goto(url);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const got = await probes(phone.page);
      assert.equal(got.sm.height, 44, `${url}: .btn.sm on touch`);
      assert.ok(got.btn.height >= 44, `${url}: a ${got.btn.height}px .btn on touch`);
      assert.ok(got.txt.height >= 44, `${url}: a ${got.txt.height}px .txtbtn on touch`);
      assert.ok(
        got.icon.width >= 44 && got.icon.height >= 44,
        `${url}: a ${got.icon.width}×${got.icon.height} .iconbtn on touch`,
      );
      assert.equal(got.field, "16px", `${url}: the field on touch`);
      // The plain textarea and select branches beat .fl textarea's font (12.5px) too.
      assert.equal(got.area, "16px", `${url}: the .fl textarea on touch`);
      assert.equal(got.select, "16px", `${url}: the .fl select on touch`);
      assert.notEqual(got.check, "16px", `${url}: a checkbox forced to 16px`);
      assert.equal(got.check, desktopCheck, `${url}: the checkbox keeps its mouse size`);
      assert.ok(parseFloat(got.checkParent) < 16);
    }
    // The Collection details JSON field (NAV-11; phone is on the collection page now).
    assert.equal(await phone.page.evaluate(METADATA), "16px", "the metadata JSON on touch");

    // The keyboard: a fake visualViewport the client picks up at bind time. Reduced motion, so the
    // sheet's 6 px open slide doesn't skew where its bottom edge measures.
    const kbd = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true, reducedMotion: "reduce" });
    await kbd.context.addInitScript(FAKE_VIEWPORT);
    await kbd.page.goto(collection);
    assert.equal(await kbd.page.evaluate("window.visualViewport === window.__vv"), true);
    assert.equal(await kbd.page.evaluate("window.innerHeight"), 844);
    // No dialog open: the viewport changing sets nothing.
    await keyboardUp(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "", "--kb without a dialog");
    await keyboardDown(kbd.page);

    await kbd.page.evaluate(`document.getElementById("details").showModal()`);
    await kbd.page.locator('#details input[name="title"]').focus();
    assert.equal(await kbd.page.evaluate(KB), "", "--kb before the keyboard is up");
    await keyboardUp(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "336px");
    const rename = sheetOf.parse(await kbd.page.evaluate(SHEET("#details")));
    assert.ok(Math.abs(rename.bottom - 508) <= 1, `the sheet's bottom at ${rename.bottom}`);
    assert.ok(rename.height <= 500, `a ${rename.height}px sheet`);
    assert.equal(rename.ftPosition, "sticky");
    assert.equal(rename.field, "16px");
    for (const height of rename.buttons) assert.ok(height >= 44, `a ${height}px footer button`);
    // The keyboard goes down with the dialog still open: --kb goes away.
    await keyboardDown(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "", "--kb with the keyboard down");
    await keyboardUp(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "336px");
    // The close event is queued as a task: --kb goes once it has run.
    await kbd.page.evaluate(`document.getElementById("details").close()`);
    await kbd.page.waitForFunction(`${KB} === ""`);
    // Detached: the keyboard changing again with no dialog open sets nothing.
    await keyboardDown(kbd.page);
    await keyboardUp(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "", "--kb after the listener detached");
    await keyboardDown(kbd.page);

    // The share sheet is taller than what's left above the keyboard: its body scrolls and its
    // footer (Cancel, Create link) stays pinned to the sheet's bottom edge.
    await kbd.page.evaluate(`document.getElementById("share").showModal()`);
    await kbd.page.locator('#share input[name="label"]').focus();
    await keyboardUp(kbd.page);
    assert.equal(await kbd.page.evaluate(KB), "336px");
    const share = sheetOf.parse(await kbd.page.evaluate(SHEET("#share")));
    assert.ok(Math.abs(share.bottom - 508) <= 1, `the share sheet's bottom at ${share.bottom}`);
    assert.ok(share.height <= 500, `a ${share.height}px share sheet`);
    assert.equal(
      await kbd.page.evaluate(`(() => {
        const dialog = document.getElementById("share");
        return dialog.scrollHeight > dialog.clientHeight;
      })()`),
      true,
      "the share sheet's body doesn't scroll",
    );
    assert.ok(
      Math.abs(share.ftBottom - share.innerBottom) <= 1,
      `the footer's bottom at ${share.ftBottom}, the sheet's at ${share.innerBottom}`,
    );
    // The focused Label field is scrolled into view above the pinned footer, not under it.
    await kbd.page.waitForFunction(`(() => {
      const field = document.querySelector('#share input[name="label"]');
      const footer = document.querySelector("#share .ft");
      const dialog = document.getElementById("share").getBoundingClientRect();
      const box = field.getBoundingClientRect();
      return box.top >= dialog.top && box.bottom <= footer.getBoundingClientRect().top;
    })()`);
    assert.equal(share.field, "16px");
    assert.equal(share.buttons.length, 2);
    for (const height of share.buttons) assert.ok(height >= 44, `a ${height}px footer button`);
    await kbd.page.evaluate(`document.getElementById("share").scrollTop = 0`);
    const top = sheetOf.parse(await kbd.page.evaluate(SHEET("#share")));
    assert.ok(Math.abs(top.ftBottom - top.innerBottom) <= 1, "the footer scrolled away");
    await kbd.page.evaluate(`document.getElementById("share").close()`);
    await kbd.page.waitForFunction(`${KB} === ""`);
  },
};
export default scenario;
