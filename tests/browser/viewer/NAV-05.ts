// NAV-05b: History draws lanes on display order (one link per row, the gutter hidden from AT),
// and [ and ] follow parents. Runs alone, on its own writer: #1, #2 on #1, #3 on #1, #4 on #2,
// so the latest line is #4 #2 #1 and #3 is a branch off #1.
import { endOfBranch, FIRST_REVISION } from "../../../apps/writer/src/viewer/lineage.ts";
import { assert, startWriter, type ViewerScenario, type WriteResult } from "../harness.ts";

const pinned = (result: WriteResult): string => new URL(result.url).pathname;

const scenario: ViewerScenario = {
  name: "NAV-05 History lanes on display order; [ and ] follow parents",
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
    assert.deepEqual(await page.locator("#tp-history .rv .h b").allTextContents(), [
      "#4",
      "#3",
      "#2",
      "#1",
    ]);
    assert.equal(
      (await row(3).locator(".br").textContent())?.trim(),
      "Branch off #1 · not in latest",
    );
    assert.equal(await page.locator("#tp-history .br").count(), 1);
    const hidden = await page.evaluate(
      `[...document.querySelectorAll("#tp-history .lg")].map((node) => node.getAttribute("aria-hidden"))`,
    );
    assert.deepEqual(hidden, ["true", "true", "true", "true"]);

    // Geometry at 1280 x 800: lane 0 at 14 px from the row's left edge, the side lane at 30 px.
    const centre = (n: number, selector: string) =>
      page.evaluate(`(() => {
        const li = document.querySelector('#tp-history li.rv[data-n="${n}"]');
        const box = li.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return box.left + box.width / 2 - li.getBoundingClientRect().left;
      })()`);
    const lane0 = Number(await centre(4, ".lg i.ln"));
    const lane1 = Number(await centre(3, ".lg i.run"));
    assert.ok(Math.abs(lane0 - 14) <= 2, `lane 0 centre ${lane0}`);
    assert.ok(Math.abs(lane1 - 30) <= 2, `lane 1 centre ${lane1}`);

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

    // Forced colours: the lanes are borders, so they stay visible.
    const forced = await ctx.newPage({ forcedColors: "active" });
    await forced.page.goto(`${base}${pinned(four)}?panel=history`);
    await forced.page.locator("#tp-history").waitFor({ state: "visible" });
    const width = await forced.page.evaluate(
      `getComputedStyle(document.querySelector('#tp-history li.rv[data-n="3"] .lg i.run')).borderLeftWidth`,
    );
    assert.equal(await forced.page.evaluate('matchMedia("(forced-colors: active)").matches'), true);
    assert.ok(
      typeof width === "string" && parseFloat(width) > 0,
      `border-left-width ${String(width)}`,
    );
  },
};
export default scenario;
