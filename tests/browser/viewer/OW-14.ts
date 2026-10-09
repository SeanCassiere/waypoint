// OW-14: a purge you can follow. Part A (the shared writer, which never commits, so every purge is
// the never-synced `{ purged: true }` branch): the purge dialog — what is erased, what happens
// when, the title and public ID with Copy buttons, loose matching — and its flash; on a phone the
// dialog is a full-width sheet with a reachable footer and 44 px Copy buttons. Part B (the demo
// writer with WAYPOINT_DEMO_PURGING=1, whose committer is stopped): a queued purge stays at step 1
// under Being purged, links to its Status row, and a purge at step 3 still names the collection.
import type { Locator, Page } from "playwright";
import { z } from "zod";

import { assert, axe, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const success = '[data-toast-slot="success"]';
const LEAKED = "Leaked .env in run output (do not share)";
const INCIDENT = "Incident 4411 raw logs";
/** A collection's public ID, from its write-result URL (/c/<pub>/…). */
const pubOf = (url: string) => new URL(url).pathname.split("/")[2] ?? "";
const flag = z.boolean();
const text = async (locator: Locator) => (await locator.textContent())?.replace(/\s+/g, " ").trim();
/** Runs `action`, then waits for the page to finish loading again (purge reloads or navigates). */
async function reloadedBy(page: Page, action: () => Promise<void>): Promise<void> {
  const loaded = page.waitForEvent("load");
  await action();
  await loaded;
}
// The sections are labelled by their headings (#trash-purging, #trash-in).
const PURGING = 'section[aria-labelledby="trash-purging"]';
const IN_TRASH = 'section[aria-labelledby="trash-in"]';
const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const scenario: ViewerScenario = {
  name: "OW-14 a purge you can follow on Trash and Status; the purge dialog takes the title or public ID",
  async run(ctx) {
    const { writer } = ctx;
    const { base } = writer;
    /** A pending collection with one file and one labelled link, moved to Trash. */
    const trashed = async (title: string) => {
      const created = await writer.api("/api/collections", {
        title,
        files: [await writer.write("index.md", `# ${title}\n`)],
      });
      const link = await writer.fetch(`/api/collections/${created.collection_id}/share-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Vendor debug" }),
      });
      assert.ok(link.ok, `link: ${link.status}`);
      const gone = await writer.fetch(`/api/collections/${created.collection_id}`, {
        method: "DELETE",
      });
      assert.equal(gone.status, 200);
      return pubOf(created.url);
    };

    // Part A: the dialog, on the shared writer (never-synced purge).
    const p = await trashed("P");
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      const confirm = page.locator("dialog#confirm");
      const ok = confirm.locator("[data-confirm-ok]");
      const hint = confirm.locator("[data-confirm-hint]");
      const input = confirm.locator("#confirm-input");
      await page.goto(`${base}/trash`);
      const row = page.locator(`li.item[data-pub="${p}"]`);
      await row.getByRole("button", { name: "Purge…" }).click();
      await confirm.waitFor({ state: "visible" });
      assert.equal(
        await text(confirm.locator("[data-confirm-band-title]")),
        "Permanently purge “P”?",
      );
      assert.deepEqual(
        await Promise.all((await confirm.locator(".sees .row").all()).map((line) => text(line))),
        [
          "P: 1 revision, 1 file",
          "Its public link “Vendor debug”, revoked the moment you confirm",
          "Files no other collection uses",
        ],
      );
      assert.equal(await text(confirm.locator(".when h3")), "What happens when");
      const when = await Promise.all(
        (await confirm.locator(".when li").all()).map((line) => text(line)),
      );
      assert.equal(when.length, 3);
      assert.equal(when[0], "Now: the link is revoked and the collection can't be restored.");
      assert.ok(when[1]?.startsWith("In the background: the bucket, then the database"), when[1]);
      assert.ok(when[2]?.startsWith("Until it finishes it stays in Trash under Being purged"));
      assert.equal(
        await text(confirm.locator("label[for=confirm-input]")),
        "To confirm, type the title or the public ID",
      );
      const copyTitle = confirm.getByRole("button", { name: "Copy title", exact: true });
      const copyPub = confirm.getByRole("button", { name: "Copy public ID", exact: true });
      assert.equal(await copyTitle.count(), 1);
      assert.equal(await copyPub.count(), 1);
      assert.equal(await text(confirm.locator("[data-confirm-values] dd.v.mono")), p);
      assert.equal(await ok.isDisabled(), true);
      assert.equal(await ok.getAttribute("aria-disabled"), "true");
      assert.equal(await text(ok), "Purge permanently");
      assert.ok(flag.parse(await page.evaluate(`document.activeElement?.id === "confirm-input"`)));
      assert.equal(
        await text(hint),
        "Paste or type either one. Case and extra spaces don't matter.",
      );

      // Copy public ID: the clipboard, the button's Copied state and a polite status in the modal.
      // Copied is a colour change only: the button keeps its size while pressed and after.
      const before = box.parse(await copyPub.boundingBox());
      await copyPub.hover();
      await page.mouse.down();
      const pressed = box.parse(await copyPub.boundingBox());
      assert.ok(Math.abs(pressed.width - before.width) < 0.5, `pressed ${pressed.width}`);
      await page.mouse.up();
      assert.ok((await text(copyPub))?.includes("Copied"), await text(copyPub));
      const copied = box.parse(await copyPub.boundingBox());
      assert.ok(Math.abs(copied.width - before.width) < 0.5, `copied ${copied.width}`);
      assert.equal(await page.evaluate("navigator.clipboard.readText()"), p);
      await confirm.locator('[role="status"]', { hasText: "Copied public ID" }).waitFor();

      await input.fill("leaked");
      assert.equal(await text(hint), "Doesn't match the title or the public ID yet.");
      assert.equal(await ok.isDisabled(), true);
      // The hint is a live region: more typing that still matches nothing leaves it untouched.
      await page.evaluate(`(() => {
        const hint = document.querySelector("#confirm-hint");
        window.__hintMutations = 0;
        new MutationObserver((records) => { window.__hintMutations += records.length; })
          .observe(hint, { childList: true, characterData: true, subtree: true });
      })()`);
      await input.pressSequentially(" env");
      assert.equal(
        z.number().parse(await page.evaluate("window.__hintMutations")),
        0,
        "the mismatch hint isn't rewritten on every keystroke",
      );
      await input.fill(p.toUpperCase());
      assert.equal(await text(hint), "Matches the public ID");
      assert.equal(await ok.isDisabled(), false);
      assert.equal(await ok.getAttribute("aria-disabled"), "false");
      await input.fill("   p  ");
      assert.equal(await text(hint), "Matches the title");
      await input.fill("");
      assert.equal(await ok.isDisabled(), true, "clearing disables it again");
      await input.fill("  P ");
      await reloadedBy(page, () => ok.click());
      await page.locator(success).waitFor({ state: "visible" });
      assert.equal(
        await text(page.locator(`${success} .tt`)),
        "Purged “P”. Nothing had reached the cloud.",
      );
      assert.equal(await row.count(), 0, "P is gone");
    }

    // Phone: a full-width sheet, the footer within reach while the body scrolls, 44 px Copy buttons.
    const q = await trashed("Q phone purge");
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      const confirm = page.locator("dialog#confirm");
      await page.goto(`${base}/trash`);
      await page
        .locator(`li.item[data-pub="${q}"]`)
        .getByRole("button", { name: "Purge…" })
        .click();
      await confirm.waitFor({ state: "visible" });
      const sheet = box.parse(await confirm.boundingBox());
      assert.equal(Math.round(sheet.x), 0);
      assert.equal(Math.round(sheet.width), 390);
      const ok = confirm.locator("[data-confirm-ok]");
      for (const to of ["top", "bottom"]) {
        await page.evaluate(
          `(() => { const d = document.querySelector("#confirm"); d.scrollTop = ${to === "top" ? "0" : "d.scrollHeight"}; })()`,
        );
        const at = box.parse(await ok.boundingBox());
        assert.ok(
          at.y >= 0 && at.y + at.height <= 844,
          `Purge permanently in view (${to}): ${at.y}`,
        );
      }
      for (const name of ["Copy title", "Copy public ID"]) {
        const copy = box.parse(
          await confirm.getByRole("button", { name, exact: true }).boundingBox(),
        );
        assert.ok(copy.height >= 44, `${name} is ${copy.height} px tall`);
      }
      await confirm.locator("[data-confirm-cancel]").click();
      await confirm.waitFor({ state: "hidden" });
    }

    // Part B: the demo writer, whose stopped committer keeps purges where they are.
    const demo = await startDemoWriter({ env: { WAYPOINT_DEMO_PURGING: "1" } });
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const confirm = page.locator("dialog#confirm");
    await page.goto(`${demo.base}/trash`);
    const leakedRow = page.locator(`${IN_TRASH} li.item.trash`, { hasText: LEAKED });
    const leaked = (await leakedRow.getAttribute("data-pub")) ?? "";
    assert.ok(leaked, "Leaked is in Trash");
    await leakedRow.getByRole("button", { name: "Purge…" }).click();
    await confirm.waitFor({ state: "visible" });
    await confirm.locator("#confirm-input").fill(leaked);
    await reloadedBy(page, () => confirm.locator("[data-confirm-ok]").click());
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      await text(page.locator(`${success} .tt`)),
      `Purging “${LEAKED}”. Its 1 public link was revoked just now. Progress is listed here ↑`,
    );
    const purging = page.locator(`${PURGING} li#purge-${leaked}`);
    assert.equal(await purging.count(), 1);
    assert.equal(await purging.getAttribute("aria-busy"), "true");
    assert.ok((await text(purging.locator(".chip")))?.includes("Purging · step 1 of 3"));
    assert.equal(await purging.locator("a, button").count(), 1, "one control");
    assert.equal(await page.locator(IN_TRASH).count(), 0, "nothing else is in Trash");
    assert.deepEqual(
      (
        await axe(page, { rules: ["nested-interactive", "aria-allowed-attr", "list", "listitem"] })
      ).map((violation) => violation.id),
      [],
      "axe on /trash",
    );
    const incidentId =
      (await page
        .locator(`${PURGING} li.item.purging`, { hasText: INCIDENT })
        .getAttribute("id")) ?? "";
    const incident = incidentId.replace(/^purge-/, "");
    assert.ok(incident, "Incident is being purged");

    await purging.getByRole("link", { name: "Details on Status" }).click();
    await page.waitForURL(`${demo.base}/status#purge-${leaked}`);
    assert.equal(await page.locator(`#purge-${leaked}`).count(), 1);
    const main = (await text(page.locator("main"))) ?? "";
    assert.ok(main.includes("Waiting, not failing."), "the grace wait is a wait");
    assert.ok(main.includes("bucket file deletes queued: 4 (all collections)"));
    assert.deepEqual(
      (
        await axe(page, { rules: ["nested-interactive", "aria-allowed-attr", "list", "listitem"] })
      ).map((violation) => violation.id),
      [],
      "axe on /status",
    );

    const gone = await page.goto(`${demo.base}/c/${incident}/`);
    assert.equal(gone?.status(), 404);
    assert.ok((await text(page.locator("main")))?.includes(`“${INCIDENT}” was purged.`));
    assert.equal(
      await page
        .locator("main")
        .getByRole("link", { name: "Trash", exact: true })
        .getAttribute("href"),
      "/trash",
    );
  },
};
export default scenario;
