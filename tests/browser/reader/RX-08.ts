// RX-08: text, code, logs, JSON and CSV read like documents. The reader serves each file's `text`
// or `csv` rendition in the frame: a header named from the frame URL, a non-selectable gutter
// with #L<n> anchors, lines that wrap under the code, highlighting, formatted one-line JSON with
// its note, visible control markers, and a bounded table with a sticky header.
import { hashShareToken, newShareToken } from "@waypoint/core";
import {
  CSV_RENDERER_NAME,
  CSV_RENDERER_VERSION,
  renderCsv,
  renderText,
  TEXT_RENDERER_NAME,
  TEXT_RENDERER_VERSION,
} from "@waypoint/render";
import type { Frame, Page } from "playwright";

import {
  bigLog,
  DRAIN_SCRIPT,
  METRICS_JSON,
  resultsCsv,
  TROJAN_JS,
} from "../../../packages/render/tests/golden-text.ts";
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

const COL = { id: "col_" + "t".repeat(26), pub: "tttttttttttt" };
const REV = { id: "rev_" + "0".repeat(25) + "t", pub: "t8t8t8t8t8t8" };
const LINK = "shl_" + "0".repeat(25) + "t";
const FILES = [
  { path: "drain.sh", mime: "text/x-shellscript", body: DRAIN_SCRIPT },
  { path: "metrics.json", mime: "application/json", body: METRICS_JSON },
  { path: "big.log", mime: "text/plain", body: bigLog() },
  { path: "results.csv", mime: "text/csv", body: resultsCsv() },
  { path: "trojan.js", mime: "text/javascript", body: TROJAN_JS },
] as const;
const NOTE =
  "Formatted for reading: the original is one 570-byte line. Download (above) gives you the file exactly as it was shared.";
const FOOTER = "784 more rows aren't shown. Download the file to see them all.";

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
/** The document has no horizontal scroll. */
const NO_SIDEWAYS =
  "document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth";

