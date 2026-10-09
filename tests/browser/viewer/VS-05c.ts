// VS-05c: one button family. On the seeded demo writer: every visible text field is at least
// 16 px on a phone (Recent with Find, a search, the share and details dialogs, History's compare
// mode, /links, the Trash purge dialog) and keeps its desktop size on a mouse; every visible
// control on the audited pages has a 44 × 44 px hit area at 390 × 844 touch; at 760 px with a
// mouse the row actions are 44 px tall and /links' are equal width; Revoke… and Revoke all stay
// quiet red text while every confirm step (the Revoke popover, the shared confirm dialog) is
// danger-solid.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const WEBHOOK = "Webhook idempotency research";
const AUDIT = "Checkout flow screenshot audit";
const LEAKED = "Leaked .env in run output (do not share)";
const PHONE = { ...VIEWPORTS.phone, mobile: true, reducedMotion: "reduce" } as const;
const NARROW = { width: 760, height: 900, touch: false, reducedMotion: "reduce" } as const;
const DESKTOP = { ...VIEWPORTS.desktop, reducedMotion: "reduce" } as const;

const field = z.object({ name: z.string(), size: z.number() });
/** Every visible text field (not checkboxes, radios or hidden inputs) and its font size. */
const FIELDS = `(() => [...document.querySelectorAll(
    "input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea")]
  .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
  .map((el) => ({
    name: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
      (el.name ? "[name=" + el.name + "]" : "") + (el.closest("dialog[id]") ? " in #" + el.closest("dialog[id]").id : ""),
    size: parseFloat(getComputedStyle(el).fontSize),
  })))()`;
async function fields(page: Page): Promise<z.infer<typeof field>[]> {
  return z.array(field).parse(await page.evaluate(FIELDS));
}
/** Every visible field is at least 16 px; returns how many were checked. */
async function sixteen(page: Page, where: string): Promise<number> {
  const found = await fields(page);
  const small = found.filter((f) => f.size < 16).map((f) => `${f.name} · ${f.size}px`);
  assert.deepEqual(small, [], `${where}: every visible field is ≥ 16 px on a phone`);
  return found.length;
}

/**
 * The 44 px audit (Spec §5). Each visible interactive element's hit area, by hitBox(): a row link
 * stretched over its row (A11Y-04's li.item a.tlink, History's .rv a.rvl) is its row; anything
 * else, the health pill included (OW-10b's own 44 × 44 box), is its own border box. Exempt:
 * - links shown inline inside running text (WCAG 2.5.8's inline exception);
 * - elements under aria-hidden="true", inert or a closed dialog, and the visually hidden .sr/.vh
 *   (the skip link until it's focused): nobody presses them;
 * - anything not rendered (closed details, popovers and menus);
 * - the document's iframe (another document; not queried);
 * - while a modal dialog is open, everything outside it (inert);
 * - checkboxes and radios whose label is at least 44 px tall (the label is the press).
 * A search filter chip's × (NAV-03: a 22 px circle on purpose) is measured by its coarse-pointer
 * ::before tap, which must take a press 21 px out from its centre, every way.
 * Returns "selector · w×h" for each control under 44 × 44.
 */
