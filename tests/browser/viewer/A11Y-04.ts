// A11Y-04: one row contract for Recent, search and Trash. Each day group is a section named by
// its h2, rows are list items whose only link is the title (named by its text, stretched over the
// row, focus ring on the li), Trash actions are raised siblings described by the title, and the
// day groups follow the browser's time zone without reordering rows. The writer is shared, so
// this scenario finds its rows only by data-pub and its unique word.
import type { Locator, Page } from "playwright";
import { z } from "zod";

import { assert, axe, VIEWPORTS, type AxeViolation, type ViewerScenario } from "../harness.ts";

const WORD = "a11yfourquokka";
const PLAIN = `${WORD} plain notes`;
const REVISED = `${WORD} revised plan`;
const TRASHED = `${WORD} trashed draft`;
const RULES = {
  rules: ["label-content-name-mismatch", "list", "listitem", "region", "nested-interactive"],
  enable: ["label-content-name-mismatch"],
};

/** axe with RULES on the whole page. The bar's health pill is named "Writer status: …", not by its
 *  visible text (a known label-content-name-mismatch on that one node): OW-10b fixes the pill and
 *  removes this filter. */
async function rowAxe(page: Page): Promise<AxeViolation[]> {
  const violations = await axe(page, RULES);
  for (const violation of violations)
    if (violation.id === "label-content-name-mismatch")
      violation.nodes = violation.nodes.filter((node) => node.target.join(" ") !== ".health");
  return violations.filter((violation) => violation.nodes.length > 0);
}
/** An aria snapshot's lines as [depth, text] (two spaces per level, the leading "- " dropped). */
function lines(snapshot: string): { depth: number; text: string }[] {
  return snapshot
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const depth = (line.length - line.trimStart().length) / 2;
      return { depth, text: line.trim().replace(/^- /, "") };
    });
}
/** The direct children of the listitem whose link is `title`, as their role words. */
function rowChildren(snapshot: string, title: string): string[] {
  const all = lines(snapshot);
  const link = all.findIndex((line) => line.text.startsWith(`link "${title}"`));
  assert.ok(link > 0, `a link "${title}" in:\n${snapshot}`);
  const item = all[link - 1];
  assert.ok(item?.text.startsWith("listitem"), `the link sits right under a listitem`);
  if (!item) return [];
  const children: string[] = [];
  for (const line of all.slice(link)) {
    if (line.depth <= item.depth) break;
    if (line.depth === item.depth + 1) children.push(line.text);
  }
  return children;
}
/** Every listitem in the snapshot has exactly one link child. */
function oneLinkPerItem(snapshot: string): void {
  const all = lines(snapshot);
  all.forEach((line, index) => {
    if (!line.text.startsWith("listitem")) return;
    let links = 0;
    for (const child of all.slice(index + 1)) {
      if (child.depth <= line.depth) break;
      if (child.depth === line.depth + 1 && child.text.startsWith("link ")) links++;
    }
    assert.equal(links, 1, `one link per row:\n${snapshot}`);
  });
}
/** The section (day group) that holds the row of `pub`. */
const sectionOf = (page: Page, pub: string): Locator =>
  page.locator("div.groups > section").filter({ has: page.locator(`li.item[data-pub="${pub}"]`) });
