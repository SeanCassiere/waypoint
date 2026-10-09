// RX-02: shell links stay correct after in-frame navigation. Tab and tree links are relative to
// the page; once the address bar follows the frame into another folder, the shell pins them to
// absolute URLs first, so clicks, reloads and Back+reload never land on the denial page.
import { hashShareToken, newShareToken } from "@waypoint/core";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  type ReaderScenario,
} from "../harness.ts";

const HASH = "sha256:" + "2".repeat(64);
const DEEP = ["index.html", "other.html", "sub/page.html", "sub/deep/leaf.html"];
const FIXTURES = [
  {
    kind: "tabs",
    title: "Stable tabs",
    col: { id: "col_" + "c".repeat(26), pub: "cccccccccccc" },
    rev: { id: "rev_" + "0".repeat(25) + "2", pub: "c2c2c2c2c2c2" },
    link: "shl_" + "0".repeat(25) + "2",
    files: DEEP,
  },
  {
    kind: "tree",
    title: "Stable tree",
    col: { id: "col_" + "d".repeat(26), pub: "dddddddddddd" },
    rev: { id: "rev_" + "0".repeat(25) + "3", pub: "d3d3d3d3d3d3" },
    link: "shl_" + "0".repeat(25) + "3",
    files: [...DEEP, ...[1, 2, 3, 4, 5, 6].map((n) => `extra-${n}.html`)],
  },
] as const;

const scenario: ReaderScenario = {
  name: "RX-02 shell links stay correct after in-frame navigation (tabs and tree)",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    const tokens = new Map<string, string>();
    for (const f of FIXTURES) {
      const token = newShareToken();
      tokens.set(f.kind, token);
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
        "index.html",
      );
      for (const path of f.files)
        ins(
          "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
          f.rev.id,
          path,
          HASH,
          "text/html",
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

    const { page } = await ctx.newPage();
    const log = collectConsole(page);
    // Every /s/ response during the scenario: none may be a denial.
    const statuses: { url: string; status: number }[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.startsWith("/s/"))
        statuses.push({ url: r.url(), status: r.status() });
    });
    // In-page code is passed as strings (no DOM types here); results come back as JSON.
    const strings = async (expression: string): Promise<string[]> => {
      const value: unknown = JSON.parse(
        String(await page.evaluate(`JSON.stringify(${expression})`)),
      );
      assert.ok(Array.isArray(value));
      return value.map(String);
    };
    const current = () =>
      strings(`[...document.querySelectorAll("a[aria-current]")].map((a) => a.dataset.p)`);
    const hrefs = () =>
      strings(`[...document.querySelectorAll("a[data-p]")].map((a) => a.getAttribute("href"))`);

    const check = async (f: (typeof FIXTURES)[number]) => {
      const shellBase = `${reader.origin}/s/${tokens.get(f.kind)}/c/${f.col.pub}/`;
      const frameBase = `${reader.origin}/x/${f.link}.${rawCap(f.link, f.rev.pub)}/r/${f.rev.pub}/`;
      const rel = new URL(frameBase).pathname;
      const label = (what: string) => `${f.kind}: ${what}`;
      const open = async (url: string) => {
        const response = await page.goto(url);
        assert.equal(response?.status(), 200, label(`loads ${url}`));
        await page.waitForFunction(
          `[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(${JSON.stringify(frameBase)}))`,
        );
      };
      // A frame-location message from the frame's own window, as the v2 rendition sends it.
      const post = async (path: string) => {
        const frame = page.frames().find((fr) => fr.url().startsWith(frameBase));
        assert.ok(frame, label("frame loaded"));
        await frame.evaluate(
          `parent.postMessage(${JSON.stringify({ type: "waypoint:location", href: rel + path })}, "*")`,
        );
        await page.waitForFunction(`location.pathname.endsWith(${JSON.stringify("/" + path)})`);
      };
      const openFiles = async () => {
        if (f.kind !== "tree") return;
        // Today's <details> summary, or A11Y-07's button and popover.
        await page.locator(".pfiles > details > summary, .pfiles .fbtn").first().click();
        await page.locator('a[data-p="other.html"]').waitFor({ state: "visible" });
      };
      const clickFile = async (path: string) => {
        await openFiles();
        const target = page.locator(`a[data-p=${JSON.stringify(path)}]`);
        const url = new URL(String(await target.getAttribute("href")), page.url()).href;
        const loaded = page.waitForResponse(url);
        await target.click();
        const response = await loaded;
        await page.waitForURL(url);
        assert.equal(response?.status(), 200, label(`click ${path}`));
      };

      // Lazy: a page that never navigates in-frame keeps its relative links.
      await open(shellBase);
      // Fixture A shows tabs, fixture B the Files tree.
      assert.equal(await page.locator(f.kind === "tabs" ? ".ptabs2" : ".pfiles").count(), 1);
      assert.equal(await page.locator(f.kind === "tabs" ? ".pfiles" : ".ptabs2").count(), 0);
      for (const href of await hrefs()) assert.ok(href.startsWith("./"), label(href));

      // In-frame navigation into a subfolder: the URL follows, every link is pinned.
      await post("sub/page.html");
      assert.ok(await page.evaluate("location.pathname.endsWith('/sub/page.html')"));
      assert.deepEqual(await current(), ["sub/page.html"]);
      if (f.kind === "tree")
        assert.equal((await page.textContent(".pfiles .cur"))?.trim(), "sub/page.html");
      for (const href of await hrefs())
        assert.ok(href.startsWith(reader.origin + "/"), label(`pinned ${href}`));

      // A tab or tree click now opens the right file.
      await clickFile("other.html");
      assert.equal(page.url(), shellBase + "other.html");
      assert.equal((await page.textContent("h1"))?.trim(), f.title);
      assert.deepEqual(await current(), ["other.html"]);

      // Reload after an in-frame navigation two folders down.
      await open(shellBase);
      await post("sub/deep/leaf.html");
      const reloaded = await page.reload();
      assert.equal(reloaded?.status(), 200, label("reload"));
      assert.equal(page.url(), shellBase + "sub/deep/leaf.html");
      assert.deepEqual(await current(), ["sub/deep/leaf.html"]);

      // Back+reload.
      await open(shellBase);
      await open(shellBase + "other.html");
      await post("sub/page.html");
      await page.goBack();
      const back = await page.reload();
      assert.equal(back?.status(), 200, label("back+reload"));
      assert.equal(page.url(), shellBase);
      assert.deepEqual(await current(), ["index.html"]);

      // The head file from two folders down.
      await open(shellBase);
      await post("sub/deep/leaf.html");
      await clickFile("index.html");
      assert.ok([shellBase, shellBase + "index.html"].includes(page.url()), page.url());
      assert.deepEqual(await current(), ["index.html"]);
    };
    for (const f of FIXTURES)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, one fixture at a time.
      await check(f);

    assert.deepEqual(
      statuses.filter((s) => s.status === 404),
      [],
    );
    assert.ok(statuses.length > 0);
    assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