const scenario: ReaderScenario = {
  name: "RX-08 text, code, logs, JSON and CSV show as text and table views in the frame",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    const bodies = new Map<string, string>();
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Field kit: renditions",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "drain.sh",
    );
    for (const [index, file] of FILES.entries()) {
      const source = "sha256:" + String(index + 1).repeat(64);
      const output = "sha256:" + "abcde"[index]!.repeat(64);
      const byteLength = Buffer.byteLength(file.body, "utf8");
      const csv = file.mime === "text/csv";
      // oxlint-disable-next-line eslint/no-await-in-loop -- Five files, rendered in order.
      const html = await (csv ? renderCsv : renderText)(file.body, { mime: file.mime, byteLength });
      if (html === null) throw new Error(`${file.path}: no rendition`);
      bodies.set(source, file.body);
      bodies.set(output, html);
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", source, byteLength);
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", output, html.length);
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        REV.id,
        file.path,
        source,
        file.mime,
        byteLength,
      );
      ins(
        "INSERT INTO renditions (source_hash,renderer,renderer_version,output_hash,output_mime,created_at) VALUES (?,?,?,?,?,1)",
        source,
        csv ? CSV_RENDERER_NAME : TEXT_RENDERER_NAME,
        csv ? CSV_RENDERER_VERSION : TEXT_RENDERER_VERSION,
        output,
        "text/html",
      );
    }
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
      blob: (hash) => {
        const body = bodies.get(hash);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
      },
    });
    const shell = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const rel = new URL(`${reader.origin}/x/${LINK}.${rawCap(LINK, REV.pub)}/r/${REV.pub}/`)
      .pathname;
    const logs: string[][] = [];

    /** A fresh page at `path`, and its document frame once loaded; records any dialog. */
    const open = async (path: string, options: PageOptions = VIEWPORTS.desktop) => {
      const { page } = await ctx.newPage(options);
      logs.push(collectConsole(page));
      const dialogs: string[] = [];
      page.on("dialog", (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
      const response = await page.goto(shell + path);
      assert.equal(response?.status(), 200, `${path}: the shell loads`);
      await until(
        page,
        `document.querySelector(".docwrap")?.hasAttribute("data-loaded") === true`,
        10_000,
      );
      const bare = path.split("#")[0];
      const frame = page.frames().find((f) => new URL(f.url()).pathname === rel + bare);
      assert.ok(frame, `the frame shows ${bare}`);
      await frame.waitForLoadState("load");
      return { page, frame, dialogs };
    };

    // Phone, light, touch: header, gutter, wrapping under the code, copy without numbers.
    {
      const { frame } = await open("drain.sh", { ...VIEWPORTS.phone, colorScheme: "light" });
      assert.equal(
        await frame.evaluate(`document.querySelector(".fh .fn").textContent`),
        "drain.sh",
      );
      assert.equal(await frame.evaluate("document.title"), "drain.sh");
      assert.equal(await frame.evaluate(`document.querySelectorAll(".l").length`), 37);
      assert.equal(await frame.evaluate(NO_SIDEWAYS), true, "no horizontal scroll on a phone");
      assert.equal(
        await frame.evaluate(`getComputedStyle(document.querySelector(".n")).userSelect`),
        "none",
      );
      // Every row of every wrapped line starts at or right of its code cell, not under the number.
      const wrapped = await json(
        frame,
        `[...document.querySelectorAll(".l .c")].map((c) => {
          const range = document.createRange();
          range.selectNodeContents(c);
          const rects = [...range.getClientRects()];
          const left = c.getBoundingClientRect().left;
          const tops = new Set(rects.map((r) => Math.round(r.top)));
          return { rows: tops.size, ok: rects.every((r) => r.left >= left - 0.5) };
        }).filter((line) => line.rows > 1)`,
      );
      assert.ok(Array.isArray(wrapped) && wrapped.length > 0, "some lines wrap on a phone");
      assert.ok(
        wrapped.every(
          (line: unknown) =>
            typeof line === "object" && line !== null && "ok" in line && line.ok === true,
        ),
        "continuation rows stay under the code",
      );
      const copied = await frame.evaluate(`(() => {
        const range = document.createRange();
        range.setStart(document.querySelector("#L1 .c"), 0);
        const last = document.querySelector("#L3 .c");
        range.setEnd(last, last.childNodes.length);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      })()`);
      assert.equal(copied, DRAIN_SCRIPT.split("\n").slice(0, 3).join("\n"), "copy has no numbers");
    }

    // Desktop, dark: the warm paper and well, tokens in their dark colours.
    {
      const { frame } = await open("drain.sh", { ...VIEWPORTS.desktop, colorScheme: "dark" });
      assert.equal(
        await frame.evaluate(`getComputedStyle(document.documentElement).backgroundColor`),
        "rgb(21, 21, 20)",
      );
      assert.equal(
        await frame.evaluate(
          `getComputedStyle(document.querySelector("pre.lines")).backgroundColor`,
        ),
        "rgb(30, 29, 26)",
      );
      const colours = await json(
        frame,
        `(() => {
          const span = document.querySelector('.c span[style*="--shiki-dark"]');
          const hex = span.style.getPropertyValue("--shiki-dark").trim();
          const probe = document.createElement("i");
          probe.style.color = hex;
          document.body.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return [getComputedStyle(span).color, expected];
        })()`,
      );
      assert.ok(Array.isArray(colours));
      assert.equal(colours[0], colours[1], "a token shows its --shiki-dark colour");
    }

    // A line link: the frame lands on #L23 and marks it.
    {
      const { page, frame } = await open("drain.sh#L23", {
        ...VIEWPORTS.desktop,
        colorScheme: "light",
      });
      await pause(300);
      assert.equal(await frame.evaluate("location.hash"), "#L23");
      const place = await json(
        frame,
        `(() => { const r = document.getElementById("L23").getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; })()`,
      );
      assert.ok(Array.isArray(place));
      const [top = NaN, bottom = NaN, height = NaN] = place.map(Number);
      assert.ok(top >= 0 && bottom <= height, `#L23 is in view: ${top}..${bottom} of ${height}`);
      assert.equal(
        await frame.evaluate(`getComputedStyle(document.getElementById("L23")).backgroundColor`),
        "rgb(255, 241, 168)",
      );
      assert.equal(await page.evaluate("location.hash"), "#L23", "the address bar keeps #L23");
    }

    // One-line JSON: formatted, with the pinned note.
    {
      const { frame } = await open("metrics.json", VIEWPORTS.tablet);
      assert.equal(await frame.evaluate(`document.querySelector(".fmt").textContent`), NOTE);
      assert.equal(
        await frame.evaluate(`document.querySelector(".fh .m").textContent`),
        "50 lines formatted · 1 line in the original · 570 B",
      );
    }

    // A log: uncoloured, its 5,000-character line wraps without sideways scroll.
    {
      const { frame } = await open("big.log", { ...VIEWPORTS.phone, colorScheme: "light" });
      assert.equal(await frame.evaluate(`document.querySelectorAll("pre [style]").length`), 0);
      assert.equal(await frame.evaluate(NO_SIDEWAYS), true, "the long line wraps");
      assert.equal(
        await frame.evaluate(`document.querySelector(".fh .k").textContent`),
        "Plain text",
      );
    }

    // Hostile text: escaped, controls marked, nothing runs.
    {
      const { frame, dialogs } = await open("trojan.js");
      await pause(300);
      const text = String(await frame.evaluate("document.body.innerText"));
      assert.ok(text.includes(`const s = "</pre><script>alert(1)</script>";`), "the code is text");
      assert.ok(text.includes("⟪U+202E⟫"), "the override is marked");
      assert.ok(text.includes("⟪U+200B⟫⟪U+0000⟫x⟪U+000D⟫y"), "invisible controls are marked");
      assert.deepEqual(dialogs, [], "no dialog");
    }

    // The table: 500 rows, a sticky header, right-aligned numbers, the footer.
    {
      const { frame } = await open("results.csv", { ...VIEWPORTS.tablet, colorScheme: "light" });
      assert.equal(await frame.evaluate(`document.querySelectorAll("tbody tr").length`), 500);
      assert.equal(
        await frame.evaluate(`getComputedStyle(document.querySelector("thead th")).position`),
        "sticky",
      );
      assert.equal(
        await frame.evaluate(`getComputedStyle(document.querySelector("th.num")).textAlign`),
        "right",
      );
      assert.equal(await frame.evaluate(`document.querySelector(".more").textContent`), FOOTER);
      await frame.evaluate("scrollTo(0, 3000)");
      await pause(100);
      const top = Number(
        await frame.evaluate(`document.querySelector("thead th").getBoundingClientRect().top`),
      );
      assert.ok(Math.abs(top) <= 1, `the header row stays pinned: ${top}`);
    }

    // On a phone the table may scroll sideways, but values aren't split mid-word or mid-number.
    {
      const { frame } = await open("results.csv", { ...VIEWPORTS.phone, colorScheme: "dark" });
      const split =
        await frame.evaluate(`[...document.querySelectorAll("tbody tr:nth-child(-n+14) td:not(.rn)")]
        .filter((td) => {
          const node = td.firstChild;
          let start = 0;
          return node.data.split(" ").some((word) => {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            start += word.length + 1;
            return range.getClientRects().length > 1;
          });
        })
        .map((td) => td.textContent)`);
      assert.deepEqual(split, [], "every value wraps only between words");
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
