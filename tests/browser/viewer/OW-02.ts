// OW-02: every mutation flashes and reloads (the flash survives the reload and is read once),
// errors are sticky alert toasts with the cause, the next step, the raw text and Status, the
// toast host follows an open modal, and dialog errors stay inline. On the seeded demo writer
// (Postgres with failed #6, Q4 with one live link).
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const Q4 = "Q4 onboarding revamp";
const CHECKOUT = "Checkout flow screenshot audit";
const success = '[data-toast-slot="success"]';
const error = '[data-toast-slot="error"]';
/** The number of child nodes of the first match (an empty toast slot has none). */
const children = async (page: Page, selector: string): Promise<number> =>
  z
    .number()
    .parse(
      await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).childNodes.length`),
    );
/** The first match's computed box-shadow. */
const shadowOf = async (page: Page, selector: string): Promise<string> =>
  z
    .string()
    .parse(
      await page.evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).boxShadow`,
      ),
    );

const scenario: ViewerScenario = {
  name: "OW-02 flash toasts survive the reload; sticky error toasts; one feedback rule",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    /** The Needs attention card for Postgres (#6 failed), on Recent. */
    const attention = (page: Page) =>
      page.locator(".ag", { hasText: POSTGRES }).filter({ hasText: "#6" });
    /** Status's row for Postgres #6, in its collection's group. */
    const failedRow = (page: Page) =>
      page.locator(".sgrp", { hasText: POSTGRES }).locator(".srow", { hasText: "#6 failed" });
    /** A collection's page, through its Recent link. */
    const open = async (page: Page, title: string) => {
      await page.goto(`${base}/`);
      await page.locator("main").getByRole("link", { name: title, exact: true }).first().click();
      await page.locator("[data-viewer]").waitFor();
    };

    // An error toast is sticky, an alert, and says what to do (no mutation: the retry is blocked).
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      // Toast lifetimes are setTimeouts: the fake clock skips them instead of waiting them out.
      await page.clock.install();
      // A slow failure: Retry is disabled while it runs, so focus falls to <body> meanwhile.
      await page.route("**/api/queue/**/retry", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.abort();
      });
      await page.goto(`${base}/`);
      await attention(page).getByRole("button", { name: "Retry" }).click();
      const toast = page.locator(`${error}[role=alert]`);
      await toast.waitFor({ state: "visible" });
      assert.equal(
        (await toast.locator(".tt").textContent())?.trim(),
        `Couldn't retry #6 of “${POSTGRES}”`,
      );
      assert.ok(
        (await toast.textContent())?.includes(
          "The writer didn't answer. Check your tailnet connection, then try again.",
        ),
      );
      assert.equal((await toast.locator("code.raw").textContent())?.trim(), "Failed to fetch");
      assert.equal(
        await toast.getByRole("link", { name: "Status" }).getAttribute("href"),
        "/status",
      );
      assert.equal(await toast.locator("svg.ic").count(), 2, "alert and close icons");
      const edge = await shadowOf(page, error);
      assert.ok(edge.includes("inset"), `a red left edge: ${edge}`);
      await page.clock.fastForward(6000);
      assert.ok(await toast.isVisible(), "the error toast is still there after 6 s");
      await toast.getByRole("button", { name: "Dismiss" }).click();
      assert.equal(await children(page, error), 0);
      assert.equal(await page.locator("[data-toast]:popover-open").count(), 0);
      // Focus never came into the toast from Retry (it was disabled), yet Dismiss doesn't drop
      // it on <body>: it goes back to Retry, enabled again.
      assert.equal(
        await page.evaluate(`document.activeElement.dataset.action ?? ""`),
        "retry",
        "Dismiss after a failed Retry returns focus to Retry",
      );

      // A sticky error follows a modal opened after it (outside the modal it would be inert),
      // and leaves it again when the modal closes.
      await page.goto(`${base}/status`);
      const failed = failedRow(page);
      await failed.getByRole("button", { name: "Retry" }).click();
      await toast.waitFor({ state: "visible" });
      const confirm = page.locator("dialog#confirm");
      const drop = async () => {
        await failed.getByRole("button", { name: "Drop #6…" }).first().click();
        await confirm.waitFor({ state: "visible" });
        await page.locator("dialog#confirm[open] [data-toast]").waitFor({ state: "attached" });
      };
      await drop();
      assert.ok(await toast.isVisible(), "the error is still up over the modal");
      await confirm.locator("[data-confirm-cancel]").click();
      await confirm.waitFor({ state: "hidden" });
      await page.waitForFunction(
        `document.querySelector("[data-toast]").parentElement === document.body`,
      );
      assert.ok(await toast.isVisible(), "the error is still up after the modal closes");
      await drop();
      await toast.getByRole("button", { name: "Dismiss" }).click();
      assert.equal(await children(page, error), 0, "Dismiss works inside the modal");
      assert.ok(await confirm.isVisible(), "dismissing the toast leaves the modal open");
      await confirm.locator("[data-confirm-cancel]").click();
      await confirm.waitFor({ state: "hidden" });

      // A modal opened from a toast control (? then Escape) gives focus back to that control,
      // although the host followed the modal in and out.
      await failed.getByRole("button", { name: "Retry" }).click();
      await toast.waitFor({ state: "visible" });
      const keys = page.locator("dialog#keys");
      const retry = failed.getByRole("button", { name: "Retry" });
      await retry.focus();
      const modalFrom = async (name: string, selector: string) => {
        await page.locator(selector).focus();
        await page.keyboard.press("?");
        await keys.waitFor({ state: "visible" });
        await page.locator("dialog#keys[open] [data-toast]").waitFor({ state: "attached" });
        await page.keyboard.press("Escape");
        await keys.waitFor({ state: "hidden" });
        await page.waitForFunction(
          `document.querySelector("[data-toast]").parentElement === document.body`,
        );
        assert.ok(
          await page.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`),
          `focus is back on the toast's ${name} after the modal closes`,
        );
      };
      await modalFrom("Dismiss", `${error} [data-toast-close]`);
      await modalFrom("Status", `${error} a[href="/status"]`);
      // Dismiss from the keyboard still returns focus to where it came from, not to the closed
      // dialog's button.
      await toast.getByRole("button", { name: "Dismiss" }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await children(page, error), 0);
      assert.equal(
        await page.evaluate(`document.activeElement.dataset.action ?? ""`),
        "retry",
        "Dismiss returns focus to Retry",
      );
    }

    // Phones: the error toast spans the viewport less 16 px each side; Dismiss is a 44 px target.
    {
      const { page } = await ctx.newPage(VIEWPORTS.phone);
      await page.route("**/api/queue/**/retry", (route) => route.abort());
      await page.goto(`${base}/`);
      await attention(page).getByRole("button", { name: "Retry" }).tap();
      const toast = page.locator(error);
      await toast.waitFor({ state: "visible" });
      const box = await toast.boundingBox();
      assert.ok(box, "the error toast has a box");
      assert.equal(Math.round(box.x), 16);
      assert.equal(Math.round(box.width), 358);
      const dismiss = await toast.getByRole("button", { name: "Dismiss" }).boundingBox();
      assert.ok(dismiss && dismiss.height >= 44, `Dismiss is ${dismiss?.height}px tall`);
      const status = await toast.getByRole("link", { name: "Status" }).boundingBox();
      assert.ok(status && status.height >= 44, `Status is ${status?.height}px tall`);
      // In a bottom-sheet dialog the toast moves to the top: the sheet's actions stay tappable.
      await page.goto(`${base}/status`);
      const failed = failedRow(page);
      await failed.getByRole("button", { name: "Retry" }).tap();
      await toast.waitFor({ state: "visible" });
      await failed.getByRole("button", { name: "Drop #6…" }).first().tap();
      const confirm = page.locator("dialog#confirm");
      await confirm.waitFor({ state: "visible" });
      await page.locator("dialog#confirm[open] [data-toast]").waitFor({ state: "attached" });
      // Let the sheet finish its open transition.
      await page.waitForTimeout(400);
      for (const action of ["[data-confirm-cancel]", "[data-confirm-ok]"]) {
        const hit = await page.evaluate(`(() => {
          const button = document.querySelector("dialog#confirm ${action}");
          const { x, y, width, height } = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
        })()`);
        assert.equal(hit, true, `the error toast leaves ${action} tappable`);
      }
      assert.ok(await toast.isVisible(), "the error is still up over the sheet");
      const top = await toast.boundingBox();
      assert.ok(top && top.y < 100, `the toast sits at the top of the screen: y=${top?.y}`);
      await confirm.locator("[data-confirm-cancel]").tap();
      await confirm.waitFor({ state: "hidden" });
      // The gallery lightbox has controls along both edges: a sticky error that follows it in
      // sits below its header, so Done, Previous and Next stay tappable.
      await open(page, CHECKOUT);
      // (The gallery's link sits in the Files sheet on a phone.)
      const gallery = await page.locator('a[href*="gallery/shots/"]').first().getAttribute("href");
      assert.ok(gallery, "the collection links its gallery");
      await page.goto(new URL(gallery, page.url()).href);
      const shot = page.locator("[data-shot]").first();
      await shot.waitFor();
      await page.locator('header.bar [popovertarget="health-pop"]').tap();
      await page.locator("#health-pop").getByRole("button", { name: "Retry #6" }).tap();
      await toast.waitFor({ state: "visible" });
      await shot.tap();
      await page.locator("#lightbox[open] [data-toast]").waitFor({ state: "attached" });
      // Let the lightbox finish its open transition.
      await page.waitForTimeout(400);
      for (const control of ["[data-lbx-done]", "[data-lbx-prev]", "[data-lbx-next]"]) {
        const hit = await page.evaluate(`(() => {
          const button = document.querySelector("#lightbox ${control}");
          const { x, y, width, height } = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
        })()`);
        assert.equal(hit, true, `the error toast leaves the lightbox's ${control} tappable`);
      }
      assert.ok(await toast.isVisible(), "the error is still up over the lightbox");
      await page.locator("#lightbox [data-lbx-done]").tap();
      await page.locator("#lightbox").waitFor({ state: "hidden" });
      // Back on the collection page the toast sits above the tab bar, which stays tappable.
      await page.waitForFunction(
        `document.querySelector("[data-toast]").parentElement === document.body`,
      );
      assert.ok(await toast.isVisible(), "the error is still up on the collection page");
      const tabs = z.array(z.boolean()).parse(
        await page.evaluate(`[...document.querySelectorAll(".tabbar a, .tabbar button")]
          .filter((tab) => tab.checkVisibility())
          .map((tab) => {
            const { x, y, width, height } = tab.getBoundingClientRect();
            return tab.contains(document.elementFromPoint(x + width / 2, y + height / 2));
          })`),
      );
      assert.ok(tabs.length >= 3, `the tab bar shows: ${tabs.length} tabs`);
      assert.ok(
        tabs.every(Boolean),
        `the error toast leaves every tab tappable: ${JSON.stringify(tabs)}`,
      );
    }

    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.clock.install();

    // Drop's confirmation names the revision and the collection (Cancel: nothing changes).
    await page.goto(`${base}/status`);
    await failedRow(page).getByRole("button", { name: "Drop #6…" }).click();
    const confirm = page.locator("dialog#confirm");
    await confirm.waitFor({ state: "visible" });
    assert.equal(
      (await confirm.locator("[data-confirm-band-title]").textContent())?.trim(),
      `Drop #6 from “${POSTGRES}”?`,
    );
    await confirm.locator("[data-confirm-cancel]").click();
    await confirm.waitFor({ state: "hidden" });

    // An inline dialog error stays inline: no error toast.
    await open(page, "HTTP API rate limiting plan");
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .locator("#more-menu")
      .getByRole("menuitem", { name: /^Rename/ })
      .click();
    // NAV-11: Rename… opens the Collection details dialog.
    const rename = page.locator("dialog#details");
    await rename.waitFor({ state: "visible" });
    await rename.locator("input[name=title]").fill("   ");
    await rename.locator("[data-details-save]").click();
    await page.waitForFunction(
      `document.querySelector("dialog#details [data-form-error]").textContent === "Enter a title"`,
    );
    assert.equal(await children(page, error), 0);
    await rename.locator('[command="close"]').click();
    await rename.waitFor({ state: "hidden" });

    // Replacing a toast whose Dismiss has focus moves focus to the new Dismiss, not to <body>.
    await page.mouse.move(0, 0);
    await page.keyboard.press("c");
    await page.locator(success).waitFor({ state: "visible" });
    await page.locator(`${success} [data-toast-close]`).focus();
    await page.evaluate(`window.ow02Old = document.activeElement`);
    await page.keyboard.press("c");
    await page.waitForFunction(`document.activeElement !== window.ow02Old`);
    assert.ok(
      await page.evaluate(
        `document.activeElement.matches(${JSON.stringify(`${success} [data-toast-close]`)})`,
      ),
      "focus moved to the replacement toast's Dismiss",
    );
    // A success that times out inside a modal goes back to <body> when the modal closes.
    await page.evaluate(`(() => {
      const dialog = document.createElement("dialog");
      dialog.id = "ow02-modal";
      document.body.append(dialog);
      dialog.showModal();
    })()`);
    await page.locator("dialog#ow02-modal [data-toast]").waitFor({ state: "attached" });
    await page.clock.fastForward(3000);
    await page.waitForFunction(
      `!document.querySelector(${JSON.stringify(success)}).hasChildNodes()`,
      undefined,
      { timeout: 4500 },
    );
    await page.evaluate(`document.querySelector("dialog#ow02-modal").close()`);
    await page.waitForFunction(
      `document.querySelector("[data-toast]").parentElement === document.body`,
    );
    await page.evaluate(`document.querySelector("dialog#ow02-modal").remove()`);

    // A toast inside a modal: the host moves into the open share dialog, then back to body.
    await page.locator("header.bar .share[commandfor=share]").click();
    const share = page.locator("dialog#share");
    await share.waitFor({ state: "visible" });
    await share.locator("[data-share-submit]").click();
    await share.locator("[data-share-copy]").waitFor({ state: "visible" });
    await share.locator("[data-share-copy]").click();
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      "Copied public link",
    );
    assert.equal(await page.locator("dialog#share[open] [data-toast]").count(), 1);
    // Closing the share dialog after a link exists navigates to the Links tab, so record where
    // the host is when the dialog's close event fires (after the toast has moved out).
    await page.evaluate(`document.querySelector("dialog#share").addEventListener("close", () => {
      const host = document.querySelector("[data-toast]");
      sessionStorage.setItem("ow02:host", String(host.parentElement === document.body && !host.closest("dialog")));
    }, { once: true })`);
    await page.keyboard.press("Escape");
    await page.waitForURL((url) => url.searchParams.get("panel") === "links");
    await share.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(`sessionStorage.getItem("ow02:host")`),
      "true",
      "the host left the share dialog when it closed",
    );

    // Keyboard Dismiss on the error, reached from a success toast that has since timed out,
    // returns focus to where it was before the toasts (not to <body>).
    await open(page, POSTGRES);
    await page.route("**/api/queue/**/retry", (route) => route.abort());
    const origin = page.locator('[data-action="retry"]:visible').first();
    await origin.click();
    await page.locator(error).getByRole("button", { name: "Dismiss" }).waitFor();
    await origin.focus();
    await page.keyboard.press("c");
    await page.locator(success).getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.ok(
      await page.evaluate(`document.activeElement.matches('${error} [data-toast-close]')`),
      "Tab reaches the error's Dismiss",
    );
    await page.clock.fastForward(3000);
    await page.waitForFunction(
      `!document.querySelector(${JSON.stringify(success)}).hasChildNodes()`,
      undefined,
      { timeout: 4500 },
    );
    await page.keyboard.press("Enter");
    assert.equal(await children(page, error), 0);
    assert.equal(
      await page.evaluate(`document.activeElement.dataset.action ?? ""`),
      "retry",
      "Dismiss returns focus to Retry, past the success toast that's gone",
    );
    // A sticky error that follows a tall modal in sits at the top, at every width: the share
    // dialog's footer actions (at the viewport's bottom edge) stay clickable.
    await origin.click();
    await page.locator(error).getByRole("button", { name: "Dismiss" }).waitFor();
    await page.locator("header.bar .share[commandfor=share]").click();
    await page.locator("dialog#share[open] [data-toast]").waitFor({ state: "attached" });
    // Let the dialog finish its open transition.
    await page.waitForTimeout(400);
    for (const action of ["[data-share-submit]", "button[formmethod=dialog][value=cancel]"]) {
      const hit = await page.evaluate(`(() => {
        const button = document.querySelector("dialog#share [data-share-step=create] ${action}");
        const { x, y, width, height } = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      })()`);
      assert.equal(hit, true, `the error toast leaves the share dialog's ${action} clickable`);
    }
    assert.ok(await page.locator(error).isVisible(), "the error is still up over the dialog");
    await page.keyboard.press("Escape");
    await page.locator("dialog#share").waitFor({ state: "hidden" });
    await page.locator(error).getByRole("button", { name: "Dismiss" }).click();
    assert.equal(await children(page, error), 0);
    await page.unroute("**/api/queue/**/retry");

    // The flash survives the reload, then it's gone.
    await page.goto(`${base}/`);
    await Promise.all([
      page.waitForEvent("load"),
      attention(page).getByRole("button", { name: "Retry" }).click(),
    ]);
    const flashed = page.locator(`${success}[role=status]`);
    await flashed.waitFor({ state: "visible" });
    assert.equal(
      (await flashed.locator(".tt").textContent())?.trim(),
      `Retrying #6 of “${POSTGRES}”`,
    );
    assert.equal(await flashed.locator("svg.ic").count(), 2, "check and close icons");
    // Its focus ring shows on the dark toast (the global ring is the toast's own colour).
    await flashed.getByRole("button", { name: "Dismiss" }).focus();
    const ring = z
      .object({ visible: z.boolean(), outline: z.string(), background: z.string() })
      .parse(
        await page.evaluate(`(() => {
          const button = document.activeElement;
          return {
            visible: button.matches("[data-toast-close]:focus-visible"),
            outline: getComputedStyle(button).outlineColor,
            background: getComputedStyle(document.querySelector(${JSON.stringify(success)})).backgroundColor,
          };
        })()`),
      );
    assert.ok(ring.visible, "Dismiss shows its focus ring");
    assert.notEqual(ring.outline, ring.background, "the focus ring contrasts with the toast");
    // Focus and the pointer hold a success toast past its 3 s; it hides once they leave.
    await page.evaluate(`document.activeElement.blur()`);
    await flashed.hover();
    await page.clock.fastForward(3500);
    assert.ok(await flashed.isVisible(), "a hovered success toast stays up");
    await page.mouse.move(0, 0);
    await page.clock.fastForward(3000);
    await page.waitForFunction(
      `!document.querySelector(${JSON.stringify(success)}).hasChildNodes()`,
      undefined,
      { timeout: 4500 },
    );
    await page.reload();
    await page.waitForTimeout(300);
    assert.equal(await children(page, success), 0);

    // Move to Trash lands on /trash with the pinned flash and the moved row highlighted.
    await open(page, Q4);
    const id = await page.locator("[data-viewer]").getAttribute("data-collection-id");
    assert.ok(id, "Q4 has a collection id");
    assert.equal(await page.locator("[data-viewer]").getAttribute("data-links"), "1");
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .locator("#more-menu")
      .getByRole("menuitem", { name: /^Move to Trash/ })
      .click();
    await confirm.waitFor({ state: "visible" });
    await confirm.locator("[data-confirm-ok]").click();
    await page.waitForURL((url) => url.pathname === "/trash");
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      `Moved “${Q4}” to Trash`,
    );
    assert.equal(
      (await page.locator(`${success} .td`).textContent())?.trim(),
      "Its 1 public link is paused, not revoked. Restore asks whether to turn it back on.",
    );
    assert.equal(await page.locator(success).getByRole("button", { name: /Undo/ }).count(), 0);
    // Dismiss reached first on the page that just loaded (no control had focus yet) doesn't drop
    // focus on <body>: it goes to the main content.
    await page.locator(`${success} [data-toast-close]`).focus();
    await page.keyboard.press("Enter");
    assert.equal(await children(page, success), 0);
    assert.equal(
      await page.evaluate(`document.activeElement.id`),
      "main",
      "Dismiss of a fresh flash puts focus on the main content",
    );
    const row = `[data-flash-target="${id}"]`;
    assert.equal(await page.locator(`${row}.flashed`).count(), 1);
    const shadow = await shadowOf(page, row);
    assert.ok(shadow.includes("inset") && shadow.includes("3px 0px 0px"), shadow);
    // Forced colours drop the shadow; the moved row keeps an outline instead.
    await page.emulateMedia({ forcedColors: "active" });
    const outline = z
      .string()
      .parse(
        await page.evaluate(
          `(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(row)})); return s.outlineStyle + " " + s.outlineWidth; })()`,
        ),
      );
    assert.equal(outline, "solid 3px", "the moved row is outlined in forced colours");
    await page.emulateMedia({ forcedColors: "none" });
    await page.reload();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".flashed").count(), 0);
    assert.equal(await children(page, success), 0);
  },
};
export default scenario;
