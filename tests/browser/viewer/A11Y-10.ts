// A11Y-10: gallery thumbnails keep their 16:10 frame at any viewport height (two columns, 16 px
// gutters and 44 px captions on phones), and a menu with a list (.mbox.has-list) fits under the
// bar or in a phone sheet, scrolls only its body and pins its footer actions.
import { deflateSync } from "node:zlib";

import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

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

const box = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });
const tile = z.object({
  img: z.object({ width: z.number(), height: z.number() }),
  cap: z.number(),
});
const tiles = z.array(tile.extend({ shot: z.number() }));

/** Every gallery tile: the thumbnail's size, the caption's height and the tile's height. */
async function measureTiles(page: Page): Promise<z.infer<typeof tiles>> {
  return tiles.parse(
    await page.evaluate(`[...document.querySelectorAll(".gallery .shot[data-shot]")].map((shot) => {
      const img = shot.querySelector(".img").getBoundingClientRect();
      return {
        img: { width: img.width, height: img.height },
        cap: shot.querySelector(".cap").getBoundingClientRect().height,
        shot: shot.getBoundingClientRect().height,
      };
    })`),
  );
}

/** Every thumbnail is 16:10 of its tile, and the tile is exactly thumbnail + caption + border. */
async function galleryFits(page: Page, where: string): Promise<void> {
  const measured = await measureTiles(page);
  assert.equal(measured.length, 8, `${where}: eight tiles`);
  for (const [index, { img, cap, shot }] of measured.entries()) {
    assert.ok(
      Math.abs(img.height - (img.width * 10) / 16) <= 1,
      `${where}: tile ${index} is ${img.width}x${img.height}, not 16:10`,
    );
    assert.ok(
      Math.abs(shot - (img.height + cap + 2)) <= 1,
      `${where}: tile ${index} is ${shot}px tall, not thumbnail + caption (${img.height} + ${cap})`,
    );
  }
}

/** A test menu with 40 list items (and optionally a header) and a pinned last action, opened
 *  from a real invoker in the bar, so it's anchored (or a sheet) exactly like the Copy menu. */
async function openFixture(page: Page, n: "" | "2", withHead: boolean): Promise<void> {
  await page.evaluate(`{
    const items = Array.from({ length: 40 }, (_, i) =>
      '<button class="mi" role="menuitem">Item ' + (i + 1) + '</button>').join("");
    const head = ${withHead} ? '<div class="mhead"><div class="lbl">Header</div></div>' : "";
    document.body.insertAdjacentHTML("beforeend",
      '<div id="t-menu${n}" class="menu" popover="auto" role="menu" aria-label="Test">' +
      '<div class="mbox has-list">' + head + '<div class="mbody">' + items + '</div>' +
      '<div class="mfoot"><button class="mi" role="menuitem" id="t-last${n}">Last action</button></div>' +
      '</div></div>');
    document.querySelector("header.bar").insertAdjacentHTML("beforeend",
      '<button type="button" id="t-open${n}" popovertarget="t-menu${n}" aria-haspopup="menu">Test</button>');
  }`);
  await page.click(`#t-open${n}`);
  await page.locator(`#t-menu${n}`).waitFor({ state: "visible" });
}

