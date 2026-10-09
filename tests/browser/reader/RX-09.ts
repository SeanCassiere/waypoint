// RX-09: links to a section work. Choosing a heading in the document's Contents puts its fragment
// in the address bar; opening that URL scrolls the frame there with no second request and no
// extra history entry; switching files drops it; fragments that fail the pattern never reach the
// frame or the address bar.
import { hashShareToken, newShareToken } from "@waypoint/core";
import { renderMarkdown, RENDERER_VERSION } from "@waypoint/render";
import type { Frame, Page } from "playwright";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type PageOptions,
  type ReaderScenario,
} from "../harness.ts";

const hash = (c: string) => "sha256:" + c.repeat(64);
const para = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Paragraph ${i + 1}: retries reuse the same key, so the receiver can drop repeats.`,
  ).join("\n\n");
// Four h2s, so the rendition has a Contents block; enough text after the last one to scroll it
// to the top on a phone.
const INDEX = [
  "# Webhook idempotency research",
  `## Background\n\n${para(8)}`,
  `## Recommendation\n\n${para(8)}`,
  `## Suggested delivery contract\n\n${para(8)}`,
  `## Open questions\n\n${para(40)}`,
].join("\n\n");
const OTHER = "# Other\n\nAnother file.\n";
const COL = { id: "col_" + "h".repeat(26), pub: "hhhhhhhhhhhh" };
const REV = { id: "rev_" + "0".repeat(25) + "h", pub: "h9h9h9h9h9h9" };
const LINK = "shl_" + "0".repeat(25) + "h";
const HEADING = "open-questions";

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (target: Page | Frame, expression: string): Promise<unknown> =>
  JSON.parse(String(await target.evaluate(`JSON.stringify(${expression})`)));
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = async (page: Page) => String(await page.evaluate("location.hash"));
const historyLength = async (page: Page) => Number(await page.evaluate("history.length"));

