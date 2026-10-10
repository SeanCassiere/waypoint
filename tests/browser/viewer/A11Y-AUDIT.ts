// A11Y-AUDIT (writer): every page and state of the seeded demo writer (A1) at 1280×800 (mouse),
// 820×1180 (touch) and 390×844 (touch, mobile): axe with zero violations of any impact, light at
// all three widths and dark at 1280 and 390; the accessibility-tree skeleton against the committed
// tests/browser/a11y-audit/viewer/<ID>[-<state>].<width>.aria.yml (UPDATE_ARIA=1 writes them);
// and the invariants (one main, one banner holding the bar, one h1, the skip link first, named
// dialogs and popovers that close on Escape and give focus back, no positive tabindex, images
// and icons hidden or named). Every check is reported before the scenario fails.
import type { Page } from "playwright";
import { z } from "zod";

import { startDemoWriter, type ViewerScenario, type WriterHandle } from "../harness.ts";
import { Audit, quiet, settled, WIDTHS, type AxeException, type Width } from "./_a11y-audit-lib.ts";

/** False positives axe reports, each with a reason and the rule's help URL. Empty: the release's
 *  gate is zero violations. */
const AXE_EXCEPTIONS: readonly AxeException[] = [];

const TITLES = {
  pg: "Postgres 17 upgrade runbook",
  webhook: "Webhook idempotency research",
  audit: "Checkout flow screenshot audit",
  leaked: "Leaked .env in run output (do not share)",
} as const;

const collectionsOf = z.object({
  collections: z.array(
    z.object({ id: z.string(), public_id: z.string(), title: z.string(), deleted: z.boolean() }),
  ),
});
const revisionsOf = z.object({
  revisions: z.array(z.object({ public_id: z.string(), display_number: z.number() })),
});

interface Ids {
  pg: string;
  webhook: string;
  audit: string;
  leaked: string;
  /** Postgres revision public IDs by number. */
  rev: (n: number) => string;
  /** The audit collection's "View as gallery" target (shots/). */
  gallery: string;
}

/** Public IDs from the writer's JSON API, never hard-coded. */
async function resolve(writer: WriterHandle): Promise<Ids> {
  const { collections } = collectionsOf.parse(
    await (await writer.fetch("/api/collections?include_deleted=1&limit=100")).json(),
  );
  const find = (title: string) => {
    const found = collections.find((collection) => collection.title === title);
    if (!found) throw new Error(`no "${title}" on the demo writer`);
    return found;
  };
  const pg = find(TITLES.pg);
  const { revisions } = revisionsOf.parse(
    await (await writer.fetch(`/api/collections/${pg.id}/revisions`)).json(),
  );
  const rev = (n: number) => {
    const found = revisions.find((revision) => revision.display_number === n);
    if (!found) throw new Error(`no Postgres #${n}`);
    return found.public_id;
  };
  const audit = find(TITLES.audit).public_id;
  const page = await (await writer.fetch(`/c/${audit}/`)).text();
  const gallery = /<a class="gal" href="([^"]+)"/.exec(page)?.[1];
  if (!gallery) throw new Error("no View as gallery link on the audit collection");
  return {
    pg: pg.public_id,
    webhook: find(TITLES.webhook).public_id,
    audit,
    leaked: find(TITLES.leaked).public_id,
    rev,
    gallery,
  };
}

const visible = (page: Page, selector: string): Promise<boolean> =>
  page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
/** Clicks (mouse) or taps (touch) the first visible match. */
async function press(page: Page, selector: string, touch: boolean): Promise<void> {
  const target = page.locator(selector).locator("visible=true").first();
  if (touch) await target.tap();
  else await target.click();
}
const popoverOpen = (page: Page, id: string) =>
  page.waitForFunction(`document.getElementById(${JSON.stringify(id)})?.matches(":popover-open")`);
