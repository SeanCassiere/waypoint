import { assert, type ReaderScenario } from "../harness.ts";
import { fixture } from "./_fixture.ts";

const scenario: ReaderScenario = {
  name: "nested frame, top navigation, frame referrer, popup COOP",
  async run(ctx) {
    const { evilPort, findFrame, json, page, shellBase } = await fixture(ctx);
    // A nested frame inside the document is not the shell's frame window.
    await page.goto(shellBase);
    await page.waitForTimeout(150);
    await findFrame(page).evaluate(`new Promise((resolve) => {
      const inner = document.createElement("iframe");
      inner.srcdoc = '<script>top.postMessage({type:"waypoint:location",href:"other.html"},"*")</scr' + 'ipt>';
      inner.addEventListener("load", () => setTimeout(resolve, 100));
      document.body.append(inner);
    })`);
    await page.waitForTimeout(100);
    assert.equal(page.url(), shellBase);

    // The sandboxed document can't navigate the shell.
    await findFrame(page).evaluate(
      `try { top.location.href = ${JSON.stringify(`http://127.0.0.1:${evilPort}/topnav`)} } catch {}`,
    );
    await page.waitForTimeout(300);
    assert.equal(page.url(), shellBase);

    // A document that navigates its own frame away sends no referrer.
    await page.goto(shellBase);
    await page.waitForTimeout(150);
    await findFrame(page).evaluate(
      `location.href = ${JSON.stringify(`http://127.0.0.1:${evilPort}/framenav`)}`,
    );
    await page.waitForTimeout(300);
    const navigated = page.frames()[1];
    assert.ok(navigated);
    assert.equal(await json(navigated, "document.referrer"), "");

    // A popup that escapes the sandbox gets no opener to the shell (COOP: same-origin).
    {
      const popupContext = await ctx.browser.newContext();
      const shell = await popupContext.newPage();
      await shell.goto(shellBase);
      await shell.waitForTimeout(200);
      const popupPromise = popupContext.waitForEvent("page");
      await findFrame(shell).evaluate(
        `open(${JSON.stringify(`http://127.0.0.1:${evilPort}/popup`)})`,
      );
      const popup = await popupPromise;
      await popup.waitForLoadState();
      await shell.waitForTimeout(500);
      assert.deepEqual(JSON.parse(await popup.title()) as unknown, {
        opener: false,
        nav: "blocked",
      });
      assert.equal(shell.url(), shellBase);
      await popupContext.close();
    }
  },
};
export default scenario;
