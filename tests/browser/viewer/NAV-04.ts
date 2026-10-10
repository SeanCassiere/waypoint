// NAV-04: the collection bar spells out collection › revision › file at three widths. Titles
// aren't truncated, every bar control takes a 44 px press on touch, the pills open the panel on
// their tab (focus on the current row or file, never closing it), the hidden headings, the bar
// heights, the phone state line and tab bar, Done on phones, and the Copy menu's list layout.
// Runs alone, on its own writer (sync off, so every revision reads "uploading").
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  startWriter,
  VIEWPORTS,
  type PageOptions,
  type ViewerScenario,
  type WriteResult,
} from "../harness.ts";

const TITLES = ["Postgres 17 upgrade runbook", "Search relevance eval — run 2026-10-06"];
const num = (page: Page, expression: string): Promise<number> =>
  page.evaluate(expression).then((value) => z.number().parse(value));
const bool = (page: Page, expression: string): Promise<boolean> =>
  page.evaluate(expression).then((value) => z.boolean().parse(value));
const pinned = (result: WriteResult): string => new URL(result.url).pathname;

/** The bar's h1 shows the whole title: one line that doesn't overflow, or (phones) at most two.
 *  With `clampable`, the title may instead be clamped to two lines (the phone rule for a long
 *  title): it still isn't cut sideways, shows at most two lines, is in view, and its heading
 *  names the whole title. Standing ruling 7: whether "Search relevance eval — run 2026-10-06"
 *  fits two 165 px lines at 390 depends on the fonts (it does with local fonts, narrowly, and
 *  doesn't on CI), so its "not clamped" check runs at 1280 and 820, where one line clearly
 *  fits, and at 390 only "Postgres 17 upgrade runbook" (one line of ~206 px, so two lines with
 *  room to spare in either wrap) must show whole. */
async function titleWhole(
  page: Page,
  where: string,
  title: string,
  clampable = false,
): Promise<void> {
  const h1 = z
    .object({ sw: z.number(), cw: z.number(), sh: z.number(), ch: z.number(), lh: z.number() })
    .parse(
      await page.evaluate(`(() => {
        const h1 = document.querySelector("header.cbar h1");
        const style = getComputedStyle(h1);
        return { sw: h1.scrollWidth, cw: h1.clientWidth, sh: h1.scrollHeight, ch: h1.clientHeight,
          lh: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 };
      })()`),
    );
  assert.ok(h1.sw <= h1.cw, `${where}: the title is cut (${h1.sw} > ${h1.cw})`);
  if (!clampable) {
    assert.ok(h1.sh <= h1.ch + 1, `${where}: the title is clamped (${h1.sh} > ${h1.ch})`);
  }
  assert.ok(h1.ch <= 2 * h1.lh + 1, `${where}: the title takes more than two lines`);
  const heading = page
    .locator("header.cbar")
    .getByRole("heading", { level: 1, name: title, exact: true });
  assert.equal(await heading.count(), 1, `${where}: the h1 is named by the whole title`);
  assert.ok(await heading.isVisible(), `${where}: the title is shown`);
  assert.ok(
    await bool(
      page,
      `(() => { const r = document.querySelector("header.cbar h1").getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`,
    ),
    `${where}: the title is in view`,
  );
}

/** Every visible a and button in the bar but the health pill (OW-10b's) owns the points 21 px
 *  above and below its centre, and 21 px left and right of it when it's narrower than 44 px;
 *  and no other control (the health pill included) owns a point 1 px inside its left or right
 *  edge, so neighbouring hit areas don't overlap. */
async function hitAreas(page: Page, where: string): Promise<void> {
  const misses = z.array(z.string()).parse(
    await page.evaluate(`(() => {
      const misses = [];
      for (const control of document.querySelectorAll("header.cbar a, header.cbar button")) {
        if (control.closest(".health")) continue;
        const r = control.getBoundingClientRect();
        if (!r.width || !r.height || control.offsetParent === null) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const points = [[x, y - 21], [x, y + 21]];
        if (r.width < 44) points.push([x - 21, y], [x + 21, y]);
        const name = control.getAttribute("aria-label") || control.textContent.trim() || control.className;
        const report = (px, py, hit) =>
          misses.push(name + " at " + Math.round(px) + "," + Math.round(py) + " → " +
            (hit ? hit.tagName + "." + (hit.getAttribute("class") || "") : "nothing"));
        for (const [px, py] of points) {
          const hit = document.elementFromPoint(px, py);
          if (!hit || !control.contains(hit)) report(px, py, hit);
        }
        for (const px of [r.left + 1, r.right - 1]) {
          const hit = document.elementFromPoint(px, y);
          const owner = hit && hit.closest("a, button");
          if (owner && owner !== control && !control.contains(owner)) report(px, y, hit);
        }
      }
      return misses;
    })()`),
  );
  assert.deepEqual(misses, [], `${where}: touch targets under 44 px`);
}

