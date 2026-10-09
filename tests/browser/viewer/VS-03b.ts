// VS-03b: no Unicode icon glyphs anywhere in the writer, every icon an icons.ts SVG at one of the
// four sizes (12, 16, 18, 20) and aria-hidden. On the seeded demo writer (Postgres: #6 failed on
// #4, #7 uploading on #5; Webhook synced and shared; the checkout audit has a shots/ gallery):
// every page at 1280 and on a phone, the share and danger dialog bands (20 px icons, no bang),
// the Copy and More menus (no item icons), the status line's alert and clock, the health pill
// in forced colours (and OW-10b's elsewhere ring), Copied on a Copy URL button and the Files
// tree's folder chevron.
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  startDemoWriter,
  startWriter,
  VIEWPORTS,
  type PageOptions,
  type ViewerScenario,
} from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const WEBHOOK = "Webhook idempotency research";
const AUDIT = "Checkout flow screenshot audit";
// The banned set of tests/no-glyph-icons.test.ts, as escapes.
const BANNED =
  "\u2630\u22EF\u25BE\u25B8\u25B4\u25C2\u2315\u232B\u25CD\u26AF\u25C9\u25CE\u29C9\u2197\u21BA" +
  "\u21BB\u21C4\u2713\u2714\u2715\u2717\u2716\u25A6\u25CC\u25F7\u25CF\u24D8\u2442\u27F2\u270E" +
  "\u2399\u2303\u2304\u2039";
const SIZES = [12, 16, 18, 20];
const still = { reducedMotion: "reduce" } as const;

const audit = z.object({
  glyphs: z.array(z.string()),
  sizes: z.array(z.string()),
  unhidden: z.number(),
  icons: z.number(),
});
/**
 * One page's (or one root's) icon audit: (a) the visible text plus every aria-label and title has
 * no banned glyph and no emoji, (b) each visible svg.ic is square and 12, 16, 18 or 20 px, (c)
 * every svg.ic is aria-hidden.
 */
async function check(page: Page, where: string, root = "body"): Promise<void> {
  const found = audit.parse(
    await page.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(root)});
      const banned = new RegExp("[" + ${JSON.stringify(BANNED)} + "]|\\\\p{Extended_Pictographic}", "u");
      const strings = [root.innerText];
      for (const node of root.querySelectorAll("[aria-label], [title]"))
        strings.push(node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? "");
      const glyphs = strings.filter((text) => banned.test(text)).map((text) => text.slice(0, 80));
      const icons = [...root.querySelectorAll("svg.ic")];
      const sizes = icons.flatMap((svg) => {
        const r = svg.getBoundingClientRect();
        if (!r.width && !r.height) return [];
        const w = Math.round(r.width * 100) / 100, h = Math.round(r.height * 100) / 100;
        return w === h && ${JSON.stringify(SIZES)}.includes(w) ? [] :
          [w + "x" + h + " " + (svg.parentElement?.className ?? "") + ": " + (svg.parentElement?.textContent ?? "").trim().slice(0, 40)];
      });
      const unhidden = icons.filter((svg) => svg.getAttribute("aria-hidden") !== "true").length;
      return { glyphs, sizes, unhidden, icons: icons.length };
    })()`),
  );
  assert.deepEqual(found.glyphs, [], `${where}: no glyph or emoji in text, labels or titles`);
  assert.deepEqual(found.sizes, [], `${where}: every visible icon is square, 12/16/18/20 px`);
  assert.equal(found.unhidden, 0, `${where}: every icon is aria-hidden`);
}

const rect = z.object({ width: z.number(), height: z.number() });
async function size(page: Page, selector: string): Promise<z.infer<typeof rect>> {
  return rect.parse(await page.locator(selector).first().boundingBox());
}
async function isSquare(page: Page, selector: string, px: number, where: string): Promise<void> {
  assert.ok(await page.locator(selector).first().isVisible(), `${where}: ${selector} shows`);
  const box = await size(page, selector);
  assert.deepEqual(
    [Math.round(box.width), Math.round(box.height)],
    [px, px],
    `${where}: ${selector} is ${px}x${px}`,
  );
}
/** The page a link titled `title` on `/` opens, as a path. */
async function pathOf(page: Page, base: string, title: string): Promise<string> {
  await page.goto(`${base}/`);
  const href = await page.locator("main a", { hasText: title }).first().getAttribute("href");
  assert.ok(href, `/ links ${title}`);
  return new URL(href, base).pathname;
}
/** A History row's link for revision `n` (its pinned page). */
async function revisionPath(page: Page, base: string, collection: string, n: number) {
  await page.goto(`${base}${collection}?panel=history`);
  const href = await page
    .locator("#tp-history a", { hasText: new RegExp(`^#${n}\\b`) })
    .first()
    .getAttribute("href");
  assert.ok(href, `History links #${n}`);
  const pinned = /^(\/c\/[^/]+\/r\/[^/]+\/)/.exec(new URL(href, base).pathname)?.[1];
  assert.ok(pinned, `#${n}'s pinned path: ${href}`);
  return pinned;
}