const HIT_AUDIT = `(() => {
  const SEL = 'a[href], button, summary, input:not([type=hidden]), select, textarea, ' +
    '[role=button], [role=menuitem], [role=tab], [tabindex]:not([tabindex="-1"])';
  const PROSE = "p, li, dd, .legend, .note, .lede, .long, .muted";
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    (el.classList.length ? "." + [...el.classList].join(".") : "") + ' "' +
    (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) + '"';
  const hitBox = (el) => {
    if (el.matches(".fchip a")) {
      // NAV-03 sized the chip's × to a 22 px circle on purpose and gives it a 44 × 44 tap under
      // coarse pointers through its ::before. Measure that box, and count it only if a press
      // 21 px out from the centre, every way, lands on the × (nothing beside it covers the tap).
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const b = getComputedStyle(el, "::before");
      if (b.content === "none" || b.position !== "absolute") return { w: r.width, h: r.height };
      const px = (v) => parseFloat(v) || 0;
      const box = { w: r.width - px(b.left) - px(b.right), h: r.height - px(b.top) - px(b.bottom) };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const probes = [[cx - 21, cy], [cx + 21, cy], [cx, cy - 21], [cx, cy + 21]];
      return probes.every(([x, y]) => el.contains(document.elementFromPoint(x, y))) ? box
        : { w: 0, h: 0 };
    }
    const stretched = el.matches("li.item a.tlink") ? el.closest("li")
      : el.matches(".rv a.rvl") ? el.closest(".rv") : el;
    const r = stretched.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  const modal = document.querySelector("dialog:modal");
  const fails = [];
  for (const el of document.querySelectorAll(SEL)) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.visibility === "hidden" || r.width === 0 || r.height === 0) continue;
    if (el.closest('[aria-hidden="true"], [inert], .vh, .sr, dialog:not([open])')) continue;
    if (el.matches(".skip") && document.activeElement !== el) continue;
    if (modal && !modal.contains(el)) continue;
    if (el.matches("a") && s.display === "inline" && el.parentElement.closest(PROSE)) continue;
    let box;
    if (el.matches("input[type=checkbox], input[type=radio]")) {
      const label = el.closest("label") || (el.id && document.querySelector('label[for="' + el.id + '"]'));
      const lr = (label || el).getBoundingClientRect();
      if (lr.height >= 44) continue;
      box = { w: lr.width, h: lr.height };
    } else box = hitBox(el);
    if (box.w < 44 || box.h < 44) fails.push(name(el) + " · " + box.w.toFixed(1) + "×" + box.h.toFixed(1));
  }
  return fails;
})()`;
async function audit(page: Page, where: string): Promise<void> {
  const fails = z.array(z.string()).parse(await page.evaluate(HIT_AUDIT));
  assert.deepEqual(fails, [], `${where}: every visible control is at least 44 × 44 px`);
}

/** Links that stand alone at ≤ 760 px: a group's title, Links tab/Trash, Show, Latest is #7 →. */
const STANDALONE =
  ".ag .t a, .sgrp h3 a, .lgh h2 a, .lgh .tab, [data-links-page] > .legend a, .status1 .seg1 a";
/**
 * Each visible standalone link takes a press 1 px inside each edge of its 44 px box (nothing
 * beside it covers part of the box), and stays 44 × 44 with a one-letter label. Returns the
 * failures and how many links were checked.
 */
const STANDALONE_AUDIT = `(() => {
  const links = [...document.querySelectorAll(${JSON.stringify(STANDALONE)})]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const fails = [];
  for (const el of links) {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const name = '"' + el.textContent.replace(/\\s+/g, " ").trim().slice(0, 30) + '"';
    const points = [[r.left + 1, r.top + r.height / 2], [r.right - 1, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + 1], [r.left + r.width / 2, r.bottom - 1]];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!el.contains(hit)) fails.push(name + " covered at " + Math.round(x - r.left) + "," +
        Math.round(y - r.top) + " by " + (hit ? hit.tagName.toLowerCase() + "." + hit.className : "nothing"));
    }
    el.textContent = "A";
    const a = el.getBoundingClientRect();
    if (a.width < 44 || a.height < 44) fails.push(name + ' as "A" · ' + a.width.toFixed(1) + "×" + a.height.toFixed(1));
  }
  return { fails, checked: links.length };
})()`;
/** Runs STANDALONE_AUDIT (it rewrites labels, so call it last on a page) and returns the count. */
async function standalone(page: Page, where: string): Promise<number> {
  const { fails, checked } = z
    .object({ fails: z.array(z.string()), checked: z.number() })
    .parse(await page.evaluate(STANDALONE_AUDIT));
  assert.deepEqual(fails, [], `${where}: standalone links are unobstructed 44 × 44 presses`);
  return checked;
}

