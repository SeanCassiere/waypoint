// VS-04: status colour roles. On the seeded demo writer, light and dark: solid buttons and dialog
// bands use the dark-safe --*-solid tokens with white text (the Webhook share dialog, its Copied
// state, the Postgres #6 Drop… confirm); inactive links (/links rows, the Links tab's cards, a
// revoked card's confirmation row) and the gallery's removed image are told apart by colour, never
// opacity; a disabled button is neutral (the Trash restore dialog's Restore before a choice); the
// Files tree's current file and History's current revision share one selection style, outlined in
// forced colours; colour contrast holds on all of them (axe). Also verifies OW-05b's control has
// no Inactive segment and that an expiry within a day is ink at 600, not amber.
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  axe,
  startDemoWriter,
  VIEWPORTS,
  type PageOptions,
  type ViewerScenario,
} from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const WEBHOOK = "Webhook idempotency research";
const AUDIT = "Checkout flow screenshot audit";
const LEAKED = "Leaked .env in run output (do not share)";
const SAM = "Design review — Sam";
const PRIYA = "Priya — payments review";
const still = { reducedMotion: "reduce" } as const;
const WHITE = "rgb(255, 255, 255)";
/** Every element that must never be dimmed with opacity, wherever it shows. */
const UNDIMMED =
  ".lnk.dead, .lnk.dead *, .lnk.gone, .lnk.gone *, .lrow.dead, .lrow.dead *, .shot.del, " +
  ".shot.del *, .tree a[aria-current], .tree a[aria-current] *";
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];
/** The solids' resolved colours (FB2), per scheme. */
const SOLID: Record<Scheme, { public: string; failed: string; ok: string }> = {
  light: { public: "rgb(31, 95, 209)", failed: "rgb(180, 35, 24)", ok: "rgb(45, 122, 76)" },
  dark: { public: "rgb(43, 91, 196)", failed: "rgb(179, 55, 43)", ok: "rgb(45, 122, 76)" },
};
const SEL_BG: Record<Scheme, string> = { light: WHITE, dark: "rgb(42, 41, 38)" };
const CHANGED: Record<Scheme, string> = {
  light: "rgb(125, 60, 152)",
  dark: "rgb(212, 180, 238)",
};