async function rect(page: Page, selector: string): Promise<z.infer<typeof box>> {
  return box.parse(
    await page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })()`),
  );
}

async function inViewport(page: Page, selector: string, where: string): Promise<void> {
  const r = await rect(page, selector);
  const size = z
    .object({ width: z.number(), height: z.number() })
    .parse(await page.evaluate("({ width: innerWidth, height: innerHeight })"));
  assert.ok(
    r.top >= 0 && r.left >= 0 && r.bottom <= size.height && r.right <= size.width,
    `${where}: ${selector} at ${JSON.stringify(r)} is outside the ${size.width}x${size.height} viewport`,
  );
}

async function number(page: Page, expression: string): Promise<number> {
  return z.number().parse(await page.evaluate(expression));
}

/** .mhead < .mbody < .mfoot, by top. */
async function order(page: Page, n: "" | "2", where: string): Promise<void> {
  const tops = z.array(z.number()).parse(
    await page.evaluate(`["mhead", "mbody", "mfoot"].map((name) =>
      document.querySelector("#t-menu${n} > .mbox > ." + name).getBoundingClientRect().top)`),
  );
  const [head = NaN, body = NaN, foot = NaN] = tops;
  assert.ok(
    head < body && body < foot,
    `${where}: header, body, footer tops are ${tops.join(", ")}`,
  );
}

const scenario: ViewerScenario = {
  name: "A11Y-10 galleries and menus that fit",
  async run(ctx) {
    const { base } = ctx.writer;
    const colours: [number, number, number][] = [
      [200, 40, 40],
      [40, 200, 40],
      [40, 40, 200],
      [200, 200, 40],
      [40, 200, 200],
      [200, 40, 200],
      [90, 90, 90],
      [160, 120, 60],
    ];
    const sizes: [number, number][] = [
      [16, 10],
      [10, 16],
      [12, 12],
      [24, 6],
      [8, 20],
      [16, 9],
      [9, 16],
      [20, 10],
    ];
    const files = await Promise.all(
      colours.map((rgb, i) => {
        const [width, height] = sizes[i] ?? [16, 10];
        return ctx.writer.write(`shots/s${i + 1}.png`, png(width, height, rgb), "image/png");
      }),
    );
    const created = await ctx.writer.api("/api/collections", {
      title: "Fit collection",
      files: [await ctx.writer.write("index.md", "# Fit\n\nScreens.\n"), ...files],
    });
    const pinned = new URL(created.url).pathname;
    const gallery = `${base}${pinned}gallery/shots/`;
    const collection = `${base}${pinned}`;
    const still = { reducedMotion: "reduce" } as const;

    // Gallery: 16:10 thumbnails at phone width and in a short desktop window.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, ...still });
      await page.goto(gallery);
      await galleryFits(page, "390x844");
      const grid = z
        .object({ columns: z.string(), gap: z.string() })
        .parse(
          await page.evaluate(
            `(() => { const s = getComputedStyle(document.querySelector(".gallery")); return { columns: s.gridTemplateColumns, gap: s.columnGap }; })()`,
          ),
        );
      assert.equal(grid.columns.trim().split(/\s+/).length, 2, `two columns: ${grid.columns}`);
      assert.equal(grid.gap, "16px", "16 px gutters");
      for (const { cap } of await measureTiles(page))
        assert.ok(cap >= 44 - 0.5, `caption ${cap}px is under 44 px`);
      const stage = z.object({ img: z.string(), stage: z.string() }).parse(
        await page.evaluate(`(() => {
            const probe = document.createElement("div");
            probe.style.background = "var(--stage)";
            document.body.append(probe);
            const stage = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return { img: getComputedStyle(document.querySelector(".shot .img")).backgroundColor, stage };
          })()`),
      );
      assert.equal(stage.img, stage.stage, "thumbnails sit on the stage");
    }
    {
      const { page } = await ctx.newPage({ width: 1280, height: 560, ...still });
      await page.goto(gallery);
      await galleryFits(page, "1280x560");
    }

    // Menu contract, anchored under the bar at 1280x800.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, ...still });
      await page.goto(collection);
      await openFixture(page, "", false);
      await inViewport(page, "#t-last", "1280x800");
      assert.ok(
        (await number(page, 'document.querySelector("#t-menu .mbody").scrollHeight')) >
          (await number(page, 'document.querySelector("#t-menu .mbody").clientHeight')),
        "the list scrolls",
      );
      const barH = await number(
        page,
        'parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h"))',
      );
      const boxH = await number(
        page,
        'document.querySelector("#t-menu > .mbox").getBoundingClientRect().height',
      );
      const innerH = await number(page, "innerHeight");
      assert.ok(boxH <= innerH - barH - 20 + 1, `the menu is ${boxH}px, over the cap`);
      // The wheel scrolls the list to its end, never the page behind it. Chromium doesn't chain a
      // wheel out of a fixed top-layer popover even without containment, so the computed
      // overscroll-behavior is what guards it here; the wheel check below covers engines that do
      // chain. The collection shell fills the viewport, so a spacer gives the page room to scroll.
      assert.equal(
        await page.evaluate(
          'getComputedStyle(document.querySelector("#t-menu .mbody")).overscrollBehaviorY',
        ),
        "contain",
        "the list contains its overscroll",
      );
      await page.evaluate(`{
        const spacer = document.createElement("div");
        spacer.id = "t-spacer";
        spacer.style.height = "200vh";
        document.body.append(spacer);
      }`);
      assert.ok(
        (await number(page, "document.scrollingElement.scrollHeight")) >
          (await number(page, "document.scrollingElement.clientHeight")),
        "the page behind the menu can scroll",
      );
      const pageTop = await number(page, "document.scrollingElement.scrollTop");
      const body = await rect(page, "#t-menu .mbody");
      await page.mouse.move((body.left + body.right) / 2, (body.top + body.bottom) / 2);
      await page.mouse.wheel(0, 5000);
      await page.waitForFunction(
        '(() => { const b = document.querySelector("#t-menu .mbody"); return b.scrollTop + b.clientHeight >= b.scrollHeight - 1; })()',
      );
      // A second wheel at the list's end is the one that would chain to the page.
      await page.mouse.wheel(0, 5000);
      await page.evaluate(
        "new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 300))",
      );
      assert.equal(
        await number(page, "document.scrollingElement.scrollTop"),
        pageTop,
        "the page didn't scroll",
      );
      await page.evaluate('document.getElementById("t-spacer").remove()');
      await page.keyboard.press("Escape");

      // Header + body + footer keep that order at desktop size too.
      await openFixture(page, "2", true);
      await order(page, "2", "1280x800");
      await page.keyboard.press("Escape");

      // The Copy menu takes the contract from NAV-04; until then there's nothing to check.
      if ((await page.locator("#copy-menu > .mbox.has-list").count()) > 0) {
        await page.locator('header [popovertarget="copy-menu"][aria-haspopup]').click();
        await page.locator("#copy-menu").waitFor({ state: "visible" });
        await page.evaluate(
          '[...document.querySelectorAll("#copy-menu .mi")].at(-1).setAttribute("data-t-last", "")',
        );
        await inViewport(page, "#copy-menu [data-t-last]", "Copy menu");
        await page.keyboard.press("Escape");
      } else {
        console.log("A11Y-10: the Copy menu has no .mbox.has-list yet (NAV-04); skipped");
      }
    }

    // Menu contract as a phone sheet.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, ...still });
      await page.goto(collection);
      await openFixture(page, "", false);
      const boxH = await number(
        page,
        'document.querySelector("#t-menu > .mbox").getBoundingClientRect().height',
      );
      const innerH = await number(page, "innerHeight");
      assert.ok(boxH <= 0.85 * innerH + 1, `the sheet is ${boxH}px, over 85dvh`);
      await inViewport(page, "#t-last", "390x844");
      await page.keyboard.press("Escape");
      await page.locator("#t-menu").waitFor({ state: "hidden" });

      await openFixture(page, "2", true);
      const sheet = z.object({ top: z.number(), position: z.string(), rows: z.string() }).parse(
        await page.evaluate(`(() => {
            const mbox = document.querySelector("#t-menu2 > .mbox");
            const grabber = getComputedStyle(mbox, "::before");
            return {
              top: mbox.getBoundingClientRect().top + parseFloat(grabber.top),
              position: grabber.position,
              rows: getComputedStyle(mbox).gridTemplateRows,
            };
          })()`),
      );
      assert.equal(sheet.position, "absolute", "the grabber isn't a grid item");
      assert.equal(sheet.rows.trim().split(/\s+/).length, 3, `three rows: ${sheet.rows}`);
      // .mhead carries the grabber's room as top padding, so its content starts below it.
      const headContent = await number(
        page,
        `(() => { const head = document.querySelector("#t-menu2 > .mbox > .mhead"); return head.getBoundingClientRect().top + parseFloat(getComputedStyle(head).paddingTop); })()`,
      );
      assert.ok(headContent >= sheet.top + 4, `the grabber overlaps the header (${headContent})`);
      await order(page, "2", "390x844");
      // With the list scrolled to its end, the pinned action is the lowest thing in the sheet
      // (its own .mfoot, which holds it, aside).
      await page.evaluate(
        '(() => { const b = document.querySelector("#t-menu2 .mbody"); b.scrollTop = b.scrollHeight; })()',
      );
      const lowest = z.object({ last: z.number(), max: z.number() }).parse(
        await page.evaluate(`(() => {
          const mbox = document.querySelector("#t-menu2 > .mbox");
          const last = document.querySelector("#t-last2");
          const bottoms = [...mbox.querySelectorAll("*")]
            .filter((node) => !node.contains(last))
            .map((node) => node.getBoundingClientRect().bottom);
          return { last: last.getBoundingClientRect().bottom, max: Math.max(...bottoms) };
        })()`),
      );
      assert.ok(lowest.last >= lowest.max - 0.5, `something sits below the footer (${lowest.max})`);
      await inViewport(page, "#t-last2", "390x844 with a header");
    }

    // Keyboard: a menu opened with Enter keeps its focused item inside the box.
    {
      const { page } = await ctx.newPage({ width: 1280, height: 560, ...still });
      await page.goto(collection);
      const copy = page.locator('header [popovertarget="copy-menu"][aria-haspopup]');
      await copy.focus();
      await page.keyboard.press("Enter");
      await page.locator("#copy-menu").waitFor({ state: "visible" });
      // menus.ts moves focus in on the popover's toggle event, which fires after it shows.
      await page.waitForFunction(`document.activeElement?.closest("#copy-menu") != null`);
      const focusedInside = async (where: string) => {
        const inside = z.object({ menu: z.boolean(), within: z.boolean() }).parse(
          await page.evaluate(`(() => {
            const item = document.activeElement;
            const mbox = document.querySelector("#copy-menu > .mbox");
            const a = item.getBoundingClientRect();
            const b = mbox.getBoundingClientRect();
            return {
              // The last item is the footer's Share (NAV-09b), which the arrow keys rove too.
              menu: mbox.contains(item) && item.matches(".mi, .mnote [role=menuitem]"),
              within: a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5 && a.left >= b.left - 0.5 && a.right <= b.right + 0.5,
            };
          })()`),
        );
        assert.ok(inside.menu, `${where}: focus is on a menu item`);
        assert.ok(inside.within, `${where}: the focused item is outside the menu box`);
      };
      await focusedInside("Enter");
      await page.keyboard.press("End");
      await focusedInside("End");
      await page.keyboard.press("ArrowDown");
      await focusedInside("ArrowDown");
    }
  },
};
export default scenario;
