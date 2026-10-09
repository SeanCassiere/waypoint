// OW-07: every Restore… opens one dialog. With paused links it lists them and waits for a choice
// (nothing checked, Restore disabled, focus on Cancel); "Revoke" revokes, then undeletes; "Turn back
// on" only undeletes. The in-Trash page's button and its ⋯ menu carry the same data as the Trash
// row. The shared writer never commits, so these collections stay pending: their links are paused
// by FC1's trashedPending rule, the same rows trashLinks() lists for committed collections.
import type { Locator, Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const WORD = "owsevenwombat";
const A = `${WORD} leaked env`;
const B = `${WORD} scratch run`;
const C = `${WORD} vendor notes`;
const D = `${WORD} long label`;
const E = `${WORD} closed after failure`;
const F = `${WORD} forced shut`;
const G = `${WORD} opened next`;
/** The longest label the API accepts, as one unbroken word: it must wrap or stop, never widen. */
const LONG = `vendor-${"q".repeat(193)}`;
const success = '[data-toast-slot="success"]';
/** A collection's public ID, from its write-result URL (/c/<pub>/…). */
const pubOf = (url: string) => new URL(url).pathname.split("/")[2] ?? "";
const flag = z.boolean();
/** Whether the first match's computed colour is the token's colour. */
const colourIs = async (page: Page, selector: string, token: string): Promise<boolean> =>
  flag.parse(
    await page.evaluate(`(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(${token})";
      document.body.append(probe);
      const same = getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color === getComputedStyle(probe).color;
      probe.remove();
      return same;
    })()`),
  );
/** Runs `action`, then waits for the page to finish loading again (restore reloads in place). */
async function reloadedBy(page: Page, action: () => Promise<void>): Promise<void> {
  const loaded = page.waitForEvent("load");
  await action();
  await loaded;
}

const scenario: ViewerScenario = {
  name: "OW-07 every restore asks about paused links; Trash rows name and open their collection",
  async run(ctx) {
    const { writer } = ctx;
    const { base } = writer;
    const linkOf = async (collectionId: string, label = "Vendor debug") => {
      const response = await writer.fetch(`/api/collections/${collectionId}/share-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      assert.equal(response.status, 201);
    };
    const trash = async (collectionId: string) => {
      const response = await writer.fetch(`/api/collections/${collectionId}`, {
        method: "DELETE",
      });
      assert.equal(response.status, 200);
    };
    const deleted = async (collectionId: string) =>
      z
        .object({ deleted: z.boolean() })
        .parse(await (await writer.fetch(`/api/collections/${collectionId}`)).json()).deleted;
    const revokedAt = async (collectionId: string) => {
      const { share_links: links } = z
        .object({ share_links: z.array(z.object({ revoked_at: z.number().nullable() })) })
        .parse(await (await writer.fetch(`/api/collections/${collectionId}/share-links`)).json());
      assert.equal(links.length, 1);
      return links[0]?.revoked_at ?? null;
    };

    const a = await writer.api("/api/collections", {
      title: A,
      files: [await writer.write("index.md", "# Leaked\n")],
    });
    await linkOf(a.collection_id);
    await trash(a.collection_id);
    const b = await writer.api("/api/collections", {
      title: B,
      files: [await writer.write("index.md", "# Scratch\n")],
    });
    await trash(b.collection_id);
    const c = await writer.api("/api/collections", {
      title: C,
      files: [await writer.write("index.md", "# Vendor\n")],
    });
    await linkOf(c.collection_id);
    await trash(c.collection_id);
    const d = await writer.api("/api/collections", {
      title: D,
      files: [await writer.write("index.md", "# Long\n")],
    });
    await linkOf(d.collection_id, LONG);
    await trash(d.collection_id);
    const linked = async (title: string) => {
      const created = await writer.api("/api/collections", {
        title,
        files: [await writer.write("index.md", `# ${title}\n`)],
      });
      await linkOf(created.collection_id);
      await trash(created.collection_id);
      return created;
    };
    const e = await linked(E);
    const f = await linked(F);
    const g = await linked(G);
    const pub = {
      a: pubOf(a.url),
      b: pubOf(b.url),
      c: pubOf(c.url),
      d: pubOf(d.url),
      e: pubOf(e.url),
      f: pubOf(f.url),
      g: pubOf(g.url),
    };

    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const confirm = page.locator("dialog#confirm");
    const ok = confirm.locator("[data-confirm-ok]");
    const note = confirm.locator("[data-confirm-note]");
    const cancelFocused = async () =>
      flag.parse(await page.evaluate(`document.activeElement.matches("[data-confirm-cancel]")`));
    const okState = async () => ({
      disabled: await ok.isDisabled(),
      aria: await ok.getAttribute("aria-disabled"),
    });

    // The Trash row: the title is the only link; the chip and the public ID are text.
    await page.goto(`${base}/trash`);
    const row: Locator = page.locator(`li.item[data-pub="${pub.a}"]`);
    const tree = await row.ariaSnapshot();
    const children = tree
      .split("\n")
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4));
    assert.deepEqual(
      children.map((line) => line.split(/[ :]/)[0]),
      ["link", "paragraph", "paragraph", "button", "button"],
      tree,
    );
    assert.ok(children[0]?.startsWith(`link "${A}"`), tree);
    // The message paragraph holds a time element, so its text is read from the DOM.
    assert.match(
      (await row.locator("p.msg").textContent())?.trim() ?? "",
      /^Moved to Trash .+ · 1 revision · 1 file$/,
    );
    assert.equal(children[2], `paragraph: ${pub.a} 1 link paused · “Vendor debug”`, tree);
    assert.equal(children[3], 'button "Restore…"');
    assert.equal(children[4], 'button "Purge…"');
    assert.equal(await row.locator("a").count(), 1, "the chip isn't a link");
    assert.equal(await row.locator(".chip.paused svg.ic").count(), 1, "the chip's globe icon");
    assert.ok(await colourIs(page, `li.item[data-pub="${pub.a}"] .chip.paused`, "--pending"));
    assert.equal(await page.locator(`li.item[data-pub="${pub.b}"] .chip`).count(), 0);

    // Restore… with a paused link: listed, nothing chosen, Restore disabled, focus on Cancel.
    await row.getByRole("button", { name: "Restore…" }).click();
    await confirm.waitFor({ state: "visible" });
    assert.equal(
      (await confirm.locator("[data-confirm-title]").textContent())?.trim(),
      `Restore “${A}”?`,
    );
    assert.equal(
      (await confirm.locator("[data-confirm-body] p").first().textContent())?.trim(),
      "This brings back 1 revision and 1 file. It has 1 public link, paused while in Trash:",
    );
    assert.equal(
      (await confirm.locator(".lnkl").textContent())?.trim(),
      "Vendor debug · Latest · never expires",
    );
    const group = confirm.getByRole("radiogroup", { name: "What happens to the link" });
    assert.equal(await group.count(), 1);
    assert.equal(await group.getByRole("radio").count(), 2);
    assert.equal(await group.locator("input:checked").count(), 0, "no default choice");
    assert.deepEqual(await okState(), { disabled: true, aria: "true" });
    assert.ok(await cancelFocused(), "focus starts on Cancel");
    assert.ok(
      flag.parse(await page.evaluate(`document.activeElement.matches(":focus-visible")`)),
      "Cancel shows its focus ring after a mouse click",
    );
    // Each radio is named by its title alone; the detail sentence is its description.
    assert.deepEqual(
      await Promise.all(
        ["Revoke the link", "Turn the link back on"].map((name) =>
          group.getByRole("radio", { name, exact: true }).count(),
        ),
      ),
      [1, 1],
    );
    assert.equal((await note.textContent())?.trim(), "Choose what happens to the link");
    assert.ok(await colourIs(page, "#confirm .ch2 .pub", "--public"));

    // Revoke: revoke-all, then undelete; the reload says so and the row is gone.
    await confirm.getByText("Revoke the link", { exact: true }).click();
    assert.equal(await group.locator("input:checked").getAttribute("value"), "revoke");
    assert.deepEqual(await okState(), { disabled: false, aria: "false" });
    assert.equal((await note.textContent())?.trim(), "");
    await reloadedBy(page, () => ok.click());
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      `Restored “${A}”. Its public link was revoked.`,
    );
    assert.notEqual(await revokedAt(a.collection_id), null, "the link was revoked");
    assert.equal(await deleted(a.collection_id), false, "A was restored");
    assert.equal(await row.count(), 0, "A has left Trash");

    // The in-Trash page's Restore… opens the dialog too (it used to undelete at once).
    const gone = await page.goto(`${base}/c/${pub.b}/`);
    assert.equal(gone?.status(), 410);
    await page.locator("main .btns").getByRole("button", { name: "Restore…" }).click();
    await confirm.waitFor({ state: "visible" });
    assert.equal(await deleted(b.collection_id), true, "nothing restored while the dialog is open");
    assert.equal(
      (await confirm.locator("[data-confirm-body]").textContent())?.trim(),
      "This brings back 1 revision and 1 file. It has no paused public links.",
    );
    assert.equal(await confirm.getByRole("radiogroup").count(), 0);
    assert.deepEqual(await okState(), { disabled: false, aria: "false" });
    assert.ok(await cancelFocused(), "focus starts on Cancel");
    await confirm.locator("[data-confirm-cancel]").click();
    await confirm.waitFor({ state: "hidden" });
    assert.equal(await deleted(b.collection_id), true, "Cancel leaves B in Trash");

    // The ⋯ menu's Restore… carries the links as well; turning the link back on only undeletes.
    await page.goto(`${base}/c/${pub.c}/`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.locator("#more-menu").getByRole("menuitem", { name: "Restore…" }).click();
    await confirm.waitFor({ state: "visible" });
    assert.ok((await confirm.locator(".lnkl").textContent())?.includes("Vendor debug"));
    assert.deepEqual(await okState(), { disabled: true, aria: "true" });
    await confirm.getByText("Turn the link back on", { exact: true }).click();
    // While Restore runs, picking the other option neither re-enables Restore nor changes the run.
    const held = Promise.withResolvers<void>();
    await page.route("**/api/collections/*/undelete", async (route) => {
      await held.promise;
      await route.continue();
    });
    const restored = page.waitForEvent("load");
    await ok.click();
    await confirm.locator('[data-confirm-ok][aria-busy="true"]').waitFor();
    await confirm.getByText("Revoke the link", { exact: true }).click({ force: true });
    assert.deepEqual(await okState(), { disabled: true, aria: "true" }, "no second run");
    assert.equal(await confirm.locator(".ch2 input:disabled").count(), 2, "choice locked");
    assert.equal(await confirm.locator(".ch2 input:checked").getAttribute("value"), "keep");
    held.resolve();
    await restored;
    await page.unroute("**/api/collections/*/undelete");
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      `Restored “${C}”. Its public link works again.`,
    );
    assert.equal(await revokedAt(c.collection_id), null, "the link was kept");
    assert.equal(await deleted(c.collection_id), false, "C was restored");
    await page.locator("[data-viewer]").waitFor();

    // A 200-character unbroken label: on a phone neither the Trash row nor the dialog scrolls sideways.
    {
      const { page: phone } = await ctx.newPage(VIEWPORTS.phone);
      await phone.goto(`${base}/trash`);
      const fits = async (selector: string) =>
        flag.parse(
          await phone.evaluate(`(() => {
            const root = document.documentElement;
            const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return root.scrollWidth <= root.clientWidth && box.left >= 0 && box.right <= root.clientWidth;
          })()`),
        );
      const longRow = phone.locator(`li.item[data-pub="${pub.d}"]`);
      assert.ok(
        await fits(`li.item[data-pub="${pub.d}"] .chip.paused`),
        "the chip stays in the row",
      );
      assert.ok(
        (await longRow.locator(".chip.paused").textContent())?.includes(LONG),
        "the chip keeps the whole label as text",
      );
      await longRow.getByRole("button", { name: "Restore…" }).click();
      const sheet = phone.locator("dialog#confirm");
      await sheet.waitFor({ state: "visible" });
      assert.ok((await sheet.locator(".lnkl").textContent())?.includes(LONG));
      const parts = [
        "#confirm .lnkl",
        "#confirm [data-confirm-ok]",
        "#confirm [data-confirm-cancel]",
      ];
      assert.deepEqual(await Promise.all(parts.map(fits)), [true, true, true], "fits a phone");
      await sheet.locator("[data-confirm-cancel]").click();
      await sheet.waitFor({ state: "hidden" });

      // A collection title is user text with no length cap, maybe one unbroken word: the dialog's
      // title wraps inside it, keeping every character, and the dialog never scrolls sideways.
      const longTitle = `${WORD}-${"t".repeat(186)}`;
      const h = await writer.api("/api/collections", {
        title: longTitle,
        files: [await writer.write("index.md", "# Long title\n")],
      });
      await trash(h.collection_id);
      await phone.goto(`${base}/trash`);
      await phone
        .locator(`li.item[data-pub="${pubOf(h.url)}"]`)
        .getByRole("button", { name: "Restore…" })
        .click();
      await sheet.waitFor({ state: "visible" });
      assert.equal(
        (await sheet.locator("[data-confirm-title]").textContent())?.trim(),
        `Restore “${longTitle}”?`,
      );
      assert.ok(
        flag.parse(
          await phone.evaluate(`(() => {
            const dialog = document.querySelector("#confirm");
            return dialog.scrollWidth <= dialog.clientWidth;
          })()`),
        ),
        "a long unbroken title doesn't widen the dialog",
      );
      const titled = ["#confirm [data-confirm-title]", ...parts.slice(1)];
      assert.deepEqual(await Promise.all(titled.map(fits)), [true, true, true], "fits a phone");
      await sheet.locator("[data-confirm-cancel]").click();
      await sheet.waitFor({ state: "hidden" });
    }

    // Revoke-all succeeds, undelete fails: the dialog stays open with the error, offers only what is
    // still true (the link is revoked), and a retry says so.
    await page.goto(`${base}/trash`);
    await page.route("**/api/collections/*/undelete", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "undelete failed" }),
      }),
    );
    await page
      .locator(`li.item[data-pub="${pub.d}"]`)
      .getByRole("button", { name: "Restore…" })
      .click();
    await confirm.waitFor({ state: "visible" });
    await confirm.getByText("Revoke the link", { exact: true }).click();
    await ok.click();
    const alert = confirm.locator("[data-confirm-error]");
    await alert.filter({ hasText: /\S/ }).waitFor();
    assert.notEqual(await revokedAt(d.collection_id), null, "revoke-all is not rolled back");
    assert.equal(await deleted(d.collection_id), true, "undelete failed");
    assert.ok(await confirm.isVisible(), "the dialog stays open");
    assert.ok(await confirm.getByText("Turn the link back on", { exact: true }).isHidden());
    assert.equal(await confirm.locator(".ch2 input:checked").getAttribute("value"), "revoke");
    assert.deepEqual(await okState(), { disabled: false, aria: "false" });
    await page.unroute("**/api/collections/*/undelete");
    await reloadedBy(page, () => ok.click());
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      `Restored “${D}”. Its public link was revoked.`,
    );
    assert.equal(await deleted(d.collection_id), false, "D was restored on retry");

    // The same failure, then Cancel: the page reloads, so E's row no longer offers the revoked link
    // and a later Restore… can't promise it works again.
    const restoreOf = (key: "e" | "f" | "g") =>
      page.locator(`li.item[data-pub="${pub[key]}"]`).getByRole("button", { name: "Restore…" });
    await page.route("**/api/collections/*/undelete", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "undelete failed" }),
      }),
    );
    await restoreOf("e").click();
    await confirm.waitFor({ state: "visible" });
    await confirm.getByText("Revoke the link", { exact: true }).click();
    await ok.click();
    await alert.filter({ hasText: /\S/ }).waitFor();
    await reloadedBy(page, () => confirm.locator("[data-confirm-cancel]").click());
    await page.unroute("**/api/collections/*/undelete");
    assert.notEqual(await revokedAt(e.collection_id), null);
    assert.equal(await deleted(e.collection_id), true);
    assert.equal(await page.locator(`li.item[data-pub="${pub.e}"] .chip`).count(), 0, "no chip");
    assert.equal(await restoreOf("e").getAttribute("data-links"), "[]");
    await restoreOf("e").click();
    await confirm.waitFor({ state: "visible" });
    assert.equal(
      (await confirm.locator("[data-confirm-body]").textContent())?.trim(),
      "This brings back 1 revision and 1 file. It has no paused public links.",
    );
    await confirm.locator("[data-confirm-cancel]").click();
    await confirm.waitFor({ state: "hidden" });

    // Escape waits while Restore runs. If the dialog is forced shut anyway, the run carries on
    // without touching the next dialog (G's): its choice, Cancel and focus stay its own.
    const revokeHeld = Promise.withResolvers<void>();
    const undeleteHeld = Promise.withResolvers<void>();
    await page.route("**/api/collections/*/share-links/revoke-all", async (route) => {
      await revokeHeld.promise;
      await route.continue();
    });
    await page.route("**/api/collections/*/undelete", async (route) => {
      await undeleteHeld.promise;
      await route.continue();
    });
    await restoreOf("f").click();
    await confirm.waitFor({ state: "visible" });
    await confirm.getByText("Revoke the link", { exact: true }).click();
    await ok.click();
    await confirm.locator('[data-confirm-ok][aria-busy="true"]').waitFor();
    await page.keyboard.press("Escape");
    assert.ok(await confirm.isVisible(), "Escape doesn't close a running restore");
    await page.evaluate(`document.querySelector("dialog#confirm").close()`);
    await confirm.waitFor({ state: "hidden" });
    await restoreOf("g").click();
    await confirm.waitFor({ state: "visible" });
    const fresh = async () => ({
      checked: await confirm.locator(".ch2 input:checked").count(),
      offered: await confirm.locator(".ch2 label:visible").count(),
      ok: await okState(),
      cancel: await confirm.locator("[data-confirm-cancel]").isEnabled(),
      focus: await cancelFocused(),
    });
    const untouched = {
      checked: 0,
      offered: 2,
      ok: { disabled: true, aria: "true" },
      cancel: true,
      focus: true,
    };
    assert.deepEqual(await fresh(), untouched, "G's dialog opens clean");
    const undeleteSent = page.waitForRequest("**/api/collections/*/undelete");
    revokeHeld.resolve();
    await undeleteSent;
    assert.deepEqual(await fresh(), untouched, "F's revoke doesn't change G's choice");
    await reloadedBy(page, () => {
      undeleteHeld.resolve();
      return Promise.resolve();
    });
    await page.unroute("**/api/collections/*/share-links/revoke-all");
    await page.unroute("**/api/collections/*/undelete");
    await page.locator(success).waitFor({ state: "visible" });
    assert.equal(
      (await page.locator(`${success} .tt`).textContent())?.trim(),
      `Restored “${F}”. Its public link was revoked.`,
    );
    assert.equal(await deleted(f.collection_id), false, "F's run finished");
    assert.equal(await deleted(g.collection_id), true, "G is still in Trash");
    assert.equal(await revokedAt(g.collection_id), null, "G's link is untouched");
  },
};
export default scenario;