const strings = z.array(z.string());
const look = z.object({
  bg: z.string(),
  color: z.string(),
  shadow: z.string(),
  weight: z.string(),
  opacity: z.string(),
  outline: z.string(),
  border: z.string(),
});
type Look = z.infer<typeof look>;
/** The computed look of the first element matching `selector`. */
async function lookOf(page: Page, selector: string): Promise<Look> {
  return look.parse(
    await page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const s = getComputedStyle(node);
      return { bg: s.backgroundColor, color: s.color, shadow: s.boxShadow, weight: s.fontWeight,
        opacity: s.opacity, outline: s.outlineStyle, border: s.borderTopColor };
    })()`),
  );
}
/** A token's resolved colour as rgb(), through a probe element. */
async function tok(page: Page, token: string): Promise<string> {
  return z.string().parse(
    await page.evaluate(`(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(${token})";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    })()`),
  );
}
/** The elements of UNDIMMED on the page whose computed opacity isn't 1. */
async function dimmed(page: Page): Promise<string[]> {
  return strings.parse(
    await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(UNDIMMED)})]
        .filter((node) => getComputedStyle(node).opacity !== "1")
        .map((node) => node.outerHTML.slice(0, 80))`,
    ),
  );
}
/** axe's colour-contrast rule, scoped; asserts no violation. */
async function contrast(page: Page, where: string, include?: string): Promise<void> {
  const found = await axe(page, { rules: ["color-contrast"], ...(include ? { include } : {}) });
  assert.deepEqual(
    found.flatMap((violation) => violation.nodes.map((node) => node.target.join(" "))),
    [],
    `${where}: no colour-contrast violation`,
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
/** The page's .soon expiry is --ink at 600 (never amber). */
async function soonIsInk(page: Page, selector: string, where: string): Promise<void> {
  const soon = await lookOf(page, selector);
  assert.equal(soon.color, await tok(page, "--ink"), `${where}: Sam's expiry is --ink`);
  assert.notEqual(soon.color, await tok(page, "--pending"), `${where}: not --pending`);
  assert.equal(soon.weight, "600", `${where}: Sam's expiry is at 600`);
}
/** Inactive rows or cards: --muted, a 3 px --rule-2 rule, an --ink-2 title, neutral tone chips. */
async function inactive(page: Page, row: string, title: string, where: string): Promise<void> {
  const facts = z
    .object({
      rows: z.number(),
      color: z.string(),
      shadow: z.string(),
      title: z.string(),
      chips: z.array(z.object({ bg: z.string(), color: z.string(), border: z.string() })),
    })
    .parse(
      await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll(${JSON.stringify(row)})];
        const first = rows[0];
        if (!first) return { rows: 0, color: "", shadow: "", title: "", chips: [] };
        const s = getComputedStyle(first);
        const tones = ".chip:is(.public, .pending, .failed, .paused)";
        const chips = rows.flatMap((r) => [...r.querySelectorAll(tones)]).map((chip) => {
          const c = getComputedStyle(chip);
          return { bg: c.backgroundColor, color: c.color, border: c.borderTopStyle };
        });
        const name = rows.map((r) => r.querySelector(${JSON.stringify(title)})).find(Boolean);
        return { rows: rows.length, color: s.color, shadow: s.boxShadow,
          title: name ? getComputedStyle(name).color : "", chips };
      })()`),
    );
  assert.ok(facts.rows > 0, `${where}: an inactive row shows`);
  const muted = await tok(page, "--muted");
  const ink2 = await tok(page, "--ink-2");
  const rule2 = await tok(page, "--rule-2");
  const sunken = await tok(page, "--sunken");
  assert.equal(facts.color, muted, `${where}: the row's meta is --muted`);
  assert.ok(
    facts.shadow.includes(rule2) && facts.shadow.includes("inset") && facts.shadow.includes("3px"),
    `${where}: a 3 px --rule-2 inset rule (${facts.shadow})`,
  );
  if (facts.title) assert.equal(facts.title, ink2, `${where}: the title is --ink-2`);
  for (const chip of facts.chips)
    assert.deepEqual(
      [chip.bg, chip.color, chip.border],
      [sunken, muted, "solid"],
      `${where}: a tone chip is neutral`,
    );
  assert.deepEqual(await dimmed(page), [], `${where}: nothing is dimmed with opacity`);
}

