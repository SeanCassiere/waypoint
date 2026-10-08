import { assert, type ViewerScenario } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "History sheet reopens at 744 px",
  async run(ctx) {
    const { base } = ctx.writer;
    const { secondPinned, thirdPinned } = await baseline(ctx);
    if (thirdPinned === undefined) throw new Error("run 02-revisions-and-keys first");
    // On the iPad mini (744 px) the History side sheet stays open while stepping revisions.
    const mini = await ctx.browser.newContext({
      viewport: { width: 744, height: 1133 },
      hasTouch: true,
    });
    const miniPage = await mini.newPage();
    await miniPage.goto(`${base}${thirdPinned}`);
    await miniPage.locator('.tabbar [data-tab="history"]').tap();
    await miniPage.locator("#tp-history").waitFor({ state: "visible" });
    await miniPage.locator("#tp-history").getByRole("link", { name: "Second" }).tap();
    await miniPage.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
    await miniPage.locator("#tp-history").waitFor({ state: "visible" });
    assert.equal(
      await miniPage.evaluate('document.querySelector("#shell").classList.contains("open")'),
      true,
      "the History sheet reopens at 744 px",
    );
    await mini.close();
  },
};
export default scenario;
