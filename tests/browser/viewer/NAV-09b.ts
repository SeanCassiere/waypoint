// NAV-09b: one name per concept. On the seeded demo writer (Postgres #1–#5 synced, #6 failed, #7
// uploading; Webhook latest #3 synced, with links in every state; Leaked in Trash): the pinned
// sentences as they render, none of the retired words on any page, and the sweep's four pieces —
// the Copy menu's "Tailnet links" heading and Share footer, the raw items that name the file, the
// "Public links" tab and History's "public sees" chip.
import type { Page } from "playwright";
import { z } from "zod";

import {
  assert,
  axe,
  startDemoWriter,
  VIEWPORTS,
  type PageOptions,
  type ViewerScenario,
} from "../harness.ts";

const POSTGRES = "Postgres 17 upgrade runbook";
const WEBHOOK = "Webhook idempotency research";
const LEAKED = "Leaked .env in run output (do not share)";
const AUDIT = "Checkout flow screenshot audit";
const BAND = '[role="region"][aria-label="Public preview"]';
const SYNCING =
  "Public preview · A Latest link shows #5, the newest revision that has synced. Recipients see a “newer version is being synced” note until #7 finishes uploading.";

const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
const strings = z.array(z.string());
const flag = z.boolean();

/** The retired words (the brief's old-word table), checked over a whole page. */
const OLD_WORDS: readonly RegExp[] = [
  /\bshare links?\b/i,
  /\bactive links?\b/i,
  /\binactive\b/i,
  /\bnot latest\b/,
  /\bOpen raw\b/,
  /\bDownload file\b/,
  /Create one with Share/,
  /\bis:shared\b/,
  /\bis:pending\b/,
  /\bUnsynced\b/,
  /Files and History/,
];
/** The old fork label, checked only where it lived (History, the compare picker, Recent's and
 *  search's rows): Needs attention's "latest, on #5" names the latest revision's parent (OW-06b). */
const FORK = /\bon #\d+\b/;

