// A11Y-AUDIT (reader): every public reader page and state (A2) over a demo writer's data, at
// 1280×800 (mouse), 820×1180 (touch) and 390×844 (touch, mobile): axe with zero violations of any
// impact, light at all three widths and dark at 1280 and 390; the accessibility-tree skeleton
// against the committed tests/browser/a11y-audit/reader/<ID>[-<state>].<width>.aria.yml
// (UPDATE_ARIA=1 writes them); and the invariants (one main, at most one banner, the letterhead's
// one h1, the skip link first where the page has one, the Files and About popovers named and
// closing on Escape, no positive tabindex, images and icons hidden or named). Every check is
// reported before the scenario fails.
import type { Page } from "playwright";
import { z } from "zod";

import {
  freePort,
  startDemoReader,
  startDemoWriter,
  type ReaderScenario,
  type WriterHandle,
} from "../harness.ts";
import {
  Audit,
  quiet,
  settled,
  WIDTHS,
  type AxeException,
  type Width,
} from "../viewer/_a11y-audit-lib.ts";

/** False positives axe reports, each with a reason and the rule's help URL. Empty: the release's
 *  gate is zero violations. */
const AXE_EXCEPTIONS: readonly AxeException[] = [];

const shareLinks = z.object({
  share_links: z.array(z.object({ label: z.string().nullable(), url: z.string().nullish() })),
});
const collectionsOf = z.object({
  collections: z.array(z.object({ id: z.string(), title: z.string() })),
});
const created = z.object({ url: z.string() });

interface Urls {
  root: string;
  unknown: string;
  revoked: string;
  latest: string;
  pinned: string;
  fixture: string;
  images: string;
  binary: string;
  syncing: string;
}

/** A seeded link's URL, by label. */
async function seeded(writer: WriterHandle, label: string): Promise<string> {
  const { share_links } = shareLinks.parse(
    await (await writer.fetch("/api/share-links?limit=200")).json(),
  );
  const url = share_links.find((link) => link.label === label)?.url;
  if (!url) throw new Error(`no "${label}" link on the demo writer`);
  return url;
}

/** A new Latest link on the collection titled `title`, once the demo reader serves it. */
async function newLink(writer: WriterHandle, title: string, label: string): Promise<string> {
  const { collections } = collectionsOf.parse(
    await (await writer.fetch("/api/collections?limit=100")).json(),
  );
  const collection = collections.find((each) => each.title === title);
  if (!collection) throw new Error(`no "${title}" on the demo writer`);
  const response = await writer.fetch(`/api/collections/${collection.id}/share-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!response.ok) throw new Error(`share link ${response.status}`);
  const { url } = created.parse(await response.json());
  // The demo reader picks the link up from the writer's DB within a few seconds.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the reader serves it.
    if ((await fetch(url)).status === 200) return url;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling until the reader serves it.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the demo reader doesn't serve ${label} yet`);
}

type Kind = "page" | "popover";
interface State {
  name: string;
  url: (urls: Urls) => string;
  kind: Kind;
  /** The page has the shell's skip link (the root and denial pages don't). */
  shell: boolean;
  popover?: string;
  trigger?: string;
  /** Extra page-specific checks, run after the common ones (light scheme). */
  extra?: (page: Page, audit: Audit, label: string) => Promise<void>;
}

const filesList = z.object({
  count: z.number(),
  paths: z.array(z.string()),
  current: z.array(z.string()),
  shown: z.string(),
});
/** R05 (acceptance check 6): the open Files popover has one link per file and marks the current
 *  one aria-current="page". Its rows are A11Y-07's bare links in a group named by its heading
 *  (A11Y-07's markup, inside RX-03's list budget), not list items. */
async function filesLinks(page: Page, audit: Audit, label: string): Promise<void> {
  const files = filesList.parse(
    await page.evaluate(`({
      count: Number(document.querySelector("button.fbtn .n")?.textContent ?? "0"),
      paths: [...document.querySelectorAll("#files a[data-p]")].map((a) => a.dataset.p),
      current: [...document.querySelectorAll('#files a[aria-current="page"]')].map((a) => a.dataset.p),
      shown: document.querySelector("#files-cur .t")?.textContent ?? "",
    })`),
  );
  audit.check(`${label}: one link per file`, [
    ...(files.paths.length === files.count
      ? []
      : [`${files.paths.length} links for ${files.count} files`]),
    ...files.paths
      .filter((path, index) => files.paths.indexOf(path) !== index)
      .map((path) => `two links to ${path}`),
  ]);
  audit.expect(
    `${label}: the current file is aria-current="page"`,
    files.current.length === 1 && files.current[0] === files.shown,
    `aria-current on ${JSON.stringify(files.current)}, current ${files.shown}`,
  );
}

