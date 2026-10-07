import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

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

const dir = await mkdtemp(join(tmpdir(), "waypoint-viewer-browser-"));
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No port");
const port = address.port;
await new Promise<void>((resolve) => server.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["apps/writer/dist/main.js"], {
  env: {
    ...process.env,
    WAYPOINT_ENV: "dev",
    WAYPOINT_SYNC: "off",
    WAYPOINT_DATA_DIR: dir,
    WAYPOINT_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
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
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
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
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator("[data-share-dialog]").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.notEqual(
    await page.locator("body").evaluate("element => getComputedStyle(element).fontFamily"),
    "Times New Roman",
  );
  // Copy menu: the handoff block names the collection and revision for another agent.
  await page.getByRole("button", { name: "Copy ▾" }).click();
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
  console.log(
    "Chromium viewer: landmarks, copy menu, frame navigation, history, source/hash, revision stepping, revision menu, shortcuts: passed",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(dir, { recursive: true, force: true });
}
