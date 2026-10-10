// Dialog footers sit flush with the dialog's bottom edge: no form margin under the footer strip
// (pages render without a doctype, where a form gets a 1em bottom margin). Checked on the
// collection page's dialogs and the Trash purge dialog, at desktop and phone sizes.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const gap = z.object({ id: z.string(), gap: z.number(), formMargin: z.number() }).nullable();

/** Opens dialog#id modally, scrolls it to its end, and returns the space under its footer. */
async function footerGap(page: Page, id: string): Promise<z.infer<typeof gap>> {
  return gap.parse(
    await page.evaluate(`(() => {
      const d = document.getElementById(${JSON.stringify(id)});
      const ft = d && d.querySelector(".ft");
      if (!ft) return null;
      d.showModal();
      d.scrollTop = d.scrollHeight;
      const result = {
        id: d.id,
        gap: d.getBoundingClientRect().bottom - ft.getBoundingClientRect().bottom,
        formMargin: Math.max(0, ...[...d.querySelectorAll("form")].map((f) => parseFloat(getComputedStyle(f).marginBottom))),
      };
      d.close();
      return result;
    })()`),
  );
}

const scenario: ViewerScenario = {
  name: "dialog footers sit flush with the dialog's bottom edge",
  async run(ctx) {
    const writer = await startDemoWriter();
    for (const viewport of [VIEWPORTS.desktop, { ...VIEWPORTS.phone, mobile: true }]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
      const { page } = await ctx.newPage({ ...viewport, reducedMotion: "reduce" });
      // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
      await page.goto(`${writer.base}/`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
      const href = await page.locator('main a[href^="/c/"]').first().getAttribute("href");
      assert.ok(href, "a collection link on Recent");
      const footered = `[...document.querySelectorAll("dialog.dlg[id]")].filter((d) => d.querySelector(".ft")).map((d) => d.id)`;
      let checked = 0;
      for (const path of [href, "/trash"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        await page.goto(`${writer.base}${path}`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page at a time.
        const ids = z.array(z.string()).parse(await page.evaluate(footered));
        for (const id of ids) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- One dialog at a time.
          const result = await footerGap(page, id);
          assert.ok(result, `#${id} has a footer`);
          // The dialog's 1 px border is the only thing under the footer.
          assert.ok(
            result.gap <= 1.5,
            `#${id} at ${viewport.width}: ${result.gap}px under the footer`,
          );
          assert.equal(result.formMargin, 0, `#${id} at ${viewport.width}: form bottom margin`);
          checked++;
        }
      }
      assert.ok(checked >= 4, `dialogs with a footer checked at ${viewport.width}: ${checked}`);
    }
  },
};
export default scenario;
