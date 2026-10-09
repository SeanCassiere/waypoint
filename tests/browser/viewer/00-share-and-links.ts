import { assert, type ViewerScenario } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "landmarks, share create/copy/revoke, copy URL, live revoke counts",
  async run(ctx) {
    const { base } = ctx.writer;
    const { first, latest, page } = await baseline(ctx);
    await page.goto(`${base}${latest}`);
    // Landmarks and the skip link (spec §7).
    assert.equal(await page.locator("header.bar").count(), 1);
    assert.equal(await page.locator("aside#panel").count(), 1);
    assert.equal(await page.locator("main#main").count(), 1);
    assert.equal(await page.locator("a.skip").getAttribute("href"), "#main");
    // Share: the dialog opens natively, the checklist follows the form, the link shows once.
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.locator("#share").waitFor({ state: "visible" });
    assert.equal(await page.locator("#share .sees div.alt > .when-latest").isVisible(), false);
    await page.locator("#share label.opt", { hasText: "Latest revision" }).click();
    assert.equal(await page.locator("#share .sees div.alt > .when-latest").isVisible(), true);
    await page.locator('#share input[name="label"]').fill("Browser review");
    await page.locator("[data-share-submit]").click();
    await page.locator('[data-share-step="created"]').waitFor({ state: "visible" });
    const created = (await page.locator("[data-share-url]").textContent()) ?? "";
    assert.match(created, /\/s\/wps_/);
    // Copy has focus once the link exists (no view transition delays it any more).
    assert.equal(
      await page.evaluate('document.activeElement?.hasAttribute("data-share-copy")'),
      true,
    );
    await page.locator("[data-share-copy]").click();
    await page.locator("[data-share-copy][data-copied]").waitFor();
    assert.equal(await page.evaluate("navigator.clipboard.readText()"), created);
    // The URL stays copyable later, so closing isn't guarded: Esc shows the Links tab.
    await page.keyboard.press("Escape");
    await page.waitForURL(/panel=links/);
    const card = page.locator(".lnk", { hasText: "Browser review" });
    await card.waitFor();
    // local-only writer: links are waiting (FC1)
    assert.equal(await page.locator("header .chip.public").count(), 0, "Public chip shows");
    // Copy URL on an existing link copies the same URL the dialog showed; Open points at it,
    // and the button keeps its width while it says Copied.
    await page.evaluate("navigator.clipboard.writeText('')");
    const copyUrl = card.getByRole("button", { name: /Copy URL/ });
    const before = (await copyUrl.boundingBox())?.width ?? 0;
    await copyUrl.click();
    await card.locator("[data-copy-url][data-copied]").waitFor();
    assert.equal((await card.locator("[data-copy-url]").boundingBox())?.width, before, "no shift");
    assert.equal(await page.evaluate("navigator.clipboard.readText()"), created);
    assert.equal(await card.locator("[data-open-url]").getAttribute("href"), created);
    // Two more links, so "Revoke all" shows (it needs 2+ active links).
    for (const label of ["Second reviewer", "Third reviewer"]) {
      const made = await fetch(`${base}/api/collections/${first.collection_id}/share-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      assert.equal(made.status, 201);
    }
    await page.reload();
    await card.waitFor();
    const revokeAll = page.locator("#tp-links [data-action=revoke-all]");
    assert.equal(await revokeAll.textContent(), "Revoke all 3 links…");
    // Revocation shows at once: no reload, the card becomes a confirmation row that notes the
    // revocation hasn't reached the cloud (sync is off here), and the counts follow.
    const revokeUrl = page.url();
    await card.locator("summary", { hasText: "Revoke…" }).click();
    await card.getByRole("button", { name: "Revoke link" }).click();
    // OW-04: revoke collapses the card
    const gone = page.locator(".lnk.gone", { hasText: "Browser review" });
    await gone.locator("[data-stops]").waitFor();
    // OW-04: counts follow the refresh
    await page.locator(".lnk[data-refreshed]", { hasText: "Browser review" }).waitFor();
    // OW-04: revoke collapses the card
    assert.equal(await gone.locator(".h b").textContent(), "Revoked “Browser review”");
    assert.equal(
      await card.locator("[data-copy-url]").count(),
      0,
      "a revoked link has no Copy URL",
    );
    assert.equal(page.url(), revokeUrl);
    // OW-04: revoke collapses the card
    assert.equal(
      await gone.locator("[data-stops]").textContent(),
      "Revoked, not yet pushed. Public access continues until it syncs.",
    );
    // OW-04: counts follow the refresh
    await page
      .locator("#tp-links [data-action=revoke-all]", { hasText: "Revoke all 2 links…" })
      .waitFor();
    assert.equal(await revokeAll.textContent(), "Revoke all 2 links…");
    // OW-04: counts follow the refresh
    await page.waitForFunction(
      `document.querySelector("#tp-links [data-action=revoke-all]")?.dataset.count === "2"`,
    );
    assert.equal(await revokeAll.getAttribute("data-count"), "2");
    // OW-04: counts follow the refresh
    await page.waitForFunction(`document.querySelector("#tab-links .n")?.textContent === "0"`);
    // local-only writer: links are waiting (FC1)
    assert.equal(await page.locator("#tab-links .n").textContent(), "0");
    // /links: a row revoked there gets a Revoked chip and the same note; counts follow, and
    // Revoke all goes once fewer than two active links remain.
    await page.goto(`${base}/links`);
    // local-only writer: links are waiting (FC1)
    assert.equal(await page.locator('[data-count-of="active"]').textContent(), "0");
    const row = page.locator(".lrow", { hasText: "Second reviewer" });
    await row.getByRole("button", { name: "Revoke…" }).click();
    await page.locator("#confirm [data-confirm-ok]").click();
    await row.locator("[data-stops]").waitFor();
    // OW-04: counts follow the refresh
    await page.locator(".lrow[data-refreshed]", { hasText: "Second reviewer" }).waitFor();
    assert.equal(await row.locator("[data-link-state]").textContent(), "Revoked");
    assert.equal(
      await row.locator("[data-stops]").textContent(),
      "Revoked, not yet pushed. Public access continues until it syncs.",
    );
    // OW-04: counts follow the refresh
    await page.waitForFunction(
      `document.querySelector('[data-count-of="active"]')?.textContent === "0"`,
    );
    // local-only writer: links are waiting (FC1)
    assert.equal(await page.locator('[data-count-of="active"]').textContent(), "0");
    // OW-04: counts follow the refresh
    await page.waitForFunction(
      `document.querySelector('[data-count-of="revoked"]')?.textContent === "2"`,
    );
    assert.equal(await page.locator('[data-count-of="revoked"]').textContent(), "2");
    // OW-04: counts follow the refresh
    await page.locator("[data-action=revoke-all]").waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-action=revoke-all]").count(), 0);
    await page.goto(revokeUrl);
    await page.locator(".lnk.dead", { hasText: "Browser review" }).waitFor({ state: "attached" });
    await page.goto(`${base}${latest}`);
    assert.notEqual(
      await page.locator("body").evaluate("element => getComputedStyle(element).fontFamily"),
      "Times New Roman",
    );
  },
};
export default scenario;
