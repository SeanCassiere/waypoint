// A11Y-05b: the gallery lightbox's mode buttons and safe arrows, Esc on the Gallery and Changes
// pages (never when that press closed something), data-change on code and table units, and the
// shortcuts dialog grouped by page with a pinned footer.
import { deflateSync } from "node:zlib";

import type { Page } from "playwright";
import { z } from "zod";

import { ariaKeys, KEYMAP } from "../../../apps/writer/src/viewer/keymap.ts";
import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const REGISTERED = new Set(KEYMAP.flatMap(ariaKeys));
const strings = z.array(z.string());
const numbers = z.array(z.number());

/** A solid-colour RGB PNG of the given size. */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const row = [0, ...Array.from({ length: width }, () => rgb).flat()];
  const pixels = new Uint8Array(Array.from({ length: height }, () => row).flat());
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

const doc = (step: string, cell: string) =>
  `# Runbook\n\nIntro.\n\n\`\`\`sh\npg_upgrade --check\npg_upgrade --jobs ${step}\nvacuumdb --all\n\`\`\`\n\nMiddle.\n\n| Step | Owner |\n| --- | --- |\n| Upgrade | ${cell} |\n| Verify | Bo |\n\nEnd.\n`;

async function activeIs(page: Page, selector: string): Promise<boolean> {
  return z
    .boolean()
    .parse(
      await page.evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
      ),
    );
}

async function count(page: Page): Promise<string> {
  return (await page.locator("#lightbox [data-lbx-count]").textContent()) ?? "";
}

/** Every aria-keyshortcuts token on the page is a KEYMAP key. */
async function shortcutsRegistered(page: Page, where: string): Promise<void> {
  const tokens = strings.parse(
    await page.evaluate(
      '[...document.querySelectorAll("[aria-keyshortcuts]")].flatMap((node) => node.getAttribute("aria-keyshortcuts").split(" ").filter(Boolean))',
    ),
  );
  assert.ok(tokens.includes("ArrowLeft") && tokens.includes("Escape"), `${where}: has tokens`);
  assert.deepEqual(
    tokens.filter((token) => !REGISTERED.has(token)),
    [],
    `${where}: aria-keyshortcuts names an unregistered key`,
  );
}

/** Esc after a pause: a second handler on the same press would have navigated by then. */
async function escapeStays(page: Page, why: string): Promise<void> {
  const before = page.url();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(page.url(), before, why);
}

