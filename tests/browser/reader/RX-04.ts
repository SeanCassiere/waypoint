// RX-04: image files on a stage instead of the frame. Fit the width, never grow, scroll when tall;
// the shell's img-src is this response's own frame base; a failed image (a 404, a revoked link)
// swaps in the error card from its template; dark stage; without JS the alt text stands in.
import { hashShareToken, newShareToken } from "@waypoint/core";
import { FRAME_DENIED_BODY, sharedTokensCss } from "@waypoint/ui";
import type { Page } from "playwright";

import { LOOKUP_TTL_MS } from "../../../apps/reader/src/app.ts";
import {
  assert,
  collectConsole,
  cspProblems,
  onCleanup,
  rawCap,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const svg = (size: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${size}><rect width="100%" height="100%" fill="#c86f3c"/><circle cx="50%" cy="50%" r="20%" fill="#2f5d8a"/></svg>`;
const hash = (c: string) => "sha256:" + c.repeat(64);
const BODIES = new Map<string, string>([
  [hash("1"), "# Screens\n\nSee the shots.\n"],
  [hash("2"), svg('width="720" height="1350"')],
  [hash("3"), svg('width="200" height="120"')],
  [hash("4"), svg('width="1280" height="6000"')],
  // Only a viewBox: no intrinsic size (the stage script must not take it for a failure).
  [hash("5"), svg('viewBox="0 0 300 200"')],
]);
const FILES = [
  ["index.md", "text/markdown", hash("1")],
  ["shots/tall.svg", "image/svg+xml", hash("2")],
  ["shots/small.svg", "image/svg+xml", hash("3")],
  ["shots/huge.svg", "image/svg+xml", hash("4")],
  ["shots/viewbox.svg", "image/svg+xml", hash("5")],
] as const;
const COL = { id: "col_" + "s".repeat(26), pub: "ssssssssssss" };
const REV = { id: "rev_" + "0".repeat(25) + "s", pub: "s4s4s4s4s4s4" };
const LINK = "shl_" + "0".repeat(25) + "s";
// A second link to the same revision: its prefix is valid, but not this shell's.
const OTHER = "shl_" + "0".repeat(25) + "t";

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
const loaded = (page: Page) =>
  until(
    page,
    `(() => { const i = document.querySelector("#doc img"); return !!i && i.complete; })()`,
  );
/** The computed colour of a CSS colour value, through a probe (CSSOM is allowed under the CSP). */
const colour = async (page: Page, value: string): Promise<string> =>
  String(
    await page.evaluate(`(() => { const p = document.createElement("span");
      p.style.backgroundColor = ${JSON.stringify(value)};
      document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; })()`),
  );

const scenario: ReaderScenario = {
  name: "RX-04 image stage: fit the width, scroll when tall, exact img-src, error card, dark, no JS",
  async run(ctx) {
    let clock = Date.now();
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    for (const [blob, body] of BODIES)
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", blob, body.length);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Checkout screens",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "index.md",
    );
    for (const [path, mime, blob] of FILES)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        REV.id,
        path,
        blob,
        mime,
        BODIES.get(blob)!.length,
      );
    const token = newShareToken();
    const links: [id: string, token: string][] = [
      [LINK, token],
      [OTHER, newShareToken()],
    ];
    for (const [id, link] of links)
      ins(
        "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
        id,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two links, seeded in order.
        await hashShareToken(link),
        COL.id,
        null,
        null,
        null,
      );
    const reader = await startReader({
      db,
      now: () => clock,
      blob: (blob) => {
        const body = BODIES.get(blob);
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(Buffer.from(body, "utf8"));
      },
    });
    const shell = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const frameBase = `${reader.origin}/x/${LINK}.${rawCap(LINK, REV.pub)}/r/${REV.pub}/`;
    const otherBase = `${reader.origin}/x/${OTHER}.${rawCap(OTHER, REV.pub)}/r/${REV.pub}/`;
    const logs: string[][] = [];
    const open = async (page: Page, path: string) => {
      const response = await page.goto(shell + path);
      assert.equal(response?.status(), 200, `loads ${path}`);
      assert.equal(
        response?.headers()["content-security-policy"]?.includes(`img-src ${frameBase};`),
        true,
        `${path}: img-src is the frame base`,
      );
    };

    // Phone: a tall image fits the width (390 − 2 × 12), starts at the top and scrolls; the
    // skip link focuses the stage, so PageDown scrolls it. The type is hidden.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      logs.push(collectConsole(page));
      await open(page, "shots/tall.svg");
      await loaded(page);
      const [width = NaN, scroll = NaN, client = NaN, top = NaN] = await numbers(
        page,
        `(() => { const s = document.querySelector("#doc.stage"); return [s.querySelector("img").getBoundingClientRect().width, s.scrollHeight, s.clientHeight, s.scrollTop]; })()`,
      );
      assert.ok(Math.abs(width - 366) <= 1, `tall image is ${width} px wide at 390`);
      assert.ok(scroll > client, `the stage scrolls (${scroll} > ${client})`);
      assert.equal(top, 0, "starts at the top");
      assert.equal(await page.locator(".icap .ty").isVisible(), false, "type hidden on phones");
      assert.equal(await page.locator(".icap b").textContent(), "tall.svg");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(`document.activeElement.className`), "skip");
      await page.keyboard.press("Enter");
      await until(page, `document.activeElement?.id === "doc"`);
      await page.keyboard.press("PageDown");
      await until(page, `document.querySelector("#doc.stage").scrollTop > 0`);
    }

    // Desktop: a small image stays at its size, centred; a 1280×6000 page fits the width.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      logs.push(collectConsole(page));
      await open(page, "shots/small.svg");
      await loaded(page);
      const [w = NaN, h = NaN, dx = NaN, dy = NaN] = await numbers(
        page,
        `(() => { const s = document.querySelector("#doc.stage").getBoundingClientRect(); const i = document.querySelector("#doc img").getBoundingClientRect();
          return [i.width, i.height, i.left + i.width / 2 - (s.left + s.width / 2), i.top + i.height / 2 - (s.top + s.height / 2)]; })()`,
      );
      assert.deepEqual([w, h], [200, 120], "not scaled up");
      assert.ok(Math.abs(dx) <= 2 && Math.abs(dy) <= 2, `centred (${dx}, ${dy})`);
      assert.equal(await page.locator(".icap .ty").textContent(), "SVG image");
      assert.equal(await page.locator("iframe").count(), 0, "no frame");

      // CSP: another link's prefix is refused; the stage's own image loaded.
      const refused = page.waitForEvent("console", {
        predicate: (m) => /Content Security Policy/.test(m.text()),
        timeout: 5000,
      });
      await page.evaluate(`(() => { const i = document.createElement("img"); i.id = "foreign";
        i.src = ${JSON.stringify(`${otherBase}shots/small.svg`)}; document.body.append(i); })()`);
      await refused;
      await until(page, `document.getElementById("foreign").complete`);
      assert.equal(
        await page.evaluate(`document.getElementById("foreign").naturalWidth`),
        0,
        "the foreign image never loads",
      );
      assert.ok(
        Number(await page.evaluate(`document.querySelector("#doc img").naturalWidth`)) > 0,
        "the stage image loaded",
      );

      await open(page, "shots/huge.svg");
      await loaded(page);
      const [hw = NaN, cw = NaN, st = NaN] = await numbers(
        page,
        `(() => { const s = document.querySelector("#doc.stage"); return [s.querySelector("img").getBoundingClientRect().width, s.clientWidth, s.scrollTop]; })()`,
      );
      assert.ok(Math.abs(hw - (cw - 56)) <= 1, `huge image is ${hw} px, stage ${cw}`);
      assert.equal(st, 0, "starts at the top");

      // An SVG with only a viewBox (no size of its own) shows at the stage's width, not as
      // the error card and not collapsed to nothing.
      await open(page, "shots/viewbox.svg");
      await loaded(page);
      await page.waitForTimeout(100);
      assert.equal(await page.locator(".imgerr").count(), 0, "viewBox-only SVG isn't an error");
      const [vw = NaN, vc = NaN] = await numbers(
        page,
        `(() => { const s = document.querySelector("#doc.stage"); return [s.querySelector("img").getBoundingClientRect().width, s.clientWidth]; })()`,
      );
      assert.ok(Math.abs(vw - (vc - 56)) <= 1, `viewBox-only SVG is ${vw} px, stage ${vc}`);
    }

    // Error by route: the image answers 404 and the card takes its place, with Reload.
    const errorCard = async (options: typeof VIEWPORTS.desktop | typeof VIEWPORTS.phone) => {
      const { page } = await ctx.newPage({ ...options, mobile: options.touch });
      logs.push(collectConsole(page));
      await page.route(`${frameBase}shots/small.svg`, (route) => route.fulfill({ status: 404 }));
      await open(page, "shots/small.svg");
      await until(page, `!!document.querySelector("#doc .fit > .imgerr[role=status]")`);
      const card = page.locator(".imgerr");
      assert.ok(await card.isVisible(), "the card is visible");
      assert.equal(await card.locator("h2").textContent(), "This image can't be shown right now");
      assert.equal(await card.locator("p").textContent(), FRAME_DENIED_BODY);
      assert.equal(await page.locator("#doc img").count(), 0, "the image is gone");
      const reload = card.getByRole("link", { name: "Reload", exact: true });
      const href = await reload.getAttribute("href");
      assert.equal(new URL(href ?? "", page.url()).href, page.url(), "Reload is this page");
      assert.equal(
        await page.evaluate(`document.querySelector(".imgerr a").matches("a.btn")`),
        true,
        "Reload is a .btn",
      );
      if (options.touch) {
        const box = await reload.boundingBox();
        assert.ok((box?.height ?? 0) >= 44, `Reload is ${box?.height} px tall on touch`);
      }
    };
    await errorCard(VIEWPORTS.desktop);
    await errorCard(VIEWPORTS.phone);

    // Error by revocation: the image loaded, then the link is revoked; the next request fails.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      logs.push(collectConsole(page));
      await open(page, "shots/small.svg");
      await loaded(page);
      assert.equal(await page.locator(".imgerr").count(), 0);
      ins("UPDATE share_links SET revoked_at=? WHERE id=?", clock, LINK);
      clock += LOOKUP_TTL_MS + 1000;
      await page.evaluate(
        `(() => { const i = document.querySelector("#doc img"); i.src = i.src + "?again"; })()`,
      );
      await until(page, `!!document.querySelector("#doc .fit > .imgerr")`);
      ins("UPDATE share_links SET revoked_at=NULL WHERE id=?", LINK);
    }

    // Dark: the stage is the dark --stage, never white.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme: "dark" });
      logs.push(collectConsole(page));
      await open(page, "shots/small.svg");
      const dark = /prefers-color-scheme:dark\)\{:root\{[^}]*--stage:([^;}]+)/.exec(
        sharedTokensCss,
      )?.[1];
      assert.ok(dark, "the dark --stage token");
      const expected = await colour(page, dark);
      assert.equal(await colour(page, "var(--stage)"), expected, "--stage is the dark value");
      assert.equal(
        await page.evaluate(
          `getComputedStyle(document.querySelector("#doc.stage")).backgroundColor`,
        ),
        expected,
      );
    }

    // No JS: the alt text is the path, and the template stays inert.
    {
      const context = await ctx.browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 1280, height: 800 },
      });
      onCleanup(() => context.close());
      const page = await context.newPage();
      ctx.watchErrors(page, "RX-04.ts (no JS)");
      logs.push(collectConsole(page));
      await page.route(`${frameBase}shots/small.svg`, (route) => route.fulfill({ status: 404 }));
      await open(page, "shots/small.svg");
      assert.equal(await page.locator("#doc img").getAttribute("alt"), "shots/small.svg");
      assert.equal(await page.locator(".imgerr").count(), 0, "no card without JS");
    }

    // Only the deliberate refusal of the foreign image.
    const problems = logs.flatMap(cspProblems);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0]!, /img-src/);
  },
};
export default scenario;
