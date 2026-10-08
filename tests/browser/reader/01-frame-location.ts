import { assert, type ReaderScenario } from "../harness.ts";
import { COL, REV, fixture } from "./_fixture.ts";

const scenario: ReaderScenario = {
  name: "frame-location messages accepted and ignored",
  async run(ctx) {
    const { cap, evilPort, findFrame, json, message, origin, page, rel, shellBase, state, token } =
      await fixture(ctx);
    // Frame-location messages, posted from the frame's own window.
    const post = async (data: unknown): Promise<unknown> => {
      await page.goto(shellBase);
      await page.waitForTimeout(150);
      await findFrame(page).evaluate(`parent.postMessage(${JSON.stringify(data)}, "*")`);
      await page.waitForTimeout(100);
      return json(page, state);
    };
    const accepted: [unknown, string][] = [
      [message("other.html"), "other.html"],
      [message(`${rel}a/b.html#x`), "a/b.html"],
      [message(`${rel}q%22'%3Cx%3E.html`), `q"'<x>.html`],
      [message(`${rel}sp%20ace.html`), "sp ace.html"],
      [message(`${rel}x/../other.html`), "other.html"],
    ];
    for (const [data, path] of accepted)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each case reloads the shell.
      assert.deepEqual(await post(data), { path, current: [path] }, JSON.stringify(data));
    const ignored: unknown[] = [
      message(rel.replace(REV.pub, REV.pub + "X") + "other.html"),
      message(rel.replace(cap, cap.slice(0, -1) + "Z") + "other.html"),
      message(`${rel}../../other.html`),
      message(`${rel}%2e%2e/%2e%2e/other.html`),
      message(`${rel}a%2Fb.html`),
      message(`${rel}a%5Cb.html`),
      message(`http://127.0.0.1:${evilPort}${rel}other.html`),
      message(`//evil.example${rel}other.html`),
      message("javascript:alert(1)//other.html"),
      message(`blob:${origin}${rel}other.html`),
      message(`${rel}secret.html`),
      message(`/s/${token}/c/${COL.pub}/other.html`),
      message(`${rel}%E0%A4%A.html`),
      { type: "waypoint:locationX", href: "other.html" },
      "waypoint:location",
      message("other.html#" + "x".repeat(9000)),
    ];
    for (const data of ignored)
      assert.deepEqual(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each case reloads the shell.
        await post(data),
        { path: "", current: ["index.html"] },
        JSON.stringify(data).slice(0, 120),
      );
  },
};
export default scenario;