const dialogOpen = (page: Page) => page.waitForFunction(`!!document.querySelector("dialog[open]")`);
type PanelTab = "files" | "history" | "links";
/** The narrow panel is a sheet that starts closed: open it (the phone's tab bar, the bar's file or
 *  revision pill) and select the tab. Public links has no opener of its own: Files, then its tab. */
async function panelOn(page: Page, tab: PanelTab, width: Width): Promise<void> {
  if (width === "desktop") return;
  const opener = tab === "history" ? "history" : "files";
  if (width === "phone") await page.locator(`.tabbar [data-tab="${opener}"]`).tap();
  else await page.locator(`header.cbar a.pill.${opener === "files" ? "file" : "rev"}`).tap();
  await page.locator("#shell.open").waitFor({ state: "attached" });
  if (tab === "links") await page.locator('#panel [role=tab][data-tab="links"]').tap();
}
/** The page state names a panel tab: at 820 and 390 open the sheet on it before auditing (W05–W07,
 *  W09), and check it is the state audited at every width. */
async function panelState(
  page: Page,
  audit: Audit,
  label: string,
  tab: PanelTab,
  width: Width,
  compare: boolean,
): Promise<void> {
  if (!(await visible(page, "aside.panel#panel"))) await panelOn(page, tab, width);
  await quiet(page);
  const state = z.object({ shown: z.boolean(), selected: z.string(), compare: z.boolean() }).parse(
    await page.evaluate(`({
        shown: document.querySelector("aside.panel#panel").checkVisibility(),
        selected: document.querySelector('#panel [role=tab][aria-selected="true"]')?.dataset.tab ?? "",
        compare: !!document.querySelector("#tp-history input[data-compare-on]:checked"),
      })`),
  );
  audit.expect(`${label}: the panel shows`, state.shown, "the panel is hidden");
  audit.expect(`${label}: the ${tab} tab is selected`, state.selected === tab, state.selected);
  if (compare) audit.expect(`${label}: compare mode is on`, state.compare, "compare mode is off");
}

type Kind = "page" | "dialog" | "popover";
interface State {
  /** The skeleton file's stem: the A1 ID and the sub-state, e.g. "D05-copy". */
  name: string;
  url: (ids: Ids) => string;
  kind: Kind;
  widths?: readonly Width[];
  /** page: the panel tab the state shows (opened on the narrow sheet), and compare mode. */
  panel?: PanelTab;
  compare?: boolean;
  /** Opens the dialog or popover (or reaches the page state). */
  open?: (page: Page, width: Width, ids: Ids) => Promise<void>;
  /** dialog: the element focus returns to ("body" for a key-opened one; null when closing
   *  navigates, checked in `extra`); popover: its trigger. */
  returnTo?: (width: Width) => string | null;
  /** popover: its id. */
  popover?: string;
  /** Extra page-specific checks, run after the common ones (light scheme). */
  extra?: (page: Page, audit: Audit, label: string, width: Width, ids: Ids) => Promise<void>;
}

const MORE = (width: Width) =>
  width === "phone" ? '.tabbar [popovertarget="more-menu"]' : "header.cbar button.more";
const COPY = (width: Width) =>
  width === "phone" ? '.tabbar [popovertarget="copy-menu"]' : "header.cbar button.copyl";

/** The heading styles W18 (the generic 404) and W19 (the collection-bar 404) must share. */
const NOTFOUND_STYLE = `(() => { const h = document.querySelector(".notfound > :is(h1, h2)"); const s = getComputedStyle(h);
  return { tag: h.tagName, text: h.textContent.trim(), fontSize: s.fontSize, fontWeight: s.fontWeight, marginTop: s.marginTop, lineHeight: s.lineHeight }; })()`;
const notFoundStyle = z.object({
  tag: z.string(),
  text: z.string(),
  fontSize: z.string(),
  fontWeight: z.string(),
  marginTop: z.string(),
  lineHeight: z.string(),
});
let genericNotFound: z.infer<typeof notFoundStyle> | undefined;

