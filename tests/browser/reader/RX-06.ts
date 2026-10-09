// RX-06: every shell offers the current file's original bytes. A Download link at the end of the
// tab or Files row (an icon-only 44 px target on phones), or in the letterhead for one file; it
// follows in-frame navigation and saves the stored file, never the rendition, under its own name.
import { readFile } from "node:fs/promises";

import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Download, Page } from "playwright";

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

const hash = (c: string) => "sha256:" + c.repeat(64);
const BODIES = new Map<string, string>([
  [hash("1"), "# Field kit\n\nSee [day 1 notes](notes/a.md).\n"],
  [hash("2"), "<!doctype html><title>Field kit</title><h1>Field kit</h1><p>Rendered</p>"],
  [hash("3"), "region,requests\neu-west,1200\n"],
  [hash("4"), "# Day 1\n\nNotes.\n"],
  [hash("5"), "\u001f\u008b binary archive bytes"],
  [hash("6"), "# HTTP API rate limiting plan\n"],
  [hash("7"), "<!doctype html><title>doc</title><p>The document</p>"],
]);
type FileRow = readonly [path: string, mime: string, blob: string];
const FIXTURES = {
  // Four files: tabs, a markdown head with a rendition, CSV, a nested note and an archive.
  multi: {
    title: "Field kit",
    col: { id: "col_" + "k".repeat(26), pub: "kkkkkkkkkkkk" },
    rev: { id: "rev_" + "0".repeat(25) + "b", pub: "kbkbkbkbkbkb" },
    link: "shl_" + "0".repeat(25) + "b",
    head: "index.md",
    files: [
      ["index.md", "text/markdown", hash("1")],
      ["data.csv", "text/csv", hash("3")],
      ["notes/a.md", "text/markdown", hash("4")],
      ["bin.tar.gz", "application/gzip", hash("5")],
    ] as readonly FileRow[],
  },
  // Seven long names: tabs that overflow a phone, with the control beside them.
  tabs: {
    title: "Overflowing tabs",
    col: { id: "col_" + "m".repeat(26), pub: "mmmmmmmmmmmm" },
    rev: { id: "rev_" + "0".repeat(25) + "c", pub: "mcmcmcmcmcmc" },
    link: "shl_" + "0".repeat(25) + "c",
    head: "index.html",
    files: [
      "index.html",
      "shots/cart-overview-with-promotions.html",
      "shots/confirmation-screen-final.html",
      "shots/payment-details-card-entry.html",
      "shots/receipt-email-preview-long.html",
      "shots/shipping-address-autocomplete.html",
      "shots/zz-order-history-after-checkout.html",
    ].map((path): FileRow => [path, "text/html", hash("7")]),
  },
  // One file: the control leads the letterhead actions.
  single: {
    title: "HTTP API rate limiting plan",
    col: { id: "col_" + "n".repeat(26), pub: "nnnnnnnnnnnn" },
    rev: { id: "rev_" + "0".repeat(25) + "d", pub: "ndndndndndnd" },
    link: "shl_" + "0".repeat(25) + "d",
    head: "plan.md",
    files: [["plan.md", "text/markdown", hash("6")]] as readonly FileRow[],
  },
  // One file with a long nested path: the label wraps, so the file name is never cut.
  longSingle: {
    title: "Long single file",
    col: { id: "col_" + "p".repeat(26), pub: "pppppppppppp" },
    rev: { id: "rev_" + "0".repeat(25) + "e", pub: "pepepepepepe" },
    link: "shl_" + "0".repeat(25) + "e",
    head: "docs/very/long/folder/name/with-a-really-long-file-name-for-testing.md",
    files: [
      [
        "docs/very/long/folder/name/with-a-really-long-file-name-for-testing.md",
        "text/markdown",
        hash("6"),
      ],
    ] as readonly FileRow[],
  },
} as const;
type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES];

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
const numbers = async (page: Page, expression: string): Promise<number[]> => {
  const value = await json(page, expression);
  assert.ok(Array.isArray(value), `${expression} is a list`);
  return value.map(Number);
};
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
const control = (page: Page, name: string) => page.getByRole("link", { name, exact: true });
/** Clicks a control and returns the download it starts, with its saved bytes. */
async function download(
  page: Page,
  click: () => Promise<void>,
): Promise<{ download: Download; body: string }> {
  const started = page.waitForEvent("download", { timeout: 10_000 });
  await click();
  const event = await started;
  const path = await event.path();
  return { download: event, body: await readFile(path, "latin1") };
}

