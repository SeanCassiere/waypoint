// A11Y-08: the writer's loading line. Busy at once, "Opening <path>…" after 300 ms, and on an
// in-shell switch the stale document is hidden (data-opening) from that same step until the new
// one loads, so it can't cover the line. Fast loads and switches never show it; in-document
// links (the frame navigating itself) get none; image and download pages have no wrap.
import type { Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

// Records, from document start, every change of the line's text, the wrap's data-opening and
// #main's aria-busy (with performance.now(), one time per observer callback, so changes made in
// one task share it), so "never set" and the 300 ms step can be checked.
const RECORDER = `(() => {
  if (window !== window.top) return;
  const events = (window.__a11y08 = []);
  const state = { text: "", opening: false, busy: null };
  new MutationObserver(() => {
    const line = document.querySelector("[data-loading]");
    const wrap = document.querySelector("[data-docwrap]");
    const main = document.getElementById("main");
    const now = {
      text: line ? line.textContent : "",
      opening: !!wrap && wrap.hasAttribute("data-opening"),
      busy: main ? main.getAttribute("aria-busy") : null,
    };
    const at = performance.now();
    for (const key of ["text", "opening", "busy"])
      if (now[key] !== state[key]) events.push({ at, key, value: (state[key] = now[key]) });
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;
interface Recorded {
  at: number;
  key: string;
  value: unknown;
}

// In-page code is passed as strings (no DOM types here); results come back as JSON.
const json = async (page: Page, expression: string): Promise<unknown> =>
  JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`)));
async function recorded(page: Page): Promise<Recorded[]> {
  const value = await json(page, "window.__a11y08");
  assert.ok(Array.isArray(value), "the recorder ran");
  return value.map((item: unknown) => {
    assert.ok(item && typeof item === "object" && "at" in item && "key" in item && "value" in item);
    return { at: Number(item.at), key: String(item.key), value: item.value };
  });
}
const values = async (page: Page, key: string) =>
  (await recorded(page)).filter((e) => e.key === key).map((e) => e.value);
const stateSchema = z.object({
  text: z.string(),
  opening: z.boolean(),
  loaded: z.boolean(),
  busy: z.string().nullable(),
  visibility: z.string(),
});
/** The line's text, the wrap's state, busy and the frame's computed visibility, at once. */
async function state(page: Page): Promise<z.infer<typeof stateSchema>> {
  const value = await json(
    page,
    `(() => { const w = document.querySelector("[data-docwrap]");
      return { text: document.querySelector("[data-loading]").textContent,
        opening: w.hasAttribute("data-opening"), loaded: w.hasAttribute("data-loaded"),
        busy: document.getElementById("main").getAttribute("aria-busy"),
        visibility: getComputedStyle(document.querySelector("[data-frame]")).visibility }; })()`,
  );
  return stateSchema.parse(value);
}
const shown = (page: Page) =>
  page.waitForFunction(`document.querySelector("[data-loading]").textContent !== ""`);
/** The frame has loaded `path` and the line is done. */
const loadedPath = (page: Page, path: string) =>
  page.waitForFunction(
    `(() => { const w = document.querySelector("[data-docwrap]");
      const f = document.querySelector("[data-frame]");
      return w.hasAttribute("data-loaded") && f.contentWindow.location.pathname.endsWith(${JSON.stringify(`/${path}`)}); })()`,
  );

const click = (page: Page, path: string) =>
  page.locator(`#tp-files a[data-file="${path}"]`).click();
// The 300 ms step, with room for a busy machine: never sooner, and well before the 1.5 s load.
const STEP_MAX_MS = 900;
// A valid file name with no break opportunity: the line must wrap it, not run off the screen.
const LONG = `decisions_${"webhook_idempotency_".repeat(9)}final.md`;