/** Every aria-label and title at or under the matched elements. */
const NAMES = `(root) => [root, ...root.querySelectorAll("[aria-label],[title]")].flatMap((el) => [el.getAttribute("aria-label"), el.getAttribute("title")]).filter((value) => value)`;
/** The rendered text of the matched elements, then their aria-labels and titles. */
const wordsIn = (selector: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].flatMap((el) => [el.innerText, ...(${NAMES})(el)])`;
/** Link-state and chip words, to catch a chip that still says "Active". */
const CHIPS = `[...document.querySelectorAll("[data-link-state], .chip")].map((el) => el.textContent.replace(/\\s+/g, " ").trim())`;

/** Where `word` first matches in `texts`, with some context; null when it doesn't. */
function hit(texts: readonly string[], word: RegExp): string | null {
  for (const text of texts) {
    const match = word.exec(text);
    if (match) return norm(text.slice(Math.max(0, match.index - 40), match.index + 60));
  }
  return null;
}

/** No retired word in the page's text, aria-labels or titles; no chip reads "Active". */
async function noOldWords(page: Page, where: string): Promise<void> {
  const texts = strings.parse(await page.evaluate(wordsIn("body")));
  for (const word of OLD_WORDS) assert.equal(hit(texts, word), null, `${where}: ${String(word)}`);
  const chips = strings.parse(await page.evaluate(CHIPS));
  assert.ok(!chips.includes("Active"), `${where}: a chip reads Active (${chips.join(", ")})`);
}
/** No "on #N" fork label in the matched elements. */
async function noForkLabel(page: Page, selector: string, where: string): Promise<void> {
  const texts = strings.parse(await page.evaluate(wordsIn(selector)));
  assert.ok(texts.length > 0, `${where}: ${selector} is on the page`);
  assert.equal(hit(texts, FORK), null, `${where}: a fork label "on #N"`);
}

/**
 * axe's aria-required-children on the open Copy menu, as failure summaries. Narrow filter
 * (standing ruling 3): a node whose every failing child is NAV-04's handoff Preview `<summary>`
 * passes, as that summary's semantics are A11Y-AUDIT B3's fix, which removes this filter. The
 * footer's Share is a menuitem inside a generic div, so it is never filtered.
 */
const MENU_CHILDREN = `axe.run("#copy-menu", { runOnly: { type: "rule", values: ["aria-required-children"] } }).then((result) => JSON.stringify(result.violations.flatMap((violation) => violation.nodes.flatMap((node) => {
  const checks = [...node.any, ...node.all, ...node.none];
  const handoffOnly = checks.length > 0 && checks.every((check) => check.data?.values === "summary" && check.relatedNodes.length > 0 && check.relatedNodes.every((related) => document.querySelector(related.target[0])?.matches("#copy-menu details.handoff-d > summary") ?? false));
  return handoffOnly ? [] : [node.failureSummary ?? violation.id];
}))))`;

/** Opens the panel where it's a sheet: the file crumb at 820, the tab bar's History at 390. */
async function openPanel(page: Page, width: number): Promise<void> {
  if (width > 1099) return;
  if (width > 760) await page.locator("a.pill.file").tap();
  else await page.locator('.tabbar [data-tab="history"]').tap();
  await page.waitForFunction(`document.querySelector("#shell")?.classList.contains("open")`);
}
const tabsOf = z.object({
  overflow: z.boolean(),
  tabs: z.array(
    z.object({
      text: z.string(),
      top: z.number(),
      lines: z.number(),
      clipped: z.boolean(),
      countInline: z.boolean(),
    }),
  ),
});
/** The panel's tab strip: whether it overflows the panel, and per tab its words (without the
 *  count), how many lines the words take, whether the tab or its count is clipped or ellipsized,
 *  and whether the count sits on the words' line (decision d-1: it may drop under them when the
 *  tabs need more than the panel, but nothing may be clipped). */
const TABS = `(() => {
  const strip = document.querySelector("#panel .ptabs");
  const edge = strip.getBoundingClientRect();
  const tabs = [...strip.querySelectorAll("[role=tab]")].map((tab) => {
    const n = tab.querySelector(".n");
    const words = [...tab.childNodes].filter((node) => node !== n);
    const text = words.map((node) => node.textContent).join("");
    const rects = words.flatMap((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].filter((rect) => rect.width > 0);
    });
    const box = tab.getBoundingClientRect();
    const count = n.getBoundingClientRect();
    const style = getComputedStyle(tab);
    return {
      text: text.replace(/\\s+/g, " ").trim(),
      top: Math.round(box.top),
      lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
      clipped:
        tab.scrollWidth > tab.clientWidth + 0.5 ||
        style.textOverflow === "ellipsis" ||
        getComputedStyle(n).textOverflow === "ellipsis" ||
        box.left < edge.left - 0.5 ||
        box.right > edge.right + 0.5 ||
        count.right > box.right + 0.5,
      countInline: rects.some((rect) => count.top < rect.bottom && count.bottom > rect.top),
    };
  });
  return { overflow: strip.scrollWidth > strip.clientWidth + 0.5, tabs };
})()`;

/** The Copy menu's footer Share: an arrow-key menu item, axe-clean, that opens the share dialog
 *  and closes the menu. The menu must be open. */
async function footerShare(page: Page, where: string): Promise<void> {
  const menu = page.locator("#copy-menu");
  const share = menu.locator(".mnote [role=menuitem]");
  assert.equal(await share.count(), 1, `${where}: one footer Share`);
  assert.equal(await share.getAttribute("commandfor"), "share");
  assert.equal(await share.getAttribute("command"), "show-modal");
  assert.equal(await share.getAttribute("popovertarget"), null, `${where}: no popovertarget`);
  assert.equal(
    flag.parse(
      await page.evaluate(
        `document.querySelector("#copy-menu .mnote [role=menuitem]").parentElement.matches("div.mnote")`,
      ),
    ),
    true,
    `${where}: the footer is a div.mnote`,
  );
  assert.equal(await menu.locator("p").count(), 0, `${where}: no p inside the menu`);
  await menu.locator(".mi").last().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    flag.parse(
      await page.evaluate(
        `document.activeElement === document.querySelector("#copy-menu .mnote [role=menuitem]")`,
      ),
    ),
    true,
    `${where}: ArrowDown from the last item reaches Share`,
  );
  // Injects axe-core; MENU_CHILDREN then reads the checks' related nodes.
  await axe(page, { include: "#copy-menu", rules: ["aria-required-children"] });
  assert.deepEqual(
    strings.parse(JSON.parse(z.string().parse(await page.evaluate(MENU_CHILDREN)))),
    [],
    `${where}: the menu's children`,
  );
  await share.click();
  await page.locator("#share").waitFor({ state: "visible" });
  assert.equal(
    flag.parse(
      await page.evaluate(
        `document.querySelector("#share").open && document.querySelector("#share").matches(":modal")`,
      ),
    ),
    true,
    `${where}: Share opens the modal share dialog`,
  );
  assert.equal(
    flag.parse(
      await page.evaluate(`document.querySelector("#copy-menu").matches(":popover-open")`),
    ),
    false,
    `${where}: the Copy menu closed`,
  );
  await page.locator("#share").getByRole("button", { name: "Cancel" }).click();
  await page.locator("#share").waitFor({ state: "hidden" });
}

