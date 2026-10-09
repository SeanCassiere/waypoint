// OW-12a: an honest Changes page. The stepper (Previous · Change N of M · Next) moves through the
// changes and docks above the phone tab bar; folds say Hide when open; source hunks load numbered
// lines; a removed image is framed in --del with its dimensions after load; changed is violet.
import { deflateSync } from "node:zlib";

import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const numbers = z.array(z.number());
const text = z.string();

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
  return Buffer.concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const steady = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `Steady paragraph ${from + index}.`).join("\n\n");
/** Three changes (a paragraph, a code line, a paragraph) between unchanged runs. */
const doc = (hours: string, jobs: string, last: string) =>
  [
    "# Runbook",
    steady(1, 8),
    `Retry for ${hours} hours.`,
    steady(9, 8),
    `\`\`\`sh\npg_upgrade --check\npg_upgrade --jobs ${jobs}\nvacuumdb --all\n\`\`\``,
    steady(17, 8),
    last,
    steady(25, 4),
  ].join("\n\n") + "\n";

/** A custom property's computed colour, as getComputedStyle reports colours. */
const resolved = (page: Page, token: string) =>
  page.evaluate(`(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(${token})";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  })()`);

async function outputText(page: Page): Promise<string> {
  return text.parse(await page.locator("[data-step-count]").textContent());
}

async function activeIndex(page: Page): Promise<number> {
  return z
    .number()
    .parse(
      await page.evaluate(
        '[...document.querySelectorAll("[data-change]")].filter((node) => node.offsetParent !== null).indexOf(document.activeElement)',
      ),
    );
}

