import { WAYPOINT_VERSION } from "@waypoint/core";

import { assert, type ReaderScenario } from "../harness.ts";
import { FILES, fixture } from "./_fixture.ts";

const scenario: ReaderScenario = {
  name: "CSP, title escaping, sandbox attributes, no token in URLs, opaque frame",
  async run(ctx) {
    const { findFrame, json, log, page, shellBase, token } = await fixture(ctx);
    await page.goto(shellBase);
    await page.waitForTimeout(300);
    const frame = findFrame(page);

    // CSP: the shell's own script ran, injected markup didn't, nothing was refused.
    assert.doesNotMatch((await page.textContent("time .lgt")) ?? "", /UTC$/);
    // "Updated" is localized as a relative time (RX-01): "2 days ago", "on 7 Oct" (any clock).
    assert.match(
      (await page.textContent("time .lgt")) ?? "",
      /^(?:just now|\d+ (?:minute|hour|day)s? ago|in \d+ (?:minute|hour|day)s?|on \d{1,2} [A-Z][a-z]{2}(?: \d{4})?)$/,
    );
    assert.equal(await json(page, `"pwned" in window`), false);
    assert.equal(await json(page, "window._WAYPOINT_VERSION"), WAYPOINT_VERSION);
    assert.equal(
      await page.textContent("h1"),
      `Evil </title><script>window.pwned=1</script>�Title "'`,
    );
    assert.deepEqual(
      log.filter((l) => /Content Security Policy|Refused|pageerror/i.test(l)),
      [],
    );
    assert.deepEqual(
      await json(
        page,
        `["sandbox", "referrerpolicy"].map((a) => document.getElementById("doc").getAttribute(a))`,
      ),
      ["allow-scripts allow-popups allow-popups-to-escape-sandbox", "no-referrer"],
    );
    // No rendered URL carries the share token (links are relative to the page itself).
    const urls = await json(
      page,
      `[...document.querySelectorAll("[href],[src]")].map((e) => e.getAttribute("href") ?? e.getAttribute("src"))`,
    );
    assert.ok(Array.isArray(urls) && urls.length >= FILES.length);
    assert.ok(!JSON.stringify(urls).includes(token));
    // The document is in an opaque origin and learns nothing about the shell.
    const probe = await json(frame, "window.probe");
    assert.deepEqual(
      { ...(probe && typeof probe === "object" ? probe : {}), ownHref: "" },
      { referrer: "", name: "", ownHref: "", topHref: "blocked", parentDoc: "blocked" },
    );
    assert.ok(!JSON.stringify(probe).includes(token));
  },
};
export default scenario;
