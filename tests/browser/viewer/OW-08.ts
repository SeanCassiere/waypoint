// OW-08: unread stays in place. Read marks (wp:read:<pub>) drive unread; wp:lastVisit is set once on
// the first visit and by Mark all read, never on leaving the page. An unread row keeps its place
// and day group, gets a dot, a bolder title and (with a mark) one link to the changes since. The
// writer is shared, so rows are found only by data-pub and unread counts come from the page.
import type { Locator, Page } from "playwright";
import { z } from "zod";

import { assert, axe, VIEWPORTS, type AxeViolation, type ViewerScenario } from "../harness.ts";

const TITLE = "ow08 unread runbook";
const FOURTH = "ow08 fourth notes";
const LEDE = "Newest first, by latest revision.";
const strings = z.array(z.string());
const revisions = z.object({
  revisions: z.array(
    z.object({ id: z.string(), public_id: z.string(), display_number: z.number() }),
  ),
});
/** A collection's public ID, from its write-result URL (/c/<pub>/…). */
const pubOf = (url: string) => new URL(url).pathname.split("/")[2] ?? "";
const row = (page: Page, pub: string): Locator => page.locator(`li.item[data-pub="${pub}"]`);
const isUnread = async (item: Locator): Promise<boolean> =>
  ((await item.getAttribute("class")) ?? "").split(" ").includes("unread");
const order = async (page: Page): Promise<string[]> =>
  strings.parse(
    await page.evaluate(`[...document.querySelectorAll("li.item")].map((li) => li.dataset.pub)`),
  );
const unreadPubs = async (page: Page): Promise<string[]> =>
  strings.parse(
    await page.evaluate(
      `[...document.querySelectorAll("li.item.unread")].map((li) => li.dataset.pub)`,
    ),
  );
const lastVisit = async (page: Page): Promise<string | null> =>
  z
    .string()
    .nullable()
    .parse(await page.evaluate(`localStorage.getItem("wp:lastVisit")`));
const setItem = (page: Page, key: string, value: string) =>
  page.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
const markOf = async (page: Page, pub: string) =>
  z
    .object({ id: z.string(), n: z.number(), pub: z.string() })
    .parse(JSON.parse(String(await page.evaluate(`localStorage.getItem("wp:read:${pub}")`))));

/** axe with the row rules on the whole page. */
async function rowAxe(page: Page): Promise<AxeViolation[]> {
  return axe(page, {
    rules: ["nested-interactive", "label-content-name-mismatch"],
    enable: ["label-content-name-mismatch"],
  });
}