const box = z.object({ w: z.number(), h: z.number() });
/** The border boxes of the visible matches. */
async function boxes(page: Page, selector: string): Promise<z.infer<typeof box>[]> {
  return z.array(box).parse(
    await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
        .map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; })`,
    ),
  );
}
async function tall(page: Page, selector: string, where: string, count?: number): Promise<void> {
  const found = await boxes(page, selector);
  if (count === undefined) assert.ok(found.length > 0, `${where}: ${selector} shows`);
  else assert.equal(found.length, count, `${where}: ${selector} shows ${count}`);
  for (const b of found) assert.ok(b.h >= 44, `${where}: a ${b.h}px ${selector}`);
}
/** Each container's controls are one equal-width row (±1 px) of 44 px presses. */
async function equalRows(page: Page, container: string, where: string): Promise<void> {
  const rows = z.array(z.array(box)).parse(
    await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(container)})]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
        .map((el) => [...el.children]
          .filter((k) => k.matches(".btn, .txtbtn, details.act") && k.getClientRects().length)
          .map((k) => { const r = k.getBoundingClientRect(); return { w: r.width, h: r.height }; }))`,
    ),
  );
  assert.ok(rows.length > 0, `${where}: ${container} shows`);
  for (const row of rows) {
    const widths = row.map((b) => b.w);
    assert.ok(
      Math.max(...widths) - Math.min(...widths) <= 1,
      `${where}: ${container}'s controls are equal width (${widths.join(", ")})`,
    );
    for (const b of row) assert.ok(b.h >= 44, `${where}: a ${b.h}px control in ${container}`);
  }
}
/** The class list of the shared confirm dialog's OK button. */
async function okClass(page: Page): Promise<string> {
  return z
    .string()
    .parse(await page.evaluate(`document.querySelector("#confirm [data-confirm-ok]").className`));
}

