import { z } from "zod";

// NAV-05b: History is a log on one spine in display order (one link per row, the nodes and day
// rows hidden from AT, the branch said in words; D82), and [ and ] follow parents. Runs alone, on its own writer: #1, #2 on #1, #3 on #1, #4 on #2,
// so the latest line is #4 #2 #1 and #3 is a branch off #1.
import { endOfBranch, FIRST_REVISION } from "../../../apps/writer/src/viewer/lineage.ts";
import { assert, startWriter, type ViewerScenario, type WriteResult } from "../harness.ts";

const pinned = (result: WriteResult): string => new URL(result.url).pathname;

const scenario: ViewerScenario = {
  name: "NAV-05 History on one spine in display order; [ and ] follow parents",
  async run(ctx) {
    const writer = await startWriter();
    const { base } = writer;
    /** The revision's internal ID, from its shell (the write result carries only URLs). */
    const revisionId = async (result: WriteResult): Promise<string> => {
      const html = await (await writer.fetch(pinned(result))).text();
      const id = /data-revision-id="([^"]+)"/.exec(html)?.[1];
      if (!id) throw new Error(`no revision id at ${pinned(result)}`);
      return id;
    };
    const one = await writer.api("/api/collections", {
      title: "NAV-05 lanes",
      files: [await writer.write("index.md", "# One\n")],
    });
    const revise = async (parent: WriteResult, message: string) =>
      writer.api(`/api/collections/${one.collection_id}/revisions`, {
        message,
        parent_revision_id: await revisionId(parent),
        files: [await writer.write("index.md", `# ${message}\n`)],
      });
    const two = await revise(one, "Two");
    const three = await revise(one, "Three");
    const four = await revise(two, "Four");

    const { page } = await ctx.newPage();
    const history = page.locator("#tp-history");
    const row = (n: number) => page.locator(`#tp-history li.rv[data-n="${n}"]`);
    await page.goto(`${base}${pinned(four)}?panel=history`);
    await history.waitFor({ state: "visible" });
    assert.deepEqual(await page.locator("#tp-history .rv .lb-t b").allTextContents(), [
      "#4",
      "#3",
      "#2",
      "#1",
    ]);
    assert.equal((await row(3).locator(".br").textContent())?.trim(), "on #1, not in latest");
    assert.equal(await page.locator("#tp-history .br").count(), 1);
    const hidden = await page.evaluate(
      `[...document.querySelectorAll("#tp-history :is(.lb-n, .lb-day)")].map((node) => node.getAttribute("aria-hidden"))`,
    );
    assert.deepEqual(hidden, ["true", "true", "true", "true", "true"]);

    // Geometry at 1280 x 800: every node, the branch's too, sits on the one spine.
    const offsets = z.array(z.number()).parse(
      await page.evaluate(`(() => {
        const ol = document.querySelector("#tp-history ol");
        const spine = parseFloat(getComputedStyle(ol, "::before").left) + 0.75;
        const left = ol.getBoundingClientRect().left;
        return [...ol.querySelectorAll("li.rv > .lb-n")].map((node) => {
          const box = node.getBoundingClientRect();
          return box.left + box.width / 2 - left - spine;
        });
      })()`),
    );
    assert.equal(offsets.length, 4);
    for (const offset of offsets)
      assert.ok(Math.abs(offset) <= 1, `node off the spine by ${offset}`);

    // [ and ] follow parents; at an end the toast says why.
    const toast = page.locator("[data-toast]");
    const toastSays = async (text: string) => {
      await toast.waitFor({ state: "visible" });
      assert.equal((await toast.textContent())?.trim(), text);
    };
    await page.goto(`${base}${pinned(two)}`);
    await page.locator("body").press("]");
    await page.waitForURL((url) => url.pathname.startsWith(pinned(four)));
    await page.goto(`${base}${pinned(three)}`);
    const before = page.url();
    await page.locator("body").press("]");
    await toastSays(endOfBranch(4));
    assert.equal(page.url(), before);
    await page.locator("body").press("[");
    await page.waitForURL((url) => url.pathname.startsWith(pinned(one)));
    await page.locator("body").press("[");
    await toastSays(FIRST_REVISION);
    assert.ok(new URL(page.url()).pathname.startsWith(pinned(one)));

    // The accessibility tree: a list named by the header, one link per row. (On #1's page, so no
    // row carries the current revision's "Changes from #K" action link.)
    await page.goto(`${base}${pinned(one)}?panel=history`);
    await history.waitFor({ state: "visible" });
    const snapshot = await page.locator("#tp-history ol").ariaSnapshot();
    const lines = snapshot.split("\n");
    assert.equal(lines[0], '- list "Latest line newest first":');
    assert.equal(lines.filter((line) => /^ {2}- listitem\b/.test(line)).length, 4);
    assert.deepEqual(
      lines.flatMap((line) => /^\s*- link "([^"]*)"/.exec(line)?.slice(1) ?? []),
      ["#4", "#3", "#2", "#1"],
    );

    // Forced colours: the spine is a border, so it stays visible.
    const forced = await ctx.newPage({ forcedColors: "active" });
    await forced.page.goto(`${base}${pinned(four)}?panel=history`);
    await forced.page.locator("#tp-history").waitFor({ state: "visible" });
    const width = await forced.page.evaluate(
      `getComputedStyle(document.querySelector("#tp-history ol"), "::before").borderLeftWidth`,
    );
    assert.equal(await forced.page.evaluate('matchMedia("(forced-colors: active)").matches'), true);
    assert.ok(
      typeof width === "string" && parseFloat(width) > 0,
      `border-left-width ${String(width)}`,
    );
  },
};
export default scenario;
