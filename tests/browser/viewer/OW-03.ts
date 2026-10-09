// OW-03: the share dialog shows what each target publishes and its Preview link follows the chosen
// target; every open starts from the D43 default (Only #N, 7 days, no label) with focus on the
// checked target; switching targets or expiry never changes the dialog's height (on phones, only
// a wrapping Latest summary may add its one line: decision d-1). Runs its own
// seeded demo writer: Postgres has #6 failed (on #4) and #7 uploading (on #5), Webhook is synced.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, startDemoWriter, VIEWPORTS, type ViewerScenario } from "../harness.ts";

const PREVIEW = "#share [data-preview-for=target]";
const state = z.object({
  only: z.boolean(),
  onlyDisabled: z.boolean(),
  latest: z.boolean(),
  focused: z.string(),
  week: z.boolean(),
  label: z.string(),
  href: z.string(),
  dataLatest: z.string(),
  dataPinned: z.string(),
  title: z.string().nullable(),
  height: z.number(),
  scroll: z.number(),
  sees: z.boolean(),
  summary: z.object({
    height: z.number(),
    lineHeight: z.number(),
    text: z.string(),
    shownHeight: z.number(),
    hiddenHeight: z.number(),
    clipped: z.boolean(),
  }),
});
/** The dialog's form, focus, preview link, height (its box, and its content: the box is capped
 *  at the viewport), checklist fold and phone summary. */
async function dialogState(page: Page): Promise<z.infer<typeof state>> {
  return state.parse(
    await page.evaluate(`(() => {
      const dialog = document.querySelector("#share");
      const input = (selector) => dialog.querySelector(selector);
      const preview = dialog.querySelector("[data-preview-for=target]");
      const summary = dialog.querySelector("summary .sum-sm");
      const shown = [...summary.children].find((child) => getComputedStyle(child).visibility !== "hidden");
      const hidden = [...summary.children].find((child) => child !== shown);
      const active = document.activeElement;
      return {
        only: input('input[name=target][value=only]').checked,
        onlyDisabled: input('input[name=target][value=only]').disabled,
        latest: input('input[name=target][value=latest]').checked,
        focused: active?.matches("input[name=target]") ? active.value : active?.tagName ?? "",
        week: input('input[name=expires][value="7"]').checked,
        label: input('input[name=label]').value,
        href: preview.getAttribute("href"),
        dataLatest: preview.dataset.latest,
        dataPinned: preview.dataset.pinned,
        title: preview.getAttribute("title"),
        height: dialog.getBoundingClientRect().height,
        scroll: dialog.scrollHeight,
        sees: dialog.querySelector("details.sees").open,
        summary: {
          height: summary.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(summary).lineHeight),
          text: shown?.innerText ?? "",
          shownHeight: shown?.getBoundingClientRect().height ?? 0,
          hiddenHeight: hidden?.getBoundingClientRect().height ?? 0,
          clipped: shown
            ? shown.scrollWidth > shown.clientWidth || getComputedStyle(shown).textOverflow === "ellipsis"
            : false,
        },
      };
    })()`),
  );
}
/** Decision d-1: the phone summary shows its whole sentence (no ellipsis), wrapping onto at most a
 *  second line, and the hidden sentence stays on one line and adds no height. Whether a sentence
 *  needs that second line depends on the fonts, so this never asserts a line count of one. */
function fits(at: z.infer<typeof state>, what: string): void {
  const { summary } = at;
  assert.equal(summary.clipped, false, `${what}: the whole sentence shows`);
  assert.ok(
    summary.shownHeight <= 2 * summary.lineHeight + 1,
    `${what}: ${summary.shownHeight} px for a ${summary.lineHeight} px line (at most two lines)`,
  );
  assert.ok(
    summary.hiddenHeight <= summary.lineHeight + 1,
    `${what}: hidden sentence ${summary.hiddenHeight} px for a ${summary.lineHeight} px line`,
  );
  assert.ok(
    Math.abs(summary.height - summary.shownHeight) <= 1,
    `${what}: summary ${summary.height} px = its shown sentence ${summary.shownHeight} px`,
  );
}
async function openWithShare(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator("#share").waitFor({ state: "visible" });
  // Focus moves to the checked target on the dialog's toggle event.
  await page.waitForFunction(
    `document.activeElement?.matches("#share input[name=target]:checked")`,
  );
}
async function openWithKey(page: Page): Promise<void> {
  await page.locator("body").press("s");
  await page.locator("#share").waitFor({ state: "visible" });
  await page.waitForFunction(
    `document.activeElement?.matches("#share input[name=target]:checked")`,
  );
}
async function cancel(page: Page): Promise<void> {
  await page.locator("#share").getByRole("button", { name: "Cancel" }).click();
  await page.locator("#share").waitFor({ state: "hidden" });
}
const pickLatest = (page: Page) =>
  page.locator("#share label.opt", { hasText: "Latest revision" }).click();