/** The page a link titled `title` on `/` opens, as a path. */
async function pathOf(page: Page, base: string, title: string): Promise<string> {
  await page.goto(`${base}/`);
  const href = await page.locator("main a", { hasText: title }).first().getAttribute("href");
  assert.ok(href, `/ links ${title}`);
  return new URL(href, base).pathname;
}
/** Revision n's pinned page, from History. */
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
/** Phones: the panel is a sheet opened from the tab bar; `links` switches it to the Links tab. */
async function openSheet(page: Page, links: boolean): Promise<void> {
  await page.locator('.tabbar [data-tab="history"]').click();
  await page.waitForFunction(`document.querySelector("#shell")?.classList.contains("open")`);
  if (links) {
    await page.locator("#tab-links").click();
    await page.locator("#tp-links .lnk").first().waitFor();
  }
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
/** More → Edit details… (NAV-11's dialog). */
async function openDetails(page: Page): Promise<void> {
  await page.locator('header.cbar [popovertarget="more-menu"]').click();
  await page
    .locator("#more-menu")
    .getByRole("menuitem", { name: /^Edit details/ })
    .click();
  await page.locator("dialog#details.dlg.details").waitFor({ state: "visible" });
}
/** Purge… on Leaked opens the confirm dialog with its typed field. */
async function openPurge(page: Page): Promise<void> {
  await page
    .locator("li.item.trash", { hasText: LEAKED })
    .getByRole("button", { name: "Purge…" })
    .click();
  await page.locator("dialog#confirm").waitFor({ state: "visible" });
}
async function closeConfirm(page: Page): Promise<void> {
  await page.locator("dialog#confirm [data-confirm-cancel]").click();
  await page.locator("dialog#confirm").waitFor({ state: "hidden" });
}

const scenario: ViewerScenario = {
  name: "VS-05c solid confirms, quiet Revoke…, 44 px hit areas at 760 px, 16 px phone fields",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page: desk } = await ctx.newPage(DESKTOP);
    const postgres = await pathOf(desk, base, POSTGRES);
    const webhook = await pathOf(desk, base, WEBHOOK);
    const checkout = await pathOf(desk, base, AUDIT);
    const five = await revisionPath(desk, base, postgres, 5);
    const six = await revisionPath(desk, base, postgres, 6);
    const seven = await revisionPath(desk, base, postgres, 7);
    const fivePub = five.split("/")[4] ?? "";

    // 16 px fields on a phone, in every state that shows a field.
    const { page: phone } = await ctx.newPage(PHONE);
    await phone.goto(`${base}/`);
    await phone.getByRole("button", { name: "Find" }).click();
    await phone.locator("dialog#find").waitFor({ state: "visible" });
    assert.ok((await sixteen(phone, "Recent with Find")) >= 1, "Find shows its field");
    await phone.goto(`${base}/?q=is:failed`);
    assert.ok((await sixteen(phone, "/?q=is:failed")) >= 1, "the search shows its field");
    await phone.goto(`${base}${webhook}`);
    await openShare(phone);
    assert.ok((await sixteen(phone, "the share dialog")) >= 1, "the share dialog has a field");
    await phone.goto(`${base}${postgres}`);
    await openSheet(phone, false);
    await phone.locator("#tp-history [data-compare-open]").click();
    await phone.waitForURL((url) => url.searchParams.get("compare") === "1");
    await sixteen(phone, "History's compare mode");
    await phone.goto(`${base}${webhook}`);
    await openDetails(phone);
    assert.ok((await sixteen(phone, "Edit details")) >= 2, "Edit details has its fields");
    await phone.goto(`${base}/links`);
    await sixteen(phone, "/links");
    await phone.goto(`${base}/trash`);
    await openPurge(phone);
    assert.ok((await sixteen(phone, "the purge dialog")) >= 1, "the purge dialog has its field");
    // The Files filter shows only for collections over 200 files; the demo has none, so the
    // field rule there is covered by the rule itself (input:not(...)), not by a page.
    assert.equal(await phone.locator("input.filter:visible").count(), 0);

    // A mouse keeps desktop field sizes: the rule is for coarse pointers only.
    await desk.goto(`${base}${webhook}`);
    await openShare(desk);
    const label = (await fields(desk)).find((f) => f.name.includes("[name=label] in #share"));
    assert.ok(label, "the share dialog's Label field");
    assert.ok(label.size < 16, `a ${label.size}px Label field on a mouse`);
    await desk.goto(`${base}${webhook}`);
    await openDetails(desk);
    const title = (await fields(desk)).find((f) => f.name.includes("[name=title] in #details"));
    assert.ok(title && title.size < 16, `the details Title field on a mouse: ${title?.size}px`);
    await desk.goto(`${base}/trash`);
    await openPurge(desk);
    const typed = (await fields(desk)).find((f) => f.name.includes("in #confirm"));
    assert.ok(typed && typed.size < 16, `the purge dialog's field on a mouse: ${typed?.size}px`);
    await closeConfirm(desk);
    // The other field states keep their desktop sizes too.
    const deskStates: [string, string, (page: Page) => Promise<void>][] = [
      ["Recent", "/", async () => {}],
      ["/?q=is:failed", "/?q=is:failed", async () => {}],
      [
        "History's compare mode",
        `${postgres}?panel=history`,
        async (page) => {
          await page.locator("#tp-history [data-compare-open]").click();
          await page.waitForURL((url) => url.searchParams.get("compare") === "1");
        },
      ],
      ["/links", "/links", async () => {}],
    ];
    for (const [where, path, open] of deskStates) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await desk.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await open(desk);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      const big = (await fields(desk)).filter((f) => f.size >= 16);
      assert.deepEqual(big, [], `${where} on a mouse: no field is 16 px by the phone rule`);
    }

    // The 44 px audit at 390 × 844 touch.
    const pages: [string, string, ((page: Page) => Promise<void>)?][] = [
      ["Recent", "/"],
      ["/?q=is:failed", "/?q=is:failed"],
      ["/?q=in:trash", "/?q=in:trash"],
      ["Postgres", postgres],
      ["Postgres with the History sheet", postgres, (page) => openSheet(page, false)],
      ["Postgres #5", five],
      ["Webhook's Links tab", webhook, (page) => openSheet(page, true)],
      ["/links", "/links"],
      ["/links Revoked", "/links?state=revoked"],
      ["/links Paused in Trash", "/links?state=paused"],
      ["/trash", "/trash"],
      ["/status", "/status"],
      ["/mcp", "/mcp"],
      ["Postgres Changes #7 vs #5", `${seven}changes?base=${fivePub}`],
      ["the audit gallery", `${checkout}gallery/shots/`],
    ];
    for (const [where, path, open] of pages) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await phone.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      if (open) await open(phone);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await audit(phone, where);
    }
    // The search's filter chips keep NAV-03's geometry (30 px chip, 22 px ×); the audit above
    // measured each × by its 44 × 44 coarse-pointer tap.
    await phone.goto(`${base}/?q=is:failed`);
    const chips = await boxes(phone, ".fchip a");
    assert.ok(chips.length >= 1, "/?q=is:failed shows a filter chip");
    for (const c of chips) assert.ok(c.w === 22 && c.h === 22, `chip × stays 22 px: ${c.w}×${c.h}`);
    const chipHeights = await boxes(phone, ".fchip");
    for (const c of chipHeights) assert.ok(c.h < 44, `chip keeps its 30 px pill: ${c.h}`);
    // Standalone links: unobstructed, and 44 × 44 even with a one-letter label (a collection
    // titled "A", /links' Trash).
    let standaloneChecked = 0;
    for (const path of ["/", "/status", "/links", "/links?state=paused", five]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await phone.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      standaloneChecked += await standalone(phone, path);
    }
    assert.ok(standaloneChecked >= 8, `standalone links checked: ${standaloneChecked}`);
    // The health pill's own box takes the press 21 px out from its centre, every way.
    await phone.goto(`${base}/`);
    const probes = z.array(z.boolean()).parse(
      await phone.evaluate(`(() => {
        const pill = document.querySelector(".bar .health");
        const r = pill.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        return [[x - 21, y], [x + 21, y], [x, y - 21], [x, y + 21]].map(([px, py]) =>
          pill.contains(document.elementFromPoint(px, py)));
      })()`),
    );
    assert.deepEqual(probes, [true, true, true, true], "the health pill takes a 42 px press");

    // ≤ 760 px with a mouse (a narrow desktop window): the same 44 px row actions.
    const { page: narrow } = await ctx.newPage(NARROW);
    await narrow.goto(`${base}/`);
    await tall(narrow, ".attn .ag .acts > :is(.btn, a.btn)", "/ Needs attention", 2);
    await tall(narrow, ".bar :is(.iconbtn, .health, .logo)", "/ bar");
    for (const b of await boxes(narrow, ".bar :is(.iconbtn, .health, .logo)"))
      assert.ok(b.w >= 44, `/ bar: a ${b.w}px wide control`);
    await narrow.goto(`${base}/status`);
    await tall(narrow, '.srow .acts > [data-action="retry"]', "/status Retry");
    await tall(narrow, '.srow .acts > [data-action="drop"]', "/status Drop #6…");
    await equalRows(narrow, ".srow .acts", "/status");
    // #5's status line offers Retry for #6; #6's own page adds Drop….
    await narrow.goto(`${base}${five}`);
    await tall(narrow, '.status1 [data-action="retry"]', "Postgres #5 status line Retry");
    await narrow.goto(`${base}${six}`);
    await tall(narrow, '.status1 :is([data-action="retry"], [data-action="drop"])', "#6", 2);
    await narrow.goto(`${base}${postgres}`);
    await openSheet(narrow, false);
    await equalRows(narrow, "#tp-history .rv .acts", "History");
    await narrow.goto(`${base}/trash`);
    await equalRows(narrow, "li.item .acts", "/trash");
    await narrow.goto(`${base}/links`);
    await equalRows(narrow, ".lrow .acts", "/links");
    await narrow.goto(`${base}${webhook}`);
    await openSheet(narrow, true);
    await equalRows(narrow, ".lnk > .row", "the Links tab");
    await tall(narrow, "#tp-links .txtbtn", "the Links tab's text actions");
    await tall(narrow, ".lnk-acts .txtbtn", "Preview as public", 1);
    // An open Revoke… popover takes the card's width and stays in view; its sentence keeps its
    // start alignment while the cells' labels centre.
    await narrow.locator(".lnk summary.txtbtn.danger").first().click();
    assert.deepEqual(
      await narrow.evaluate(
        `[".lnk details.act[open] .pop", ".lnk details.act[open] .pop span"].map((s) =>
          getComputedStyle(document.querySelector(s)).textAlign)`,
      ),
      ["start", "start"],
      "the Revoke… popover's text starts at its edge",
    );
    const pop = await boxes(narrow, ".lnk details.act[open] .pop");
    const card = await boxes(narrow, ".lnk");
    assert.ok(pop[0] && card[0] && pop[0].w > card[0].w / 2, "the popover spans the card");
    assert.equal(
      await narrow.evaluate(
        `document.querySelector(".lnk details.act[open] .pop").getBoundingClientRect().right <= innerWidth`,
      ),
      true,
      "the popover opens within the viewport",
    );

    // Variants in the DOM (owner decision 9 Oct 2026): Revoke… and Revoke all are quiet red
    // text; the confirm step is danger-solid; an outline danger never sits in the links UI.
    for (const path of ["/", "/links", "/trash", "/status", webhook, five]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await desk.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      assert.equal(await okClass(desk), "btn danger-solid", `${path}: the confirm OK's template`);
    }
    await desk.goto(`${base}${webhook}?panel=links`);
    const revoke = desk.locator(".lnk:not(.dead) details.act > summary", { hasText: "Revoke…" });
    assert.ok((await revoke.count()) >= 2, "the live cards have Revoke…");
    assert.equal(await revoke.first().getAttribute("class"), "txtbtn danger");
    await revoke.first().click();
    const confirmRevoke = desk.locator('.lnk details.act[open] [data-action="revoke-link"]');
    assert.equal((await confirmRevoke.textContent())?.trim(), "Revoke link");
    assert.equal(await confirmRevoke.getAttribute("class"), "btn sm danger-solid");
    await desk.locator('.lnk details.act[open] [data-action="close-details"]').click();
    assert.equal(
      await desk.locator('.lnk-foot [data-action="revoke-all"]').getAttribute("class"),
      "txtbtn danger",
      "the Links tab's Revoke all",
    );
    assert.equal(await desk.locator(":is(.lnk, .lnk-foot) .btn.danger").count(), 0);
    await desk.goto(`${base}/links`);
    const rowRevoke = desk.locator('.lrow [data-action="revoke-link"]');
    assert.ok((await rowRevoke.count()) >= 1, "/links rows have Revoke…");
    const rowClasses = z
      .array(z.string())
      .parse(
        await desk.evaluate(
          `[...document.querySelectorAll('.lrow [data-action="revoke-link"]')].map((el) => el.className)`,
        ),
      );
    for (const cls of rowClasses) assert.equal(cls, "txtbtn danger", "a /links row's Revoke…");
    assert.equal(
      await desk.locator('.lc-foot [data-action="revoke-all"]').getAttribute("class"),
      "txtbtn danger",
      "/links' Revoke all",
    );
    assert.equal(await desk.locator(":is(.lrow, .lc-foot) .btn.danger").count(), 0);
    await rowRevoke.first().click();
    await desk.locator("dialog#confirm").waitFor({ state: "visible" });
    assert.equal(await okClass(desk), "btn danger-solid", "/links' Revoke… confirm");
    await closeConfirm(desk);
    // History → #6 → Drop…: the confirm stays danger-solid; Trash's Restore… is primary.
    await desk.goto(`${base}${postgres}?panel=history`);
    await desk.locator('#tp-history .rv[data-n="6"] [data-action="drop"]').click();
    await desk.locator("dialog#confirm").waitFor({ state: "visible" });
    assert.equal(await okClass(desk), "btn danger-solid", "the Drop #6 confirm");
    await closeConfirm(desk);
    await desk.goto(`${base}${six}`);
    await desk.locator('.status1 [data-action="drop"]').click();
    await desk.locator("dialog#confirm").waitFor({ state: "visible" });
    assert.equal(await okClass(desk), "btn danger-solid", "the status line's Drop… confirm");
    await closeConfirm(desk);
    await desk.goto(`${base}/trash`);
    await desk
      .locator("li.item.trash", { hasText: LEAKED })
      .getByRole("button", { name: "Restore…" })
      .click();
    await desk.locator("dialog#confirm").waitFor({ state: "visible" });
    assert.equal(await okClass(desk), "btn primary", "Trash's Restore confirm");
    await closeConfirm(desk);
    await openPurge(desk);
    assert.equal(await okClass(desk), "btn danger-solid", "Purge permanently");
    await closeConfirm(desk);
    // The collection's More → Move to Trash… stays a menu item; its confirm is danger-solid.
    await desk.goto(`${base}${checkout}`);
    await desk.locator('header.cbar [popovertarget="more-menu"]').click();
    const trashItem = desk.locator("#more-menu").getByRole("menuitem", { name: /^Move to Trash/ });
    assert.match((await trashItem.getAttribute("class")) ?? "", /^mi dangeritem\b/);
    await trashItem.click();
    await desk.locator("dialog#confirm").waitFor({ state: "visible" });
    assert.equal(await okClass(desk), "btn danger-solid", "Move to Trash's confirm");
    await closeConfirm(desk);
  },
};
export default scenario;