/** Collection pages with the panel: "Files and history" is one heading (none while the narrow
 *  sheet is closed), in sentence case. */
async function panelHeading(page: Page, audit: Audit, label: string): Promise<void> {
  if ((await page.locator("aside.panel#panel").count()) === 0) return;
  const snapshot = await page.locator("body").ariaSnapshot();
  const headings = snapshot.match(/heading "Files and history"/g)?.length ?? 0;
  const shown = await visible(page, "aside.panel#panel");
  audit.expect(
    `${label}: ${shown ? "one" : "no"} "Files and history" heading`,
    headings === (shown ? 1 : 0),
    `${headings} headings`,
  );
  audit.expect(
    `${label}: no "Files and History"`,
    !/Files and History/.test(snapshot),
    "title case found",
  );
}

const STATES: readonly State[] = [
  {
    name: "W01",
    url: () => "/",
    kind: "page",
    async extra(page, audit, label, width) {
      if (width !== "desktop") return;
      // NAV-02/FD2: on Recent at 1280, "/" focuses the bar's field; Find stays closed.
      await page.locator("body").press("/");
      const state = z
        .object({ field: z.boolean(), find: z.boolean() })
        .parse(
          await page.evaluate(
            `({ field: document.activeElement === document.querySelector("[data-search] input"), find: document.querySelector("#find").open })`,
          ),
        );
      audit.expect(`${label}: "/" focuses the bar's field`, state.field, "focus elsewhere");
      audit.expect(`${label}: "/" leaves #find closed`, !state.find, "#find opened");
    },
  },
  { name: "W02", url: () => "/?q=runbook", kind: "page" },
  { name: "W03", url: () => "/?q=is:failed", kind: "page" },
  { name: "W04", url: () => "/?q=in:trash", kind: "page" },
  { name: "W05", url: (ids) => `/c/${ids.pg}/`, kind: "page", panel: "files", extra: panelHeading },
  {
    name: "W06",
    url: (ids) => `/c/${ids.pg}/?panel=history`,
    kind: "page",
    panel: "history",
    extra: panelHeading,
  },
  {
    name: "W07",
    url: (ids) => `/c/${ids.webhook}/?panel=links`,
    kind: "page",
    panel: "links",
    extra: panelHeading,
  },
  {
    name: "W08",
    url: (ids) => `/c/${ids.pg}/r/${ids.rev(5)}/runbook.md`,
    kind: "page",
    async extra(page, audit, label, width) {
      await panelHeading(page, audit, label);
      // B2: the Files tree's change marks are a hidden word, never aria-label on a plain span.
      await panelOn(page, "files", width);
      const marks = z
        .object({ current: z.string(), labelled: z.number(), words: z.array(z.string()) })
        .parse(
          await page.evaluate(`({
            current: document.querySelector("#tp-files a[aria-current] .k .vh")?.textContent ?? "",
            labelled: document.querySelectorAll("#tp-files span[aria-label]").length,
            words: [...document.querySelectorAll("#tp-files a[data-file] .k")].map((k) =>
              (k.querySelector(":scope > [aria-hidden=true]") ? "" : "not hidden ") + (k.querySelector(":scope > .vh")?.textContent ?? "none")),
          })`),
        );
      audit.expect(
        `${label}: the current file's mark reads "changed"`,
        marks.current === "changed",
        marks.current,
      );
      audit.expect(
        `${label}: no aria-label on a tree span`,
        marks.labelled === 0,
        `${marks.labelled}`,
      );
      audit.check(
        `${label}: tree marks`,
        marks.words.filter((word) => !["added", "changed", "unchanged"].includes(word)),
      );
      if (width !== "desktop") return;
      // B1: the hidden Document heading follows an in-frame navigation.
      await page.evaluate(`(() => { const w = document.querySelector("iframe.frame").contentWindow;
        w.location.assign(new URL("extensions.md", w.location.href).href); })()`);
      const ok = await page
        .waitForFunction(
          `[...document.querySelectorAll("#main > h2.vh")].some((h) => h.textContent === "Document: extensions.md")`,
          undefined,
          { timeout: 5000 },
        )
        .then(() => true)
        .catch(() => false);
      audit.expect(`${label}: the Document heading follows the frame`, ok, "not updated");
    },
  },
  {
    name: "W09",
    url: (ids) => `/c/${ids.pg}/?panel=history&compare=1`,
    kind: "page",
    panel: "history",
    compare: true,
    extra: panelHeading,
  },
  {
    name: "W10",
    url: (ids) => `/c/${ids.pg}/r/${ids.rev(7)}/changes`,
    kind: "page",
    extra: panelHeading,
  },
  { name: "W11", url: (ids) => ids.gallery, kind: "page", extra: panelHeading },
  {
    name: "W12",
    url: (ids) => ids.gallery,
    kind: "dialog",
    async open(page, width) {
      await press(page, "main a.shot", width !== "desktop");
      await page.locator("#lightbox[open]").waitFor();
    },
    returnTo: () => "main a.shot",
  },
  { name: "W13", url: () => "/links", kind: "page" },
  { name: "W13-revoked", url: () => "/links?state=revoked", kind: "page" },
  { name: "W14", url: () => "/trash", kind: "page" },
  { name: "W15", url: (ids) => `/c/${ids.leaked}/`, kind: "page" },
  { name: "W16", url: () => "/status", kind: "page" },
  { name: "W17", url: () => "/mcp", kind: "page" },
  {
    name: "W18",
    url: () => "/nope",
    kind: "page",
    async extra(page, audit, label, width) {
      if (width !== "desktop") return;
      genericNotFound = notFoundStyle.parse(await page.evaluate(NOTFOUND_STYLE));
      audit.expect(
        `${label}: the 404 heading is an h1`,
        genericNotFound.tag === "H1",
        genericNotFound.tag,
      );
    },
  },
  {
    name: "W19",
    url: (ids) => `/c/${ids.pg}/r/${ids.rev(4)}/extensions.md`,
    kind: "page",
    async extra(page, audit, label, width) {
      if (width !== "desktop") return;
      // B1b: under the collection bar the heading is an h2 that looks exactly like W18's h1.
      const style = notFoundStyle.parse(await page.evaluate(NOTFOUND_STYLE));
      audit.expect(`${label}: the 404 heading is an h2`, style.tag === "H2", style.tag);
      const generic = genericNotFound ?? style;
      audit.check(
        `${label}: the h2 looks like W18's h1`,
        (["text", "fontSize", "fontWeight", "marginTop", "lineHeight"] as const)
          .filter((key) => style[key] !== generic[key])
          .map((key) => `${key}: ${style[key]} vs ${generic[key]}`),
      );
    },
  },
  { name: "W20", url: (ids) => `/c/${ids.pg}/?as=public`, kind: "page" },
  { name: "W21", url: (ids) => `/c/${ids.pg}/r/${ids.rev(6)}/?as=public`, kind: "page" },
  { name: "W22", url: (ids) => `/c/${ids.pg}/r/${ids.rev(7)}/?as=public`, kind: "page" },
  {
    name: "D02",
    url: (ids) => `/c/${ids.webhook}/`,
    kind: "dialog",
    async open(page, width) {
      await press(page, MORE(width), width !== "desktop");
      await popoverOpen(page, "more-menu");
      await press(
        page,
        '#more-menu [commandfor="details"][data-focus="title"]',
        width !== "desktop",
      );
      await page.locator("dialog#details[open]").waitFor();
    },
    returnTo: MORE,
  },
  {
    name: "D03",
    url: (ids) => `/c/${ids.pg}/`,
    kind: "dialog",
    async open(page) {
      await page.locator("body").press("?");
      await page.locator("dialog#keys[open]").waitFor();
    },
    returnTo: () => "body",
  },
  {
    name: "D04-collection",
    url: (ids) => `/c/${ids.pg}/`,
    kind: "dialog",
    async open(page) {
      await page.locator("body").press("/");
      await page.locator("dialog#find[open]").waitFor();
    },
    returnTo: () => "body",
  },
  {
    name: "D04-recent",
    url: () => "/",
    kind: "dialog",
    widths: ["phone"],
    async open(page) {
      await press(page, 'header.bar [commandfor="find"]', true);
      await page.locator("dialog#find[open]").waitFor();
    },
    returnTo: () => 'header.bar button.show-sm[commandfor="find"]',
  },
  {
    name: "D05-copy",
    url: (ids) => `/c/${ids.pg}/r/${ids.rev(5)}/runbook.md`,
    kind: "popover",
    widths: ["desktop", "phone"],
    popover: "copy-menu",
    async open(page, width) {
      await press(page, COPY(width), width !== "desktop");
      await popoverOpen(page, "copy-menu");
    },
    returnTo: COPY,
  },
  {
    name: "D05-more",
    url: (ids) => `/c/${ids.pg}/r/${ids.rev(5)}/runbook.md`,
    kind: "popover",
    popover: "more-menu",
    async open(page, width) {
      await press(page, MORE(width), width !== "desktop");
      await popoverOpen(page, "more-menu");
    },
    returnTo: MORE,
    async extra(page, audit, label, width) {
      if (width !== "tablet") return;
      // NAV-04: at 761–1099.98 px the bar has no Copy link; ⋯'s Copy group is the Copy surface.
      audit.expect(
        `${label}: no Copy link in the bar`,
        !(await visible(page, "header.cbar button.copyl")),
        "the bar shows Copy link",
      );
      audit.expect(
        `${label}: ⋯ shows the Copy link group`,
        await visible(page, "#more-menu .midonly"),
        "no visible .midonly item",
      );
    },
  },
  {
    name: "D06",
    url: (ids) => `/c/${ids.pg}/`,
    kind: "popover",
    popover: "health-pop",
    async open(page, width) {
      await press(page, "header.bar button.health", width !== "desktop");
      await popoverOpen(page, "health-pop");
    },
    returnTo: () => "header.bar button.health",
  },
  {
    name: "D07",
    url: () => "/trash",
    kind: "dialog",
    async open(page, width) {
      await press(
        page,
        `button[data-action="restore"][data-title="${TITLES.leaked}"]`,
        width !== "desktop",
      );
      await dialogOpen(page);
    },
    returnTo: () => `button[data-action="restore"][data-title="${TITLES.leaked}"]`,
  },
  {
    name: "D08",
    url: () => "/trash",
    kind: "dialog",
    async open(page, width) {
      await press(
        page,
        `button[data-action="purge"][data-title="${TITLES.leaked}"]`,
        width !== "desktop",
      );
      await dialogOpen(page);
    },
    returnTo: () => `button[data-action="purge"][data-title="${TITLES.leaked}"]`,
  },
  {
    name: "D09",
    url: (ids) => `/c/${ids.pg}/?panel=history`,
    kind: "dialog",
    async open(page, width) {
      if (!(await visible(page, 'button[data-action="drop"][data-n="6"]')))
        await panelOn(page, "history", width);
      await press(page, 'button[data-action="drop"][data-n="6"]', width !== "desktop");
      await dialogOpen(page);
    },
    returnTo: () => 'button[data-action="drop"][data-n="6"]',
  },
  {
    name: "D10",
    url: () => "/",
    kind: "popover",
    widths: ["phone"],
    popover: "go-to",
    async open(page) {
      await press(page, "header.bar button.where", true);
      await popoverOpen(page, "go-to");
    },
    returnTo: () => "header.bar button.where",
  },
  // D01 last: it creates a share link on Webhook, which W07 and /links have already been audited
  // without. Its "Link created" step is audited as D01-created.
  {
    name: "D01",
    url: (ids) => `/c/${ids.webhook}/`,
    kind: "dialog",
    async open(page, width) {
      await openShare(page, width);
    },
    returnTo: (width) => shareOpener(width),
  },
  {
    name: "D01-created",
    url: (ids) => `/c/${ids.webhook}/`,
    kind: "dialog",
    async open(page, width) {
      await openShare(page, width);
      await page.locator('#share input[name="label"]').fill(`audit ${width}`);
      await press(page, "#share [data-share-submit]", width !== "desktop");
      await page.locator("#share [data-share-done]").waitFor({ state: "visible" });
    },
    // OW-03: once a link exists, closing the dialog opens the Public links tab (a navigation),
    // so focus starts over on that page instead of returning to Share.
    returnTo: () => null,
  },
];

