// OW-04: the Links tab stays true after a revoke (the card collapses into a confirmation row, the
// page is re-fetched and the status line, counts, bar chip and keyed nodes follow, with no
// reload) and after Extend (flash, reload, the new expiry). Then refreshFrom's fixtures on /links:
// keyed nodes from a routed "fresh" page, the fetch-failure fallback, the counter pass,
// overlapping revokes whose refreshes come back out of order or fail, focus kept through a swap,
// a Dismiss and a sheet close, and a public segment the refresh adds. Runs its own seeded demo
// writer (sync on, so links are live): Webhook has "Design review — Sam" (Latest, 2 h), "Priya —
// payments review" (Only #3, 7 days), a revoked and an expired link.
import type { APIResponse, Locator, Page, Route } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const WEBHOOK = "Webhook idempotency research";
const SAM = "Design review — Sam";
const PRIYA = "Priya — payments review";
const DAY = 86_400_000;

/** Polls a locator's textContent for up to 5 s, then asserts it. */
async function expectText(locator: Locator, text: string, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last: string | null = null;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the refresh lands.
    last = await locator.textContent({ timeout: 1000 }).catch(() => null);
    if (last === text) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the refresh lands.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(last, text, what);
}
/** Waits until the page's script expression is true (the counts land with the refresh). */
const until = (page: Page, expression: string) => page.waitForFunction(expression);
const number = async (page: Page, selector: string): Promise<number> =>
  Number(await page.locator(selector).textContent());
/** Revokes through a card's inline confirmation, then waits for the counts to be final. */
async function revokeCard(page: Page, label: string): Promise<void> {
  const card = page.locator(".lnk:not(.dead)", { hasText: label });
  await card.locator("summary", { hasText: "Revoke…" }).click();
  await card.getByRole("button", { name: "Revoke link" }).click();
  await page.locator(".lnk[data-refreshed]", { hasText: label }).waitFor();
}
/** Revokes a /links row (the [data-link] holder) through the confirm dialog. */
async function startRevokeRow(page: Page, label: string): Promise<Locator> {
  const row = page.locator("main [data-link]", { hasText: label });
  await row.getByRole("button", { name: "Revoke…" }).click();
  await page.locator("#confirm [data-confirm-ok]").click();
  return row;
}
/** Waits for a revoked /links row's counts to be final. */
const settled = (page: Page, label: string) =>
  page.locator("main [data-link][data-refreshed]", { hasText: label }).waitFor();
/** Revokes a /links row, then waits for its counts to be final. */
async function revokeRow(page: Page, label: string): Promise<Locator> {
  const row = await startRevokeRow(page, label);
  await settled(page, label);
  return row;
}
/**
 * Holds every GET of `url` (the revoke refreshes), each with the page as the writer rendered it
 * when the GET arrived, until the test answers it: overlapping refreshes in a chosen order.
 */
