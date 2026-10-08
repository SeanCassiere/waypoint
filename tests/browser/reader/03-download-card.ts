import { assert, type ReaderScenario } from "../harness.ts";
import { fixture } from "./_fixture.ts";

const scenario: ReaderScenario = {
  name: "download card links to the capability URL",
  async run(ctx) {
    const { frameBase, page, shellBase, token } = await fixture(ctx);
    // The download card links to the capability URL, never the token.
    await page.goto(`${shellBase}bin.dat`);
    const download = (await page.getAttribute("#doc", "href")) ?? "";
    assert.ok(download.startsWith(`${frameBase}bin.dat`));
    assert.ok(!download.includes(token));
  },
};
export default scenario;
