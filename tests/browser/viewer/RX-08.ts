// RX-08: the writer frames text and CSV files as their `text`/`csv` renditions, and the More
// menu's "Download file" still saves the original bytes (`?download`), also after an in-frame
// switch to another file.
import type { Frame, Page } from "playwright";

import { DRAIN_SCRIPT, resultsCsv } from "../../../packages/render/tests/golden-text.ts";
import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

/** The document frame once it has loaded `path`. */
async function docFrame(page: Page, path: string): Promise<Frame> {
  await page.waitForFunction(
    `(() => { const w = document.querySelector("[data-docwrap]");
      const f = document.querySelector("[data-frame]");
      return w.hasAttribute("data-loaded") && f.contentWindow.location.pathname.endsWith(${JSON.stringify(`/${path}`)}); })()`,
  );
  // The page's own URL ends with the path too: only the raw document frame counts.
  const frame = page
    .frames()
    .find((f) => f.url().includes("/raw/r/") && new URL(f.url()).pathname.endsWith(`/${path}`));
  assert.ok(frame, `the frame shows ${path}`);
  await frame.waitForLoadState("load");
  return frame;
}

const scenario: ViewerScenario = {
  name: "RX-08 the writer frames text and CSV renditions; Download file saves the original",
  async run(ctx) {
    const { base } = ctx.writer;
    const created = await ctx.writer.api("/api/collections", {
      title: "Renditions in the writer",
      head_path: "drain.sh",
      files: [
        await ctx.writer.write("drain.sh", DRAIN_SCRIPT),
        await ctx.writer.write("results.csv", resultsCsv()),
      ],
    });
    const pub = new URL(created.url).pathname.split("/r/")[1]?.split("/")[0] ?? "";
    assert.ok(pub, "the revision's public ID");
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(`${base}${new URL(created.latest_url).pathname}drain.sh`);
    const script = await docFrame(page, "drain.sh");
    assert.equal(await script.evaluate(`document.body.className`), "tv");
    assert.equal(
      await script.evaluate(`document.querySelector(".fh .fn").textContent`),
      "drain.sh",
    );

    const download = page.locator("[data-download-raw]");
    const href = String(await download.getAttribute("href"));
    assert.ok(href.endsWith(`/raw/r/${pub}/drain.sh?download`), `Download file: ${href}`);
    const saved = await page.request.get(new URL(href, base).href);
    assert.equal(saved.status(), 200);
    assert.match(saved.headers()["content-disposition"] ?? "", /^attachment/);
    assert.equal(saved.headers()["content-type"], "text/x-shellscript; charset=utf-8");
    const bytes = await saved.body();
    assert.equal(bytes.length, 1094, "the script's bytes, not HTML");
    assert.equal(bytes.toString("utf8"), DRAIN_SCRIPT);

    // An in-frame switch keeps the menu item on the original bytes of the file now showing.
    await page.locator('#tp-files a[data-file="results.csv"]').click();
    const table = await docFrame(page, "results.csv");
    assert.equal(await table.evaluate(`document.querySelectorAll("table.csv").length`), 1);
    const next = String(await download.getAttribute("href"));
    assert.ok(next.endsWith(`/raw/r/${pub}/results.csv?download`), `after a switch: ${next}`);

    const source = await page.request.get(`${base}/raw/r/${pub}/drain.sh?source`);
    assert.equal(await source.text(), DRAIN_SCRIPT, "?source is the script text");
  },
};
export default scenario;