const scenario: ViewerScenario = {
  name: "OW-12a honest Changes page",
  async run(ctx) {
    const { base } = ctx.writer;
    const first = await ctx.writer.api("/api/collections", {
      title: "Honest changes",
      head_path: "runbook.md",
      files: [
        await ctx.writer.write("runbook.md", doc("72", "4", "Owner is Al.")),
        await ctx.writer.write("cart.png", png(72, 45, [200, 40, 40]), "image/png"),
      ],
    });
    const second = await ctx.writer.api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Shorter retries",
      mode: "replace",
      files: [await ctx.writer.write("runbook.md", doc("24", "8", "Owner is Bo."))],
    });
    const changes = `${base}${new URL(second.url).pathname}changes`;

    // Desktop: the stepper shows the count, then steps with clicks and k.
    const { page } = await ctx.newPage({ width: 1280, height: 800 });
    await page.goto(changes);
    await page.locator("[data-stepper]").waitFor({ state: "visible" });
    assert.equal(await outputText(page), "3 changes");
    const next = page.locator('[data-stepper] button[data-step="1"]');
    await next.click();
    assert.equal(await activeIndex(page), 0, "first Next focuses the first change");
    assert.equal(
      await page.evaluate('document.activeElement.matches(":focus-visible")'),
      true,
      "a pointer click on Next leaves a focus ring on the change",
    );
    await next.click();
    assert.equal(await activeIndex(page), 1, "second Next focuses the second change");
    assert.ok((await outputText(page)).startsWith("Change 2 of 3"), await outputText(page));
    assert.equal(await outputText(page), "Change 2 of 3, runbook.md, code, 1 line changed");
    await page.keyboard.press("k");
    assert.equal(await activeIndex(page), 0, "k goes back to the first change");
    assert.equal(await outputText(page), "Change 1 of 3, runbook.md, paragraph changed");
    // Safari (and Firefox on macOS) don't focus a clicked button, and the click blurs the change:
    // with focus on the body, Next still moves on from the change it last focused.
    const clickUnfocused = () =>
      page.evaluate(`(() => {
        document.activeElement?.blur();
        document.querySelector('[data-stepper] button[data-step="1"]').click();
      })()`);
    await clickUnfocused();
    assert.equal(await activeIndex(page), 1, "unfocused Next moves to the second change");
    await clickUnfocused();
    assert.equal(await activeIndex(page), 2, "unfocused Next again moves to the third change");
    assert.ok((await outputText(page)).startsWith("Change 3 of 3"), await outputText(page));
    await page.keyboard.press("k");
    assert.equal(await activeIndex(page), 1, "k still steps back from the focused change");

    // Colour role: the changed bar is --changed.
    const changed = text.parse(await resolved(page, "--changed"));
    const shadow = text.parse(
      await page.evaluate('getComputedStyle(document.querySelector(".blk.mod")).boxShadow'),
    );
    assert.ok(shadow.includes(changed), `light: ${shadow} has ${changed}`);

    // A fold: opening it loads its blocks and swaps the label.
    const fold = page.locator("details.folded[data-fold]").first();
    await fold.locator("summary").click();
    await page.locator('details.folded[data-fold-state="loaded"]').first().waitFor();
    const labels = z
      .array(z.string())
      .parse(
        await page.evaluate(
          '[".when-open", ".when-closed"].map((selector) => getComputedStyle(document.querySelector(`details.folded[data-fold-state="loaded"] > summary ${selector}`)).display)',
        ),
      );
    assert.notEqual(labels[0], "none", "Hide shows when open");
    assert.equal(labels[1], "none", "Show hides when open");
    assert.ok((await fold.locator(".blk").count()) > 0, "the fold's blocks loaded");

    // The removed image: framed in --del, its dimensions after load.
    const removed = page.locator("figure.rmimg");
    await removed.scrollIntoViewIfNeeded();
    await removed.locator("[data-dim-wrap]").waitFor({ state: "visible" });
    assert.match(text.parse(await removed.locator("[data-dim]").textContent()), /^\d+×\d+$/);
    assert.equal(await removed.locator("[data-dim]").textContent(), "72×45");
    const del = text.parse(await resolved(page, "--del"));
    assert.equal(
      await page.evaluate(
        'getComputedStyle(document.querySelector("figure.rmimg .img")).borderTopColor',
      ),
      del,
      "the removed image's frame is --del",
    );

    // Source view: a hunk loads numbered unchanged lines.
    await page.goto(`${changes}?view=source`);
    const hunk = page.locator("details.lnfold").first();
    await hunk.locator("summary").click();
    await hunk.locator(".ln").first().waitFor();
    assert.ok((await hunk.locator(".ln .n").first().textContent())?.match(/^\d+$/));

    // Dark: the changed bar follows the dark --changed.
    const dark = (await ctx.newPage({ width: 1280, height: 800, colorScheme: "dark" })).page;
    await dark.goto(changes);
    const darkChanged = text.parse(await resolved(dark, "--changed"));
    assert.notEqual(darkChanged, changed, "dark --changed differs");
    const darkShadow = text.parse(
      await dark.evaluate('getComputedStyle(document.querySelector(".blk.mod")).boxShadow'),
    );
    assert.ok(darkShadow.includes(darkChanged), `dark: ${darkShadow} has ${darkChanged}`);

    // Phone: docked on the tab bar, 44px buttons, no keycaps, the last change scrolls clear.
    const phone = (await ctx.newPage({ ...VIEWPORTS.phone })).page;
    await phone.goto(changes);
    await phone.locator("[data-stepper]").waitFor({ state: "visible" });
    assert.equal(
      await phone.evaluate('getComputedStyle(document.querySelector("[data-stepper]")).position'),
      "fixed",
    );
    const dock = numbers.parse(
      await phone.evaluate(`(() => {
        const stepper = document.querySelector("[data-stepper]").getBoundingClientRect();
        const tabbar = document.querySelector(".tabbar").getBoundingClientRect();
        const buttons = [...document.querySelectorAll("[data-stepper] button")].map((node) => node.getBoundingClientRect().height);
        return [stepper.bottom, tabbar.top, ...buttons];
      })()`),
    );
    const [bottom = NaN, tabTop = NaN, ...heights] = dock;
    assert.ok(Math.abs(bottom - tabTop) <= 1, `stepper bottom ${bottom}, tab bar top ${tabTop}`);
    assert.equal(heights.length, 2);
    for (const height of heights) assert.ok(height >= 44, `button ${height}px tall`);
    assert.deepEqual(
      await phone.evaluate(
        '[...document.querySelectorAll("[data-stepper] kbd")].map((node) => getComputedStyle(node).display)',
      ),
      ["none", "none"],
      "no keycaps on the phone",
    );
    const clear = numbers.parse(
      await phone.evaluate(`(() => {
        for (const node of [document.scrollingElement, document.querySelector(".cmp"), document.querySelector(".main")])
          if (node) node.scrollTop = node.scrollHeight;
        const changes = [...document.querySelectorAll("[data-change]")];
        const last = changes[changes.length - 1].getBoundingClientRect();
        return [last.bottom, document.querySelector("[data-stepper]").getBoundingClientRect().top];
      })()`),
    );
    const [lastBottom = NaN, dockTop = NaN] = clear;
    assert.ok(lastBottom <= dockTop + 1, `last change ends at ${lastBottom}, dock at ${dockTop}`);

    // Phone: an over-limit run's link names a long file path; it wraps instead of being clipped.
    const long =
      "migration_20261009_customer_subscription_line_item_reconciliation_and_backfill_runbook.md";
    const big = await ctx.writer.api("/api/collections", {
      title: "Long run",
      head_path: long,
      files: [await ctx.writer.write(long, `${steady(1, 250)}\n\nLast is old.\n`)],
    });
    const bigNext = await ctx.writer.api(`/api/collections/${big.collection_id}/revisions`, {
      message: "Last is new",
      mode: "replace",
      files: [await ctx.writer.write(long, `${steady(1, 250)}\n\nLast is new.\n`)],
    });
    await phone.goto(`${base}${new URL(bigNext.url).pathname}changes`);
    const link = phone.locator("a.fold").first();
    await link.waitFor();
    assert.ok((await link.textContent())?.includes(`(opens ${long} on its own)`));
    const fit = numbers.parse(
      await phone.evaluate(
        '(() => { const link = document.querySelector("a.fold"); return [link.scrollWidth, link.clientWidth]; })()',
      ),
    );
    const [linkScroll = NaN, linkClient = NaN] = fit;
    assert.ok(linkScroll <= linkClient, `fold link ${linkScroll}px wide in ${linkClient}px`);
  },
};
export default scenario;