const scenario: ViewerScenario = {
  name: "A11Y-08: loading line after 300 ms, stale document hidden on slow switches, none when fast",
  async run(ctx) {
    const { base } = ctx.writer;
    const created = await ctx.writer.api("/api/collections", {
      title: "Loading line",
      head_path: "index.md",
      files: [
        await ctx.writer.write("index.md", "# Runbook\n\nSee [the notes](notes/b.md).\n"),
        await ctx.writer.write("notes/b.md", "# Notes B\n\nB.\n"),
        await ctx.writer.write("notes/c.md", "# Notes C\n\nC.\n"),
        await ctx.writer.write(LONG, "# Long\n\nL.\n"),
        await ctx.writer.write("shot.png", new Uint8Array([137, 80, 78, 71]), "image/png"),
        await ctx.writer.write("build.zip", "PK zip", "application/zip"),
      ],
    });
    const latest = new URL(created.latest_url).pathname;
    let slow = false;
    const open = async (page: Page) => {
      await page.addInitScript(RECORDER);
      await page.route("**/raw/r/**", async (route) => {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
    };

    // A slow first load: busy at once, the line after 300 ms; all cleared on load.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = true;
      await page.goto(`${base}${latest}`, { waitUntil: "domcontentloaded" });
      await shown(page);
      assert.deepEqual(await state(page), {
        text: "Opening index.md…",
        opening: true,
        loaded: false,
        busy: "true",
        visibility: "hidden",
      });
      assert.ok(
        await page.getByRole("status").filter({ hasText: "Opening index.md…" }).isVisible(),
        "the line is a visible status",
      );
      await loadedPath(page, "index.md");
      assert.deepEqual(await state(page), {
        text: "",
        opening: false,
        loaded: true,
        busy: null,
        visibility: "visible",
      });
      const events = await recorded(page);
      const busyAt = events.find((e) => e.key === "busy" && e.value === "true")?.at ?? NaN;
      const textAt = events.find((e) => e.key === "text" && e.value)?.at ?? NaN;
      assert.ok(textAt - busyAt >= 295, `shown ${textAt - busyAt} ms after busy`);
      assert.ok(textAt - busyAt < STEP_MAX_MS, `shown by ${textAt - busyAt} ms after busy`);
    }

    // A fast first load records no text.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      assert.deepEqual(await values(page, "text"), [], "a fast load never shows the line");
      assert.equal((await state(page)).busy, null);
    }

    // A slow switch: the stale document stays for 300 ms, then the frame is hidden and the line
    // shows alone at the top of the document area; all cleared on load.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      slow = true;
      await click(page, "notes/b.md");
      await page.waitForTimeout(150);
      const early = await json(
        page,
        `performance.now() - window.__a11y08.findLast((e) => e.key === "busy" && e.value === "true").at`,
      );
      // Checked only while it is still early (a slow machine may take longer to get here); the
      // recorded times below hold the 300 ms step either way.
      if (Number(early) < 290)
        assert.deepEqual(await state(page), {
          text: "",
          opening: false,
          loaded: false,
          busy: "true",
          visibility: "visible",
        });
      await shown(page);
      assert.deepEqual(await state(page), {
        text: "Opening notes/b.md…",
        opening: true,
        loaded: false,
        busy: "true",
        visibility: "hidden",
      });
      assert.ok(await page.locator(".loading").isVisible(), "the line is visible");
      const top = await json(
        page,
        `document.querySelector("[data-loading]").getBoundingClientRect().top -
          document.querySelector("[data-docwrap]").getBoundingClientRect().top`,
      );
      assert.ok(Number(top) >= 0 && Number(top) <= 64, `the line is ${String(top)} px down`);
      await loadedPath(page, "notes/b.md");
      assert.deepEqual(await state(page), {
        text: "",
        opening: false,
        loaded: true,
        busy: null,
        visibility: "visible",
      });
      const events = await recorded(page);
      const busyAt = events.findLast((e) => e.key === "busy" && e.value === "true")?.at ?? NaN;
      const openingAt = events.find((e) => e.key === "opening" && e.value === true)?.at ?? NaN;
      const textAt = events.find((e) => e.key === "text" && e.value)?.at ?? NaN;
      assert.ok(openingAt - busyAt >= 295, `hidden ${openingAt - busyAt} ms after the click`);
      assert.ok(openingAt - busyAt < STEP_MAX_MS, `hidden by ${openingAt - busyAt} ms`);
      assert.equal(textAt, openingAt, "the text and the hidden frame arrive in one step");
    }

    // A fast switch: no line, the frame is never hidden.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      await click(page, "notes/b.md");
      await loadedPath(page, "notes/b.md");
      assert.deepEqual(await values(page, "text"), [], "no line");
      assert.deepEqual(await values(page, "opening"), [], "never hidden");
    }

    // A second switch while the first is still opening: the frame stays hidden, the line names
    // the new file at once, and both clear on the second load.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      slow = true;
      await click(page, "notes/b.md");
      await shown(page);
      await click(page, "notes/c.md");
      const now = await state(page);
      assert.equal(now.text, "Opening notes/c.md…", "the new path at once");
      assert.equal(now.opening, true, "still hidden");
      await loadedPath(page, "notes/c.md");
      assert.deepEqual(await values(page, "opening"), [true, false], "hidden once, until load");
      assert.deepEqual(await values(page, "text"), [
        "Opening notes/b.md…",
        "Opening notes/c.md…",
        "",
      ]);
      assert.equal((await state(page)).busy, null);
    }

    // Back to the file the frame still shows while a slow switch is pending (A -> B -> A): that
    // is a new navigation too, so the line names it (never the abandoned B) and clears on load.
    const back = async (wait: "before" | "after") => {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      slow = true;
      await click(page, "notes/b.md");
      if (wait === "before") await page.waitForTimeout(100);
      else await shown(page);
      const backAt = Number(await json(page, "performance.now()"));
      await click(page, "index.md");
      if (wait === "after") {
        const now = await state(page);
        assert.equal(now.text, "Opening index.md…", "after the step: the new path at once");
        assert.equal(now.opening, true, "after the step: still hidden");
      } else {
        await shown(page);
        assert.equal((await state(page)).text, "Opening index.md…", "before the step: A's line");
      }
      await loadedPath(page, "index.md");
      const events = await recorded(page);
      const later = events.filter((e) => e.key === "text" && e.at >= backAt).map((e) => e.value);
      assert.ok(!later.includes("Opening notes/b.md…"), `${wait}: never B after going back`);
      assert.deepEqual(await state(page), {
        text: "",
        opening: false,
        loaded: true,
        busy: null,
        visibility: "visible",
      });
    };
    await back("before");
    await back("after");

    // A long file name with no break opportunity wraps inside the document area: nothing runs
    // past the column or the viewport, on a phone or a desktop.
    const long = async (viewport: (typeof VIEWPORTS)["phone" | "desktop"]) => {
      const { page } = await ctx.newPage(viewport);
      await open(page);
      slow = true;
      await page.goto(`${base}${latest}${LONG}`, { waitUntil: "domcontentloaded" });
      await shown(page);
      const fit = await json(
        page,
        `(() => { const l = document.querySelector("[data-loading]");
          const w = document.querySelector("[data-docwrap]").getBoundingClientRect();
          const r = l.getBoundingClientRect();
          return { text: l.textContent, inLine: l.scrollWidth <= l.clientWidth,
            inArea: r.left >= w.left && r.right <= w.right + 0.5,
            inView: r.right <= innerWidth + 0.5,
            noScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`,
      );
      assert.deepEqual(
        fit,
        { text: `Opening ${LONG}…`, inLine: true, inArea: true, inView: true, noScroll: true },
        `${viewport.width} px: the long name wraps in place`,
      );
      await loadedPath(page, LONG);
    };
    await long(VIEWPORTS.phone);
    await long(VIEWPORTS.desktop);

    // An in-document link: the frame navigates itself; no line, not busy.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await open(page);
      slow = false;
      await page.goto(`${base}${latest}`);
      await loadedPath(page, "index.md");
      slow = true;
      await page.frameLocator("iframe.frame").getByRole("link", { name: "the notes" }).click();
      await page.waitForTimeout(600);
      assert.deepEqual(await values(page, "text"), [], "no line while it loads");
      assert.equal((await state(page)).busy, null, "not busy while it loads");
      await page.waitForFunction(
        `document.querySelector("[data-frame]").contentWindow.location.pathname.endsWith("/notes/b.md")`,
      );
      await page.waitForFunction(`document.querySelector("[data-frame]").title === "notes/b.md"`);
      assert.deepEqual(await values(page, "text"), [], "no line");
      assert.deepEqual(await values(page, "opening"), [], "never hidden");
      assert.equal((await state(page)).busy, null);
    }

    // Image and download pages have no wrap.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      slow = false;
      for (const path of ["shot.png", "build.zip"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two pages, checked in order.
        await page.goto(`${base}${latest}${path}`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Two pages, checked in order.
        assert.equal(await page.locator("[data-docwrap]").count(), 0, `${path}: no wrap`);
      }
    }
  },
};
export default scenario;