const scenario: ViewerScenario = {
  name: "NAV-09b one vocabulary: tailnet-scoped Copy menu, named file actions, Public links tab, pinned sentences",
  async run(ctx) {
    const writer = await startDemoWriter();
    const { base } = writer;
    const open = async (options: PageOptions = VIEWPORTS.desktop) =>
      (await ctx.newPage(options)).page;
    const page = await open();
    await page.goto(`${base}/`);
    const home = async (title: string) => {
      const href = await page.locator("a", { hasText: title }).first().getAttribute("href");
      const pub = /^\/c\/([^/]+)\//.exec(href ?? "")?.[1];
      assert.ok(pub, `${title}: a collection link on Home`);
      return `${base}/c/${pub}/`;
    };
    const postgres = await home(POSTGRES);
    const webhook = await home(WEBHOOK);
    /** A revision's pinned URL, as History links it. */
    const revision = async (at: Page, collection: string, n: number) => {
      await at.goto(`${collection}?panel=history`);
      const href = await at.locator(`#tp-history li.rv[data-n="${n}"] a.rvl`).getAttribute("href");
      assert.ok(href, `History links #${n}`);
      const url = new URL(href, base);
      url.search = "";
      return url.href;
    };
    const pg5 = await revision(page, postgres, 5);

    // Pinned sentences, as rendered -----------------------------------------------------------

    // RX-10's band, Latest behind: the sentence, then the band's own Back link.
    await page.goto(`${postgres}?as=public`);
    {
      const band = page.locator(BAND);
      const back = norm(await band.locator("a").last().innerText());
      const sentence = norm((await band.innerText()).replace(back, ""));
      assert.ok(sentence.startsWith(SYNCING), sentence);
    }
    {
      const phone = await open({ ...VIEWPORTS.phone, mobile: true });
      await phone.goto(`${postgres}?as=public`);
      const band = norm(await phone.locator(BAND).innerText());
      assert.ok(band.includes("Public preview · Latest links show #5"), band);
    }
    await page.goto(`${webhook}?as=public`);
    assert.ok(
      norm(await page.locator(BAND).innerText()).includes("A Latest link shows #3, the latest."),
    );
    // History → #2 → More → Preview as public.
    await page.goto(await revision(page, webhook, 2));
    await page.locator('header.cbar [popovertarget="more-menu"]').click();
    const preview = page.locator("#more-menu").getByRole("menuitem", { name: "Preview as public" });
    const previewHref = await preview.getAttribute("href");
    assert.ok(previewHref, "More has Preview as public");
    await page.goto(new URL(previewHref, base).href);
    assert.ok(
      norm(await page.locator(BAND).innerText()).includes(
        "An Only #2 link shows this revision. It won't change.",
      ),
    );
    // OW-03's Latest track.
    await page.goto(postgres);
    await page.locator("header.cbar button[commandfor=share]").click();
    await page.locator("#share").waitFor({ state: "visible" });
    await page.locator("#share label.opt", { hasText: "Latest revision" }).click();
    assert.ok(
      norm(await page.locator("#share").innerText()).includes(
        "Latest: shows the newest revision. While #7 uploads, recipients see #5 with a syncing note.",
      ),
    );
    await page.locator("#share").getByRole("button", { name: "Cancel" }).click();
    // OW-06b's Needs attention, with its parent wording kept verbatim (the fork-label exclusion).
    await page.goto(`${base}/`);
    assert.ok(
      norm(await page.locator("body").innerText()).includes(
        "Other machines and public links see #5 (with a syncing note)",
      ),
    );
    assert.ok(
      strings
        .parse(await page.evaluate(`[...document.querySelectorAll(".q")].map((q) => q.innerText)`))
        .map(norm)
        .includes("latest, on #5"),
      "Needs attention says latest, on #5",
    );
    // OW-14's purge dialog (cancelled).
    await page.goto(`${base}/trash`);
    await page
      .locator("li.item", { hasText: LEAKED })
      .getByRole("button", { name: "Purge…" })
      .click();
    {
      const confirm = page.locator("dialog#confirm");
      await confirm.waitFor({ state: "visible" });
      const hint = confirm.locator("[data-confirm-hint]");
      const input = confirm.locator("#confirm-input");
      assert.equal(
        norm(await confirm.locator("label[for=confirm-input]").innerText()),
        "To confirm, type the title or the public ID",
      );
      assert.equal(
        await confirm.getByRole("button", { name: "Copy title", exact: true }).count(),
        1,
      );
      assert.equal(
        await confirm.getByRole("button", { name: "Copy public ID", exact: true }).count(),
        1,
      );
      await input.fill(LEAKED);
      assert.equal(norm(await hint.innerText()), "Matches the title");
      await input.fill("");
      const pub = norm(await confirm.locator("[data-confirm-values] dd.v.mono").innerText());
      await input.fill(pub);
      assert.equal(norm(await hint.innerText()), "Matches the public ID");
      assert.equal(
        await confirm.getByRole("button", { name: "Purge permanently", exact: true }).count(),
        1,
      );
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await confirm.waitFor({ state: "hidden" });
    }

    // Vocabulary, rendered ----------------------------------------------------------------------

    for (const path of ["/", "/?q=is:shared", "/?q=is:pending", "/?q=in:trash"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await page.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await noOldWords(page, path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await noForkLabel(page, "li.item", `${path} rows`);
    }
    for (const path of [
      "/links",
      "/links?state=paused",
      "/links?state=expired",
      "/links?state=revoked",
      "/trash",
      "/status",
      "/mcp",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await page.goto(`${base}${path}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, visited in turn.
      await noOldWords(page, path);
    }
    await page.goto(pg5);
    await noOldWords(page, "Postgres #5 Files");
    await page.goto(`${pg5}?panel=history`);
    await noOldWords(page, "Postgres #5 History");
    await noForkLabel(page, "#tp-history", "Postgres History");
    await page.goto(`${postgres}?panel=history&compare=1`);
    await noForkLabel(page, "#tp-history", "Postgres compare picker");
    await page.goto(pg5);
    await page.locator("header.cbar button.copyl").click();
    await page.locator("#copy-menu").waitFor({ state: "visible" });
    // The handoff Preview open, so its text (#5 is "older") is checked too.
    await page.locator("#copy-menu details.handoff-d > summary").click();
    await page.locator("#copy-menu pre[data-handoff]").waitFor({ state: "visible" });
    assert.match(
      norm(await page.locator("#copy-menu pre[data-handoff]").innerText()),
      /revision: #5 \S+ \(older, /,
    );
    await noOldWords(page, "Postgres Copy menu");
    await page.keyboard.press("Escape");
    await page.locator('header.cbar [popovertarget="more-menu"]').click();
    await page.locator("#more-menu").waitFor({ state: "visible" });
    await noOldWords(page, "Postgres More menu");
    await page.keyboard.press("Escape");
    await page.goto(`${webhook}?panel=links`);
    await page.locator("#tp-links details.inactive > summary").click();
    assert.match(
      norm(await page.locator("#tp-links details.inactive > summary").innerText()),
      /^Show \d+ expired or revoked$/,
    );
    await noOldWords(page, "Webhook Public links tab");

    // §1: the Copy menu's tailnet heading and its Share footer -----------------------------------

    await page.goto(pg5);
    await page.locator("header.cbar button.copyl").click();
    await page.locator("#copy-menu").waitFor({ state: "visible" });
    {
      const heading = page.locator("#copy-menu .lbl").first();
      assert.equal(await heading.locator("svg.ic").count(), 1, "the heading's lock");
      assert.equal(
        norm((await heading.textContent()) ?? ""),
        "Tailnet links · open only on your tailnet",
      );
      assert.equal(
        norm((await page.locator("#copy-menu .mnote").textContent()) ?? ""),
        "Need a link for someone outside the tailnet? Use Share.",
      );
    }
    await footerShare(page, "1280");
    {
      const phone = await open(VIEWPORTS.phone);
      await phone.goto(pg5);
      await phone.locator('.tabbar [popovertarget="copy-menu"]').tap();
      await phone.locator("#copy-menu").waitFor({ state: "visible" });
      assert.equal(
        norm((await phone.locator("#copy-menu .lbl").first().textContent()) ?? ""),
        "Tailnet links · open only on your tailnet",
      );
      await footerShare(phone, "390");
    }
    // 761–1099: ⋯ keeps NAV-04's "Copy link" group, with no tailnet footer.
    {
      const mid = await open({ width: 900, height: 1000 });
      await mid.goto(pg5);
      await mid.locator('header.cbar [popovertarget="more-menu"]').click();
      await mid.locator("#more-menu").waitFor({ state: "visible" });
      assert.equal(norm(await mid.locator("#more-menu .lbl.midonly").innerText()), "COPY LINK");
      assert.equal(
        norm((await mid.locator("#more-menu .lbl.midonly").textContent()) ?? ""),
        "Copy link",
      );
      assert.equal(await mid.locator("#more-menu .mnote").count(), 0);
    }
    // The folder gallery renders the same Copy menu, so its footer Share opens a #share there too
    // (review round 2: the gallery had no share dialog).
    {
      await page.goto(`${base}/`);
      await page.goto(await home(AUDIT));
      const href = await page.locator(".tree a.gal").first().getAttribute("href");
      assert.ok(href, "the audit's Files tree has a View as gallery row");
      await page.goto(new URL(href, base).href);
      await page.locator("header.cbar button.copyl").click();
      await page.locator("#copy-menu").waitFor({ state: "visible" });
      await footerShare(page, "gallery");
      // Creating a link there ends where the created dialog says it can be copied again: Done
      // reloads the gallery on its Public links tab, which lists the new link (review round 4).
      const gallery = new URL(page.url());
      await page.locator("header.cbar button.copyl").click();
      await page.locator("#copy-menu").waitFor({ state: "visible" });
      await page.locator("#copy-menu .mnote [role=menuitem]").click();
      await page.locator("#share").waitFor({ state: "visible" });
      await page.locator('#share input[name="label"]').fill("NAV-09b gallery");
      await page.locator("[data-share-submit]").click();
      await page.locator('[data-share-step="created"]').waitFor({ state: "visible" });
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("panel") === "links"),
        page.locator("#share [data-share-done]").click(),
      ]);
      await page.locator("#tp-links").waitFor({ state: "attached" });
      assert.equal(new URL(page.url()).pathname, gallery.pathname, "gallery: Done stays on it");
      const tab = page.locator("#panel [role=tab][data-tab=links]");
      assert.equal(await tab.getAttribute("aria-selected"), "true", "gallery: Public links open");
      assert.match(
        norm((await tab.textContent()) ?? ""),
        /^Public links\s*\d+$/,
        "gallery: the tab reads Public links",
      );
      assert.ok(
        norm((await page.locator("#tp-links").textContent()) ?? "").includes("NAV-09b gallery"),
        "gallery: the Public links tab lists the new link",
      );
      await noOldWords(page, "gallery Public links tab");
    }

    // The panel toggle and the keys dialog say "Files and history" --------------------------------

    {
      const toggle = page.locator("header.cbar button.ptog");
      assert.equal(await toggle.getAttribute("aria-label"), "Files and history");
      assert.ok((await toggle.getAttribute("title"))?.startsWith("Files and history"));
      await page.goto(pg5);
      await page.locator("body").press("?");
      await page.locator("#keys[open]").waitFor();
      assert.ok(
        norm(await page.locator("#keys").innerText()).includes("Show or hide Files and history"),
      );
      await page.keyboard.press("Escape");
    }

    // §2: the raw items name the current file, also after in-frame navigation ----------------------

    {
      const more = page.locator('header.cbar [popovertarget="more-menu"]');
      const rawItem = page.locator("#more-menu [data-open-raw]");
      const download = page.locator("#more-menu [data-download-raw]");
      await more.click();
      assert.equal(norm(await rawItem.innerText()), "Open runbook.md raw");
      assert.equal(norm(await download.innerText()), "Download runbook.md");
      assert.equal(await rawItem.getAttribute("title"), "runbook.md");
      await page.keyboard.press("Escape");
      await page.locator('#tp-files a[data-file="extensions.md"]').click();
      await page.waitForFunction(
        `[...document.querySelectorAll("#more-menu [data-file-name]")].every((name) => name.textContent === "extensions.md")`,
      );
      await more.click();
      assert.equal(norm(await rawItem.innerText()), "Open extensions.md raw");
      assert.equal(norm(await download.innerText()), "Download extensions.md");
      assert.equal(await download.getAttribute("title"), "extensions.md");
      await page.keyboard.press("Escape");
    }
    // A long file name with no break in it wraps inside its item: the menu (and the phone's
    // sheet) never grows sideways, and the item still says the whole name.
    {
      const long = `${"postgres_upgrade_runbook_".repeat(4).slice(0, 80)}.md`;
      const made = await writer.api("/api/collections", {
        title: "Long file name",
        files: [await writer.write(long, "# Long\n")],
      });
      for (const [label, viewport] of [
        ["1280", VIEWPORTS.desktop],
        ["820", VIEWPORTS.tablet],
        ["390", VIEWPORTS.phone],
      ] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
        const at = await open(viewport);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
        await at.goto(`${base}${new URL(made.url).pathname}`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
        await at.locator('[popovertarget="more-menu"]:visible').first().click();
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
        await at.locator("#more-menu").waitFor({ state: "visible" });
        assert.equal(
          // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
          norm(await at.locator("#more-menu [data-open-raw]").innerText()),
          `Open ${long} raw`,
          `${label}: the raw item names the whole file`,
        );
        assert.equal(
          // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
          norm(await at.locator("#more-menu [data-download-raw]").innerText()),
          `Download ${long}`,
          `${label}: the download item names the whole file`,
        );
        const overflow = z.array(z.string()).parse(
          // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport at a time.
          await at.evaluate(
            `[document.querySelector("#more-menu .mbox"), ...document.querySelectorAll("#more-menu [data-open-raw], #more-menu [data-download-raw]"), document.documentElement].filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.tagName + "." + el.className)`,
          ),
        );
        assert.deepEqual(overflow, [], `${label}: nothing scrolls sideways`);
      }
    }

    // §3: "Public links" fits beside Files and History on one line ---------------------------------

    // Postgres gets a Latest link (the tab shows once a collection has links), so its History 7
    // is beside "Public links"; Webhook has the most links.
    {
      const found = z
        .object({ collections: z.array(z.object({ id: z.string(), title: z.string() })) })
        .parse(
          await (
            await writer.fetch(`/api/collections?query=${encodeURIComponent(POSTGRES)}`)
          ).json(),
        );
      const id = found.collections.find((collection) => collection.title === POSTGRES)?.id;
      assert.ok(id, "the Postgres collection");
      const made = await writer.fetch(`/api/collections/${id}/share-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "spot-check" }),
      });
      assert.ok(made.ok, `link: ${made.status}`);
    }
    for (const [label, viewport] of [
      ["1280", VIEWPORTS.desktop],
      ["820", VIEWPORTS.tablet],
      ["390", VIEWPORTS.phone],
    ] as const)
      for (const [name, url] of [
        ["Postgres", postgres],
        ["Webhook", webhook],
      ] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        const at = await open(viewport);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        await at.goto(url);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        await openPanel(at, viewport.width);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        const strip = tabsOf.parse(await at.evaluate(TABS));
        assert.deepEqual(
          strip.tabs.map((tab) => tab.text),
          ["Files", "History", "Public links"],
          `${label} ${name}: the tab words, in order`,
        );
        assert.deepEqual(
          strip.tabs.map((tab) => tab.lines),
          [1, 1, 1],
          `${label} ${name}: each tab's words on one line`,
        );
        assert.equal(
          new Set(strip.tabs.map((tab) => tab.top)).size,
          1,
          `${label} ${name}: one row`,
        );
        assert.ok(!strip.overflow, `${label} ${name}: the tab strip fits the panel`);
        assert.ok(!strip.tabs.some((tab) => tab.clipped), `${label} ${name}: no tab is clipped`);
        // The strict one-line check, only at the demo counts: after decision d-1's padding the
        // tabs leave at least 15% spare in the dev machine's page font at all three widths
        // (16.5% at 1280, the tightest), so wider CI fonts still fit (standing ruling 7).
        assert.deepEqual(
          strip.tabs.map((tab) => tab.countInline),
          [true, true, true],
          `${label} ${name}: each count beside its words`,
        );
        if (name !== "Webhook") continue;
        // Valid but large counts (review r2): the words never wrap or ellipsize and nothing is
        // clipped; a count may drop under its words (decision d-1).
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        await at.evaluate(
          `document.querySelectorAll("#panel .ptabs [role=tab] .n").forEach((n, i) => { n.textContent = ["2000", "1000", "100"][i]; })`,
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- One viewport and collection at a time.
        const big = tabsOf.parse(await at.evaluate(TABS));
        assert.deepEqual(
          big.tabs.map((tab) => [tab.text, tab.lines]),
          [
            ["Files", 1],
            ["History", 1],
            ["Public links", 1],
          ],
          `${label} large counts: the words whole, in order, on one line each`,
        );
        assert.ok(!big.overflow, `${label} large counts: the tab strip fits the panel`);
        assert.ok(!big.tabs.some((tab) => tab.clipped), `${label} large counts: nothing clipped`);
      }

    // §4: History's "public sees" on the revision Latest links show --------------------------------

    await page.goto(`${postgres}?panel=history`);
    assert.deepEqual(
      strings.parse(
        await page.evaluate(
          `[...document.querySelectorAll("#tp-history li.rv")].filter((row) => row.querySelector(".chip.public")).map((row) => row.dataset.n + " " + row.querySelector(".chip.public").textContent.trim())`,
        ),
      ),
      ["5 public sees"],
    );
    // #7 is the latest and still uploading: its state chip takes precedence over "latest", as
    // before this brief (decision d-2; the bar's revision pill says "latest · uploading").
    assert.deepEqual(
      strings.parse(
        await page.evaluate(
          `[...document.querySelectorAll('#tp-history li.rv[data-n="7"] .h .chip')].map((chip) => chip.textContent.trim().split(/\\s+/)[0])`,
        ),
      ),
      ["uploading"],
    );
    await page.goto(`${webhook}?panel=history`);
    assert.equal(await page.locator("#tp-history .chip.public").count(), 0);
  },
};
export default scenario;