/** Clicks the centre of an element with the mouse (hit-testing decides what gets the click). */
async function clickCentre(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  assert.ok(box, "the target has a box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const strings = z.array(z.string());
/** A collection's public ID, from its write-result URL (/c/<pub>/…). */
const pubOf = (url: string) => new URL(url).pathname.split("/")[2] ?? "";
/** The role word of each aria snapshot line ("link", "paragraph", …). */
const kinds = (children: string[]) => children.map((text) => text.split(/[ :]/)[0]);

const scenario: ViewerScenario = {
  name: "A11Y-04: one row contract for Recent, search and Trash",
  async run(ctx) {
    const { writer } = ctx;
    const { base } = writer;
    const plain = await writer.api("/api/collections", {
      title: PLAIN,
      files: [await writer.write("index.md", "# Plain\n")],
    });
    const revised = await writer.api("/api/collections", {
      title: REVISED,
      files: [await writer.write("index.md", "# Revised\n")],
    });
    await writer.api(`/api/collections/${revised.collection_id}/revisions`, {
      message: "Second pass",
      files: [
        await writer.write("index.md", "# Revised, again\n"),
        await writer.write("notes.md", "More\n"),
      ],
    });
    const trashed = await writer.api("/api/collections", {
      title: TRASHED,
      files: [await writer.write("index.md", "# Trashed\n")],
    });
    // The shared writer has sharing configured: a live link pauses when the collection moves.
    const shared = await writer.fetch(`/api/collections/${trashed.collection_id}/share-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Vendor debug" }),
    });
    assert.equal(shared.status, 201);
    const deleted = await writer.fetch(`/api/collections/${trashed.collection_id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    const pub = {
      plain: pubOf(plain.url),
      revised: pubOf(revised.url),
      trashed: pubOf(trashed.url),
    };

    const { page } = await ctx.newPage(VIEWPORTS.desktop);

    // Recent: a named section per day, a list of rows, one link per row named by its title.
    await page.goto(`${base}/`);
    const recent = await sectionOf(page, pub.plain).ariaSnapshot();
    const head = lines(recent).slice(0, 3);
    assert.deepEqual(
      head.map((line) => line.text),
      ['region "Today":', 'heading "Today" [level=2]', "list:"],
      recent,
    );
    const plainRow = rowChildren(recent, PLAIN);
    assert.deepEqual(kinds(plainRow), ["link", "time", "paragraph", "text", "paragraph"], recent);
    assert.equal(plainRow[3], 'text: "#1"');
    assert.ok(
      lines(recent).some((line) => line.text === `/url: /c/${pub.plain}/`),
      "the title links to the collection",
    );
    // The change marker reads as words, not glyphs.
    const revisedRow = rowChildren(await sectionOf(page, pub.revised).ariaSnapshot(), REVISED);
    assert.ok(revisedRow.at(-1)?.includes("1 file changed 1 file added"), revisedRow.join("\n"));
    oneLinkPerItem(recent);
    assert.deepEqual(await rowAxe(page), [], "axe on /");

    // Tab: past the bar and Needs attention to the first row's title; the ring is on the li.
    await page.locator("a.skip").focus();
    let reached = false;
    for (let presses = 0; presses < 40 && !reached; presses++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One key press at a time.
      await page.keyboard.press("Tab");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Checked after each press.
      reached = z.boolean().parse(await page.evaluate(`document.activeElement.matches("a.tlink")`));
    }
    assert.ok(reached, "Tab reaches a row's title link within 40 presses");
    const ring = strings.parse(
      await page.evaluate(
        `(() => { const a = document.activeElement; return [getComputedStyle(a.closest("li")).outlineStyle, getComputedStyle(a).outlineStyle]; })()`,
      ),
    );
    assert.deepEqual(ring, ["solid", "none"], "the focus ring is drawn on the li, not the link");

    // The message area is part of the stretched link.
    await clickCentre(page, page.locator(`li.item[data-pub="${pub.plain}"] .msg`));
    await page.waitForURL((url) => url.pathname === `/c/${pub.plain}/`);

    // Search: the same rows, the match marked inside the link.
    await page.goto(`${base}/?q=${WORD}`);
    const search = await sectionOf(page, pub.plain).ariaSnapshot();
    assert.deepEqual(
      lines(search)
        .slice(0, 3)
        .map((line) => line.text),
      ['region "Today":', 'heading "Today" [level=2]', "list:"],
      search,
    );
    assert.deepEqual(kinds(rowChildren(search, PLAIN)), [
      "link",
      "time",
      "paragraph",
      "text",
      "paragraph",
    ]);
    assert.equal(
      await page.locator(`li.item[data-pub="${pub.plain}"] a.tlink mark`).textContent(),
      WORD,
    );
    oneLinkPerItem(search);
    assert.equal(await page.locator(`li.item[data-pub="${pub.trashed}"]`).count(), 0);
    assert.deepEqual(await rowAxe(page), [], `axe on /?q=${WORD}`);

    // Trash: the shared variant, actions raised and described by the title.
    await page.goto(`${base}/trash`);
    const trash = await sectionOf(page, pub.trashed).ariaSnapshot();
    assert.deepEqual(
      lines(trash)
        .slice(0, 3)
        .map((line) => line.text),
      ['region "In Trash · moved today":', 'heading "In Trash · moved today" [level=2]', "list:"],
      trash,
    );
    assert.deepEqual(
      kinds(rowChildren(trash, TRASHED)),
      ["link", "paragraph", "paragraph", "button", "button"],
      trash,
    );
    const trashRow = rowChildren(trash, TRASHED);
    assert.equal(trashRow[3], 'button "Restore"');
    assert.equal(trashRow[4], 'button "Purge…"');
    assert.ok(trashRow[2]?.includes("1 link, inactive while in Trash"), trashRow.join("\n"));
    const row = page.locator(`li.item[data-pub="${pub.trashed}"]`);
    for (const name of ["Restore", "Purge…"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two buttons.
      const described = await row
        .getByRole("button", { name, exact: true })
        .getAttribute("aria-describedby");
      assert.ok(described, `${name} has a description`);
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two buttons.
        (await page.locator(`[id="${described}"]`).textContent())?.trim(),
        TRASHED,
        `${name} is described by the row title`,
      );
    }
    assert.equal(await row.locator("a").count(), 1, "the paused-links chip isn't a link");
    assert.deepEqual(await rowAxe(page), [], "axe on /trash");
    // Purge… sits above the stretched link: it opens the dialog, not the in-Trash page.
    await row.getByRole("button", { name: "Purge…" }).click();
    const confirm = page.locator("dialog#confirm");
    await confirm.waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/trash");
    await confirm.locator("[data-confirm-cancel]").click();
    await confirm.waitFor({ state: "hidden" });
    await clickCentre(page, row.locator(".msg"));
    await page.waitForURL((url) => url.pathname === `/c/${pub.trashed}/`);
    await page.getByText("is in Trash").first().waitFor();

    // Time zone: the browser's days, the server's row order.
    const order = async (view: Page) =>
      strings.parse(
        await view.evaluate(
          `[...document.querySelectorAll("div.groups li.item")].map((li) => li.dataset.pub)`,
        ),
      );
    const noScript = await ctx.browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 800 },
    });
    const zoned = await ctx.browser.newContext({
      timezoneId: "Pacific/Kiritimati",
      viewport: { width: 1280, height: 800 },
    });
    try {
      const plainView = await noScript.newPage();
      await plainView.goto(`${base}/`);
      const serverOrder = await order(plainView);
      const serverNow = Date.now();
      const view = await zoned.newPage();
      ctx.watchErrors(view, "Pacific/Kiritimati");
      await view.clock.setFixedTime(serverNow + 2 * 24 * 3_600_000);
      await view.goto(`${base}/`);
      const first = (await view.locator("div.groups h2.day").first().textContent()) ?? "";
      assert.ok(
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(
          first,
        ),
        `the first heading is a weekday in the browser's zone: ${first}`,
      );
      assert.deepEqual(await order(view), serverOrder, "rows keep the server's order");
      const ids = strings.parse(
        await view.evaluate(
          `[...document.querySelectorAll("div.groups > section")].map((s) => s.getAttribute("aria-labelledby") + "=" + s.querySelector("h2.day").id)`,
        ),
      );
      assert.ok(
        ids.every((pair, index) => pair === `recent-day-${index}=recent-day-${index}`),
        ids.join(", "),
      );
    } finally {
      await noScript.close();
      await zoned.close();
    }
  },
};
export default scenario;
