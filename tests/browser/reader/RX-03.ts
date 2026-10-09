// RX-03: every tab and tree row shows a type icon from the page's one sprite; files that can't be
// previewed end with "download · size"; the page title is "<file name> · <collection title>" and
// follows in-frame navigation; moving the current tab changes no tab's width.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const HASH = "sha256:" + "3".repeat(64);
const FIXTURES = {
  // 12 files: the Files tree, with an archive that can't be previewed.
  tree: {
    title: "Field kit",
    col: { id: "col_" + "h".repeat(26), pub: "hhhhhhhhhhhh" },
    rev: { id: "rev_" + "0".repeat(25) + "9", pub: "h9h9h9h9h9h9" },
    link: "shl_" + "0".repeat(25) + "9",
    head: "doc.md",
    files: [
      ["doc.md", "text/markdown", 120],
      ["archive/build-output.tar.gz", "application/gzip", 4_300_000],
      ["data/x.csv", "text/csv", 300],
      ["data/events.json", "application/json", 300],
      ["images/diagram.png", "image/png", 3000],
      ...[1, 2, 3, 4, 5, 6, 7].map((n): [string, string, number] => [
        `notes/day-${n}.md`,
        "text/markdown",
        200,
      ]),
    ],
  },
  // 3 files: tabs, names well under 80 characters (the reserved width measures the raw path).
  tabs: {
    title: "Webhook idempotency research",
    col: { id: "col_" + "j".repeat(26), pub: "jjjjjjjjjjjj" },
    rev: { id: "rev_" + "0".repeat(25) + "a", pub: "jajajajajaja" },
    link: "shl_" + "0".repeat(25) + "a",
    head: "summary.md",
    files: [
      ["summary.md", "text/markdown", 100],
      ["checklist.md", "text/markdown", 100],
      ["notes/retry-semantics-across-providers.md", "text/markdown", 100],
    ],
  },
} as const;
type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES];

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
/** Polls a page expression from Node: the shell's CSP blocks Playwright's in-page polling. */
async function until(page: Page, expression: string, timeout = 5000): Promise<void> {
  const start = performance.now();
  // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
  while ((await page.evaluate(expression)) !== true) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${expression}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const scenario: ReaderScenario = {
  name: "RX-03 file type icons, download marker, per-file title and stable tab widths",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    const tokens = new Map<Fixture, string>();
    for (const f of Object.values(FIXTURES)) {
      const token = newShareToken();
      tokens.set(f, token);
      ins(
        "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
        f.col.id,
        f.col.pub,
        f.title,
      );
      ins(
        "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
        f.rev.id,
        f.rev.pub,
        f.col.id,
        f.head,
      );
      for (const [path, mime, size] of f.files)
        ins(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
          f.rev.id,
          path,
          HASH,
          mime,
          size,
        );
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
        f.link,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, seeded in order.
        await hashShareToken(token),
        f.col.id,
        null,
        null,
        null,
      );
    }
    const reader = await startReader({
      db,
      blob: () => new Response("<!doctype html><title>doc</title><p>The document</p>"),
    });
    const shellBase = (f: Fixture) => `${reader.origin}/s/${tokens.get(f)}/c/${f.col.pub}/`;
    const frameBase = (f: Fixture) =>
      `${reader.origin}/x/${f.link}.${rawCap(f.link, f.rev.pub)}/r/${f.rev.pub}/`;
    const logs: string[][] = [];
    const open = async (page: Page, f: Fixture) => {
      const response = await page.goto(shellBase(f));
      assert.equal(response?.status(), 200, "loads the head");
      await until(
        page,
        `[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(${JSON.stringify(frameBase(f))}))`,
      );
    };
    // A frame-location message from the frame's own window, as the v2 rendition sends it.
    const post = async (page: Page, f: Fixture, path: string) => {
      const frame = page.frames().find((fr) => fr.url().startsWith(frameBase(f)));
      assert.ok(frame, "frame loaded");
      const href = new URL(frameBase(f)).pathname + path;
      await frame.evaluate(
        `parent.postMessage(${JSON.stringify({ type: "waypoint:location", href })}, "*")`,
      );
      await until(
        page,
        `document.querySelector("a[aria-current]")?.dataset.p === ${JSON.stringify(path)}`,
      );
    };
    const T = FIXTURES.tree;
    const S = FIXTURES.tabs;

    // The Files tree: icons render, the archive's accessible name carries its marker.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      logs.push(collectConsole(page));
      await open(page, T);
      assert.equal(await page.title(), "doc.md · Field kit", "title on load");
      assert.equal(
        await page.evaluate(`document.querySelectorAll("svg.sprite symbol").length`),
        6,
        "one sprite with six symbols",
      );
      await page.click(".fbtn");
      await until(page, `document.getElementById("files").matches(":popover-open")`);
      assert.equal(
        await page
          .getByRole("link", { name: "archive/build-output.tar.gz download · 4.1 MB" })
          .count(),
        1,
        "the archive row's accessible name",
      );
      assert.equal(await page.locator("#files small").count(), 1, "one download marker");
      const boxes = await json(
        page,
        `[...document.querySelectorAll("#files svg.ti")]
          .filter((svg) => svg.closest("details") === null || svg.closest("details").open)
          .map((svg) => {
            const r = svg.getBoundingClientRect();
            const b = svg.querySelector("use").getBBox();
            return [r.width, r.height, b.width, b.height];
          })`,
      );
      assert.ok(Array.isArray(boxes) && boxes.length >= 12, "icons in the open panel");
      for (const box of boxes)
        assert.ok(
          Array.isArray(box) && box.every((value) => Number(value) > 0),
          `icon has a box: ${JSON.stringify(box)}`,
        );
      await page.keyboard.press("Escape");

      // In-frame navigation: the title and the Files button's icon follow.
      await post(page, T, "data/x.csv");
      assert.equal(await page.title(), "x.csv · Field kit", "title follows the frame");
      assert.equal(
        await page.evaluate(`document.querySelector("#files-cur use").getAttribute("href")`),
        "#i-table",
        "Files button shows the table icon",
      );
    }

    // Tabs: moving aria-current changes no tab's width, on desktop and on a phone, where this
    // strip overflows and scrolls (tabs never shrink).
    for (const [viewport, size] of [
      ["desktop", VIEWPORTS.desktop],
      ["phone", VIEWPORTS.phone],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      const { page } = await ctx.newPage({ ...size });
      logs.push(collectConsole(page));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      await open(page, S);
      const widths = () =>
        json(
          page,
          `[...document.querySelectorAll(".ptabs2 a")].map((a) => a.getBoundingClientRect().width)`,
        );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      const before = await widths();
      assert.ok(Array.isArray(before) && before.length === 3, `${viewport}: three tabs`);
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
        await page.locator(".ptabs2 svg.ti").count(),
        3,
        `${viewport}: an icon on every tab`,
      );
      for (const path of ["checklist.md", "notes/retry-semantics-across-providers.md"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One navigation at a time.
        await post(page, S, path);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One navigation at a time.
        const after = await widths();
        assert.ok(Array.isArray(after) && after.length === 3);
        for (const [i, width] of before.entries())
          assert.ok(
            Math.abs(Number(width) - Number(after[i])) <= 0.5,
            `${viewport}, ${path} current: tab ${i} width ${String(width)} → ${String(after[i])}`,
          );
      }
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
        await page.title(),
        "retry-semantics-across-providers.md · Webhook idempotency research",
      );
    }

    // Forced colours: every icon's stroke follows its row's, tab's or button's text colour, the
    // current row's and tab's included.
    for (const f of [T, S]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, checked in order.
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
      logs.push(collectConsole(page));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, checked in order.
      await open(page, f);
      if (f === T) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, checked in order.
        await page.click(".fbtn");
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, checked in order.
        await until(page, `document.getElementById("files").matches(":popover-open")`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, checked in order.
      const pairs = await json(
        page,
        `[...document.querySelectorAll("#files a svg.ti, .fbtn svg.ti, .ptabs2 svg.ti")].map((svg) => [
          getComputedStyle(svg).stroke,
          getComputedStyle(svg.closest("a, button")).color,
        ])`,
      );
      assert.ok(
        Array.isArray(pairs) && pairs.length >= (f === T ? 12 : 3),
        "icons under forced colours",
      );
      for (const pair of pairs)
        assert.ok(
          Array.isArray(pair) && pair[0] === pair[1],
          `icon stroke follows the text colour: ${JSON.stringify(pair)}`,
        );
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