const scenario: ReaderScenario = {
  name: "RX-09 section links: the address bar keeps #heading, and opening it lands there",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    const bodies = new Map<string, string>([
      [hash("1"), INDEX],
      [hash("2"), await renderMarkdown(INDEX)],
      [hash("3"), OTHER],
      [hash("4"), await renderMarkdown(OTHER)],
    ]);
    for (const [blob, body] of bodies)
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", blob, body.length);
    for (const [source, output] of [
      [hash("1"), hash("2")],
      [hash("3"), hash("4")],
    ] as const)
      ins(
        "INSERT INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,1)",
        source,
        "markdown",
        RENDERER_VERSION,
        output,
        "text/html",
      );
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Webhook idempotency research",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "index.md",
    );
    for (const [path, blob] of [
      ["index.md", hash("1")],
      ["other.md", hash("3")],
    ] as const)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        REV.id,
        path,
        blob,
        "text/markdown",
        bodies.get(blob)!.length,
      );
    const token = newShareToken();
    ins(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
      LINK,
      await hashShareToken(token),
      COL.id,
      null,
      null,
      null,
    );
    const reader = await startReader({
      db,
      blob: (blob) => {
        const body = bodies.get(blob);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
      },
    });
    const shell = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const frameBase = `${reader.origin}/x/${LINK}.${rawCap(LINK, REV.pub)}/r/${REV.pub}/`;
    const rel = new URL(frameBase).pathname;
    const logs: string[][] = [];

    /** A fresh page that records every raw request and any dialog. */
    const fresh = async (options: PageOptions = VIEWPORTS.desktop) => {
      const { page } = await ctx.newPage(options);
      logs.push(collectConsole(page));
      const raw: string[] = [];
      page.on("request", (r) => {
        const url = new URL(r.url());
        if (url.pathname.startsWith("/x/")) raw.push(url.pathname);
      });
      const dialogs: string[] = [];
      page.on("dialog", (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
      return { page, raw, dialogs };
    };
    /** The document frame once it shows `path` and has loaded. */
    const docFrame = async (page: Page, path: string): Promise<Frame> => {
      await until(
        page,
        `document.querySelector(".docwrap")?.hasAttribute("data-loaded") === true`,
        10_000,
      );
      const frame = page.frames().find((f) => new URL(f.url()).pathname === rel + path);
      assert.ok(frame, `the frame shows ${path}`);
      await frame.waitForLoadState("load");
      return frame;
    };

    /** Opens index.md at the heading and checks it lands there, in one request, in place. */
    const openAtHeading = async (options: PageOptions) => {
      const { page, raw } = await fresh(options);
      const at = `${options.width}px`;
      // Read at commit, before the frame's load hands over the fragment: an entry added there
      // (a plain `src` assignment would add one) must show up in the comparison below.
      const response = await page.goto(`${shell}index.md#${HEADING}`, { waitUntil: "commit" });
      assert.equal(response?.status(), 200, `loads at ${at}`);
      const length = await historyLength(page);
      await page.waitForLoadState("load");
      const frame = await docFrame(page, "index.md");
      await pause(500);
      assert.ok(frame.url().endsWith(`#${HEADING}`), `the frame has the fragment at ${at}`);
      const place = await json(
        frame,
        `[document.getElementById(${JSON.stringify(HEADING)}).getBoundingClientRect().top, scrollY]`,
      );
      assert.ok(Array.isArray(place), "the heading's place");
      const [top = NaN, scrollY = NaN] = place.map(Number);
      assert.ok(top >= -2 && top <= 120, `heading at the top at ${at}: ${top}`);
      assert.ok(scrollY > 0, `scrolled at ${at}: ${scrollY}`);
      assert.deepEqual(
        raw.filter((p) => p === rel + "index.md"),
        [rel + "index.md"],
        `one request for the document at ${at}`,
      );
      assert.equal(await hashOf(page), `#${HEADING}`, `the bar keeps it at ${at}`);
      assert.equal(await historyLength(page), length, `no history entry at ${at}`);
      return page;
    };

    // TOC click: the address bar follows the heading, on the file's own link.
    {
      const { page } = await fresh();
      await page.goto(shell);
      const frame = await docFrame(page, "index.md");
      await frame
        .locator("details.toc")
        .getByRole("link", { name: "Open questions", exact: true })
        .click();
      await until(page, `location.hash === ${JSON.stringify(`#${HEADING}`)}`);
      assert.ok(
        String(await page.evaluate("location.pathname")).endsWith("/index.md"),
        "on index.md's own link",
      );
    }

    // Open with a fragment, then switch files: the fragment goes.
    {
      const page = await openAtHeading(VIEWPORTS.desktop);
      const other = page.locator('.ptabs2 a[data-p="other.md"]');
      await other.click();
      await page.waitForURL(`${shell}other.md`);
      await docFrame(page, "other.md");
      assert.equal(await hashOf(page), "", "switching drops the fragment");
    }

    // Phone, dark: the same landing.
    await openAtHeading({ ...VIEWPORTS.phone, colorScheme: "dark" });

    // Hostile fragments never reach the frame or run anything.
    for (const fragment of [`"><img src=x onerror=alert(1)>`, "a'b", "a".repeat(257)]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      const { page, dialogs } = await fresh();
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      await page.goto(`${shell}index.md#${fragment}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      const frame = await docFrame(page, "index.md");
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      await pause(300);
      const label = JSON.stringify(fragment.slice(0, 20));
      assert.deepEqual(dialogs, [], `no dialog for ${label}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      assert.equal(await page.evaluate(`document.querySelectorAll("img").length`), 0, label);
      assert.ok(!frame.url().includes("#"), `the frame has no fragment for ${label}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page per fragment, in order.
      assert.equal(Number(await frame.evaluate("scrollY")), 0, `stays at the top for ${label}`);
    }

    // Hostile reports: only a fragment that passes the pattern reaches the address bar.
    {
      const { page } = await fresh();
      await page.goto(shell);
      const frame = await docFrame(page, "index.md");
      const post = (fragment: string) =>
        frame.evaluate(
          `parent.postMessage({ type: "waypoint:location", href: location.pathname + ${JSON.stringify(fragment)} }, "*")`,
        );
      const before = await hashOf(page);
      for (const fragment of ["#a'b", "#" + "a".repeat(300)]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One report at a time, in order.
        await post(fragment);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One report at a time, in order.
        await pause(200);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One report at a time, in order.
        assert.equal(await hashOf(page), before, `ignored: ${fragment.slice(0, 20)}`);
      }
      await post("#ok-1");
      await until(page, `location.hash === "#ok-1"`);
      assert.ok(
        String(await page.evaluate("location.pathname")).endsWith("/index.md"),
        "on index.md's own link",
      );
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