/** Opens the share dialog: the bar's Share, or More → Share… where the bar has none. */
async function openShare(page: Page): Promise<void> {
  const share = page.locator("header.cbar button[commandfor=share]");
  if (await share.isVisible()) await share.click();
  else {
    await page.locator('header.cbar [popovertarget="more-menu"]').click();
    await page
      .locator("#more-menu")
      .getByRole("menuitem", { name: /^Share/ })
      .click();
  }
  await page.locator("#share").waitFor({ state: "visible" });
}
const bandFacts = z.object({
  icons: z.array(rect),
  bangs: z.number(),
  hiddenBangs: z.number(),
});
async function band(page: Page, where: string): Promise<void> {
  const facts = bandFacts.parse(
    await page.evaluate(`(() => {
      const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
      const icons = [...dialog.querySelectorAll(".band svg.ic")].filter((svg) => svg.getClientRects().length)
        .map((svg) => { const r = svg.getBoundingClientRect(); return { width: r.width, height: r.height }; });
      const hiddenBangs = [...dialog.querySelectorAll('[aria-hidden="true"]')]
        .filter((node) => node.textContent.trim() === "!").length;
      return { icons, bangs: dialog.querySelectorAll(".band .bang").length, hiddenBangs };
    })()`),
  );
  assert.deepEqual(
    facts.icons.map((icon) => [icon.width, icon.height]),
    [[20, 20]],
    `${where}: the band's icon is 20x20`,
  );
  assert.equal(facts.bangs, 0, `${where}: no .bang in the band`);
  assert.equal(facts.hiddenBangs, 0, `${where}: no aria-hidden "!"`);
}