const scenario: ViewerScenario = {
  name: "VS-04 dark-safe solids, colour (not opacity) for inactive states, one selection style",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page: desk } = await ctx.newPage({ ...VIEWPORTS.desktop, ...still });
    const postgres = await pathOf(desk, base, POSTGRES);
    const webhook = await pathOf(desk, base, WEBHOOK);
    const checkout = await pathOf(desk, base, AUDIT);
    const five = await revisionPath(desk, base, postgres, 5);
    const six = await revisionPath(desk, base, postgres, 6);
    await desk.goto(`${base}${five}`);
    const runbookHref = await desk.locator('.tree a[data-file="runbook.md"]').getAttribute("href");
    assert.ok(runbookHref, "#5's Files tree lists runbook.md");
    const runbook = new URL(runbookHref, base).pathname;
    await desk.goto(`${base}${checkout}`);
    const galleryHref = await desk.locator(".tree a.gal").first().getAttribute("href");
    assert.ok(galleryHref, "the audit's Files tree has a View as gallery row");
    const gallery = new URL(galleryHref, base).pathname;

    for (const scheme of SCHEMES) {
      const options: PageOptions = { ...VIEWPORTS.desktop, ...still, colorScheme: scheme };
      const { page } = await ctx.newPage(options);

      // /links: every segment passes contrast; inactive rows aren't dimmed. No Inactive segment.
      await page.goto(`${base}/links`);
      const segments = strings.parse(
        await page.evaluate(
          `[...document.querySelectorAll("[data-links-page] > .seg a")].map((a) => a.textContent.trim())`,
        ),
      );
      assert.ok(segments.length >= 4, `${scheme} /links: the segments (${segments.join(", ")})`);
      assert.deepEqual(
        segments.filter((text) => text.startsWith("Inactive")),
        [],
        `${scheme} /links: no Inactive segment`,
      );
      for (const state of ["", "?state=paused", "?state=expired", "?state=revoked"]) {
        await page.goto(`${base}/links${state}`);
        await contrast(page, `${scheme} /links${state}`);
        assert.deepEqual(await dimmed(page), [], `${scheme} /links${state}: nothing dimmed`);
      }
      await page.goto(`${base}/links?state=revoked`);
      await inactive(page, ".lrow.dead", ".who b", `${scheme} /links revoked`);
      await page.goto(`${base}/links?state=expired`);
      await inactive(page, ".lrow.dead", ".who b", `${scheme} /links expired`);
      const inactiveUrl = await writer.fetch("/links?state=inactive");
      assert.equal(inactiveUrl.status, 200, "/links?state=inactive still loads");

      // Expiry within a day: --ink at 600, on /links (with the clock) and on the Links tab.
      await page.goto(`${base}/links`);
      // Sam's is the only link that expires within a day.
      assert.equal(await page.locator(".lrow .soon").count(), 1, `${scheme} /links: one .soon`);
      assert.equal(
        await page.locator(".lrow", { hasText: SAM }).locator(".soon svg.ic").count(),
        1,
        `${scheme} /links: Sam's expiry keeps its clock`,
      );
      await soonIsInk(page, ".lrow .soon", `${scheme} /links`);
      await page.goto(`${base}${webhook}?panel=links`);
      assert.equal(await page.locator(".lnk", { hasText: SAM }).locator(".soon").count(), 1);
      await soonIsInk(page, ".lnk .soon", `${scheme} Links tab`);
      await page.evaluate(`document.querySelector("#tp-links details.inactive").open = true`);
      await inactive(page, ".lnk.dead", ".h b", `${scheme} Links tab inactive`);
      await contrast(page, `${scheme} Links tab, inactive open`, "#tp-links");

      // The Webhook share dialog: a solid band and Create link; then Copied, solid green.
      await page.goto(`${base}${webhook}`);
      await openShare(page);
      await contrast(page, `${scheme} share dialog`, "#share");
      const shareBand = await lookOf(page, '#share [data-share-step="create"] .band');
      assert.deepEqual(
        [shareBand.bg, shareBand.color],
        [SOLID[scheme].public, WHITE],
        `${scheme} share dialog: the band is --public-solid with white text`,
      );
      assert.equal(SOLID[scheme].public, await tok(page, "--public-solid"));
      const create = await lookOf(page, "#share .btn.public-solid");
      assert.deepEqual(
        [create.bg, create.color],
        [SOLID[scheme].public, WHITE],
        `${scheme}: Create link is --public-solid with white text`,
      );
      await page.locator('#share input[name="label"]').fill("VS-04");
      await page.locator("[data-share-submit]").click();
      await page.locator('[data-share-step="created"]').waitFor({ state: "visible" });
      const copy = page.locator("#share [data-share-copy]");
      const before = await lookOf(page, "#share [data-share-copy]");
      assert.deepEqual(
        [before.bg, before.color],
        [SOLID[scheme].public, WHITE],
        `${scheme}: the created link's Copy is --public-solid with white text`,
      );
      // Copied reverts after 1.6 s: hold that one timer, so the scan sees the real Copied state.
      await page.evaluate(`(() => {
        const real = window.setTimeout;
        window.__vs04Held = [];
        window.__vs04Real = real;
        window.setTimeout = (fn, ms, ...rest) =>
          ms === 1600 ? (window.__vs04Held.push(fn), 0) : real(fn, ms, ...rest);
      })()`);
      await copy.click();
      await page.waitForFunction(
        `document.querySelector("#share [data-share-copy]").hasAttribute("data-copied")`,
      );
      const copied = await lookOf(page, "#share [data-share-copy]");
      assert.deepEqual(
        [copied.bg, copied.color],
        [SOLID[scheme].ok, WHITE],
        `${scheme}: Copied is --ok-solid with white text`,
      );
      await contrast(page, `${scheme} Link created, Copied`, "#share");
      const held = z.object({ copied: z.boolean(), text: z.string() }).parse(
        await page.evaluate(`(() => {
          const button = document.querySelector("#share [data-share-copy]");
          return { copied: button.hasAttribute("data-copied"), text: button.textContent.trim() };
        })()`),
      );
      assert.deepEqual(
        held,
        { copied: true, text: "Copied" },
        `${scheme}: Copied held for the scan`,
      );
      await page.evaluate(`(() => {
        window.setTimeout = window.__vs04Real;
        for (const fn of window.__vs04Held) fn();
      })()`);
      // Closing once a link exists opens the Links tab: let that navigation finish first.
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => url.searchParams.get("panel") === "links");
      await page.waitForLoadState("load");

      // The Postgres #6 Drop… confirm: a solid red band and confirm button, white text.
      await page.goto(`${base}${six}`);
      await page.locator(".status1 [data-action=drop]").click();
      await page.locator("dialog#confirm").waitFor({ state: "visible" });
      const dropBand = await lookOf(page, "dialog#confirm.danger .band");
      assert.deepEqual(
        [dropBand.bg, dropBand.color],
        [SOLID[scheme].failed, WHITE],
        `${scheme} Drop #6: the band is --failed-solid with white text`,
      );
      const drop = await lookOf(page, "dialog#confirm [data-confirm-ok].danger-solid");
      assert.deepEqual(
        [drop.bg, drop.color],
        [SOLID[scheme].failed, WHITE],
        `${scheme} Drop #6: the confirm button is --failed-solid with white text`,
      );
      await contrast(page, `${scheme} Drop #6`, "dialog[open]");
      await page.locator("dialog#confirm [data-confirm-cancel]").click();
      await page.locator("dialog#confirm").waitFor({ state: "hidden" });

      // Postgres #5, runbook.md (changed) selected: one selection style in Files and History.
      await page.goto(`${base}${runbook}`);
      const file = await lookOf(page, ".tree a[aria-current]");
      assert.equal(file.bg, SEL_BG[scheme], `${scheme}: the current file's fill is --sel-bg`);
      assert.equal(SEL_BG[scheme], await tok(page, "--sel-bg"));
      const bar = await tok(page, "--sel-bar");
      const ring = await tok(page, "--sel-ring");
      assert.ok(
        file.shadow.includes("inset") && file.shadow.includes(bar) && file.shadow.includes(ring),
        `${scheme}: the current file has the --sel-bar inset bar and the --sel-ring (${file.shadow})`,
      );
      assert.equal(file.color, await tok(page, "--ink"), `${scheme}: the current file is --ink`);
      assert.equal(
        (await lookOf(page, ".tree a[aria-current] .nm")).weight,
        "600",
        `${scheme}: the current file's name is at 600`,
      );
      const mark = await lookOf(page, ".tree a[aria-current] .k");
      assert.equal(mark.color, CHANGED[scheme], `${scheme}: the ~ mark stays --changed`);
      assert.equal(CHANGED[scheme], await tok(page, "--changed"));
      const meta = await lookOf(page, ".tree a[aria-current] .hd");
      assert.equal(
        meta.color,
        await tok(page, "--muted"),
        `${scheme}: the current file's head label is --muted`,
      );
      assert.deepEqual(await dimmed(page), [], `${scheme} #5: nothing dimmed`);
      await contrast(page, `${scheme} #5 Files, runbook.md selected`, ".panel");
      await page.goto(`${base}${runbook}?panel=history`);
      await page.locator("#tp-history").waitFor({ state: "visible" });
      const rev = await lookOf(page, '#tp-history li.rv[aria-current="true"]');
      assert.deepEqual(
        [rev.bg, rev.shadow],
        [file.bg, file.shadow],
        `${scheme}: History's current row has the current file's fill, bar and ring`,
      );
      assert.equal(
        (await lookOf(page, '#tp-history li.rv[aria-current="true"] .msg')).weight,
        "600",
        `${scheme}: the current revision's message is at 600`,
      );
      await contrast(page, `${scheme} #5 History`, ".panel");

      // The gallery's removed image: not faded, dashed, its name --ink-2.
      await page.goto(`${base}${gallery}`);
      const removed = await lookOf(page, ".shot.del");
      assert.equal(removed.opacity, "1", `${scheme}: the removed card isn't faded`);
      const dashed = await page.evaluate(
        `getComputedStyle(document.querySelector(".shot.del")).borderTopStyle`,
      );
      assert.equal(dashed, "dashed", `${scheme}: the removed card keeps its dashed border`);
      assert.equal(
        (await lookOf(page, ".shot.del .cap .nm")).color,
        await tok(page, "--ink-2"),
        `${scheme}: the removed card's name is --ink-2`,
      );
      assert.deepEqual(await dimmed(page), [], `${scheme} gallery: nothing dimmed`);

      // Trash: Restore… on Leaked (its paused link) waits for a choice; Restore is neutral, not
      // a faded primary, then the primary solid once a radio is checked. The purge dialog too.
      await page.goto(`${base}/trash`);
      const leaked = page.locator("li.item.trash", { hasText: LEAKED });
      await leaked.getByRole("button", { name: "Restore…" }).click();
      const confirm = page.locator("dialog#confirm");
      await confirm.waitFor({ state: "visible" });
      const ok = "dialog#confirm [data-confirm-ok]";
      assert.equal(await page.locator(ok).isDisabled(), true, `${scheme}: Restore starts disabled`);
      const off = await lookOf(page, ok);
      assert.deepEqual(
        [off.opacity, off.color, off.bg],
        ["1", await tok(page, "--faint"), await tok(page, "--sunken")],
        `${scheme}: disabled Restore is --faint on --sunken, not faded`,
      );
      await contrast(page, `${scheme} restore dialog`, "dialog[open]");
      await confirm.getByText("Turn the link back on", { exact: true }).click();
      const on = await lookOf(page, ok);
      assert.deepEqual(
        [on.opacity, on.bg, on.color],
        ["1", await tok(page, "--ink"), await tok(page, "--paper")],
        `${scheme}: a choice makes Restore the primary solid`,
      );
      await confirm.locator("[data-confirm-cancel]").click();
      await confirm.waitFor({ state: "hidden" });
      await leaked.getByRole("button", { name: "Purge…" }).click();
      await confirm.waitFor({ state: "visible" });
      await contrast(page, `${scheme} purge dialog`, "dialog[open]");
      await confirm.locator("[data-confirm-cancel]").click();
      await confirm.waitFor({ state: "hidden" });

      // Every variant stays neutral when disabled, hovered too (variants' :hover rules come later).
      // No disabled outline or ghost button renders on the demo, so these are injected.
      await page.evaluate(`(() => {
        const variants = ["", "primary", "public", "public-solid", "danger", "danger-solid", "ghost"];
        for (const [index, variant] of variants.entries()) {
          const button = document.createElement("button");
          button.className = ("btn " + variant).trim();
          button.id = "vs04-off-" + index;
          if (index % 2) button.disabled = true;
          else button.setAttribute("aria-disabled", "true");
          button.textContent = "Off " + variant;
          document.querySelector("main").prepend(button);
        }
      })()`);
      const neutral = [
        await tok(page, "--faint"),
        await tok(page, "--sunken"),
        await tok(page, "--rule"),
        "1",
      ];
      for (let index = 0; index < 7; index++) {
        const selector = `#vs04-off-${index}`;
        const rest = await lookOf(page, selector);
        await page.locator(selector).hover({ force: true });
        const hovered = await lookOf(page, selector);
        for (const [state, seen] of [
          ["at rest", rest],
          ["hovered", hovered],
        ] as const)
          assert.deepEqual(
            [seen.color, seen.bg, seen.border, seen.opacity],
            neutral,
            `${scheme}: disabled ${selector} is --faint on --sunken with a --rule border, ${state}`,
          );
      }

      // A phone: the side sheet's current file has the same selection style.
      const { page: phone } = await ctx.newPage({
        ...VIEWPORTS.phone,
        ...still,
        colorScheme: scheme,
      });
      await phone.goto(`${base}${runbook}`);
      await phone.locator(".tabbar").getByRole("button", { name: "Files" }).click();
      await phone.locator("#tp-files").waitFor({ state: "visible" });
      const sheet = await lookOf(phone, "#tp-files .tree a[aria-current]");
      assert.deepEqual(
        [sheet.bg, sheet.shadow, sheet.color],
        [file.bg, file.shadow, file.color],
        `${scheme} 390: the sheet's current file has the selection style`,
      );
    }

    // Forced colours: the current History row and the current file each show an outline.
    {
      const { page } = await ctx.newPage({
        ...VIEWPORTS.desktop,
        ...still,
        forcedColors: "active",
      });
      await page.goto(`${base}${runbook}?panel=history`);
      for (const selector of ['#tp-history li.rv[aria-current="true"]', ".tree a[aria-current]"])
        assert.equal(
          (await lookOf(page, selector)).outline,
          "solid",
          `forced colours: ${selector} is outlined`,
        );
      await page.goto(`${base}/status`);
      await page.locator('[popovertarget="home-more"]').click();
      await page.locator("#home-more").waitFor({ state: "visible" });
      assert.equal(
        (await lookOf(page, "#home-more .mi[aria-current]")).outline,
        "solid",
        "forced colours: More's current item is outlined",
      );
    }

    // A menu's current destination (More on /status) has the same selection style.
    await desk.goto(`${base}/status`);
    await desk.locator('[popovertarget="home-more"]').click();
    await desk.locator("#home-more").waitFor({ state: "visible" });
    const current = await lookOf(desk, "#home-more .mi[aria-current]");
    const selBar = await tok(desk, "--sel-bar");
    assert.equal(current.bg, await tok(desk, "--sel-bg"), "More's current item: --sel-bg");
    assert.ok(
      current.shadow.includes("inset") && current.shadow.includes(selBar),
      `More's current item has the --sel-bar inset bar (${current.shadow})`,
    );
    await desk.keyboard.press("Escape");
    // Opened from the keyboard, focus lands on the current item: it keeps the selection style and
    // gets a focus outline (the bar and ring replace the menu's focus shadow).
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, ...still });
      await page.goto(`${base}/status`);
      await page.locator('[popovertarget="home-more"]').focus();
      await page.keyboard.press("Enter");
      await page.locator("#home-more").waitFor({ state: "visible" });
      const item = "#home-more .mi[aria-current]";
      await page.waitForFunction(`document.activeElement?.matches(${JSON.stringify(item)})`);
      assert.equal(
        await page.evaluate(`document.activeElement.matches(":focus-visible")`),
        true,
        "More's current item has keyboard focus",
      );
      const focused = await lookOf(page, item);
      assert.equal(focused.bg, current.bg, "a focused current item keeps --sel-bg");
      assert.equal(focused.shadow, current.shadow, "a focused current item keeps its bar and ring");
      assert.equal(focused.outline, "solid", "a focused current item has a focus outline");
    }

    // --sel/--on-sel paint only the ink chip (the segmented control uses neither): never a
    // selected row (they use --sel-bg, above).
    const selUsers = strings.parse(
      await desk.evaluate(`(() => {
        const found = [];
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.cssRules) walk(rule.cssRules);
            if (rule.style && /var\\(--(sel|on-sel)\\)/.test(rule.style.cssText))
              found.push(rule.selectorText);
          }
        };
        for (const sheet of document.styleSheets) walk(sheet.cssRules);
        return [...new Set(found)].sort();
      })()`),
    );
    assert.deepEqual(selUsers, [".chip.ink"], "--sel/--on-sel are used only by .chip.ink");

    // A card just revoked collapses into a confirmation row: not dimmed either.
    await desk.goto(`${base}${webhook}?panel=links`);
    const card = desk.locator(".lnk:not(.dead)", { hasText: PRIYA });
    await card.locator("summary", { hasText: "Revoke…" }).click();
    await card.getByRole("button", { name: "Revoke link" }).click();
    await desk.locator(".lnk.gone").waitFor({ state: "visible" });
    assert.deepEqual(await dimmed(desk), [], "the revoked card's confirmation row isn't dimmed");
    await contrast(desk, "the revoked card's confirmation row", "#tp-links");
  },
};
export default scenario;