async function barHeight(page: Page): Promise<number> {
  return num(page, 'document.querySelector("header.cbar").getBoundingClientRect().height');
}

/** The In-Trash page's TrashBar is also a header.cbar; NAV-04's bar rules leave it as it was. */
async function trashBarUnchanged(page: Page, where: string, phone: boolean): Promise<void> {
  const bar = z
    .object({
      gap: z.string(),
      left: z.string(),
      right: z.string(),
      logo: z.boolean(),
      back: z.boolean(),
    })
    .parse(
      await page.evaluate(`(() => {
        const bar = document.querySelector("header.cbar");
        const style = getComputedStyle(bar);
        const shown = (node) => !!node && getComputedStyle(node).display !== "none";
        return { gap: style.columnGap, left: style.paddingLeft, right: style.paddingRight,
          logo: shown(bar.querySelector(".logo")), back: shown(bar.querySelector(".back")) };
      })()`),
    );
  assert.equal(await page.locator("header.cbar nav.bc").count(), 0, `${where}: TrashBar`);
  assert.deepEqual(
    bar,
    phone
      ? { gap: "6px", left: "10px", right: "10px", logo: false, back: true }
      : { gap: "10px", left: "16px", right: "16px", logo: true, back: false },
    `${where}: the In-Trash bar renders as before NAV-04`,
  );
}