const scenario: ViewerScenario = {
  name: "OW-08 unread rows stay in place and read marks persist",
  async run(ctx) {
    const { writer } = ctx;
    const { base } = writer;
    const first = await writer.api("/api/collections", {
      title: TITLE,
      files: [await writer.write("index.md", "# Runbook\n")],
    });
    const revise = async (n: number) =>
      writer.api(`/api/collections/${first.collection_id}/revisions`, {
        message: `Pass ${n}`,
        files: [await writer.write("index.md", `# Runbook, pass ${n}\n`)],
      });
    // One at a time: each revision builds on the last.
    await revise(2);
    await revise(3);
    await revise(4);
    await writer.api("/api/collections", {
      title: "ow08 other notes",
      files: [await writer.write("index.md", "# Other\n")],
    });
    await writer.api("/api/collections", {
      title: "ow08 third notes",
      files: [await writer.write("index.md", "# Third\n")],
    });
    const firstPub = pubOf(first.url);
    const listed = revisions.parse(
      await (await writer.fetch(`/api/collections/${first.collection_id}/revisions`)).json(),
    ).revisions;
    const rev = (n: number) => {
      const found = listed.find((revision) => revision.display_number === n);
      assert.ok(found, `#${n} is listed`);
      return found ?? { id: "", public_id: "", display_number: n };
    };
    const markOne = JSON.stringify({ id: rev(1).id, n: 1, pub: rev(1).public_id });

    // A fresh browser: lastVisit is set on the first visit, so nothing is unread yet.
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(`${base}/`);
    const firstVisit = await lastVisit(page);
    assert.ok(firstVisit && Number(firstVisit) > 0, "wp:lastVisit is set on the first visit");
    assert.equal(await page.locator("li.item.unread").count(), 0);
    assert.equal((await page.locator("[data-lede]").textContent())?.trim(), LEDE);

    // A read mark at #1: the row is unread, with one link to the changes since #1.
    await setItem(page, `wp:read:${firstPub}`, markOne);
    await page.reload();
    const item = row(page, firstPub);
    assert.equal(await isUnread(item), true);
    const link = item.locator("a.rv-link");
    assert.ok(await link.isVisible(), "the new-since link is visible");
    assert.equal(await link.textContent(), `3 new since you read #1 in ${TITLE} ›`);
    const name = `3 new since you read #1 in ${TITLE}`;
    assert.equal(await item.getByRole("link", { name, exact: true }).count(), 1, "its name");
    assert.equal(
      await link.getAttribute("href"),
      `/c/${firstPub}/r/${rev(4).public_id}/changes?base=${rev(1).public_id}`,
    );
    const title = item.locator("a.tlink");
    assert.equal(await title.getAttribute("aria-describedby"), `new-${firstPub}`);
    assert.equal(await link.getAttribute("id"), `new-${firstPub}`);
    assert.equal(
      await item.locator("a[href], button, input, select, textarea, [tabindex]").count(),
      2,
      "two focusable elements in the row",
    );
    await title.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(`document.activeElement.id`),
      `new-${firstPub}`,
      "Tab goes from the title to the link",
    );
    // The dot and the link use --ink; the title is bolder.
    const styles = strings.parse(
      await page.evaluate(`(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ink)";
        document.body.append(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        const li = document.querySelector('li.item[data-pub="${firstPub}"]');
        const dot = getComputedStyle(li.querySelector(".t"), "::before");
        return [
          ink,
          dot.backgroundColor,
          dot.width,
          getComputedStyle(li.querySelector(".tt")).fontWeight,
          getComputedStyle(li.querySelector("a.rv-link")).color,
        ];
      })()`),
    );
    assert.deepEqual(styles.slice(1), [styles[0], "6px", "750", styles[0]], styles.join(", "));
    assert.equal(
      (await page.locator("[data-lede]").textContent())?.trim(),
      "1 collection has revisions you haven't read. Mark all read · Read marks live in this browser.",
    );
    assert.equal(await page.locator("[data-lede] b").textContent(), "1 collection");
    assert.deepEqual(await rowAxe(page), [], "axe on / with an unread row");

    // Rows stay where the server put them: no Unread group, no divider.
    const noScript = await ctx.browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const plain = await noScript.newPage();
      await plain.goto(`${base}/`);
      assert.deepEqual(await order(page), await order(plain), "rows keep the server's order");
      assert.equal(await plain.locator("li.item.unread, a.rv-link:not([hidden])").count(), 0);
      assert.equal((await plain.locator("[data-lede]").textContent())?.trim(), LEDE);
    } finally {
      await noScript.close();
    }
    assert.equal(
      await page.evaluate(
        `[...document.querySelectorAll("body *")].some((node) => /^(Unread ·|New since)/.test(node.textContent.trim()))`,
      ),
      false,
      "no Unread group and no New since divider",
    );

    // Leaving the page doesn't move lastVisit.
    await page.goto(`${base}/status`);
    await page.goto(`${base}/`);
    assert.equal(await lastVisit(page), firstVisit, "wp:lastVisit is unchanged");
    assert.equal(await isUnread(item), true);

    // The link opens the Changes page for #4 against #1.
    const changes = `/c/${firstPub}/r/${rev(4).public_id}/changes`;
    const response = page.waitForResponse(
      (answer) =>
        answer.request().isNavigationRequest() && new URL(answer.url()).pathname === changes,
    );
    await item.locator("a.rv-link").click();
    assert.equal((await response).status(), 200);
    await page.getByRole("heading", { name: "Changes from #1 to #4" }).waitFor();

    // Unmarked and new since lastVisit: unread, described as "Unread", no link.
    const fourth = await writer.api("/api/collections", {
      title: FOURTH,
      files: [await writer.write("index.md", "# Fourth\n")],
    });
    const fourthPub = pubOf(fourth.url);
    // updated_at is on search results (GET /api/collections/<id> has no such field).
    const updated = z
      .object({ collections: z.array(z.object({ id: z.string(), updated_at: z.number() })) })
      .parse(
        await (await writer.fetch(`/api/collections?query=${encodeURIComponent(FOURTH)}`)).json(),
      )
      .collections.find((found) => found.id === fourth.collection_id);
    assert.ok(updated, "the fourth collection is found");
    const fourthAt = updated?.updated_at ?? 0;
    await page.goto(`${base}/`);
    await setItem(page, `wp:read:${firstPub}`, markOne);
    await setItem(page, "wp:lastVisit", String(fourthAt - 1));
    await page.evaluate(`localStorage.removeItem("wp:read:${fourthPub}")`);
    await page.reload();
    const fresh = row(page, fourthPub);
    assert.equal(await isUnread(fresh), true);
    assert.equal(await fresh.locator("a.rv-link").isHidden(), true);
    assert.equal(await fresh.locator("a.rv-link").getAttribute("href"), null);
    const described = await fresh.locator("a.tlink").getAttribute("aria-describedby");
    assert.equal(described, `unread-${fourthPub}`);
    assert.equal(await page.locator(`[id="${described}"]`).textContent(), "Unread");
    const expected = strings.parse(
      await page.evaluate(`(() => {
        const lastVisit = Number(localStorage.getItem("wp:lastVisit"));
        return [...document.querySelectorAll("li.item")]
          .filter((li) => (!localStorage.getItem("wp:read:" + li.dataset.pub) && Number(li.dataset.at) > lastVisit) || li.dataset.pub === ${JSON.stringify(firstPub)})
          .map((li) => li.dataset.pub);
      })()`),
    );
    const unread = await unreadPubs(page);
    assert.deepEqual(unread.toSorted(), expected.toSorted(), "unread rows, by data-pub");
    assert.ok(unread.includes(fourthPub) && unread.includes(firstPub), unread.join(", "));

    // Mark all read: every mark set, nothing moves, focus on the heading, one toast.
    const before = await order(page);
    const count = unread.length;
    await page.locator("[data-mark-all]").click();
    assert.equal(await page.locator("li.item.unread").count(), 0);
    assert.equal(await page.locator("a.rv-link:not([hidden])").count(), 0);
    assert.equal(await page.locator("li.item a.tlink[aria-describedby]").count(), 0);
    assert.deepEqual(await order(page), before, "no row moved");
    assert.equal((await page.locator("[data-lede]").textContent())?.trim(), LEDE);
    assert.equal(await page.evaluate(`document.activeElement.id`), "recent-title");
    assert.equal(
      (await page.locator('[data-toast-slot="success"] .tt').textContent())?.trim(),
      `Marked ${count} ${count === 1 ? "collection" : "collections"} read`,
    );
    assert.equal((await markOf(page, firstPub)).n, 4);
    assert.equal((await markOf(page, fourthPub)).n, 1);
    await page.reload();
    assert.equal(await page.locator("li.item.unread").count(), 0, "still read after a reload");

    // Touch: the link is a full-height tap target.
    const phone = await ctx.newPage(VIEWPORTS.phone);
    await phone.page.goto(`${base}/`);
    await setItem(phone.page, `wp:read:${firstPub}`, markOne);
    await phone.page.reload();
    const box = await row(phone.page, firstPub).locator("a.rv-link").boundingBox();
    assert.ok(box && box.height >= 44, `tap target ${box?.height ?? 0} px tall`);
    const shown = await row(phone.page, firstPub).locator("a.rv-link").innerText();
    assert.match(
      shown,
      / ›$/,
      `the visible link text keeps the space before the arrow: "${shown}"`,
    );

    // Forced colours paint backgrounds as Canvas: the dot is drawn in CanvasText instead.
    await phone.page.emulateMedia({ forcedColors: "active" });
    const [dot, canvas] = strings.parse(
      await phone.page.evaluate(`[
        getComputedStyle(document.querySelector('li.item[data-pub="${firstPub}"] .t'), "::before").backgroundColor,
        getComputedStyle(document.body).backgroundColor,
      ]`),
    );
    assert.notEqual(dot, canvas, `the dot (${dot}) stands out from the page (${canvas})`);

    // A full localStorage: the first-visit write throws, but existing marks still show, nothing
    // else on the page stops (newPage records page errors), and Mark all read still clears.
    const full = await ctx.newPage(VIEWPORTS.desktop);
    await full.page.goto(`${base}/`);
    await setItem(full.page, `wp:read:${firstPub}`, markOne);
    await full.page.evaluate(`localStorage.removeItem("wp:lastVisit")`);
    await full.page.addInitScript(`Storage.prototype.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };`);
    await full.page.reload();
    assert.equal(await lastVisit(full.page), null, "the first-visit write failed");
    assert.equal(await isUnread(row(full.page, firstPub)), true, "the read mark still shows");
    assert.ok(await row(full.page, firstPub).locator("a.rv-link").isVisible());
    await full.page.locator("[data-mark-all]").click();
    assert.equal(await full.page.locator("li.item.unread").count(), 0, "Mark all read clears");
  },
};
export default scenario;
