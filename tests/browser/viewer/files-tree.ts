// D72: the Files tree lists folders before files, starts collapsed except the current file's
// folders, has Expand all / Collapse all, remembers open folders per collection for the tab, puts
// them back after a filter query, and opens a folder when the document links into it.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const strings = z.array(z.string());
/** The tree's rows in document order: folders as their data-dir, files as their path. */
const rows = async (page: Page) =>
  strings.parse(
    await page.evaluate(
      `[...document.querySelectorAll("#tp-files [data-dir], #tp-files a[data-file]")].map((n) => n.dataset.dir ?? n.dataset.file)`,
    ),
  );
const opened = async (page: Page) =>
  strings.parse(
    await page.evaluate(
      `[...document.querySelectorAll("#tp-files details[open]")].map((d) => d.dataset.dir)`,
    ),
  );
/** Waits for the toggle events (a task after each change) to have been handled. */
const settle = (page: Page) => page.evaluate("new Promise((resolve) => setTimeout(resolve, 50))");

const at = (result: { latest_url: string }) => new URL(result.latest_url).pathname;

const scenario: ViewerScenario = {
  name: "Files tree: folders first, collapsed, Expand all, remembered, filter, reveal",
  async run(ctx) {
    const { writer } = ctx;
    const files = await Promise.all(
      [
        ["index.md", "# Home\n\n[Deep](notes/deep/x.md)\n"],
        ["Zeta.md", "# Z\n"],
        ["api.md", "# API\n"],
        ["ch10.md", "# 10\n"],
        ["ch2.md", "# 2\n"],
        ["notes/b.md", "# B\n"],
        ["notes/A.md", "# A\n"],
        ["notes/deep/x.md", "# X\n"],
        ["Beta/c.md", "# C\n"],
        ["assets/logo.md", "# Logo\n"],
      ].map(([path, content]) => writer.write(path ?? "", content ?? "")),
    );
    const many = await Promise.all(
      Array.from({ length: 200 }, (_, i) => writer.write(`bulk/f${i}.md`, `# ${i}\n`)),
    );
    const small = await writer.api("/api/collections", { title: "Tree order", files });
    const large = await writer.api("/api/collections", {
      title: "Tree filter",
      files: [...files, ...many],
    });

    const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, reducedMotion: "reduce" });
    await page.goto(`${writer.base}${at(small)}`);
    assert.deepEqual(await rows(page), [
      "index.md",
      "assets/",
      "assets/logo.md",
      "Beta/",
      "Beta/c.md",
      "notes/",
      "notes/deep/",
      "notes/deep/x.md",
      "notes/A.md",
      "notes/b.md",
      "api.md",
      "ch2.md",
      "ch10.md",
      "Zeta.md",
    ]);
    assert.deepEqual(await opened(page), [], "every folder starts collapsed at the head");
    const all = page.locator("#tp-files [data-tree-all]");
    assert.equal(await all.textContent(), "Expand all");
    assert.ok(await all.isVisible(), "script shows Expand all");

    // Expand all opens every folder and turns into Collapse all; a hand toggle flips it back.
    await all.click();
    await settle(page);
    assert.deepEqual(await opened(page), ["assets/", "Beta/", "notes/", "notes/deep/"]);
    assert.equal(await all.textContent(), "Collapse all");
    await page.locator('#tp-files details[data-dir="Beta/"] > summary').click();
    await settle(page);
    assert.equal(await all.textContent(), "Expand all");
    await all.click();
    await all.click();
    await settle(page);
    assert.deepEqual(await opened(page), [], "Collapse all closes every folder");

    // A link inside the document opens the folders of the file it lands on.
    await page.frameLocator("iframe").getByRole("link", { name: "Deep" }).click();
    await page.waitForURL(`**${at(small)}notes/deep/x.md`);
    await settle(page);
    assert.deepEqual(await opened(page), ["notes/", "notes/deep/"]);
    assert.ok(await page.locator('#tp-files a[aria-current="page"]').isVisible());

    // Remembered for the tab: open Beta/ by hand, reload, and it is still open, as are the
    // current file's folders; a new tab (context) starts collapsed again.
    await page.locator('#tp-files details[data-dir="Beta/"] > summary').click();
    await settle(page);
    await page.goto(`${writer.base}${at(small)}`);
    assert.deepEqual(await opened(page), ["Beta/", "notes/", "notes/deep/"]);
    const fresh = await ctx.newPage(VIEWPORTS.desktop);
    await fresh.page.goto(`${writer.base}${at(small)}`);
    assert.deepEqual(await opened(fresh.page), []);

    // f with the current file's folder collapsed by hand opens it and focuses the file.
    await page.goto(`${writer.base}${at(small)}notes/A.md`);
    await page.locator('#tp-files details[data-dir="notes/"] > summary').click();
    await settle(page);
    await page.locator("#main").focus();
    await page.keyboard.press("f");
    assert.equal(
      await page.evaluate("document.activeElement?.dataset?.file ?? null"),
      "notes/A.md",
      "f focuses the current file",
    );

    // The filter opens every folder while it has a query and puts them back when cleared, and
    // Expand all waits for it.
    await page.goto(`${writer.base}${at(large)}`);
    await page.locator('#tp-files details[data-dir="Beta/"] > summary').click();
    await settle(page);
    const before = await opened(page);
    const filter = page.locator("#tp-files [data-filter]");
    await filter.fill("x.md");
    await settle(page);
    assert.ok(await page.locator('[data-file="notes/deep/x.md"]').isVisible());
    assert.ok(await page.locator("#tp-files [data-tree-all]").isDisabled());
    await filter.fill("");
    await settle(page);
    assert.deepEqual(await opened(page), before, "clearing the filter restores the folders");
    assert.ok(await page.locator("#tp-files [data-tree-all]").isEnabled());
    await page.reload();
    assert.deepEqual(await opened(page), before, "the filter's opened folders aren't saved");

    // Without script the folders still toggle natively, and there's no button.
    const plain = await ctx.browser.newContext({ javaScriptEnabled: false });
    try {
      const nojs = await plain.newPage();
      await nojs.goto(`${writer.base}${at(small)}`);
      assert.equal(await nojs.locator("#tp-files [data-tree-all]").isVisible(), false);
      await nojs.locator('#tp-files details[data-dir="notes/"] > summary').click();
      assert.ok(await nojs.locator('[data-file="notes/A.md"]').isVisible());
    } finally {
      await plain.close();
    }
  },
};
export default scenario;