const scenario: ViewerScenario = {
  name: "A11Y-05b: lightbox modes and keys, Esc on Gallery and Changes, data-change on code and tables, grouped shortcuts",
  async run(ctx) {
    const { base } = ctx.writer;
    const first = await ctx.writer.api("/api/collections", {
      title: "Lightbox collection",
      files: [
        await ctx.writer.write("index.md", doc("4", "Al")),
        await ctx.writer.write("shots/a.png", png(16, 10, [200, 40, 40]), "image/png"),
        await ctx.writer.write("shots/b.png", png(12, 9, [40, 200, 40]), "image/png"),
      ],
    });
    const second = await ctx.writer.api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Second",
      files: [
        await ctx.writer.write("index.md", doc("8", "Cy")),
        await ctx.writer.write("shots/b.png", png(14, 9, [40, 40, 200]), "image/png"),
        await ctx.writer.write("shots/c.png", png(8, 8, [90, 90, 90]), "image/png"),
      ],
    });
    const firstPinned = new URL(first.url).pathname;
    const secondPinned = new URL(second.url).pathname;
    const gallery = `${base}${secondPinned}gallery/shots/`;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const path = () => new URL(page.url()).pathname;

    // Lightbox: focus starts on the pressed mode; arrows page images and keep the mode.
    await page.goto(gallery);
    await page.locator('[data-shot][data-name="b.png"]').click();
    await page.locator("#lightbox[open]").waitFor();
    assert.ok(
      await activeIs(page, '#lightbox [data-lbx-modes] button[aria-pressed="true"]'),
      "focus on the pressed mode",
    );
    assert.equal(
      await page.evaluate('document.activeElement.matches(":focus-visible")'),
      true,
      "its focus ring shows after a click",
    );
    assert.equal(
      await page.locator('#lightbox [data-lbx-modes] button[aria-pressed="true"]').textContent(),
      "Side by side",
    );
    assert.equal(await count(page), "2 of 3");
    const centres = numbers.parse(
      await page.evaluate(
        '[document.querySelector("#lightbox [data-lbx-modes]"), document.querySelector("#lightbox [data-lbx-done]")].map((node) => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; })',
      ),
    );
    const [modesMid = NaN, doneMid = NaN] = centres;
    assert.ok(
      Math.abs(modesMid - doneMid) <= 1,
      `Done ${modesMid - doneMid}px off the modes' line`,
    );
    await shortcutsRegistered(page, "Gallery page, lightbox open");
    await page.keyboard.press("ArrowRight");
    assert.equal(await count(page), "3 of 3");
    // c.png is new (no "before"), so the modes are hidden and focus moves to Next; the mode
    // persists while paging.
    assert.ok(await activeIs(page, "#lightbox [data-lbx-next]"), "focus stays in the lightbox");
    assert.equal(
      await page.locator('#lightbox [data-mode="side"]').getAttribute("aria-pressed"),
      "true",
    );
    await page.keyboard.press("ArrowLeft");
    assert.equal(await count(page), "2 of 3");
    await page
      .getByRole("group", { name: "Compare view" })
      .getByRole("button", { name: "Slider" })
      .click();
    assert.equal(await page.locator("#lightbox").getAttribute("data-mode"), "slider");
    assert.equal(
      await page.getByRole("button", { name: "Slider" }).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator("#lightbox .pair").isVisible(), false, ".pair hidden");
    assert.equal(await page.locator("#lightbox .slider").isVisible(), true, ".slider shown");
    // The range keeps its own arrows.
    const range = page.locator("#lightbox [data-lbx-range]");
    await range.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await count(page), "2 of 3", "arrows on the range don't page");
    assert.equal(await range.inputValue(), "51");
    assert.equal(
      await page.getByRole("button", { name: "Done" }).getAttribute("aria-keyshortcuts"),
      "Escape",
    );
    await page.keyboard.press("Escape");
    await page.locator("#lightbox:not([open])").waitFor({ state: "attached" });
    assert.ok(
      await activeIs(page, '[data-shot][data-name="b.png"]'),
      "focus back on the thumbnail",
    );
    assert.equal(path(), `${secondPinned}gallery/shots/`, "Esc that closes the lightbox stays");

    // Dimensions fill in after load (fillDims).
    await page.waitForFunction(
      '[...document.querySelectorAll(".shot [data-dim]")].every((dim) => /^\\d+×\\d+$/.test(dim.textContent))',
    );
    assert.deepEqual(await page.locator(".shot [data-dim]").allTextContents(), [
      "16×10",
      "14×9",
      "8×8",
    ]);

    // Gallery Esc → Done, with nothing open.
    const done = await page.locator("[data-gallery][data-done]").getAttribute("data-done");
    assert.equal(done, secondPinned);
    await page.locator("body").press("Escape");
    await page.waitForURL((url) => url.pathname === secondPinned);

    // A toast on screen (a manual popover) doesn't block it.
    await page.goto(gallery);
    await page.evaluate(`(() => {
      const host = document.querySelector("[data-toast]");
      const slot = host.querySelector('[data-toast-slot="error"]') ?? host;
      slot.textContent = "Couldn't save";
      host.showPopover();
    })()`);
    assert.equal(await page.locator("[data-toast]:popover-open").count(), 1);
    await page.locator("body").press("Escape");
    await page.waitForURL((url) => url.pathname === secondPinned);

    // j reaches the changed code block and the changed table.
    await page.goto(`${base}${secondPinned}changes`);
    await page.getByRole("heading", { name: /^Changes in #2/ }).waitFor();
    const visited = new Set<string>();
    for (let press = 0; press < 12; press++) {
      await page.locator("body").press("j");
      const note = z
        .string()
        .parse(
          await page.evaluate(
            '(() => { const node = document.activeElement; return node?.matches("div.blk[data-change]") ? node.querySelector(".srcnote")?.textContent ?? "" : ""; })()',
          ),
        );
      if (note.startsWith("Code")) visited.add("code");
      if (note.startsWith("Table")) visited.add("table");
    }
    assert.deepEqual([...visited].toSorted(), ["code", "table"], "j visits code and table units");

    // Shortcuts dialog on the Changes page: own group first, focus on Close, two columns.
    await page.locator("body").press("?");
    await page.locator("#keys[open]").waitFor();
    assert.ok(await activeIs(page, "#keys .ft button.primary"), "focus on Close");
    assert.equal(await page.locator("#keys .kg h3").first().textContent(), "On the Changes page");
    const tracks = () =>
      page.evaluate('getComputedStyle(document.querySelector("#keys .kcols")).gridTemplateColumns');
    assert.equal(
      z
        .string()
        .parse(await tracks())
        .split(" ").length,
      2,
      "two columns at 1280",
    );
    const filled = strings.parse(
      await page.evaluate(
        '[...document.querySelectorAll("#keys [data-keys-n]")].map((span) => span.textContent === span.dataset.keysN.replace("#N", "#2").replace("#L", "#2") ? "ok" : span.textContent)',
      ),
    );
    assert.ok(filled.length > 0 && filled.every((one) => one === "ok"), `filled: ${filled.join()}`);
    assert.deepEqual(await page.locator('#keys [data-keys-n="#N"]').allTextContents(), ["#2"]);
    await page.keyboard.press("Escape");
    await page.locator("#keys:not([open])").waitFor({ state: "attached" });

    // Phone: a full-width bottom sheet, one column, the body scrolls, the footer stays in view.
    const phone = (await ctx.newPage({ ...VIEWPORTS.phone, mobile: true })).page;
    await phone.goto(`${base}${secondPinned}changes`);
    await phone.keyboard.press("?");
    await phone.locator("#keys[open]").waitFor();
    await phone.waitForTimeout(250); // the open transition
    const sheet = numbers.parse(
      await phone.evaluate(`(() => {
        const dialog = document.querySelector("#keys");
        const box = dialog.getBoundingClientRect();
        const body = dialog.querySelector(".bd");
        return [
          box.left,
          box.width - innerWidth,
          innerHeight - dialog.querySelector(".ft").getBoundingClientRect().bottom,
          body.scrollHeight - body.clientHeight,
          getComputedStyle(dialog.querySelector(".kcols")).gridTemplateColumns.split(" ").length,
          box.bottom - dialog.querySelector(".ft").getBoundingClientRect().bottom,
        ];
      })()`),
    );
    const [
      left = NaN,
      widthGap = NaN,
      footerGap = NaN,
      overflow = NaN,
      columns = NaN,
      flush = NaN,
    ] = sheet;
    assert.ok(Math.abs(left) <= 1, `sheet left ${left}`);
    assert.ok(Math.abs(widthGap) <= 1, `sheet width off by ${widthGap}`);
    assert.ok(footerGap >= 0, `footer below the fold by ${-footerGap}`);
    assert.ok(overflow > 0, "the body scrolls");
    assert.equal(columns, 1, "one column at 390");
    assert.ok(Math.abs(flush) <= 1, `footer ${flush}px above the sheet's bottom edge`);

    // #N and #L on the first revision: this one is #1, the latest #2.
    await page.goto(`${base}${firstPinned}`);
    await page.locator("body").press("?");
    await page.locator("#keys[open]").waitFor();
    assert.deepEqual(await page.locator('#keys [data-keys-n="#N"]').allTextContents(), ["#1"]);
    const older = page.locator("#keys .kg dd small").filter({ hasText: "At the end of a branch" });
    assert.equal(
      await older.textContent(),
      "At the end of a branch: End of this branch. Latest is #2",
    );
    assert.equal(
      await page.locator("#keys .kg h3").first().textContent(),
      "In this collection collection, Changes and Gallery pages",
    );
    await page.keyboard.press("Escape");
    await page.goto(`${base}/`);
    await page.locator("body").press("?");
    await page.locator("#keys[open]").waitFor();
    assert.equal(
      await page
        .locator("#keys details.kother dd small")
        .filter({ hasText: "At the end of a branch" })
        .textContent(),
      "At the end of a branch: End of this branch. Latest is the newest revision",
    );
    assert.deepEqual(await page.locator('#keys [data-keys-n="#N"]').allTextContents(), [
      "the revision",
    ]);
    assert.equal(await page.locator("#keys .kg h3").first().textContent(), "Everywhere");
    await page.keyboard.press("Escape");

    // Changes Esc guard on a tablet: Esc that closes the sheet or a menu stays on the page.
    const tablet = (await ctx.newPage(VIEWPORTS.tablet)).page;
    await tablet.goto(`${base}${secondPinned}changes`);
    await tablet.getByRole("heading", { name: /^Changes in #2/ }).waitFor();
    await tablet.locator("body").press(".");
    await tablet.locator("#shell.open").waitFor({ state: "attached" });
    await escapeStays(tablet, "Esc that closes the sheet stays on Changes");
    assert.equal(await tablet.locator("#shell.open").count(), 0, "sheet closed");
    await tablet
      .locator('header.bar [popovertarget="more-menu"][aria-haspopup="menu"]')
      .first()
      .click();
    await tablet.locator("#more-menu:popover-open").waitFor();
    await escapeStays(tablet, "Esc that closes the More menu stays on Changes");
    assert.equal(await tablet.locator("#more-menu:popover-open").count(), 0, "menu closed");
    const changesDone = await tablet.locator(".cmp[data-done]").getAttribute("data-done");
    assert.ok(changesDone, ".cmp[data-done]");
    await tablet.keyboard.press("Escape");
    await tablet.waitForURL((url) => url.pathname === changesDone);

    // Coarse pointer: no shortcuts item or panel keycaps; lightbox controls are tap-sized.
    const touch = (await ctx.newPage({ ...VIEWPORTS.tablet, mobile: true })).page;
    await touch.goto(`${base}${secondPinned}`);
    assert.equal(
      await touch.evaluate(
        'getComputedStyle(document.querySelector("#more-menu .mi[commandfor=keys]")).display',
      ),
      "none",
    );
    assert.equal(
      await touch.evaluate('getComputedStyle(document.querySelector(".pfoot")).display'),
      "none",
    );
    await touch.goto(gallery);
    await touch.locator('[data-shot][data-name="b.png"]').tap();
    await touch.locator("#lightbox[open]").waitFor();
    assert.equal(await touch.locator("#lightbox .lbx-hint").isVisible(), false, "no key hint");
    const heights = numbers.parse(
      await touch.evaluate(
        '[...document.querySelectorAll("#lightbox [data-lbx-prev], #lightbox [data-lbx-next], #lightbox [data-lbx-done], #lightbox [data-lbx-modes] button")].map((node) => node.getBoundingClientRect().height)',
      ),
    );
    assert.equal(heights.length, 6);
    assert.ok(
      heights.every((height) => height >= 44),
      `tap targets: ${heights.join()}`,
    );
    // A keyboard still opens the list.
    await touch.keyboard.press("Escape");
    await touch.locator("#lightbox:not([open])").waitFor({ state: "attached" });
    await touch.keyboard.press("?");
    await touch.locator("#keys[open]").waitFor();
  },
};
export default scenario;
