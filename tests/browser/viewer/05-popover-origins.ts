import { assert, type ViewerScenario } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "popover origins without anchored queries",
  async run(ctx) {
    const { base } = ctx.writer;
    const { pageErrors } = ctx;
    const { latest } = await baseline(ctx);
    // Without anchored container queries, script sets the origin from the actual placement.
    const legacy = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 } });
    await legacy.addInitScript({
      content: `{
        const supports = CSS.supports.bind(CSS);
        CSS.supports = (...args) => (/anchored/.test(args.join(" ")) ? false : supports(...args));
      }`,
    });
    const legacyPage = await legacy.newPage();
    await legacyPage.goto(`${base}${latest}`);
    const origin = async (id: string) => {
      const expression = `document.querySelector("#${id} > .mbox").style.getPropertyValue("--origin")`;
      // The origin is set on the toggle event, which fires just after the popover opens.
      await legacyPage.waitForFunction(`${expression} !== ""`);
      return legacyPage.evaluate(expression);
    };
    await legacyPage.locator('header [popovertarget="copy-menu"]').click();
    assert.equal(await origin("copy-menu"), "top right");
    await legacy.close();
    assert.deepEqual(pageErrors, [], "no script errors");
  },
};
export default scenario;
