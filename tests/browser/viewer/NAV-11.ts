// NAV-11: About this collection at the foot of the Files tab, and one Collection details dialog:
// Save enables after an edit, Enter never closes it unsaved, projects and tags are suggested from
// other collections, the JSON error is the browser's own and nothing is sent, a save flashes and
// reloads, it opens without script with Save disabled, and on phones its fields are 44 px.
// Runs alone, on its own writer (sync off).
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";

import { assert, startWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const bool = (page: Page, expression: string): Promise<boolean> =>
  page.evaluate(expression).then((value) => z.boolean().parse(value));
const strings = (page: Page, expression: string): Promise<string[]> =>
  page.evaluate(expression).then((value) => z.array(z.string()).parse(value));
const focused = (page: Page, selector: string): Promise<unknown> =>
  page.waitForFunction(
    `document.activeElement && document.activeElement.matches(${JSON.stringify(selector)})`,
  );
/** The card's token texts (Project, Tags, Written on). */
const tokens = (page: Page): Promise<string[]> =>
  strings(
    page,
    `[...document.querySelectorAll("#tp-files .about a.tok")].map((a) => a.textContent)`,
  );
const INVALID = '{"a": 1 "b": 2}';
// Values with no spaces, longer than any of the three widths (they must wrap, not overflow).
const LONG_PROJECT = `long-project-${"p".repeat(90)}`;
const LONG_TAG = `long-tag-${"t".repeat(90)}`;
const LONG_HOST = `long-host-${"h".repeat(90)}`;
/** The open dialog, the Files tab and the card when shown, each wider than its box. */
const overflowing = (page: Page): Promise<string[]> =>
  strings(
    page,
    `[...document.querySelectorAll("dialog#details[open], #tp-files, #tp-files .about")]
      .filter((e) => e.getClientRects().length > 0 && e.scrollWidth > e.clientWidth)
      .map((e) => (e.id || e.className) + " " + e.scrollWidth + ">" + e.clientWidth)`,
  );
/** Waits until the element and its subtree have finished animating (the panel sheet slide and the
 *  dialog's open transition move their boxes by fractions of a pixel while they run). */
const settled = (page: Page, selector: string): Promise<unknown> =>
  page.waitForFunction(
    `document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).length === 0`,
  );

const scenario: ViewerScenario = {
  name: "NAV-11 collection details: the About card in Files, one details dialog, Save after an edit",
  async run(ctx) {
    const writer = await startWriter();
    const { base } = writer;
    const made = await writer.api("/api/collections", {
      title: "Webhook idempotency research",
      metadata: { project: "webhooks", tags: ["research"], source_host: "devbox" },
      files: [
        await writer.write("index.md", "# Webhook idempotency research\n"),
        await writer.write("sources.md", "# Sources\n"),
      ],
    });
    await writer.api("/api/collections", {
      title: "Postgres 17 upgrade runbook",
      metadata: { project: "infra", tags: ["postgres"] },
      files: [await writer.write("index.md", "# Postgres\n")],
    });
    const long = await writer.api("/api/collections", {
      title: "Long values",
      metadata: { project: LONG_PROJECT, tags: [LONG_TAG], source_host: LONG_HOST },
      files: [await writer.write("index.md", "# Long\n")],
    });
    const url = `${base}${new URL(made.latest_url).pathname}`;
    const longUrl = `${base}${new URL(long.latest_url).pathname}`;

    const desktop = await ctx.newPage(VIEWPORTS.desktop);
    const { page } = desktop;
    let patches = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/api/collections/")) patches++;
    });
    await page.goto(url);
    const about = page.locator("#tp-files .about");
    await about.scrollIntoViewIfNeeded();
    assert.ok(await about.isVisible(), "the card shows in the Files tab");
    assert.ok(
      await bool(
        page,
        `(() => { const legend = document.querySelector("#tp-files .legend");
          const about = document.querySelector("#tp-files .about");
          return !!(legend.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING)
            && document.querySelector("#tp-files").lastElementChild === about; })()`,
      ),
      "the card comes after the legend, last in the tab",
    );
    assert.ok(await about.locator(".idcopy").isVisible(), "script shows the copy button");
    assert.deepEqual(await tokens(page), ["webhooks", "research", "devbox"]);

    // Edit: focus in Project, Save disabled until an edit.
    const dialog = page.locator("dialog#details");
    const save = dialog.locator("[data-details-save]");
    const tags = dialog.locator("input[name=tags]");
    const edit = about.getByRole("button", { name: "Edit" });
    await edit.click();
    await dialog.waitFor({ state: "visible" });
    await focused(page, "#details input[name=project]");
    assert.equal(await dialog.locator("[data-nojs]").count(), 0, "script removes the note");
    assert.ok(await save.isDisabled(), "Save starts disabled");
    await tags.click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    assert.ok(await save.isEnabled(), "Save enables after an edit");
    await page.keyboard.press("Backspace");
    assert.equal(await tags.inputValue(), "research");

    // Suggestions from /api/facets: the other collection's project and tag.
    await page.waitForFunction(`document.querySelectorAll("#details-projects option").length >= 1`);
    assert.ok(
      (
        await strings(
          page,
          `[...document.querySelectorAll("#details-projects option")].map((o) => o.value)`,
        )
      ).includes("infra"),
      "the datalist offers infra",
    );
    const suggest = dialog.locator("[data-tag-suggest]");
    await suggest.waitFor({ state: "visible" });
    assert.ok((await suggest.textContent())?.includes("Used on other collections:"));
    const postgres = suggest.getByRole("button", { name: "+ postgres" });
    assert.equal(await suggest.getByRole("button", { name: "+ research" }).count(), 0);
    await postgres.click();
    assert.ok((await tags.inputValue()).endsWith(", postgres"), await tags.inputValue());
    assert.equal(await postgres.count(), 0, "the added tag's button goes");

    // Invalid JSON: the browser's own message, aria-invalid, nothing sent, still open.
    await dialog.locator("details.othermeta > summary").click();
    const extra = dialog.locator("textarea[name=extra]");
    await extra.fill(INVALID);
    await save.click();
    const jsonError = dialog.locator("[data-json-error]");
    await page.waitForFunction(
      `document.querySelector("#details [data-json-error]").textContent !== ""`,
    );
    const expected = z
      .string()
      .parse(
        await page.evaluate(
          `(() => { try { JSON.parse(${JSON.stringify(INVALID)}); return ""; } catch (e) { return e.message; } })()`,
        ),
      );
    assert.ok(expected.length > 0);
    assert.equal(await jsonError.textContent(), expected);
    assert.equal(await extra.getAttribute("aria-invalid"), "true");
    assert.equal(await dialog.locator("[data-form-error]").textContent(), "");
    assert.equal(patches, 0, "no PATCH for invalid JSON");
    assert.ok(await dialog.isVisible(), "the dialog stays open");
    await focused(page, "#details textarea[name=extra]");
    // Editing the JSON clears its error.
    await extra.fill("{}");
    assert.equal(await extra.getAttribute("aria-invalid"), null);
    assert.equal(await jsonError.textContent(), "");

    // Save: one PATCH, then the page reloads with the flash.
    const success = page.locator('[data-toast-slot="success"]');
    let loaded = page.waitForEvent("load");
    await save.click();
    await loaded;
    assert.equal(patches, 1);
    await success.filter({ hasText: "Details saved" }).waitFor({ state: "visible" });
    assert.deepEqual(await tokens(page), ["webhooks", "research", "postgres", "devbox"]);

    // Enter with Save disabled does nothing; Cancel closes without saving.
    await about.getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor({ state: "visible" });
    assert.ok(await save.isDisabled(), "Save is disabled again after the reload");
    await dialog.locator("input[name=title]").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.ok(await dialog.isVisible(), "Enter didn't close the dialog");
    assert.equal(patches, 1, "Enter sent nothing");
    // An edit that's cancelled is dropped: the next opening starts from the saved values.
    await page.keyboard.type(" draft");
    assert.ok(await save.isEnabled());
    await dialog.locator('[command="close"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(patches, 1, "Cancel sent nothing");
    await focused(page, "#tp-files .about .ah button");
    await about.getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor({ state: "visible" });
    assert.equal(
      await dialog.locator("input[name=title]").inputValue(),
      "Webhook idempotency research",
      "Cancel dropped the edit",
    );
    assert.ok(await save.isDisabled(), "Save is disabled again after Cancel");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // Enter in Tags after an edit saves.
    await about.getByRole("button", { name: "Edit" }).click();
    await dialog.waitFor({ state: "visible" });
    await tags.click();
    await page.keyboard.press("End");
    await page.keyboard.type(", ops");
    assert.ok(await save.isEnabled());
    loaded = page.waitForEvent("load");
    await page.keyboard.press("Enter");
    await loaded;
    assert.equal(patches, 2, "one PATCH for Enter");
    await success.filter({ hasText: "Details saved" }).waitFor({ state: "visible" });
    assert.ok((await tokens(page)).includes("ops"), "the card lists ops");

    // More → Rename… focuses Title. The flash is dismissed first: opening any dialog from the
    // More menu while a toast is up throws in toast.ts's raise() (showPopover during another show
    // operation; Keyboard shortcuts… does it too), which isn't this item's code.
    await success.locator("[data-toast-close]").click();
    await success.filter({ hasText: "Details saved" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .locator("#more-menu")
      .getByRole("menuitem", { name: /^Rename/ })
      .click();
    await dialog.waitFor({ state: "visible" });
    await focused(page, "#details input[name=title]");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // Without script: the dialog opens natively, Save is disabled with the note, Enter does
    // nothing, Cancel closes; no copy button and no suggestions.
    const noScript = await ctx.browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const plain = await noScript.newPage();
      await plain.goto(url);
      const plainDialog = plain.locator("dialog#details");
      assert.equal(await plain.locator("#tp-files .about .idcopy").isVisible(), false);
      await plain.locator("#tp-files .about").getByRole("button", { name: "Edit" }).click();
      await plainDialog.waitFor({ state: "visible" });
      assert.ok(await plainDialog.locator("[data-details-save]").isDisabled());
      const note = plainDialog.locator("[data-nojs]");
      assert.ok(await note.isVisible(), "the no-script note shows");
      assert.equal(
        (await note.textContent())?.trim(),
        "Saving needs JavaScript, which isn't running on this page.",
      );
      assert.equal(await plainDialog.locator("[data-tag-suggest]").isVisible(), false);
      await plainDialog.locator("input[name=title]").focus();
      await plain.keyboard.press("Enter");
      await plain.waitForTimeout(300);
      assert.ok(await plainDialog.isVisible(), "Enter didn't close it without script");
      assert.equal(plain.url(), url);
      await plainDialog.locator('[command="close"]').click();
      await plainDialog.waitFor({ state: "hidden" });
    } finally {
      await noScript.close();
      // Each part closes its contexts once done, so no more than two are open at a time.
      await desktop.context.close();
    }

    // Phone, touch: the card is the foot of the Files sheet; 32 px tokens; 44 px fields.
    const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    await phone.page.goto(url);
    await phone.page.locator(".tabbar").getByRole("button", { name: "Files" }).click();
    const sheet = phone.page.locator("#tp-files");
    await sheet.waitFor({ state: "visible" });
    await settled(phone.page, "#panel");
    const phoneAbout = sheet.locator(".about");
    await phoneAbout.scrollIntoViewIfNeeded();
    assert.ok(await phoneAbout.isVisible(), "the card shows in the Files sheet");
    assert.ok(
      await bool(
        phone.page,
        `document.querySelector("#tp-files").lastElementChild === document.querySelector("#tp-files .about")`,
      ),
    );
    for (const token of await phoneAbout.locator(".tok").all()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One token at a time.
      const height = (await token.boundingBox())?.height ?? 0;
      assert.ok(Math.abs(height - 32) <= 1, `a ${height}px token`);
    }
    await phoneAbout.getByRole("button", { name: "Edit" }).click();
    const phoneDialog = phone.page.locator("dialog#details");
    await phoneDialog.waitFor({ state: "visible" });
    await settled(phone.page, "dialog#details");
    for (const input of await phoneDialog.locator("input").all()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One field at a time.
      const height = (await input.boundingBox())?.height ?? 0;
      assert.ok(height >= 44, `a ${height}px field`);
    }
    const saveHeight = (await phoneDialog.locator("[data-details-save]").boundingBox())?.height;
    assert.ok((saveHeight ?? 0) >= 44, `a ${String(saveHeight)}px Save`);
    // A long suggested tag (the long collection's) wraps in the button.
    await phoneDialog
      .locator("[data-tag-suggest]")
      .getByRole("button", { name: `+ ${LONG_TAG}` })
      .waitFor({ state: "visible" });
    assert.deepEqual(await overflowing(phone.page), [], "a long suggestion fits at 390");
    await phone.context.close();

    // Long values wrap inside the card and the dialog at all three widths.
    const longValues = async (
      label: string,
      open: (at: Page) => Promise<void>,
      { context, page: at }: { context: BrowserContext; page: Page },
    ) => {
      await at.goto(longUrl);
      await open(at);
      await settled(at, "#panel");
      const longAbout = at.locator("#tp-files .about");
      await longAbout.scrollIntoViewIfNeeded();
      assert.deepEqual(await tokens(at), [LONG_PROJECT, LONG_TAG, LONG_HOST], label);
      assert.deepEqual(await overflowing(at), [], `the card fits at ${label}`);
      await longAbout.getByRole("button", { name: "Edit" }).click();
      const longDialog = at.locator("dialog#details");
      await longDialog.waitFor({ state: "visible" });
      await settled(at, "dialog#details");
      assert.ok(
        (await longDialog.locator("#details-project-hint").textContent())?.includes(
          `project:${LONG_PROJECT}`,
        ),
        label,
      );
      assert.deepEqual(await overflowing(at), [], `the dialog fits at ${label}`);
      await context.close();
    };
    await longValues("1280", () => Promise.resolve(), await ctx.newPage(VIEWPORTS.desktop));
    await longValues(
      "820",
      (at) => at.locator("a.pill.file").tap(),
      await ctx.newPage(VIEWPORTS.tablet),
    );
    await longValues(
      "390",
      (at) => at.locator(".tabbar").getByRole("button", { name: "Files" }).click(),
      await ctx.newPage({ ...VIEWPORTS.phone, mobile: true }),
    );
  },
};
export default scenario;
