import { assert, type ReaderScenario } from "../harness.ts";
import { fixture } from "./_fixture.ts";

const scenario: ReaderScenario = {
  name: "no request carried the token as Referer",
  async run(ctx) {
    const { referers, token } = await fixture(ctx);
    assert.deepEqual(
      referers.filter((r) => r.includes(token)),
      [],
    );
  },
};
export default scenario;