const scenario: ViewerScenario = {
  name: "NAV-04 collection bar: breadcrumb, pills open the panel, three widths, 44 px on touch",
  async run(ctx) {
    const writer = await startWriter();
    const { base } = writer;
    const first = await writer.api("/api/collections", {
      title: TITLES[0],
      metadata: { project: "infra" },
      files: [
        await writer.write("index.md", "# Postgres 17 upgrade runbook\n\n[Notes](notes.md)\n"),
        await writer.write("notes.md", "# Notes\n"),
      ],
    });
    const second = await writer.api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Second",
      files: [await writer.write("index.md", "# Postgres 17 upgrade runbook\n\nSecond.\n")],
    });
    const eval2 = await writer.api("/api/collections", {
      title: TITLES[1],
      files: [await writer.write("index.md", "# Eval\n")],
    });
    // A one-letter project: its ancestor link still takes a 44 px press on touch.
    const tiny = await writer.api("/api/collections", {
      title: "Tiny project",
      metadata: { project: "x" },
      files: [await writer.write("index.md", "# Tiny\n")],
    });
    const trashed = await writer.api("/api/collections", {
      title: "Old runbook",
      metadata: { project: "infra" },
      files: [await writer.write("index.md", "# Old runbook\n")],
    });
    const gone = await writer.fetch(`/api/collections/${trashed.collection_id}`, {
      method: "DELETE",
    });
    assert.equal(gone.status, 200);
    const trashPage = `${base}${pinned(trashed).replace(/r\/[^/]+\/$/, "")}`;
    const docs = [pinned(first), pinned(eval2)];
    const one = `${base}${pinned(first)}index.md`;

    const widths: [string, PageOptions, number][] = [
      ["1280 mouse", VIEWPORTS.desktop, 52],
      ["1280 touch", { ...VIEWPORTS.desktop, touch: true }, 52],
      ["820 touch", VIEWPORTS.tablet, 60],
      ["390 touch", VIEWPORTS.phone, 69],
    ];
    for (const [where, options, height] of widths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
      const { page, context } = await ctx.newPage(options);
      for (const [i, doc] of docs.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        await page.goto(`${base}${doc}`);
        // The long title may take the phone's two-line clamp (ruling 7; see titleWhole).
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        await titleWhole(
          page,
          `${where} ${doc}`,
          TITLES[i] ?? "",
          i === 1 && (options.width ?? 1280) <= 760,
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      await page.goto(one);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      const h = await barHeight(page);
      assert.ok(Math.abs(h - height) <= 1, `${where}: the bar is ${h}px, not ${height}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      if (options.touch) await hitAreas(page, where);
      if (where === "1280 touch") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        await page.goto(`${base}${pinned(tiny)}`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        await hitAreas(page, `${where}, project "x"`);
      }
      // The other pages keep their 52 px bar.
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      await page.goto(`${base}/`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
      const home = await num(
        page,
        'document.querySelector("header.bar").getBoundingClientRect().height',
      );
      assert.ok(Math.abs(home - 52) <= 1, `${where}: Recent's bar is ${home}px`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Closed before the next viewport.
      await context.close();
    }

    // 1280: the hidden headings, the breadcrumb's spoken text, the pill contract. Reduced
    // motion, so the ring's colour is read after its transition, not during it.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, reducedMotion: "reduce" });
      await page.goto(one);
      const headings = ["Files and history", "Sync and sharing status", "Document: index.md"];
      const found = await Promise.all(
        headings.map(async (name) => {
          const heading = page.getByRole("heading", { level: 2, name, exact: true });
          return { name, count: await heading.count(), box: await heading.boundingBox() };
        }),
      );
      for (const { name, count, box } of found) {
        assert.equal(count, 1, `heading ${name}`);
        assert.ok(box && box.width <= 1 && box.height <= 1, `${name} is visually hidden`);
      }
      const snapshot = (await page.locator("nav.bc").ariaSnapshot())
        .split("\n")
        .filter((line) => !/^\s*- \/url:/.test(line))
        .join("\n");
      assert.match(snapshot, /navigation "Breadcrumb"/);
      assert.match(snapshot, /- list/);
      assert.doesNotMatch(snapshot, /[/›]/, `the breadcrumb says no separators:\n${snapshot}`);
      const pill = page.locator("a.pill.rev");
      const file = page.locator("a.pill.file");
      // Files is open by default: the file crumb is pressed.
      assert.equal(await file.getAttribute("aria-expanded"), "true");
      assert.equal(await pill.getAttribute("aria-expanded"), "false");
      const current = '#tp-history li.rv[aria-current="true"] a.rvl';
      // A second press moves focus there again and never closes the panel.
      const press = async (time: string) => {
        await pill.click();
        await page.locator('#tab-history[aria-selected="true"]').waitFor({ state: "attached" });
        assert.equal(
          await bool(page, `document.activeElement === document.querySelector('${current}')`),
          true,
          `${time} press: focus on the current row`,
        );
        assert.equal(await pill.getAttribute("aria-expanded"), "true");
        assert.equal(await file.getAttribute("aria-expanded"), "false");
        assert.equal(
          await bool(page, '!document.querySelector("#shell").classList.contains("closed")'),
          true,
          `${time} press: the panel stays open`,
        );
      };
      await press("first");
      await press("second");
      const ring = z.object({ width: z.string(), color: z.string(), ink: z.string() }).parse(
        await page.evaluate(`(() => {
          const style = getComputedStyle(document.querySelector("a.pill.rev"));
          const probe = document.createElement("i");
          probe.style.color = "var(--ink)";
          document.body.append(probe);
          const ink = getComputedStyle(probe).color;
          probe.remove();
          return { width: style.borderTopWidth, color: style.borderTopColor, ink };
        })()`),
      );
      assert.equal(ring.width, "2px", "the pressed pill's ring");
      assert.equal(ring.color, ring.ink, "the ring is --ink");
      await page.emulateMedia({ forcedColors: "active" });
      assert.ok(
        (await num(
          page,
          'parseFloat(getComputedStyle(document.querySelector("a.pill.rev")).borderTopWidth)',
        )) > 0,
        "forced colours keep the ring",
      );
      await page.emulateMedia({ forcedColors: "none" });

      // The Copy menu (A11Y-10's list contract) fits under the bar with its IDs pinned.
      await page.locator("header.cbar button.copyl").click();
      await page.locator("#copy-menu").waitFor({ state: "visible" });
      assert.equal(await page.locator("#copy-menu .mbox.has-list").count(), 1);
      const fits = `(() => {
        const items = document.querySelectorAll("#copy-menu .mi");
        const r = items[items.length - 1].getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      })()`;
      assert.equal(await bool(page, fits), true, "Revision ID is in the viewport");
      const barH = await num(
        page,
        'parseFloat(getComputedStyle(document.querySelector("header.cbar")).getPropertyValue("--bar-h"))',
      );
      const boxH = await num(
        page,
        'document.querySelector("#copy-menu > .mbox").getBoundingClientRect().height',
      );
      const innerH = await num(page, "innerHeight");
      assert.ok(boxH <= innerH - barH - 20 + 1, `the Copy menu is ${boxH}px`);
      const scrolls =
        '(() => { const b = document.querySelector("#copy-menu .mbody"); return b.scrollHeight > b.clientHeight + 1; })()';
      assert.equal(await bool(page, scrolls), false, "the short list doesn't scroll");
      await page.locator("#copy-menu details.handoff-d > summary").click();
      assert.equal(await page.locator("#copy-menu [data-handoff]").isVisible(), true);
      if (await bool(page, scrolls))
        assert.equal(
          await bool(page, fits),
          true,
          "the footer stays pinned while the list scrolls",
        );
      await page.keyboard.press("Escape");
      // Download file asks for the stored bytes, also after the frame has loaded.
      const download = page.locator("#more-menu [data-download-raw]");
      assert.match((await download.getAttribute("href")) ?? "", /\/index\.md\?download$/);
      // The file crumb, the state line, the hidden Document heading and Download file follow
      // the document when a link inside it opens another file.
      await page.frameLocator("iframe.frame").getByRole("link", { name: "Notes" }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/notes.md"));
      await page.waitForFunction(
        'document.querySelector("a.pill.file .mono").textContent === "notes.md"',
      );
      assert.equal(await page.locator(".idsub .mono").textContent(), "notes.md");
      assert.equal(
        await page
          .getByRole("heading", { level: 2, name: "Document: notes.md", exact: true })
          .count(),
        1,
        "the Document heading names the file shown",
      );
      assert.match((await download.getAttribute("href")) ?? "", /\/notes\.md\?download$/);
    }

    // 820 touch: the file crumb opens the side sheet under the bar; Esc returns focus to it.
    {
      const { page } = await ctx.newPage(VIEWPORTS.tablet);
      await page.goto(one);
      const file = page.locator("a.pill.file");
      await file.tap();
      await page.locator("#shell.open").waitFor({ state: "attached" });
      assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
      await page.waitForFunction(
        'document.activeElement === document.querySelector("#tp-files a[aria-current]")',
      );
      assert.equal(await file.getAttribute("aria-expanded"), "true");
      const sheetTop = await num(
        page,
        'document.querySelector("#panel").getBoundingClientRect().top',
      );
      const barBottom = await num(
        page,
        'document.querySelector("header.cbar").getBoundingClientRect().bottom',
      );
      assert.ok(
        Math.abs(sheetTop - barBottom) <= 1,
        `the sheet starts at ${sheetTop}, not ${barBottom}`,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction('!document.querySelector("#shell").classList.contains("open")');
      assert.equal(
        await bool(page, 'document.activeElement === document.querySelector("a.pill.file")'),
        true,
        "Esc returns focus to the file crumb",
      );
      assert.equal(await file.getAttribute("aria-expanded"), "false");
      // Copy link is in ⋯ here.
      assert.equal(await page.locator("header.cbar button.copyl").isVisible(), false);
      await page.locator('header.cbar [popovertarget="more-menu"][aria-haspopup]').tap();
      await page.locator("#more-menu").waitFor({ state: "visible" });
      const copyItems = await Promise.all(
        [/^Link to latest/, /^Link to this revision \(#1\)/, /^Handoff block/].map((name) =>
          page.locator("#more-menu").getByRole("menuitem", { name }).isVisible(),
        ),
      );
      assert.deepEqual(copyItems, [true, true, true], "⋯ carries Copy link's three actions");
      await page.keyboard.press("Escape");
      await page.goto(trashPage);
      await trashBarUnchanged(page, "820 In Trash", false);
    }

    // 390 touch: the state line, the tab bar's History, the scrim, the More sheet.
    {
      const { page } = await ctx.newPage(VIEWPORTS.phone);
      await page.goto(one);
      const pillText = ((await page.locator("a.pill.rev").textContent()) ?? "").trim();
      assert.equal(await page.locator(".idsub").isVisible(), true);
      assert.equal(
        ((await page.locator(".idsub").textContent()) ?? "").trim(),
        `${pillText} · index.md`,
      );
      assert.match(pillText, /^#1 /);
      assert.equal(await page.locator("li.crumb").first().isVisible(), false);
      const history = page.locator('.tabbar [data-tab="history"]');
      await history.tap();
      await page.locator("#shell.open").waitFor({ state: "attached" });
      assert.equal(await history.getAttribute("aria-expanded"), "true");
      await page.waitForFunction(
        `document.activeElement === document.querySelector('#tp-history li.rv[aria-current="true"] a.rvl')`,
      );
      // NAV-10's 44 px Compare… in the sheet header (a regression guard; NAV-04 doesn't style it).
      const compare = await page.locator("#tp-history a.cmpbtn").boundingBox();
      assert.ok(compare && compare.height >= 44, `Compare… is ${compare?.height}px tall`);
      await page.touchscreen.tap(195, 40);
      await page.waitForFunction('!document.querySelector("#shell").classList.contains("open")');
      assert.equal(
        await bool(
          page,
          `document.activeElement === document.querySelector('.tabbar [data-tab="history"]')`,
        ),
        true,
        "the scrim returns focus to History",
      );
      assert.equal(await history.getAttribute("aria-expanded"), "false");
      await page.locator('.tabbar [popovertarget="more-menu"]').tap();
      await page.locator("#more-menu").waitFor({ state: "visible" });
      assert.match(
        String(
          await page.evaluate(
            '[...document.querySelectorAll("#more-menu .mi")].find((item) => item.offsetParent !== null)?.textContent.trim()',
          ),
        ),
        /^Share…/,
        "Share… is the More sheet's first item",
      );
      await page.keyboard.press("Escape");
      // The Copy sheet: under 85 dvh, Revision ID on screen.
      await page.locator('.tabbar [popovertarget="copy-menu"]').tap();
      await page.locator("#copy-menu").waitFor({ state: "visible" });
      await page.waitForTimeout(200);
      const sheet = await num(
        page,
        'document.querySelector("#copy-menu > .mbox").getBoundingClientRect().height',
      );
      assert.ok(sheet <= 0.85 * 844 + 1, `the Copy sheet is ${sheet}px`);
      assert.equal(
        await bool(
          page,
          `(() => { const items = document.querySelectorAll("#copy-menu .mi"); const r = items[items.length - 1].getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`,
        ),
        true,
        "Revision ID is on screen in the sheet",
      );
      await page.keyboard.press("Escape");

      // The phone status line wraps: a long failed list (status-line.tsx's list form, rendered
      // here with 40 revisions, since this sync-off writer can't fail one) stays on screen, and
      // Retry is 44 px tall at the end.
      const line = z
        .object({
          page: z.number(),
          over: z.number(),
          markerLines: z.number(),
          retry: z.object({ height: z.number(), right: z.number() }),
        })
        .parse(
          await page.evaluate(`(() => {
            const line = document.querySelector("[data-status]");
            for (const node of [...line.childNodes]) if (!node.classList?.contains("stap")) node.remove();
            const list = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => "#" + (from + i)).join(", ");
            line.insertAdjacentHTML("beforeend",
              '<span class="seg1"><span class="f">! ' + list(3, 42) + ' failed to sync</span></span>' +
              '<span class="sepdot" aria-hidden="true">·</span>' +
              '<span class="seg1"><span class="p">◌ ' + list(43, 62) + ' uploading</span></span>' +
              '<span class="sepdot" aria-hidden="true">·</span>' +
              '<span class="seg1"><span class="long">Other machines and public links see nothing yet.</span></span>' +
              '<span class="grow"></span><button type="button" class="btn sm" data-action="retry">Retry #42</button>');
            line.hidden = false;
            const marker = line.querySelector(".f");
            const lh = parseFloat(getComputedStyle(marker).lineHeight) || 18;
            const over = Math.max(...[...line.querySelectorAll(".seg1, .btn")].map((node) =>
              node.getBoundingClientRect().right - innerWidth));
            const retry = line.querySelector(".btn").getBoundingClientRect();
            return { page: document.documentElement.scrollWidth - innerWidth, over,
              markerLines: Math.round(marker.getBoundingClientRect().height / lh),
              retry: { height: retry.height, right: innerWidth - retry.right } };
          })()`),
        );
      assert.ok(line.page <= 0, `390: the status line widens the page by ${line.page}px`);
      assert.ok(line.over <= 0, `390: a status segment ends ${line.over}px past the screen`);
      assert.ok(line.markerLines >= 2, "390: the failed list wraps onto lines");
      assert.ok(line.retry.height >= 44, `390: Retry is ${line.retry.height}px tall`);
      assert.ok(line.retry.right >= 0, "390: Retry is on screen");

      // Changes on a phone: Done stays, 44 px tall; ‹ goes.
      await page.goto(`${base}${pinned(second)}changes`);
      const done = await page.locator("header.cbar a[data-done]").boundingBox();
      assert.ok(done && done.height >= 44, `Done is ${done?.height}px tall`);
      assert.equal(await page.locator("header.cbar .back").isVisible(), false);
      await hitAreas(page, "390 Changes");
      // The 404 has no ⋯: the health pill, last in the bar, stays off the screen edge.
      await page.goto(`${base}${pinned(first)}nope.md`);
      assert.equal(await page.locator("header.cbar .more").count(), 0);
      const lastEdge = await num(
        page,
        'innerWidth - document.querySelector("header.cbar .health").getBoundingClientRect().right',
      );
      assert.ok(lastEdge >= 8, `390 404: the health pill is ${lastEdge}px from the edge`);
      await page.goto(trashPage);
      await trashBarUnchanged(page, "390 In Trash", true);
    }
  },
};
export default scenario;
