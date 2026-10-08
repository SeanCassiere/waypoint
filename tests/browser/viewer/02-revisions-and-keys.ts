import { assert, type ViewerScenario, type WriterHandle } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "revision stepping, revision menu, changes keys, compare, shortcuts, History tab persistence",
  async run(ctx) {
    const { base } = ctx.writer;
    const api: WriterHandle["api"] = (path, body) => ctx.writer.api(path, body);
    const write: WriterHandle["write"] = (path, content) => ctx.writer.write(path, content);
    const state = await baseline(ctx);
    const { first, page, pinned, secondPinned } = state;
    // "]" steps to the newer revision and keeps the current file.
    await page.goto(`${base}${pinned}notes/b.md`);
    await page.locator("body").press("]");
    await page.waitForURL(`**${secondPinned}notes/b.md`);
    // The panel's History tab lists both revisions, newest first.
    await page.locator("body").press("h");
    await page.locator("#tp-history").waitFor({ state: "visible" });
    assert.deepEqual(await page.locator("#tp-history .rv .h b").allTextContents(), ["#2", "#1"]);
    const third = await api(`/api/collections/${first.collection_id}/revisions`, {
      message: "Third",
      mode: "replace",
      files: [await write("index.md", "# Third\n")],
    });
    const thirdPinned = new URL(third.url).pathname;
    // A file missing from the target revision falls back to its head.
    await page.goto(`${base}${secondPinned}notes/b.md`);
    await page.locator("body").press("]");
    await page.waitForURL(`**${thirdPinned}`);
    assert.equal(new URL(page.url()).pathname, `${thirdPinned}index.md`);
    // The revision menu opens with "r" and its entries keep the current file.
    await page.goto(`${base}${secondPinned}notes/b.md`);
    await page.getByRole("button", { name: /^Revision 2/ }).click();
    await page.locator("#rev-menu").waitFor({ state: "visible" });
    await page.locator("#rev-menu").getByRole("link", { name: "Revision 1" }).click();
    await page.waitForURL(`**${pinned}notes/b.md`);
    // "d" opens the Changes page against the parent; j focuses the first change; Esc goes back.
    await page.goto(`${base}${secondPinned}`);
    await page.locator("body").press("d");
    await page.waitForURL(`**${secondPinned}changes`);
    await page.getByRole("heading", { name: "Changes in #2" }).waitFor();
    await page.locator("body").press("j");
    assert.equal(await page.evaluate('document.activeElement?.hasAttribute("data-change")'), true);
    await page.locator("body").press("Escape");
    await page.waitForURL((url) => url.pathname === secondPinned);
    // Compare… opens natively (commandfor/command) and navigates to the chosen pair.
    await page.getByRole("button", { name: /^Revision 2/ }).click();
    await page.getByRole("button", { name: /Compare…/ }).click();
    await page.locator("#compare").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.waitForURL(/\/changes\?base=/);
    // Keyboard shortcuts dialog and the disable toggle.
    await page.locator("body").press("?");
    await page.locator("#keys").waitFor({ state: "visible" });
    await page.locator("[data-keys-off]").check();
    await page.keyboard.press("Escape");
    await page.locator("body").press("h");
    assert.equal(await page.locator("#tp-history").isVisible(), false, "shortcuts stay off");
    await page.evaluate('localStorage.removeItem("wp:keys")');
    // History stays open while stepping through revisions (owner feedback): picking a
    // revision in the History tab, then "[" and "]", keeps the tab and highlights the revision.
    await page.goto(`${base}${thirdPinned}`);
    await page.locator("#tab-history").click();
    assert.match(page.url(), /[?&]panel=history/);
    await page.locator("#tp-history").getByRole("link", { name: "Second" }).click();
    await page.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
    assert.match(page.url(), /[?&]panel=history/);
    assert.equal(await page.locator("#tab-history").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#tp-history").isVisible(), true);
    assert.equal(
      await page.locator('#tp-history .rv[aria-current="true"] .h b').textContent(),
      "#2",
    );
    await page.locator("body").press("[");
    await page.waitForURL((url) => url.pathname === `${pinned}index.md`);
    assert.equal(await page.locator("#tab-history").getAttribute("aria-selected"), "true");
    assert.equal(
      await page.locator('#tp-history .rv[aria-current="true"] .h b').textContent(),
      "#1",
    );
    await page.locator("body").press("]");
    await page.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
    assert.match(page.url(), /[?&]panel=history/);
    assert.equal(await page.locator("#tp-history").isVisible(), true);
    state.third = third;
    state.thirdPinned = thirdPinned;
  },
};
export default scenario;
