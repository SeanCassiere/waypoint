// OW-12b: tables render as tables on the Changes page. A changed row is tinted --changed-bg, an
// added table takes the add bar, a wide table scrolls sideways inside its wrapper with content
// cells at least 10ch wide, and a long cell's content is capped at 22ch and wraps.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const numbers = z.array(z.number());
const text = z.string();

/** A custom property's computed value as a colour, as getComputedStyle reports colours. */
const resolved = (page: Page, token: string) =>
  page.evaluate(`(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(${token})";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  })()`);

/** Page-side source: the width of 1ch in an element's own font, from a probe appended inside it
 * (so a th's weight applies), then removed. */
const CH = `(cell) => {
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:10ch;height:0;padding:0;border:0";
  cell.append(probe);
  const ch = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return ch;
}`;

/** How far the focused element's focus ring sits inside every ancestor that clips it, up to and
 * including its diff card (.fd): the smallest gap, negative when an edge is clipped. */
const ringClearance = async (page: Page) => {
  const [clearance = NaN] = numbers.parse(
    await page.evaluate(`(() => {
      const target = document.activeElement;
      const style = getComputedStyle(target);
      if (style.outlineStyle === "none") return [-1000];
      const out = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const b = target.getBoundingClientRect();
      const gaps = [];
      for (let clip = target.parentElement; clip; clip = clip.parentElement) {
        const view = getComputedStyle(clip);
        if (view.overflowX !== "visible" || view.overflowY !== "visible") {
          const c = clip.getBoundingClientRect();
          const left = c.left + clip.clientLeft;
          const top = c.top + clip.clientTop;
          gaps.push(
            b.left - out - left,
            b.top - out - top,
            left + clip.clientWidth - (b.right + out),
            top + clip.clientHeight - (b.bottom + out),
          );
        }
        if (clip.matches(".fd")) break;
      }
      return [gaps.length ? Math.min(...gaps) : -1000];
    })()`),
  );
  return clearance;
};

const rollback = (rows: string[]) =>
  [
    "# Runbook",
    "## Rollback",
    // A short last header keeps the table well inside the card at 1280 (it must fit, any font).
    `| Failure point | Action | Downtime |\n| --- | --- | --- |\n${rows.join("\n")}`,
  ].join("\n\n") + "\n";
const sentence =
  "Promote the logical replica, repoint PgBouncer at it, confirm that writes land on the new primary, then page the database owner and record the cutover time and the replica's full lag in the incident log.";
const wide = `| One | Two | Three | Four | Five | Six |\n| --- | --- | --- | --- | --- | --- |\n| ${sentence} | b | c | d | e | f |\n| g | h | i | j | k | l |\n`;