const scenario: ViewerScenario = {
  name: "VS-03b no glyph icons: icons.ts SVGs at 12/16/18/20 px everywhere, bands, menus, pill",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page: desk } = await ctx.newPage({ ...VIEWPORTS.desktop, ...still });
    const postgres = await pathOf(desk, base, POSTGRES);
    const webhook = await pathOf(desk, base, WEBHOOK);
    const checkout = await pathOf(desk, base, AUDIT);
    const five = await revisionPath(desk, base, postgres, 5);
    const six = await revisionPath(desk, base, postgres, 6);
    const seven = await revisionPath(desk, base, postgres, 7);
    const fivePub = five.split("/")[4];
    const changes = `${seven}changes?base=${fivePub}`;
    await desk.goto(`${base}${checkout}`);
    const galleryHref = await desk.locator(".tree a.gal").first().getAttribute("href");
    assert.ok(galleryHref, "the audit's Files tree has a View as gallery row");
    const gallery = new URL(galleryHref, base).pathname;

    // (a)–(c) on every page, at 1280 and on a phone.
    const pages = [
      "/",
      postgres,
      `${postgres}?panel=history`,
      `${webhook}?panel=links`,
      "/links",
      "/trash",
      "/status",
      "/mcp",
      changes,
      gallery,
    ];
    const viewports: [string, PageOptions][] = [
      ["1280", { ...VIEWPORTS.desktop, ...still }],
      ["390", { ...VIEWPORTS.phone, ...still }],
    ];
    for (const [label, options] of viewports) {
      const { page } = await ctx.newPage(options);
      for (const path of pages) {
        await page.goto(`${base}${path}`);
        await check(page, `${label} ${path}`);
      }

      // Dialog bands: the Webhook share dialog (globe) and the Postgres #6 Drop… confirm (alert).
      await page.goto(`${base}${webhook}`);
      await openShare(page);
      await band(page, `${label} share dialog`);
      await check(page, `${label} share dialog`, "#share");
      await page.locator("#share label.opt", { hasText: "Latest revision" }).click();
      await page.locator("#share .expiry label", { hasText: "Never" }).click();
      await page.evaluate(`document.querySelector("#share details.sees").open = true`);
      const sees = z.array(z.object({ w: z.number(), h: z.number(), text: z.string() })).parse(
        await page.evaluate(`[...document.querySelectorAll("#share .sees .bang")]
          .filter((bang) => bang.getClientRects().length && getComputedStyle(bang).visibility !== "hidden")
          .map((bang) => { const svg = bang.querySelector("svg.ic"); const r = svg?.getBoundingClientRect();
            return { w: r?.width ?? 0, h: r?.height ?? 0, text: bang.textContent.trim() }; })`),
      );
      assert.equal(sees.length, 2, `${label}: Latest and No expiry show both warning rows`);
      assert.deepEqual(
        sees.map((row) => [row.w, row.h, row.text]),
        [
          [16, 16, ""],
          [16, 16, ""],
        ],
        `${label}: each warning row holds a 16 px icon and no "!"`,
      );
      await check(page, `${label} share dialog, Latest, no expiry`, "#share");
      await page.locator("#share").getByRole("button", { name: "Cancel" }).click();
      await page.locator("#share").waitFor({ state: "hidden" });

      await page.goto(`${base}${six}`);
      await page.locator(".status1 [data-action=drop]").click();
      await page.locator("dialog#confirm").waitFor({ state: "visible" });
      await band(page, `${label} Drop #6`);
      await check(page, `${label} Drop #6`, "dialog#confirm");
      await page.locator("dialog#confirm [data-confirm-cancel]").click();
      await page.locator("dialog#confirm").waitFor({ state: "hidden" });

      // The status line on #5: alert before "#6 failed", clock before "#7 …uploading", 16 px.
      await page.goto(`${base}${five}`);
      await isSquare(page, ".status1 .f svg.ic", 16, `${label} #5`);
      await isSquare(page, ".status1 .p svg.ic", 16, `${label} #5`);
      const tone = z.object({ stroke: z.string(), color: z.string(), tap: z.string() }).parse(
        await page.evaluate(`(() => {
          const f = document.querySelector(".status1 .f");
          return { stroke: getComputedStyle(f.querySelector("svg.ic")).stroke,
            color: getComputedStyle(f).color,
            tap: document.querySelector(".status1 .stap").textContent };
        })()`),
      );
      assert.equal(
        tone.stroke,
        tone.color,
        `${label} #5: the alert's stroke is the segment colour`,
      );
      assert.ok(!/[!\u25CC\u25CF]/.test(tone.tap), `${label} #5: the tap target has no glyph`);
      assert.ok(
        !new RegExp(`[${BANNED}]`).test(tone.tap),
        `${label} #5: the tap target has no glyph`,
      );
      assert.equal(await page.locator(".status1 .stap svg").count(), 0, "no icon in .stap");
      const name = await page.locator(".status1 .stap").getAttribute("aria-label");
      assert.ok(
        name?.startsWith("#6 failed to sync"),
        `${label} #5: the tap target's name: ${name}`,
      );
    }

    // Menus (1280): no item has an icon or a glyph.
    await desk.goto(`${base}${postgres}`);
    for (const [button, menu] of [
      ['header.cbar [popovertarget="copy-menu"]', "#copy-menu"],
      ['header.cbar [popovertarget="more-menu"]', "#more-menu"],
    ] as const) {
      await desk.locator(button).first().click();
      await desk.locator(menu).waitFor({ state: "visible" });
      const items = z
        .array(z.object({ svg: z.boolean(), text: z.string() }))
        .parse(
          await desk.evaluate(
            `[...document.querySelectorAll(${JSON.stringify(`${menu} .mi`)})].map((mi) => ({ svg: !!mi.querySelector("svg"), text: mi.textContent }))`,
          ),
        );
      assert.ok(items.length >= 3, `${menu}: ${items.length} items`);
      assert.deepEqual(
        items.filter((item) => item.svg || new RegExp(`[${BANNED}]`).test(item.text)),
        [],
        `${menu}: no item icons or glyphs`,
      );
      await desk.keyboard.press("Escape");
      await desk.locator(menu).waitFor({ state: "hidden" });
    }

    // Copy → Link to latest still copies (clipboard granted).
    await desk.evaluate("navigator.clipboard.writeText('')");
    await desk.locator('header.cbar [popovertarget="copy-menu"]').first().click();
    await desk
      .locator("#copy-menu")
      .getByRole("menuitem", { name: /^Link to latest/ })
      .click();
    await desk.waitForFunction("navigator.clipboard.readText().then((text) => text.length > 0)");
    const copied = z.string().parse(await desk.evaluate("navigator.clipboard.readText()"));
    assert.ok(copied.endsWith(postgres), `Link to latest copies the latest URL: ${copied}`);

    // Copied on /links: the check icon and "Copied", then the label again.
    await desk.goto(`${base}/links`);
    const copyUrl = desk.locator("[data-copy-url]").first();
    const before = await copyUrl.innerHTML();
    await copyUrl.click();
    await desk.waitForFunction(
      `document.querySelector("[data-copy-url]").hasAttribute("data-copied")`,
    );
    assert.equal((await copyUrl.innerText()).trim(), "Copied");
    assert.equal(await copyUrl.locator("svg.ic").count(), 1, "Copied shows the check icon");
    await isSquare(desk, "[data-copy-url] svg.ic", 16, "Copied");
    await desk.waitForFunction(
      `!document.querySelector("[data-copy-url]").hasAttribute("data-copied")`,
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await copyUrl.innerHTML(), before, "Copy URL restores its label");

    // Pinned state colours: the created link's Active globe is --public (as on the server's chip),
    // and the local-only hero's sync-off dot is --muted, also on prod's warning-toned hero.
    const colours = async (selector: string, token: string) =>
      z.object({ icon: z.string(), token: z.string() }).parse(
        await desk.evaluate(`(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(${token})";
          document.body.append(probe);
          const token = getComputedStyle(probe).color;
          probe.remove();
          return { icon: getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color, token };
        })()`),
      );
    await desk.goto(`${base}${webhook}`);
    // The demo writer runs with sync off, so the new link would stay Activating: answer as active.
    await desk.route("**/share-links", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const response = await route.fetch();
      const body = z
        .object({ share_link: z.record(z.string(), z.unknown()) })
        .passthrough()
        .parse(await response.json());
      await route.fulfill({
        response,
        json: { ...body, share_link: { ...body.share_link, state: "active" } },
      });
    });
    await openShare(desk);
    await desk.locator("#share [data-share-submit]").click();
    await desk.locator("#share [data-share-state] svg.ic").waitFor({ state: "visible" });
    assert.equal((await desk.locator("#share [data-share-state]").innerText()).trim(), "Active");
    await isSquare(desk, "#share [data-share-state] svg.ic", 12, "Active chip");
    const active = await colours("#share [data-share-state] svg.ic", "--public");
    assert.equal(active.icon, active.token, "the Active chip's globe is --public");
    await desk.unroute("**/share-links");
    // The demo fakes a cloud, so local-only mode needs plain writers: dev (off tone) and prod (warn).
    for (const [environment, tone] of [
      ["dev", "off"],
      ["prod", "warn"],
    ] as const) {
      const local = await startWriter({ env: { WAYPOINT_ENV: environment } });
      await desk.goto(`${local.base}/status`);
      const dot = await colours(`.hero.${tone} > svg.ic`, "--muted");
      assert.equal(
        dot.icon,
        dot.token,
        `${environment} local-only hero: the sync-off dot is --muted`,
      );
      await local.stop();
    }

    // The health pill: one state icon, no state dot; visible in forced colours.
    for (const path of [postgres, "/"]) {
      await desk.goto(`${base}${path}`);
      const pill = z.object({ icons: z.number(), dots: z.number() }).parse(
        await desk.evaluate(`(() => {
          const pill = document.querySelector("header.bar .health");
          return { icons: pill.querySelectorAll("svg.ic").length,
            dots: pill.querySelectorAll("span.d:not(.ring)").length };
        })()`),
      );
      assert.deepEqual(pill, { icons: 1, dots: 0 }, `${path}: the pill's icon, no state dot`);
    }
    {
      const { page } = await ctx.newPage({
        ...VIEWPORTS.desktop,
        ...still,
        forcedColors: "active",
      });
      await page.goto(`${base}${five}`);
      await isSquare(page, "header.bar .health svg.ic", 16, "forced colours");
      const stroke = await page.evaluate(
        `getComputedStyle(document.querySelector("header.bar .health svg.ic")).stroke`,
      );
      assert.notEqual(stroke, "none", "forced colours: the pill's icon has a stroke");
      await isSquare(page, ".status1 .f svg.ic", 16, "forced colours");
      await isSquare(page, ".status1 .p svg.ic", 16, "forced colours");
    }
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.tablet, ...still, forcedColors: "active" });
      await page.goto(`${base}${webhook}`);
      const ring = page.locator("header.bar .health .d.ring");
      assert.ok(await ring.isVisible(), "Webhook at 820: the elsewhere ring shows");
      const border = z.object({ style: z.string(), width: z.number() }).parse(
        await page.evaluate(`(() => {
          const s = getComputedStyle(document.querySelector("header.bar .health .d.ring"));
          return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth) };
        })()`),
      );
      assert.equal(border.style, "solid", "forced colours: the ring's border is solid");
      assert.ok(border.width >= 1, `forced colours: the ring's border is ${border.width} px`);
    }

    // The Files tree: shots/ starts with a 12 px chevron, turned −90° while closed.
    await desk.goto(`${base}${checkout}`);
    const summary = desk.locator('.tree details[data-dir="shots/"] > summary');
    assert.equal(await summary.locator("> svg.ic.sm").count(), 1, "shots/ has its chevron");
    assert.ok(
      z
        .boolean()
        .parse(
          await desk.evaluate(
            `document.querySelector('.tree details[data-dir="shots/"] > summary').firstElementChild.matches("svg.ic.sm")`,
          ),
        ),
      "the chevron comes first",
    );
    const turn = async () =>
      z
        .string()
        .parse(
          await desk.evaluate(
            `getComputedStyle(document.querySelector('.tree details[data-dir="shots/"] > summary > svg.ic')).transform`,
          ),
        );
    const open = z
      .boolean()
      .parse(
        await desk.evaluate(`document.querySelector('.tree details[data-dir="shots/"]').open`),
      );
    if (!open) await summary.click();
    assert.equal(await turn(), "none", "open: the chevron points down");
    await summary.click();
    const closed = /^matrix\(([-\d.e]+), ([-\d.e]+), ([-\d.e]+), ([-\d.e]+), 0, 0\)$/.exec(
      await turn(),
    );
    assert.ok(closed, "closed: a rotation matrix");
    assert.deepEqual(
      closed.slice(1).map((value) => Math.round(Number(value))),
      [0, -1, 1, 0],
      "closed: turned −90°",
    );
    // Open again: the folder's View as gallery row has a 12 px grid icon.
    await summary.click();
    await isSquare(desk, ".tree a.gal svg.ic", 12, "View as gallery");
  },
};
export default scenario;