async function holdPages(page: Page, url: string) {
  const held: { route: Route; response: APIResponse }[] = [];
  await page.route(url, async (route) => {
    held.push({ route, response: await route.fetch() });
  });
  return async (index: number) => {
    const deadline = Date.now() + 10_000;
    while (!held[index]) {
      assert.ok(Date.now() < deadline, `refresh ${index + 1} requested`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the refresh is held.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const refresh = held[index];
    assert.ok(refresh);
    return refresh;
  };
}

/** Reloads `target` until the status line names `text` (new links go live once pushed). */
async function untilLive(target: Page, text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the links are live.
  while (!((await target.locator("[data-status]").textContent()) ?? "").includes(text)) {
    assert.ok(Date.now() < deadline, `the status line reads ${text}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the links are live.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the links are live.
    await target.reload();
  }
}

const collections = z.object({
  collections: z.array(z.object({ id: z.string(), public_id: z.string(), title: z.string() })),
});

const scenario: ViewerScenario = {
  name: "OW-04 revoke refreshes the Links tab in place; extend flashes; refreshFrom fixtures",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const listed = collections.parse(await (await writer.fetch("/api/collections")).json());
    const webhook = listed.collections.find((collection) => collection.title === WEBHOOK);
    assert.ok(webhook, "the seeded Webhook collection");
    const addLink = async (label: string) => {
      const made = await writer.fetch(`/api/collections/${webhook.id}/share-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, expires_at: Date.now() + 30 * DAY }),
      });
      assert.equal(made.status, 201, `${label} created`);
    };
    await addLink("Third");
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    const url = `${base}/c/${webhook.public_id}/?panel=links`;
    await page.goto(url);
    const tabCount = page.locator("#tab-links .n");
    const status = page.locator("[data-status]");
    const revokeAll = page.locator("#tp-links [data-action=revoke-all]");
    const inactive = page.locator("#tp-links details.inactive > summary");
    const chip = page.locator("header .chip.public");
    // NAV-04 may remove the bar's Public chip; while it's there, it follows the live links.
    const chips = await chip.count();
    assert.equal(await tabCount.textContent(), "3");
    assert.equal(await inactive.textContent(), "Show 2 inactive");
    assert.equal(await revokeAll.textContent(), "Revoke all 3 links…");

    // Revoke Sam: no reload; the card collapses into a confirmation row with focus; the status
    // line, the tab count, the inactive list and Revoke all follow the fresh page.
    await page.evaluate("window.__ow04 = 1");
    await revokeCard(page, SAM);
    assert.equal(await page.evaluate("window.__ow04"), 1, "no reload");
    assert.equal(page.url(), url);
    const samRow = page.locator(".lnk.gone", { hasText: SAM });
    assert.equal(await samRow.locator(".h b").textContent(), `Revoked “${SAM}”`);
    assert.equal(await samRow.getByRole("button", { name: "Dismiss" }).count(), 1);
    // The push note, then where the link went.
    const notes = await samRow.locator(":scope > p").allTextContents();
    assert.equal(notes.length, 2);
    assert.match(
      notes[0] ?? "",
      /^(Revoked, not yet pushed\.|Public access stops within seconds\.)/,
    );
    assert.equal(notes[1], "Listed under inactive.");
    assert.equal(
      await page.evaluate("document.activeElement?.matches('.lnk.gone[data-revoked]')"),
      true,
      "the confirmation row has focus",
    );
    await until(page, `document.querySelector("#tab-links .n")?.textContent === "2"`);
    assert.equal(await tabCount.textContent(), "2");
    await status.filter({ hasText: "“Third” follows latest" }).waitFor();
    assert.match((await status.textContent()) ?? "", /“Third” follows latest/);
    await expectText(inactive, "Show 3 inactive", "the inactive list follows");
    await expectText(revokeAll, "Revoke all 2 links…", "Revoke all counts open cards");

    // Revoke Third: the status line names the one remaining pinned link; Revoke all goes. The
    // inactive list, expanded first, stays expanded when the fresh one replaces it.
    await inactive.click();
    await revokeCard(page, "Third");
    await status.filter({ hasText: `1 live link. “${PRIYA}” shows only #3` }).waitFor();
    assert.match(
      (await status.textContent()) ?? "",
      new RegExp(`1 live link\\. “${PRIYA}” shows only #3`),
    );
    await until(page, `document.querySelector("#tab-links .n")?.textContent === "1"`);
    assert.equal(await tabCount.textContent(), "1");
    await page.locator("[data-refresh=links-foot]").waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-refresh=links-foot]").count(), 0);
    assert.equal(await chip.count(), chips > 0 ? 1 : 0, "Priya is still live");
    await expectText(inactive, "Show 4 inactive", "the inactive list follows again");
    assert.equal(
      await page.evaluate(`document.querySelector("#tp-links details.inactive")?.open`),
      true,
      "the expanded inactive list stays expanded",
    );

    // The note follows the revocation until the reader no longer serves the link (the demo
    // pushes; the reader's cache covers 10 s more).
    await samRow
      .locator("[data-stops]", { hasText: "Its URL no longer works." })
      .waitFor({ timeout: 40_000 });
    assert.equal(await samRow.locator(":scope > p").count(), 2);

    // Dismiss removes the row; focus goes to the next open card (Priya's) or New public link.
    const thirdRow = page.locator(".lnk.gone", { hasText: "Third" });
    await thirdRow.getByRole("button", { name: "Dismiss" }).click();
    await thirdRow.waitFor({ state: "detached" });
    const focused = z.string().parse(
      await page.evaluate(`(() => {
        const active = document.activeElement;
        const card = active?.closest(".lnk:not(.dead)");
        if (card) return active.matches("button, summary") && card.textContent.includes(${JSON.stringify(PRIYA)}) ? "priya" : "other card";
        return active?.matches('button[commandfor="share"]') ? "new" : active?.tagName ?? "none";
      })()`),
    );
    assert.ok(focused === "priya" || focused === "new", `focus after Dismiss: ${focused}`);

    // Extend Priya by 7 days: the page reloads and the flash names the link and its new expiry.
    const priya = page.locator(".lnk:not(.dead)", { hasText: PRIYA });
    await priya.locator("summary", { hasText: "Extend…" }).click();
    await priya.getByRole("button", { name: "+7 days" }).click();
    const flashed = page.locator('[data-toast-slot="success"] .tt', {
      hasText: `Extended “${PRIYA}” by 7 days. It now expires`,
    });
    await flashed.waitFor();
    assert.match((await flashed.textContent()) ?? "", /It now expires \d+ \w+ \d{4}, \d\d:\d\d\.$/);
    assert.equal(
      await page.locator(".lnk:not(.dead)", { hasText: PRIYA }).locator("dd").nth(2).textContent(),
      "in 14 days",
    );

    // Revoke Priya, the last live link: the public segment, the bar chip and the live count go,
    // and the tab says there's nothing live.
    await revokeCard(page, PRIYA);
    const fresh = await (await page.request.get(page.url())).text();
    const freshCount = z
      .string()
      .optional()
      .parse(
        await page.evaluate(
          `new DOMParser().parseFromString(${JSON.stringify(fresh)}, "text/html").querySelector("#tab-links .n")?.textContent ?? undefined`,
        ),
      );
    if (freshCount === undefined) await tabCount.waitFor({ state: "detached" });
    else
      await until(
        page,
        `document.querySelector("#tab-links .n")?.textContent === ${JSON.stringify(freshCount)}`,
      );
    assert.equal((await tabCount.count()) ? await tabCount.textContent() : undefined, freshCount);
    await page.locator("[data-status] .pubseg").waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-status] .pubseg").count(), 0);
    await expectText(
      page.locator("[data-refresh=links-empty]"),
      "No live links. Create one with Share.",
      "the empty note",
    );
    await chip.waitFor({ state: "detached" });
    assert.equal(await chip.count(), 0);

    // refreshFrom fixtures on /links. Two more live Webhook links, so /links has four live rows
    // (these two, HTTP API and Leadership preview) for the three revokes below.
    await addLink("Fixture A");
    await addLink("Fixture B");
    const links = `${base}/links`;

    // (a) Keyed nodes: test-only keys on the page and a routed "fresh" page that changes them.
    await page.goto(links);
    await page.evaluate(`(() => {
      window.__ow04 = 1;
      document.querySelector("main p").setAttribute("data-refresh", "ow04-head");
      document.querySelector("main nav").setAttribute("data-refresh", "ow04-seg");
      const gone = document.createElement("p");
      gone.dataset.refresh = "ow04-gone";
      gone.textContent = "x";
      document.querySelector("main").append(gone);
    })()`);
    const real = await (await page.request.get(links)).text();
    const routed = z.string().parse(
      await page.evaluate(`(() => {
        const doc = new DOMParser().parseFromString(${JSON.stringify(real)}, "text/html");
        const head = doc.createElement("p");
        head.dataset.refresh = "ow04-head";
        head.textContent = "FRESH HEAD";
        doc.querySelector("main p").replaceWith(head);
        const seg = doc.createElement("nav");
        seg.dataset.refresh = "ow04-seg";
        seg.textContent = "FRESH SEG";
        doc.querySelector("main nav").replaceWith(seg);
        return "<!doctype html>" + doc.documentElement.outerHTML;
      })()`),
    );
    await page.route(
      links,
      (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: routed }),
      { times: 1 },
    );
    const rowA = await revokeRow(page, "Fixture A");
    await page.unroute(links);
    assert.equal(await page.evaluate("window.__ow04"), 1, "no reload on /links");
    await expectText(page.locator("[data-refresh=ow04-head]"), "FRESH HEAD", "keyed head");
    await expectText(page.locator("[data-refresh=ow04-seg]"), "FRESH SEG", "keyed segment nav");
    await page.locator("[data-refresh=ow04-gone]").waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-refresh=ow04-gone]").count(), 0);
    assert.equal(await rowA.locator("[data-link-state]").textContent(), "Revoked");
    assert.match((await rowA.getAttribute("class")) ?? "", /\bdead\b/);

    // (b) Fallback: the re-fetch fails, so countRevoked() adjusts the counts.
    await page.reload();
    const active = '[data-count-of="active"]';
    const revoked = '[data-count-of="revoked"]';
    let before = { active: await number(page, active), revoked: await number(page, revoked) };
    await page.route(links, (route) => route.abort(), { times: 1 });
    await revokeRow(page, "Fixture B");
    await page.unroute(links);
    await expectText(page.locator(active), String(before.active - 1), "fallback: active count");
    await expectText(page.locator(revoked), String(before.revoked + 1), "fallback: revoked count");

    // (c) The counter pass with no keys: the fresh page's counts.
    await page.reload();
    before = { active: await number(page, active), revoked: await number(page, revoked) };
    await revokeRow(page, "Leadership preview");
    await expectText(page.locator(active), String(before.active - 1), "refresh: active count");
    await expectText(page.locator(revoked), String(before.revoked + 1), "refresh: revoked count");

    // (d) Overlapping revokes (review r1): each revoke changes the counts exactly once, whichever
    // refresh comes back first and whichever fails. Four more live rows for the four revokes.
    await Promise.all(["Fixture C", "Fixture D", "Fixture E", "Fixture F"].map(addLink));
    // The newer refresh comes back first; then the older one fails.
    await page.reload();
    before = { active: await number(page, active), revoked: await number(page, revoked) };
    let refresh = await holdPages(page, links);
    await startRevokeRow(page, "Fixture C");
    const olderFails = await refresh(0);
    await startRevokeRow(page, "Fixture D");
    const newerLands = await refresh(1);
    await newerLands.route.fulfill({ response: newerLands.response });
    await olderFails.route.abort();
    await settled(page, "Fixture C");
    await settled(page, "Fixture D");
    await page.unroute(links);
    await expectText(page.locator(active), String(before.active - 2), "newer first: active count");
    await expectText(page.locator(revoked), String(before.revoked + 2), "newer first: revoked");
    // The newer refresh fails; then the older one comes back.
    await page.reload();
    before = { active: await number(page, active), revoked: await number(page, revoked) };
    refresh = await holdPages(page, links);
    await startRevokeRow(page, "Fixture E");
    const olderLands = await refresh(0);
    await startRevokeRow(page, "Fixture F");
    const newerFails = await refresh(1);
    await newerFails.route.abort();
    await olderLands.route.fulfill({ response: olderLands.response });
    await settled(page, "Fixture E");
    await settled(page, "Fixture F");
    await page.unroute(links);
    await expectText(page.locator(active), String(before.active - 2), "newer fails: active count");
    await expectText(page.locator(revoked), String(before.revoked + 2), "newer fails: revoked");

    // (g) Back on the Links tab (review r3): keyboard focus on "Show N inactive" survives the
    // held refresh's swap of the inactive list.
    await Promise.all([addLink("Fixture O"), addLink("Fixture P")]);
    await page.goto(url);
    const live = await number(page, "#tab-links .n");
    refresh = await holdPages(page, url);
    const cardO = page.locator(".lnk:not(.dead)", { hasText: "Fixture O" });
    await cardO.locator("summary", { hasText: "Revoke…" }).click();
    await cardO.getByRole("button", { name: "Revoke link" }).click();
    const heldO = await refresh(0);
    await inactive.focus();
    await heldO.route.fulfill({ response: heldO.response });
    await page.locator(".lnk[data-refreshed]", { hasText: "Fixture O" }).waitFor();
    await page.unroute(url);
    assert.equal(
      await page.evaluate(
        `document.activeElement?.matches("#tp-links details.inactive > summary") ?? false`,
      ),
      true,
      "focus stays on Show N inactive",
    );
    await until(page, `document.querySelector("#tab-links .n")?.textContent === "${live - 1}"`);

    // (j) Dismiss (review r8) when the next card has no Copy URL (a writer without sharing) and
    // its Extend… is open, which hides the summary: focus goes to a control that is shown.
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll(".lnk.gone")].find((node) => node.textContent.includes("Fixture O"));
      const card = [...document.querySelectorAll(".lnk:not(.dead)")].find((node) => node.textContent.includes("Fixture P"));
      row.after(card);
      card.querySelector(".r1")?.remove();
    })()`);
    await page
      .locator(".lnk:not(.dead)", { hasText: "Fixture P" })
      .locator("summary", { hasText: "Extend…" })
      .click();
    const rowO = page.locator(".lnk.gone", { hasText: "Fixture O" });
    await rowO.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await rowO.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(`(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.getClientRects().length > 0
          && (active.closest(".lnk:not(.dead)")?.textContent.includes("Fixture P") ?? false);
      })()`),
      true,
      "focus after Dismiss is on a control shown in the next card",
    );

    // (h) Phone (review r7): the Links sheet closes (focus back on its opener) while the last
    // live link's refresh is held; the refresh then hides the status line, and keyboard focus
    // stays on a visible control instead of the body. NAV-04 removed the status line's phone tap
    // target, so the sheet opens from the tab bar's History button, then the Links tab.
    const { page: phone } = await ctx.newPage(VIEWPORTS.phone);
    await phone.goto(`${base}/c/${webhook.public_id}/`);
    assert.equal(await phone.locator("[data-status] .pubseg").count(), 1, "Fixture P is live");
    const opener = phone.locator('.tabbar [data-tab="history"]');
    const openLinks = async () => {
      await opener.focus();
      await phone.keyboard.press("Enter");
      await until(phone, `document.querySelector("#shell")?.classList.contains("open") ?? false`);
      await phone.locator("#tab-links").click();
      await phone.locator("#tp-links").waitFor();
    };
    await openLinks();
    const cardP = phone.locator(".lnk:not(.dead)", { hasText: "Fixture P" });
    await cardP.locator("summary", { hasText: "Revoke…" }).click();
    refresh = await holdPages(phone, url);
    await cardP.getByRole("button", { name: "Revoke link" }).click();
    const heldP = await refresh(0);
    await phone.keyboard.press("Escape");
    await until(phone, `document.activeElement?.matches('.tabbar [data-tab="history"]') ?? false`);
    await heldP.route.fulfill({ response: heldP.response });
    // The sheet is closed, so the row is hidden.
    await phone
      .locator(".lnk[data-refreshed]", { hasText: "Fixture P" })
      .waitFor({ state: "attached" });
    await phone.unroute(url);
    assert.equal(await phone.locator("[data-status]").isHidden(), true, "the status line hides");
    assert.equal(
      await phone.evaluate(`(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active !== document.body
          && !active.closest("[data-status]") && active.getClientRects().length > 0;
      })()`),
      true,
      "focus moves to a visible control when the status line hides",
    );

    // (i) Phone (review r8): the last live link's refresh lands while the sheet is still open,
    // hiding the status line; closing the sheet then puts focus on a visible control, not on
    // the closed sheet or the body.
    await addLink("Fixture Q");
    await phone.goto(`${base}/c/${webhook.public_id}/`);
    await untilLive(phone, "1 live link");
    await openLinks();
    await revokeCard(phone, "Fixture Q");
    assert.equal(
      await phone.locator("[data-status]").isHidden(),
      true,
      "the line hides (sheet open)",
    );
    await phone.keyboard.press("Escape");
    await until(phone, `!document.querySelector("#shell")?.classList.contains("open")`);
    assert.equal(
      await phone.evaluate(`(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active !== document.body
          && active.getClientRects().length > 0 && getComputedStyle(active).visibility !== "hidden"
          && !active.closest("[data-status], #panel");
      })()`),
      true,
      "closing the sheet puts focus on a visible control",
    );

    // (k) Review r8: the fresh page has a public segment the current line lacks (a link went
    // live after the page loaded): the refresh inserts it, with the line's separators in step.
    await Promise.all([addLink("Fixture R"), addLink("Fixture S")]);
    await page.goto(url);
    await untilLive(page, "2 live links");
    await page.evaluate(`(() => {
      const line = document.querySelector("[data-status]");
      const segment = line.querySelector(".pubseg").closest(".seg1");
      const separator = segment.previousElementSibling?.classList.contains("sepdot")
        ? segment.previousElementSibling
        : segment.nextElementSibling?.classList.contains("sepdot") ? segment.nextElementSibling : null;
      separator?.remove();
      segment.remove();
      line.hidden = !line.querySelector(".seg1");
    })()`);
    await revokeCard(page, "Fixture S");
    await status.filter({ hasText: "1 live link. “Fixture R” follows latest" }).waitFor();
    assert.equal(await status.locator(".pubseg").count(), 1, "the public segment is back");
    assert.equal(await status.isVisible(), true, "the status line shows");
    assert.equal(
      await status.locator(":scope > .sepdot").count(),
      Math.max(0, (await status.locator(":scope > .seg1").count()) - 1),
      "one separator between segments",
    );
  },
};
export default scenario;
