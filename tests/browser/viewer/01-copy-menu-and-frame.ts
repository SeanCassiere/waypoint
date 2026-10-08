import { assert, type ViewerScenario } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "copy menu, frame navigation, history, source/hash",
  async run(ctx) {
    const { base } = ctx.writer;
    const { latest, page, pinned, rawRequests } = await baseline(ctx);
    // Copy menu: the handoff block names the collection and revision for another agent.
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.locator("#copy-menu").waitFor({ state: "visible" });
    const handoff = (await page.locator("[data-handoff]").textContent()) ?? "";
    assert.match(handoff, /collection_id: col_/);
    assert.match(handoff, /Watch: wait_for_revision/);
    await page.keyboard.press("Escape");
    assert.equal(new URL(page.url()).pathname, latest);
    await page.frameLocator("iframe").getByRole("link", { name: "Notes" }).click();
    await page.waitForURL(`**${latest}notes/b.md`);
    assert.equal(
      rawRequests.filter((url) => url.endsWith("/notes/b.md")).length,
      1,
      "in-frame navigation fetched twice",
    );
    assert.equal(
      await page.locator('#tp-files a[aria-current="page"]').getAttribute("data-file"),
      "notes/b.md",
    );
    await page.goto(`${base}${latest}`);
    const beforeHistory = Number(await page.evaluate("history.length"));
    await page.locator('[data-file="notes/b.md"]').click();
    await page.waitForURL(`**${latest}notes/b.md`);
    assert.equal(await page.evaluate("history.length"), beforeHistory + 1);
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, latest);
    await page.waitForFunction(
      'document.querySelector("iframe")?.contentWindow?.location.pathname.endsWith("/index.md")',
    );
    await page.goForward();
    assert.equal(new URL(page.url()).pathname, `${latest}notes/b.md`);
    await page.waitForFunction(
      'document.querySelector("iframe")?.contentWindow?.location.pathname.endsWith("/notes/b.md")',
    );
    await page.goto(`${base}${pinned}`);
    await page.frameLocator("iframe").getByRole("link", { name: "Source" }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.endsWith("notes/b.md") && url.search === "?source" && url.hash === "#hello",
    );
    assert.equal(new URL(page.url()).pathname, `${pinned}notes/b.md`);
  },
};
export default scenario;