/** Share opens from the bar (1280, 820) or the phone's More sheet. */
const shareOpener = (width: Width) =>
  width === "phone" ? '.tabbar [popovertarget="more-menu"]' : "header.cbar button.share";
async function openShare(page: Page, width: Width): Promise<void> {
  if (width === "phone") {
    await press(page, MORE(width), true);
    await popoverOpen(page, "more-menu");
    await press(page, '#more-menu .pubitem[commandfor="share"]', true);
  } else await press(page, "header.cbar button.share", width !== "desktop");
  await page.locator("dialog#share[open]").waitFor();
}

const scenario: ViewerScenario = {
  name: "A11Y-AUDIT axe, accessibility-tree skeletons and invariants on every writer page and state at three widths",
  async run(ctx) {
    const writer = await startDemoWriter();
    const ids = await resolve(writer);
    const audit = new Audit("viewer", AXE_EXCEPTIONS, "header.bar");
    let states = 0;
    for (const state of STATES)
      for (const { width, options } of WIDTHS) {
        if (state.widths && !state.widths.includes(width)) continue;
        const label = `${state.name}.${width}`;
        // A fresh context per state: no popover, sheet or last-visit state carries over.
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page state at a time.
        const { context, page } = await ctx.newPage({ ...options, colorScheme: "light" });
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- One page state at a time.
          await audited(page, audit, state, label, width, ids, writer.base);
          states += 1;
        } catch (error) {
          audit.check(`${label}: reachable`, [
            error instanceof Error ? error.message : String(error),
          ]);
        } finally {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Closed before the next state.
          await context.close();
        }
      }
    console.log(`A11Y-AUDIT viewer: ${states} page states audited`);
    audit.finish();
  },
};

