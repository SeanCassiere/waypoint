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
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.locator("[data-share-dialog]").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-share-form] input[name="label"]').count(), 1);
  assert.equal(await page.locator('[data-share-form] input[name="expires"]').count(), 1);
  await page.locator("[data-share-close]").click();
  assert.notEqual(
    await page.locator("body").evaluate("element => getComputedStyle(element).fontFamily"),
    "Times New Roman",
  );
  assert.equal(new URL(page.url()).pathname, latest);
  await page.frameLocator("iframe").getByRole("link", { name: "Notes" }).click();
  await page.waitForURL(`**${latest}notes/b.md`);
  assert.equal(
    rawRequests.filter((url) => url.endsWith("/notes/b.md")).length,
    1,
    "in-frame navigation fetched twice",
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
  await page.goto(`${base}${pinned}notes/b.md`);
  await page
    .locator("[data-picker]")
    .selectOption(new URL(second.url).pathname.split("/r/")[1]?.split("/")[0] ?? "");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForURL(`**${secondPinned}notes/b.md`);
  assert.equal(new URL(page.url()).pathname, `${secondPinned}notes/b.md`);
  const third = await api(`/api/collections/${first.collection_id}/revisions`, {
    message: "Third",
    mode: "replace",
    files: [await write("index.md", "# Third\n")],
  });
  const thirdPinned = new URL(third.url).pathname;
  await page.goto(`${base}${secondPinned}notes/b.md`);
  await page
    .locator("[data-picker]")
    .selectOption(new URL(third.url).pathname.split("/r/")[1]?.split("/")[0] ?? "");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForURL(`**${thirdPinned}`);
  assert.equal(new URL(page.url()).pathname, `${thirdPinned}index.md`);
  await page
    .locator("[data-picker]")
    .selectOption(new URL(second.url).pathname.split("/r/")[1]?.split("/")[0] ?? "");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForURL(`**${secondPinned}index.md`);
  assert.equal(new URL(page.url()).pathname, `${secondPinned}index.md`);
  console.log(
    "Chromium viewer share dialog, navigation, history, source/hash, picker, and font: passed",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(dir, { recursive: true, force: true });
}
