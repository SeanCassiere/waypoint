import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { z } from "zod";

type WriteResult = { collection_id: string; url: string; latest_url: string };
function writeResult(value: unknown): WriteResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("url" in value) ||
    !("latest_url" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.latest_url !== "string"
  )
    throw new Error("Invalid write result");
  return { collection_id: value.collection_id, url: value.url, latest_url: value.latest_url };
}

/** Browser-side expression: is the popover open? */
const openState = (id: string) =>
  `document.getElementById(${JSON.stringify(id)})?.matches(":popover-open") === true`;

const dir = await mkdtemp(join(tmpdir(), "waypoint-viewer-browser-"));
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No port");
const port = address.port;
await new Promise<void>((resolve) => server.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../apps/writer/dist/main.js", import.meta.url))],
  {
    env: {
      ...process.env,
      WAYPOINT_ENV: "dev",
      WAYPOINT_SYNC: "off",
      WAYPOINT_DATA_DIR: dir,
      WAYPOINT_PORT: String(port),
      WAYPOINT_PUBLIC_BASE_URL: "https://reader-dev.example.test",
      // A fixed test key (never a real one): 32 bytes of 42.
      WAYPOINT_SHARE_TOKEN_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stderr.on("data", (chunk: unknown) => {
  logs += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
});
let browser: Browser | undefined;
try {
  async function waitForWriter(attempts: number): Promise<void> {
    if (attempts === 0) throw new Error(`Writer did not boot: ${logs}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return waitForWriter(attempts - 1);
  }
  await waitForWriter(100);
  async function write(path: string, content: string): Promise<{ path: string; hash: string }> {
    const bytes = Buffer.from(content);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const response = await fetch(`${base}/api/blobs/${hash}`, { method: "PUT", body: bytes });
    assert.equal(response.status, 200);
    return { path, hash };
  }
  async function api(path: string, body: object): Promise<WriteResult> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status !== 200)
      throw new Error(`API ${response.status}: ${await response.text()}`);
    return writeResult(await response.json());
  }
  const first = await api("/api/collections", {
    title: "Browser collection",
    files: [
      await write(
        "index.md",
        "# Home\n\n[Notes](notes/b.md)\n\n[Source](notes/b.md?source#hello)\n",
      ),
      await write("notes/b.md", "# Hello\n\n[Home](../index.md)\n"),
    ],
  });
  const second = await api(`/api/collections/${first.collection_id}/revisions`, {
    message: "Second",
    files: [await write("index.md", "# Second\n\n[Notes](notes/b.md)\n")],
  });
  const latest = new URL(first.latest_url).pathname;
  const pinned = new URL(first.url).pathname;
  const secondPinned = new URL(second.url).pathname;
  // Playwright's own Chromium (`pnpm exec playwright install chromium`), or CHROME_PATH.
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  // Script errors abort every later binding on the page, so any one fails the run.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const rawRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/raw/r/")) rawRequests.push(request.url());
  });
  await page.goto(`${base}${latest}`);
  // Landmarks and the skip link (spec §7).
  assert.equal(await page.locator("header.bar").count(), 1);
  assert.equal(await page.locator("aside#panel").count(), 1);
  assert.equal(await page.locator("main#main").count(), 1);
  assert.equal(await page.locator("a.skip").getAttribute("href"), "#main");
  // Share: the dialog opens natively, the checklist follows the form, the link shows once.
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator("#share").waitFor({ state: "visible" });
  assert.equal(await page.locator("#share .row.when-latest").isVisible(), false);
  await page.locator("#share label.opt", { hasText: "Latest revision" }).click();
  assert.equal(await page.locator("#share .row.when-latest").isVisible(), true);
  await page.locator('#share input[name="label"]').fill("Browser review");
  await page.locator("[data-share-submit]").click();
  await page.locator('[data-share-step="created"]').waitFor({ state: "visible" });
  const created = (await page.locator("[data-share-url]").textContent()) ?? "";
  assert.match(created, /\/s\/wps_/);
  // Copy has focus once the link exists (no view transition delays it any more).
  assert.equal(
    await page.evaluate('document.activeElement?.hasAttribute("data-share-copy")'),
    true,
  );
  await page.locator("[data-share-copy]").click();
  await page.locator("[data-share-copy][data-copied]").waitFor();
  assert.equal(await page.evaluate("navigator.clipboard.readText()"), created);
  // The URL stays copyable later, so closing isn't guarded: Esc shows the Links tab.
  await page.keyboard.press("Escape");
  await page.waitForURL(/panel=links/);
  const card = page.locator(".lnk", { hasText: "Browser review" });
  await card.waitFor();
  assert.equal(await page.locator("header .chip.public").count(), 1, "Public chip shows");
  // Copy URL on an existing link copies the same URL the dialog showed; Open points at it,
  // and the button keeps its width while it says Copied.
  await page.evaluate("navigator.clipboard.writeText('')");
  const copyUrl = card.getByRole("button", { name: /Copy URL/ });
  const before = (await copyUrl.boundingBox())?.width ?? 0;
  await copyUrl.click();
  await card.locator("[data-copy-url][data-copied]").waitFor();
  assert.equal((await card.locator("[data-copy-url]").boundingBox())?.width, before, "no shift");
  assert.equal(await page.evaluate("navigator.clipboard.readText()"), created);
  assert.equal(await card.locator("[data-open-url]").getAttribute("href"), created);
  // Two more links, so "Revoke all" shows (it needs 2+ active links).
  for (const label of ["Second reviewer", "Third reviewer"]) {
    const made = await fetch(`${base}/api/collections/${first.collection_id}/share-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    assert.equal(made.status, 201);
  }
  await page.reload();
  await card.waitFor();
  const revokeAll = page.locator("#tp-links [data-action=revoke-all]");
  assert.equal(await revokeAll.textContent(), "Revoke all 3 links…");
  // Revocation shows at once: no reload, the card reads Revoked, notes that the revocation
  // hasn't reached the cloud (sync is off here), and the counts follow.
  const revokeUrl = page.url();
  await card.locator("summary", { hasText: "Revoke…" }).click();
  await card.getByRole("button", { name: "Revoke link" }).click();
  await card.locator("[data-stops]").waitFor();
  assert.equal(await card.locator("[data-link-state]").textContent(), "Revoked");
  assert.equal(await card.locator("[data-copy-url]").count(), 0, "a revoked link has no Copy URL");
  assert.equal(page.url(), revokeUrl);
  assert.equal(
    await card.locator("[data-stops]").textContent(),
    "Revoked, not yet pushed. Public access continues until it syncs.",
  );
  assert.equal(await revokeAll.textContent(), "Revoke all 2 links…");
  assert.equal(await revokeAll.getAttribute("data-count"), "2");
  assert.equal(await page.locator("#tab-links .n").textContent(), "2");
  // /links: a row revoked there gets a Revoked chip and the same note; counts follow, and
  // Revoke all goes once fewer than two active links remain.
  await page.goto(`${base}/links`);
  assert.equal(await page.locator('[data-count-of="active"]').textContent(), "2");
  const row = page.locator(".r", { hasText: "Second reviewer" });
  await row.getByRole("button", { name: "Revoke…" }).click();
  await page.locator("#confirm [data-confirm-ok]").click();
  await row.locator("[data-stops]").waitFor();
  assert.equal(await row.locator("[data-link-state]").textContent(), "Revoked");
  assert.equal(
    await row.locator("[data-stops]").textContent(),
    "Revoked, not yet pushed. Public access continues until it syncs.",
  );
  assert.equal(await page.locator('[data-count-of="active"]').textContent(), "1");
  assert.equal(await page.locator('[data-count-of="revoked"]').textContent(), "2");
  assert.equal(await page.locator("[data-action=revoke-all]").count(), 0);
  await page.goto(revokeUrl);
  await page.locator(".lnk.dead", { hasText: "Browser review" }).waitFor({ state: "attached" });
  await page.goto(`${base}${latest}`);
  assert.notEqual(
    await page.locator("body").evaluate("element => getComputedStyle(element).fontFamily"),
    "Times New Roman",
  );
  // Copy menu: the handoff block names the collection and revision for another agent.
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.locator("#copy-menu").waitFor({ state: "visible" });
  const handoff = (await page.locator("[data-handoff]").textContent()) ?? "";
  assert.match(handoff, /collection_id: col_/);
  assert.match(handoff, /Watch: wait_for_revision/);
  await page.keyboard.press("Escape");
  assert.equal(new URL(page.url()).pathname, latest);
  await page.frameLocator("iframe").getByRole("link", { name: "Notes" }).click();
  await page.waitForURL(`**${latest}notes/b.md`);
  assert.equal(
    rawRequests.filter((url) => url.endsWith("/notes/b.md")).length,
    1,
    "in-frame navigation fetched twice",
  );
  assert.equal(
    await page.locator('#tp-files a[aria-current="page"]').getAttribute("data-file"),
    "notes/b.md",
  );
  await page.goto(`${base}${latest}`);
  const beforeHistory = Number(await page.evaluate("history.length"));
  await page.locator('[data-file="notes/b.md"]').click();
  await page.waitForURL(`**${latest}notes/b.md`);
  assert.equal(await page.evaluate("history.length"), beforeHistory + 1);
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, latest);
  await page.waitForFunction(
    'document.querySelector("iframe")?.contentWindow?.location.pathname.endsWith("/index.md")',
  );
  await page.goForward();
  assert.equal(new URL(page.url()).pathname, `${latest}notes/b.md`);
  await page.waitForFunction(
    'document.querySelector("iframe")?.contentWindow?.location.pathname.endsWith("/notes/b.md")',
  );
  await page.goto(`${base}${pinned}`);
  await page.frameLocator("iframe").getByRole("link", { name: "Source" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith("notes/b.md") && url.search === "?source" && url.hash === "#hello",
  );
  assert.equal(new URL(page.url()).pathname, `${pinned}notes/b.md`);
  // "]" steps to the newer revision and keeps the current file.
  await page.goto(`${base}${pinned}notes/b.md`);
  await page.locator("body").press("]");
  await page.waitForURL(`**${secondPinned}notes/b.md`);
  // The panel's History tab lists both revisions, newest first.
  await page.locator("body").press("h");
  await page.locator("#tp-history").waitFor({ state: "visible" });
  assert.deepEqual(await page.locator("#tp-history .rv .h b").allTextContents(), ["#2", "#1"]);
  const third = await api(`/api/collections/${first.collection_id}/revisions`, {
    message: "Third",
    mode: "replace",
    files: [await write("index.md", "# Third\n")],
  });
  const thirdPinned = new URL(third.url).pathname;
  // A file missing from the target revision falls back to its head.
  await page.goto(`${base}${secondPinned}notes/b.md`);
  await page.locator("body").press("]");
  await page.waitForURL(`**${thirdPinned}`);
  assert.equal(new URL(page.url()).pathname, `${thirdPinned}index.md`);
  // The revision menu opens with "r" and its entries keep the current file.
  await page.goto(`${base}${secondPinned}notes/b.md`);
  await page.getByRole("button", { name: /^Revision 2/ }).click();
  await page.locator("#rev-menu").waitFor({ state: "visible" });
  await page.locator("#rev-menu").getByRole("link", { name: "Revision 1" }).click();
  await page.waitForURL(`**${pinned}notes/b.md`);
  // "d" opens the Changes page against the parent; j focuses the first change; Esc goes back.
  await page.goto(`${base}${secondPinned}`);
  await page.locator("body").press("d");
  await page.waitForURL(`**${secondPinned}changes`);
  await page.getByRole("heading", { name: "Changes in #2" }).waitFor();
  await page.locator("body").press("j");
  assert.equal(await page.evaluate('document.activeElement?.hasAttribute("data-change")'), true);
  await page.locator("body").press("Escape");
  await page.waitForURL((url) => url.pathname === secondPinned);
  // Compare… opens natively (commandfor/command) and navigates to the chosen pair.
  await page.getByRole("button", { name: /^Revision 2/ }).click();
  await page.getByRole("button", { name: /Compare…/ }).click();
  await page.locator("#compare").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.waitForURL(/\/changes\?base=/);
  // Keyboard shortcuts dialog and the disable toggle.
  await page.locator("body").press("?");
  await page.locator("#keys").waitFor({ state: "visible" });
  await page.locator("[data-keys-off]").check();
  await page.keyboard.press("Escape");
  await page.locator("body").press("h");
  assert.equal(await page.locator("#tp-history").isVisible(), false, "shortcuts stay off");
  await page.evaluate('localStorage.removeItem("wp:keys")');
  // History stays open while stepping through revisions (owner feedback): picking a
  // revision in the History tab, then "[" and "]", keeps the tab and highlights the revision.
  await page.goto(`${base}${thirdPinned}`);
  await page.locator("#tab-history").click();
  assert.match(page.url(), /[?&]panel=history/);
  await page.locator("#tp-history").getByRole("link", { name: "Second" }).click();
  await page.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
  assert.match(page.url(), /[?&]panel=history/);
  assert.equal(await page.locator("#tab-history").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#tp-history").isVisible(), true);
  assert.equal(await page.locator('#tp-history .rv[aria-current="true"] .h b').textContent(), "#2");
  await page.locator("body").press("[");
  await page.waitForURL((url) => url.pathname === `${pinned}index.md`);
  assert.equal(await page.locator("#tab-history").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('#tp-history .rv[aria-current="true"] .h b').textContent(), "#1");
  await page.locator("body").press("]");
  await page.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
  assert.match(page.url(), /[?&]panel=history/);
  assert.equal(await page.locator("#tp-history").isVisible(), true);

  // Light dismiss (owner feedback): every popover closes on a press outside it, including a
  // press inside the document iframe (whose events never reach the shell), with a mouse and
  // with touch, at phone, iPad mini, iPad and desktop widths. Entrances grow from the trigger.
  const widths = [
    { width: 390, height: 844, touch: true },
    { width: 744, height: 1133, touch: true },
    { width: 1024, height: 768, touch: true },
    { width: 1024, height: 768, touch: false },
    { width: 1440, height: 900, touch: false },
  ];
  // Browser-side checks are strings: this project type-checks tests without the DOM lib.
  const geometrySchema = z.object({
    rect: z.object({
      left: z.number(),
      right: z.number(),
      top: z.number(),
      bottom: z.number(),
      height: z.number(),
    }),
    x: z.number(),
    y: z.number(),
    trigger: z
      .object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() })
      .nullable(),
  });
  const chrome: Browser = browser;
  for (const { width, height, touch } of widths) {
    const sized = await chrome.newContext({
      viewport: { width, height },
      hasTouch: touch,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const view = await sized.newPage();
    view.on("pageerror", (error) => pageErrors.push(`${width}px: ${error.message}`));
    await view.goto(`${base}${latest}`);
    await view.locator("iframe.frame").waitFor();
    // Below 600 px menus are bottom sheets; up to 760 px the tab bar holds Copy and More.
    const phone = width < 600;
    const tabbar = width <= 760;
    const triggers: [string, string][] = [
      [
        "copy-menu",
        tabbar ? '.tabbar [popovertarget="copy-menu"]' : 'header [popovertarget="copy-menu"]',
      ],
      [
        "more-menu",
        tabbar ? '.tabbar [popovertarget="more-menu"]' : 'header [popovertarget="more-menu"]',
      ],
      ["rev-menu", ".revbtn"],
      ["health-pop", "header .health"],
    ];
    const isOpen = async (id: string) => (await view.evaluate(openState(id))) === true;
    const closed = (id: string) =>
      view
        .waitForFunction(`!(${openState(id)})`, undefined, { timeout: 2000 })
        .catch(() => undefined);
    const press = async (x: number, y: number) => {
      if (touch) await view.touchscreen.tap(x, y);
      else await view.mouse.click(x, y);
    };
    const open = async (id: string, selector: string) => {
      const trigger = view.locator(selector).first();
      if (touch) await trigger.tap();
      else await trigger.click();
      await view.waitForFunction(openState(id));
      await view.waitForTimeout(200);
    };
    for (const [id, selector] of triggers) {
      const label = `${id} at ${width}px (${touch ? "touch" : "mouse"})`;
      await open(id, selector);
      // The box grows out of its trigger: phones slide a bottom sheet up from the bottom edge;
      // elsewhere the origin is the corner nearest the trigger.
      const { rect, x, y, trigger } = geometrySchema.parse(
        JSON.parse(
          String(
            await view.evaluate(`(() => {
              const box = document.querySelector("#${id} > .mbox");
              const [x = 0, y = 0] = getComputedStyle(box).transformOrigin.split(" ").map(parseFloat);
              const trigger = document.querySelector(${JSON.stringify(selector)});
              return JSON.stringify({ rect: box.getBoundingClientRect(), x, y, trigger: trigger?.getBoundingClientRect() ?? null });
            })()`),
          ),
        ),
      );
      if (phone) {
        assert.ok(Math.abs(y - rect.height) < 2, `${label}: origin at the bottom edge`);
        assert.ok(Math.abs(rect.bottom - height) < 2, `${label}: sheet sits on the bottom edge`);
      } else {
        assert.ok(trigger, `${label}: trigger found`);
        const below = rect.top >= trigger.bottom - 2;
        assert.ok(
          Math.abs(rect.top + y - (below ? rect.top : rect.bottom)) < 2,
          `${label}: vertical origin faces the trigger`,
        );
        const nearest =
          Math.abs(rect.left - trigger.left) <= Math.abs(rect.right - trigger.right)
            ? rect.left
            : rect.right;
        assert.ok(
          Math.abs(rect.left + x - nearest) < 2,
          `${label}: horizontal origin on the trigger's side`,
        );
      }
      // A press inside the document iframe (away from the popover's box) closes it.
      const frame = await view.locator("iframe.frame").boundingBox();
      assert.ok(frame);
      const spot = [
        [frame.x + frame.width - 16, frame.y + frame.height - 16],
        [frame.x + 16, frame.y + frame.height - 16],
        [frame.x + 16, frame.y + 16],
        [frame.x + frame.width - 16, frame.y + 16],
      ].find(
        ([px = 0, py = 0]) =>
          px < rect.left - 24 ||
          px > rect.right + 24 ||
          py < rect.top - 24 ||
          py > rect.bottom + 24,
      );
      assert.ok(spot, `${label}: part of the document is uncovered`);
      await press(spot[0] ?? 0, spot[1] ?? 0);
      await closed(id);
      assert.equal(await isOpen(id), false, `${label}: a press in the iframe closes it`);
      // So does a press elsewhere in the shell (the status line, or the phone sheet's scrim).
      await open(id, selector);
      const bar = await view.locator("header.bar").boundingBox();
      assert.ok(bar);
      const below = bar.y + bar.height + (touch ? 6 : 2);
      const outside = [touch ? width / 2 : bar.x + 4, 8, width - 8].find(
        // Clear of the box by more than touch adjustment's reach.
        (px) =>
          px < rect.left - 24 ||
          px > rect.right + 24 ||
          below < rect.top - 24 ||
          below > rect.bottom + 24,
      );
      assert.ok(outside !== undefined, `${label}: part of the status line is uncovered`);
      await press(outside, below);
      await closed(id);
      assert.equal(await isOpen(id), false, `${label}: a press outside closes it`);
      // The closing press doesn't also act on what's beneath (on phones, the status line's
      // tap target would open the History sheet).
      assert.equal(
        await view.evaluate(
          'document.querySelector("#shell")?.classList.contains("open") === true',
        ),
        false,
        `${label}: the closing press doesn't reach the page beneath`,
      );
      assert.equal(new URL(view.url()).pathname, latest);
      // And Esc.
      await open(id, selector);
      await view.keyboard.press("Escape");
      assert.equal(await isOpen(id), false, `${label}: Esc closes it`);
    }
    // Choosing a menu item closes its menu (the item's action cancels the native hide), and
    // the toast it shows never holds the touch scrim.
    const copyTrigger = triggers[0]?.[1] ?? "";
    await open("copy-menu", copyTrigger);
    const item = view.locator("#copy-menu").getByRole("menuitem", { name: /Collection ID/ });
    if (touch) await item.tap();
    else await item.click();
    await closed("copy-menu");
    assert.equal(await isOpen("copy-menu"), false, `a menu item closes its menu at ${width}px`);
    await view.locator("[data-toast]").waitFor({ state: "visible", timeout: 4000 });
    await view.locator("[data-toast]").waitFor({ state: "hidden", timeout: 4000 });
    assert.equal(
      await view.evaluate(
        'getComputedStyle(document.querySelector(".pop-scrim")).display === "none" && !document.querySelector(".pop-scrim").classList.contains("linger")',
      ),
      true,
      `no scrim is left behind after the toast at ${width}px`,
    );
    await open("rev-menu", ".revbtn");
    const historyItem = view
      .locator("#rev-menu")
      .getByRole("button", { name: /Open History panel/ });
    if (touch) await historyItem.tap();
    else await historyItem.click();
    await closed("rev-menu");
    assert.equal(
      await isOpen("rev-menu"),
      false,
      `Open History panel closes the menu at ${width}px`,
    );
    assert.equal(await view.locator("#tp-history").isVisible(), true);
    await view.keyboard.press("Escape");
    // On touch screens a tap that closes a menu doesn't also follow a link in the document.
    if (touch && !phone) {
      // #1's head file links to notes/b.md.
      await view.goto(`${base}${pinned}`);
      await view.locator("iframe.frame").waitFor();
      const notes = await view
        .frameLocator("iframe.frame")
        .getByRole("link", { name: "Notes" })
        .boundingBox();
      assert.ok(notes);
      await open("health-pop", "header .health");
      await press(notes.x + 4, notes.y + notes.height / 2);
      await closed("health-pop");
      assert.equal(await isOpen("health-pop"), false);
      await view.waitForTimeout(500);
      assert.match(
        String(
          await view.evaluate(
            'document.querySelector("iframe.frame").contentWindow.location.pathname',
          ),
        ),
        /\/index\.md$/,
        `the closing tap didn't follow the document's link at ${width}px`,
      );
    }
    // Esc pressed while focus is inside the document closes an open popover too.
    const frame = await view.locator("iframe.frame").boundingBox();
    assert.ok(frame);
    await press(frame.x + frame.width - 16, frame.y + 16);
    await view.evaluate('document.getElementById("health-pop")?.showPopover()');
    await view.frameLocator("iframe.frame").locator("body").press("Escape");
    assert.equal(await isOpen("health-pop"), false, `Esc inside the document at ${width}px`);
    await sized.close();
  }
  // On the iPad mini (744 px) the History side sheet stays open while stepping revisions.
  const mini = await chrome.newContext({ viewport: { width: 744, height: 1133 }, hasTouch: true });
  const miniPage = await mini.newPage();
  await miniPage.goto(`${base}${thirdPinned}`);
  await miniPage.locator('.tabbar [data-tab="history"]').tap();
  await miniPage.locator("#tp-history").waitFor({ state: "visible" });
  await miniPage.locator("#tp-history").getByRole("link", { name: "Second" }).tap();
  await miniPage.waitForURL((url) => url.pathname === `${secondPinned}index.md`);
  await miniPage.locator("#tp-history").waitFor({ state: "visible" });
  assert.equal(
    await miniPage.evaluate('document.querySelector("#shell").classList.contains("open")'),
    true,
    "the History sheet reopens at 744 px",
  );
  await mini.close();
  // Without anchored container queries, script sets the origin from the actual placement.
  const legacy = await chrome.newContext({ viewport: { width: 1440, height: 900 } });
  await legacy.addInitScript({
    content: `{
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => (/anchored/.test(args.join(" ")) ? false : supports(...args));
    }`,
  });
  const legacyPage = await legacy.newPage();
  await legacyPage.goto(`${base}${latest}`);
  const origin = async (id: string) => {
    const expression = `document.querySelector("#${id} > .mbox").style.getPropertyValue("--origin")`;
    // The origin is set on the toggle event, which fires just after the popover opens.
    await legacyPage.waitForFunction(`${expression} !== ""`);
    return legacyPage.evaluate(expression);
  };
  await legacyPage.locator(".revbtn").click();
  assert.equal(await origin("rev-menu"), "top left");
  await legacyPage.locator('header [popovertarget="copy-menu"]').click();
  assert.equal(await origin("copy-menu"), "top right");
  await legacy.close();
  assert.deepEqual(pageErrors, [], "no script errors");
  console.log(
    "Chromium viewer: landmarks, share create/copy/revoke, copy URL, copy menu, frame navigation, history, source/hash, revision stepping, revision menu, shortcuts, History tab persistence (744 sheet reopens), light dismiss, menu items closing menus, touch taps not reaching the document, live revoke counts and popover origins at 390/744/1024 (touch and mouse)/1440: passed",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(dir, { recursive: true, force: true });
}