const STATES: readonly State[] = [
  { name: "R01", url: (u) => u.root, kind: "page", shell: false },
  { name: "R02", url: (u) => u.unknown, kind: "page", shell: false },
  { name: "R02-revoked", url: (u) => u.revoked, kind: "page", shell: false },
  { name: "R03", url: (u) => u.latest, kind: "page", shell: true },
  { name: "R04", url: (u) => u.pinned, kind: "page", shell: true },
  // Webhook's three files are tabs at every width; the Files popover (A11Y-07) needs more than
  // eight, so it opens on the demo's reader fixture (twelve files).
  {
    name: "R05",
    url: (u) => u.fixture,
    kind: "popover",
    shell: true,
    popover: "files",
    trigger: "button.fbtn",
    extra: filesLinks,
  },
  {
    name: "R06",
    url: (u) => u.latest,
    kind: "popover",
    shell: true,
    popover: "about",
    trigger: "button.abt",
  },
  { name: "R07", url: (u) => `${u.images}shots/checkout.png`, kind: "page", shell: true },
  { name: "R08", url: (u) => `${u.binary}data/events.parquet`, kind: "page", shell: true },
  { name: "R09", url: (u) => `${u.fixture}data/sample.csv`, kind: "page", shell: true },
  { name: "R10", url: (u) => u.syncing, kind: "page", shell: true },
];

async function audited(
  page: Page,
  audit: Audit,
  state: State,
  label: string,
  width: Width,
  urls: Urls,
): Promise<void> {
  const response = await page.goto(state.url(urls));
  await settled(page);
  audit.expect(
    `${label}: loads`,
    state.shell ? response?.status() === 200 : true,
    `status ${response?.status()}`,
  );
  if (state.kind === "page") {
    await audit.skipLink(page, label, state.shell);
    await page.evaluate(`document.activeElement?.blur()`);
  }
  if (state.kind === "popover" && state.trigger && state.popover) {
    const trigger = page.locator(state.trigger).locator("visible=true").first();
    if (width === "desktop") await trigger.click();
    else await trigger.tap();
    await page.waitForFunction(
      `document.getElementById(${JSON.stringify(state.popover)})?.matches(":popover-open")`,
    );
  }
  await quiet(page);
  await audit.axeSchemes(page, label, state.name, width !== "tablet");
  await audit.skeleton(page, label, `${state.name}.${width}`);
  await audit.invariants(page, label);
  await state.extra?.(page, audit, label);
  if (state.kind === "popover" && state.trigger && state.popover)
    await audit.popover(page, label, state.popover, state.trigger);
}

const scenario: ReaderScenario = {
  name: "A11Y-AUDIT axe, accessibility-tree skeletons and invariants on every reader page and state at three widths",
  async run(ctx) {
    let port = await freePort();
    // The reader fixture (more than eight files, a CSV) is the demo's opt-in extra collection.
    const start = () =>
      startDemoWriter({
        env: {
          WAYPOINT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
          WAYPOINT_DEMO_READER_FIXTURE: "1",
        },
      });
    let writer = await start();
    // The writer picks its own free port; in the rare case it took the reader's, start over once.
    if (new URL(writer.base).port === String(port)) {
      await writer.stop();
      port = await freePort();
      writer = await start();
    }
    const reader = await startDemoReader(writer.dataDir, port);
    const urls: Urls = {
      root: `${reader.origin}/`,
      unknown: `${reader.origin}/s/wps_doesnotexist/c/x/`,
      revoked: await seeded(writer, "Blog draft feedback"),
      latest: await seeded(writer, "Design review — Sam"),
      pinned: await seeded(writer, "Priya — payments review"),
      fixture: await seeded(writer, "Reader fixture"),
      images: await newLink(writer, "Checkout flow screenshot audit", "audit-images"),
      binary: await newLink(writer, "Search relevance eval — run 2026-10-06", "audit-binary"),
      // RX-11's demo seeding: Postgres's #7 is still uploading, so a Latest link shows the note.
      syncing: await newLink(writer, "Postgres 17 upgrade runbook", "audit-syncing"),
    };
    // R10 needs RX-11's demo seeding (Postgres #7 still uploading): without it the link shows a
    // plain Latest page, so skip R10 with a note rather than audit the wrong state.
    const seededSyncing = (await (await fetch(urls.syncing)).text()).includes('class="f pend"');
    if (!seededSyncing)
      console.log("A11Y-AUDIT reader: R10 skipped: RX-11's syncing seeding is absent");
    const audit = new Audit("reader", AXE_EXCEPTIONS, null);
    let states = 0;
    for (const state of STATES.filter((each) => each.name !== "R10" || seededSyncing))
      for (const { width, options } of WIDTHS) {
        const label = `${state.name}.${width}`;
        // oxlint-disable-next-line eslint/no-await-in-loop -- One page state at a time.
        const { context, page } = await ctx.newPage({ ...options, colorScheme: "light" });
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- One page state at a time.
          await audited(page, audit, state, label, width, urls);
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
    console.log(`A11Y-AUDIT reader: ${states} page states audited`);
    audit.finish();
  },
};
export default scenario;