const scenario: ViewerScenario = {
  name: "OW-03 share dialog: what each target publishes, Preview follows the target, reset on open",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const { page } = await ctx.newPage(VIEWPORTS.desktop);
    await page.goto(`${base}/`);
    const link = async (title: string) => {
      const href = await page.locator("a", { hasText: title }).first().getAttribute("href");
      const pub = /^\/c\/([^/]+)\//.exec(href ?? "")?.[1];
      assert.ok(pub, `${title}: a collection link on Home`);
      return `${base}/c/${pub}/`;
    };
    const postgres = await link("Postgres 17 upgrade runbook");
    const webhook = await link("Webhook idempotency research");
    /** A revision's URL, as History links it. */
    const revision = async (at: Page, n: number) => {
      await at.goto(`${postgres}?panel=history`);
      const href = await at.locator(`#tp-history li.rv[data-n="${n}"] a.rvl`).getAttribute("href");
      assert.ok(href, `History links #${n}`);
      return `${base}${href}`;
    };

    // From failed #6: Only is disabled, Latest is checked and focused, Preview opens the Latest URL.
    await page.goto(await revision(page, 6));
    await openWithShare(page);
    let now = await dialogState(page);
    assert.equal(now.onlyDisabled, true);
    assert.equal(now.latest, true);
    assert.equal(now.focused, "latest");
    assert.equal(now.href, now.dataLatest);
    assert.doesNotMatch(now.href, /\/r\//);
    assert.match(now.href, /\?as=public$/);
    assert.equal(
      (await page.locator(PREVIEW).innerText()).trim(),
      "Preview what this link shows: #5",
    );
    await cancel(page);

    // Latest URL (#7): Only #7 is the default; Preview follows the radio; the height holds.
    await page.goto(postgres);
    await openWithShare(page);
    now = await dialogState(page);
    assert.equal(now.only, true);
    assert.equal(now.focused, "only");
    assert.equal(now.href, now.dataPinned);
    assert.match(now.href, /\/r\/[^/]+\/.*\?as=public$/);
    assert.equal(now.title, null);
    const { height, scroll } = now;
    await pickLatest(page);
    now = await dialogState(page);
    assert.equal(now.href, now.dataLatest);
    assert.equal(now.title, "Opens the Latest URL as a stranger sees it today");
    assert.ok(Math.abs(now.height - height) <= 1, `Latest: ${now.height} vs ${height}`);
    assert.ok(Math.abs(now.scroll - scroll) <= 1, `Latest content: ${now.scroll} vs ${scroll}`);
    assert.equal(
      (await page.locator('#share [data-track="latest"] .tnote').innerText()).trim(),
      "Latest: shows the newest revision. While #7 uploads, recipients see #5 with a syncing note.",
    );
    await page.locator("#share .expiry label", { hasText: "Never" }).click();
    now = await dialogState(page);
    assert.ok(Math.abs(now.height - height) <= 1, `Never: ${now.height} vs ${height}`);
    assert.ok(Math.abs(now.scroll - scroll) <= 1, `Never content: ${now.scroll} vs ${scroll}`);

    // Cancel resets: Only, 7 days, no label, focus on Only; the same through the s key.
    await page.locator('#share input[name="label"]').fill("x");
    await cancel(page);
    await openWithShare(page);
    now = await dialogState(page);
    assert.deepEqual([now.only, now.focused, now.week, now.label], [true, "only", true, ""]);
    assert.equal(now.href, now.dataPinned);
    await pickLatest(page);
    await page.locator("#share .expiry label", { hasText: "Never" }).click();
    await page.locator('#share input[name="label"]').fill("x");
    await cancel(page);
    await openWithKey(page);
    now = await dialogState(page);
    assert.deepEqual([now.only, now.focused, now.week, now.label], [true, "only", true, ""]);
    await cancel(page);

    // Webhook (all synced): creating a link focuses Copy.
    await page.goto(webhook);
    await openWithShare(page);
    assert.equal(
      (await page.locator('#share [data-track="latest"] .tnote').textContent())?.trim(),
      "Latest: shows the newest revision, now #3.",
    );
    assert.equal(await page.locator("#share [data-warn]").count(), 0);
    await page.locator('#share input[name="label"]').fill("spot");
    await page.locator("[data-share-submit]").click();
    await page.locator('[data-share-step="created"]').waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate('document.activeElement?.hasAttribute("data-share-copy")'),
      true,
    );

    // Phones fold the checklist per open, unless the shown track warns; never on a switch.
    const phone = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    await phone.page.goto(await revision(phone.page, 5));
    await openWithKey(phone.page);
    now = await dialogState(phone.page);
    assert.equal(now.only, true);
    assert.equal(await phone.page.locator('#share [data-track="latest"][data-warn]').count(), 1);
    assert.equal(now.sees, false, "#5 (Only, synced): folded");
    assert.equal(now.summary.text, "Title + all 2 files in #5");
    fits(now, "#5 Only");
    await pickLatest(phone.page);
    now = await dialogState(phone.page);
    assert.equal(now.sees, false, "no re-fold on a target change");
    assert.equal(now.summary.text, "Title + 2 files in #5 now, then every future revision");
    fits(now, "#5 Latest");
    await cancel(phone.page);
    await phone.page.goto(postgres);
    await openWithKey(phone.page);
    now = await dialogState(phone.page);
    assert.equal(now.sees, true, "#7 (Only, uploading): open");
    fits(now, "#7 Only");
    await cancel(phone.page);

    // Decision d-1: on phones the shown summary wraps rather than clip, and the hidden one adds no
    // height. Neither writer can seed a synced #10 (the demo's committer stops after seeding; the
    // suite's local-only writer never syncs), so Webhook's two sentences take the template's
    // wording for bigger numbers: #10 with 10 files (the decision's case; whether it needs a second
    // line depends on the font), then four-digit numbers, which need one at 390 px.
    const sumLatest = phone.page.locator("#share summary .sum-sm .when-latest");
    await phone.page.goto(webhook);
    // The full sentence stays its title too.
    assert.equal(
      await sumLatest.getAttribute("title"),
      "Title + 3 files in #3 now, then every future revision",
    );
    const longSummary = async (files: number, n: number, wraps: boolean) => {
      const only = `Title + all ${files} files in #${n}`;
      const latest = `Title + ${files} files in #${n} now, then every future revision`;
      await phone.page.goto(webhook);
      await phone.page.evaluate(`(() => {
        const set = (selector, text) => {
          const node = document.querySelector("#share summary .sum-sm " + selector);
          node.textContent = text;
          node.title = text;
        };
        set(".when-only", ${JSON.stringify(only)});
        set(".when-latest", ${JSON.stringify(latest)});
      })()`);
      await openWithKey(phone.page);
      now = await dialogState(phone.page);
      assert.equal(now.summary.text, only);
      fits(now, `#${n} Only (the Latest sentence hidden)`);
      await pickLatest(phone.page);
      now = await dialogState(phone.page);
      assert.equal(now.summary.text, latest);
      fits(now, `#${n} Latest (the Only sentence hidden)`);
      if (wraps)
        assert.ok(
          now.summary.shownHeight > now.summary.lineHeight + 1,
          `#${n} Latest wraps: ${now.summary.shownHeight} px for a ${now.summary.lineHeight} px line`,
        );
      await cancel(phone.page);
    };
    await longSummary(10, 10, false);
    await longSummary(1200, 1000, true);
  },
};
export default scenario;