const scenario: ReaderScenario = {
  name: "RX-06 Download the original file from the shell: row, letterhead, phones, navigation",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    for (const [blob, body] of BODIES)
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", blob, body.length);
    // index.md's rendition: the frame shows HTML, the download must save the markdown.
    ins(
      "INSERT INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,1)",
      hash("1"),
      "markdown",
      9,
      hash("2"),
      "text/html",
    );
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
      for (const [path, mime, blob] of f.files)
        ins(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
          f.rev.id,
          path,
          blob,
          mime,
          BODIES.get(blob)!.length,
        );
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
        f.link,
        // oxlint-disable-next-line eslint/no-await-in-loop -- A few fixtures, seeded in order.
        await hashShareToken(token),
        f.col.id,
        null,
        null,
        null,
      );
    }
    const reader = await startReader({
      db,
      blob: (blob) => {
        const body = BODIES.get(blob);
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(Buffer.from(body, "latin1"));
      },
    });
    const shellBase = (f: Fixture) => `${reader.origin}/s/${tokens.get(f)}/c/${f.col.pub}/`;
    const frameBase = (f: Fixture) =>
      `${reader.origin}/x/${f.link}.${rawCap(f.link, f.rev.pub)}/r/${f.rev.pub}/`;
    const logs: string[][] = [];
    const open = async (page: Page, f: Fixture, path = "") => {
      const response = await page.goto(shellBase(f) + path);
      assert.equal(response?.status(), 200, `loads ${path || "the head"}`);
    };
    const waitForFrame = (page: Page, f: Fixture) =>
      until(
        page,
        `[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(${JSON.stringify(frameBase(f))}))`,
      );
    const M = FIXTURES.multi;

    // Desktop: the row control saves the markdown source, follows the frame, and sits beside the
    // download card's own button on an archive.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      logs.push(collectConsole(page));
      await open(page, M);
      await waitForFrame(page, M);
      const head = control(page, "Download index.md");
      assert.ok(await head.isVisible(), "Download index.md is visible");
      assert.equal(await head.innerText(), "Download", "labelled Download");
      assert.equal(
        await page.evaluate(`document.querySelector(".prow").lastElementChild.matches("a.dlb")`),
        true,
        "the control ends the row",
      );
      const first = await download(page, () => head.click());
      assert.equal(first.download.suggestedFilename(), "index.md");
      assert.equal(first.body, BODIES.get(hash("1")), "saves the markdown source");
      assert.equal(first.download.url(), `${frameBase(M)}index.md?download`);

      // In-frame navigation to notes/a.md: the control follows, from the row's data-p.
      const frame = page.frames().find((fr) => fr.url().startsWith(frameBase(M)));
      assert.ok(frame, "frame loaded");
      const href = new URL(frameBase(M)).pathname + "notes/a.md";
      await frame.evaluate(
        `parent.postMessage(${JSON.stringify({ type: "waypoint:location", href })}, "*")`,
      );
      await until(
        page,
        `document.querySelector(".dlb")?.getAttribute("aria-label") === "Download notes/a.md"`,
      );
      const moved = control(page, "Download notes/a.md");
      assert.equal(await moved.count(), 1, "renamed");
      const second = await download(page, () => moved.click());
      assert.equal(second.download.suggestedFilename(), "a.md");
      assert.equal(second.body, BODIES.get(hash("4")));

      // CSV saves its own bytes while the frame shows it as text.
      await open(page, M, "data.csv");
      const csv = await download(page, () => control(page, "Download data.csv").click());
      assert.equal(csv.download.suggestedFilename(), "data.csv");
      assert.equal(csv.body, BODIES.get(hash("3")));

      // The archive: the card's own button and the row control both save bin.tar.gz.
      await open(page, M, "bin.tar.gz");
      const card = page.locator("#doc");
      assert.equal(await card.innerText(), "Download", "the card keeps its button");
      for (const click of [
        () => card.click(),
        () => control(page, "Download bin.tar.gz").click(),
      ]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two controls, checked in order.
        const saved = await download(page, click);
        assert.equal(saved.download.suggestedFilename(), "bin.tar.gz");
        assert.equal(saved.body, BODIES.get(hash("5")));
      }
    }

    // Phone: an icon-only 44 px target with its accessible name.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone });
      logs.push(collectConsole(page));
      await open(page, M);
      const head = control(page, "Download index.md");
      assert.equal(await head.count(), 1, "accessible name unchanged");
      const box = await head.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `44×44: ${JSON.stringify(box)}`);
      assert.equal(await page.locator(".dlb .lbl").isVisible(), false, "label hidden");

      // Seven tabs: the strip still scrolls, the control stays inside the row, nothing overflows.
      const T = FIXTURES.tabs;
      await open(page, T);
      const [scrollWidth, clientWidth] = await numbers(
        page,
        `(() => { const s = document.querySelector(".ptabs2"); return [s.scrollWidth, s.clientWidth]; })()`,
      );
      assert.ok(scrollWidth! > clientWidth!, `strip scrolls: ${scrollWidth} > ${clientWidth}`);
      const [right, contentRight] = await numbers(
        page,
        `(() => { const row = document.querySelector(".prow"); const r = row.getBoundingClientRect();
          const pad = parseFloat(getComputedStyle(row).paddingRight);
          return [document.querySelector(".prow > .dlb").getBoundingClientRect().right, r.right - pad]; })()`,
      );
      assert.ok(
        Math.abs(right! - contentRight!) <= 1,
        `control's right edge ${right} vs ${contentRight}`,
      );
      assert.ok(
        Number(await page.evaluate("document.scrollingElement.scrollWidth")) <= 390,
        "no horizontal overflow",
      );
    }

    // One file: the control leads the letterhead actions, labelled with the path in mono.
    {
      const S = FIXTURES.single;
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop });
      logs.push(collectConsole(page));
      await open(page, S);
      const lead = control(page, "Download plan.md");
      assert.ok(await lead.isVisible(), "Download plan.md is visible");
      assert.equal(await lead.innerText(), "plan.md");
      assert.equal(
        await page.evaluate(
          `(() => { const a = document.querySelector(".acts > .dlb"); const ro = document.querySelector(".acts > .ro");
            return !!a && !!ro && !!(a.compareDocumentPosition(ro) & Node.DOCUMENT_POSITION_FOLLOWING); })()`,
        ),
        true,
        "before Read-only",
      );
      assert.match(
        String(
          await page.evaluate(`getComputedStyle(document.querySelector(".dlb .nm")).fontFamily`),
        ),
        /mono/i,
        "the name is in mono",
      );
      const saved = await download(page, () => lead.click());
      assert.equal(saved.download.suggestedFilename(), "plan.md");
      assert.equal(saved.body, BODIES.get(hash("6")));
    }

    // A long single-file path wraps inside the button: every character shows, nothing overflows.
    for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.tablet]) {
      const L = FIXTURES.longSingle;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      const { page } = await ctx.newPage({ ...viewport });
      logs.push(collectConsole(page));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      await open(page, L);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      const text = await page.evaluate(`document.querySelector(".acts > .dlb .nm").textContent`);
      assert.equal(text, L.head, `the full path at ${viewport.width}px`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two viewports, checked in order.
      const [clipped, right, height, pageWidth] = await numbers(
        page,
        `(() => { const n = document.querySelector(".acts > .dlb .nm"); const a = n.closest("a").getBoundingClientRect();
          return [+(n.scrollWidth > n.clientWidth || n.scrollHeight > n.clientHeight), a.right, a.height,
            document.scrollingElement.scrollWidth]; })()`,
      );
      const at = `at ${viewport.width}px: ${JSON.stringify({ clipped, right, height, pageWidth })}`;
      assert.equal(clipped, 0, `the name isn't clipped ${at}`);
      assert.ok(right! <= viewport.width, `inside the viewport ${at}`);
      assert.ok(pageWidth! <= viewport.width, `no horizontal overflow ${at}`);
      assert.ok(height! >= (viewport.touch ? 44 : 32), `tall enough ${at}`);
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