async function audited(
  page: Page,
  audit: Audit,
  state: State,
  label: string,
  width: Width,
  ids: Ids,
  base: string,
): Promise<void> {
  await page.goto(`${base}${state.url(ids)}`);
  await settled(page);
  const dark = width !== "tablet";
  if (state.kind === "page") {
    // The skip link first, from a fresh load, before anything else takes focus.
    await audit.skipLink(page, label, true);
    await page.evaluate(`document.activeElement?.blur()`);
  }
  if (state.panel) await panelState(page, audit, label, state.panel, width, state.compare === true);
  await state.open?.(page, width, ids);
  await quiet(page);
  await audit.axeSchemes(page, label, state.name, dark);
  await audit.skeleton(page, label, `${state.name}.${width}`);
  await audit.invariants(page, label);
  await state.extra?.(page, audit, label, width, ids);
  if (state.kind === "dialog") {
    const returnTo = state.returnTo ? state.returnTo(width) : "body";
    await audit.dialog(page, label, returnTo);
    if (returnTo === null) {
      const links = await page
        .waitForURL((url) => url.searchParams.get("panel") === "links", { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      audit.expect(`${label}: closing opens the Public links tab`, links, page.url());
    }
  }
  if (state.kind === "popover")
    await audit.popover(page, label, state.popover ?? "", state.returnTo?.(width) ?? "body");
}

export default scenario;