export default {
  name: "OW-12b rendered table diffs",
  async run(ctx) {
    const { base } = ctx.writer;
    assert.ok(sentence.length >= 200, `a long sentence (${sentence.length})`);
    const first = await ctx.writer.api("/api/collections", {
      title: "Table diffs",
      head_path: "runbook.md",
      files: [
        await ctx.writer.write(
          "runbook.md",
          rollback([
            "| `--check` fails | Abort; nothing changed | 0 min |",
            "| Upgrade fails before start | Restore from backup | ~1 h |",
          ]),
        ),
      ],
    });
    const second = await ctx.writer.api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Faster rollback",
      mode: "replace",
      files: [
        await ctx.writer.write(
          "runbook.md",
          rollback([
            "| `--check` fails | Abort; nothing changed | 0 min |",
            "| Upgrade fails before start | Restore 15.8 data dir from snapshot | 25 min |",
            "| Errors after resume | Promote the logical replica | 4 min |",
          ]),
        ),
        await ctx.writer.write("wide.md", wide),
      ],
    });
    const changes = `${base}${new URL(second.url).pathname}changes`;

    // Desktop: the changed table is a table; its ~ row is tinted --changed-bg; j focuses it.
    const { page } = await ctx.newPage({ width: 1280, height: 800 });
    await page.goto(changes);
    const changed = page.locator(".blk.mod:has(table.dt)");
    await changed.waitFor();
    assert.equal(await changed.locator("caption").textContent(), "Table · 1 row changed, 1 added");
    assert.equal(await changed.locator("tr.r-mod").count(), 1);
    assert.equal(await changed.locator("tr.r-add").count(), 1);
    assert.equal(
      await page.evaluate(
        'getComputedStyle(document.querySelector(".blk.mod tr.r-mod")).backgroundColor',
      ),
      text.parse(await resolved(page, "--changed-bg")),
      "the ~ row is tinted --changed-bg",
    );
    await page.locator("body").press("j");
    assert.equal(
      await page.evaluate('document.activeElement?.matches(".blk.mod:has(table.dt)") ?? false'),
      true,
      "j focuses the table block",
    );
    // Its ring is drawn whole: every edge inside the card's clip (.fd hides overflow).
    const clearance = await ringClearance(page);
    assert.ok(
      clearance >= -0.5,
      `the table block's focus ring is inside the card (${clearance}px)`,
    );

    // Source view: a line row is a stepper target too; its ring stays inside the line scroller.
    const source = (await ctx.newPage({ width: 1280, height: 800 })).page;
    await source.goto(`${changes}?view=source`);
    await source.locator(".lines .ln[data-change]").first().waitFor();
    await source.locator("body").press("j");
    assert.equal(
      await source.evaluate('document.activeElement?.matches(".lines .ln[data-change]") ?? false'),
      true,
      "j focuses a changed line",
    );
    const lineClearance = await ringClearance(source);
    assert.ok(
      lineClearance >= -0.5,
      `the line's focus ring is inside its scroller and card (${lineClearance}px)`,
    );

    // The added table takes the add bar.
    const added = page.locator(".blk.add:has(table.dt)");
    await added.scrollIntoViewIfNeeded();
    const add = text.parse(await resolved(page, "--add"));
    const shadow = text.parse(
      await page.evaluate(
        'getComputedStyle(document.querySelector(".blk.add:has(table.dt)")).boxShadow',
      ),
    );
    assert.ok(shadow.includes(add), `the add bar ${shadow} has ${add}`);
    assert.equal(await added.locator("tr.r-add").count(), 2);

    // A long cell: its content is capped at 22ch and wraps onto several lines.
    const cap = numbers.parse(
      await page.evaluate(`(() => {
        const ch = ${CH};
        const cell = document.querySelector(".blk.add tbody td:not(.g)");
        const content = cell.querySelector(".dc");
        const box = content.getBoundingClientRect();
        return [box.width, box.height, parseFloat(getComputedStyle(content).lineHeight), ch(cell)];
      })()`),
    );
    const [capWidth = NaN, capHeight = NaN, lineHeight = NaN, capCh = NaN] = cap;
    assert.ok(capWidth <= 22 * capCh + 1, `the long cell is ${capWidth}px, 22ch is ${22 * capCh}`);
    assert.ok(capHeight > lineHeight * 2.5, `the long cell wraps (${capHeight}px tall)`);

    // Phone: the wide table scrolls inside its wrapper; content cells stay at least 10ch wide;
    // the page doesn't scroll sideways.
    const phone = (await ctx.newPage({ ...VIEWPORTS.phone })).page;
    await phone.goto(changes);
    const wrap = phone.locator(".blk.add .dtwrap");
    await wrap.waitFor();
    const scroll = numbers.parse(
      await phone.evaluate(
        '(() => { const wrap = document.querySelector(".blk.add .dtwrap"); return [wrap.scrollWidth, wrap.clientWidth]; })()',
      ),
    );
    const [scrollWidth = NaN, clientWidth = NaN] = scroll;
    assert.ok(scrollWidth > clientWidth, `the table scrolls (${scrollWidth} > ${clientWidth})`);
    const cells = z.array(z.tuple([z.string(), z.number(), z.number()])).parse(
      await phone.evaluate(`(() => {
        const ch = ${CH};
        return [...document.querySelectorAll(".blk.add .dtwrap :is(th, td)")]
          .filter((cell) => !cell.matches(".g") && !cell.closest("tr.r-gap"))
          .map((cell) => [cell.textContent.slice(0, 12), cell.getBoundingClientRect().width, ch(cell)]);
      })()`),
    );
    assert.equal(cells.length, 18, "6 header and 12 body content cells");
    for (const [label, width, ch] of cells)
      assert.ok(width >= 10 * ch - 1, `${label}: ${width}px, 10ch is ${10 * ch}px`);
    const pageScroll = numbers.parse(
      await phone.evaluate(
        "[document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth]",
      ),
    );
    const [pageWidth = NaN, viewport = NaN] = pageScroll;
    assert.ok(pageWidth <= viewport, `the page is ${pageWidth}px in ${viewport}px`);

    // The right-edge fade is a mask over the cells (tinted rows too) while columns are hidden to
    // the right, gone once the table is scrolled to its end; a table that fits has none.
    const fade = async (selector: string, end: boolean) =>
      z.tuple([z.string(), z.string()]).parse(
        await phone.evaluate(`(async () => {
          const wrap = document.querySelector(${JSON.stringify(selector)});
          wrap.scrollLeft = ${end ? "wrap.scrollWidth" : "0"};
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const style = getComputedStyle(wrap);
          return [style.maskImage, style.maskSize];
        })()`),
      );
    const [startImage, startSize] = await fade(".blk.add .dtwrap", false);
    assert.ok(
      startImage.includes("linear-gradient"),
      `a fade while columns are hidden (${startImage})`,
    );
    assert.equal(startSize, "100% 100%", "the fade sits at the right edge");
    const [, endSize] = await fade(".blk.add .dtwrap", true);
    assert.notEqual(endSize, "100% 100%", `no fade at the end (${endSize})`);
    const fits = z.tuple([z.number(), z.number(), z.string()]).parse(
      await page.evaluate(`(() => {
        const wrap = document.querySelector(".blk.mod .dtwrap");
        return [wrap.scrollWidth, wrap.clientWidth, getComputedStyle(wrap).maskImage];
      })()`),
    );
    assert.ok(fits[0] <= fits[1], `the Rollback table fits at 1280 (${fits[0]} in ${fits[1]})`);
    assert.equal(fits[2], "none", "no fade on a table that fits");

    // Forced colours keep the user's palette: no mask fades the cells of an overflowing table.
    const forced = (await ctx.newPage({ ...VIEWPORTS.phone, forcedColors: "active" })).page;
    await forced.goto(changes);
    await forced.locator(".blk.add .dtwrap").waitFor();
    const forcedFade = z.tuple([z.number(), z.number(), z.string()]).parse(
      await forced.evaluate(`(async () => {
        const wrap = document.querySelector(".blk.add .dtwrap");
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return [wrap.scrollWidth, wrap.clientWidth, getComputedStyle(wrap).maskImage];
      })()`),
    );
    assert.ok(forcedFade[0] > forcedFade[1], "the table overflows in forced colours too");
    assert.equal(forcedFade[2], "none", "no fade mask in forced colours");
  },
} satisfies ViewerScenario;
