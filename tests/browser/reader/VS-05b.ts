// VS-05b: the shell's one `.btn` family. The download card's button is `btn primary`: ink fill and
// 32 px with a mouse (as before), at least 44 px tall on touch screens, a ButtonText border under
// forced colours; RX-01's About button stays 32 px on touch (it isn't a `.btn`).
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import {
  assert,
  collectConsole,
  cspProblems,
  readerTestDb,
  startReader,
  VIEWPORTS,
  type ReaderScenario,
} from "../harness.ts";

const HASH = "sha256:" + "5".repeat(64);
const COL = { id: "col_" + "v".repeat(26), pub: "vvvvvvvvvvvv" };
const REV = { id: "rev_" + "0".repeat(25) + "v", pub: "v5v5v5v5v5v5" };
const LINK = "shl_" + "0".repeat(25) + "v";
const FILES = [
  ["index.md", "text/markdown", 100],
  ["other.md", "text/markdown", 100],
  ["archive.zip", "application/zip", 4096],
] as const;

/** `#doc`'s computed style, as [height, background, colour, top border colour]. */
const doc = async (page: Page): Promise<string[]> => {
  const value: unknown = JSON.parse(
    String(
      await page.evaluate(`JSON.stringify((() => {
        const s = getComputedStyle(document.getElementById("doc"));
        return [s.height, s.backgroundColor, s.color, s.borderTopColor]; })())`),
    ),
  );
  assert.ok(Array.isArray(value) && value.length === 4, "#doc has a computed style");
  return value.map(String);
};
/** The computed colour of a CSS colour value, through a probe the forced palette leaves alone
 *  (CSSOM is allowed under the CSP). */
const colour = async (page: Page, value: string): Promise<string> =>
  String(
    await page.evaluate(`(() => { const p = document.createElement("span");
      p.style.forcedColorAdjust = "none"; p.style.color = ${JSON.stringify(value)};
      document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`),
  );
const height = async (page: Page, selector: string): Promise<number> =>
  Number(
    await page.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().height`,
    ),
  );

const scenario: ReaderScenario = {
  name: "VS-05b shared shell button family: download card look, 44 px on touch, forced colours",
  async run(ctx) {
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Button family",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "index.md",
    );
    for (const [path, mime, size] of FILES)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        REV.id,
        path,
        HASH,
        mime,
        size,
      );
    const token = newShareToken();
    // A following link (no pinned revision).
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
      blob: () => new Response("# Button family\n\nThe document.\n"),
    });
    const base = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const logs: string[][] = [];
    const open = async (page: Page, path: string) => {
      logs.push(collectConsole(page));
      const response = await page.goto(base + path);
      assert.equal(response?.status(), 200, `loads ${path}`);
    };

    // Mouse, light and dark: the card's Download looks as before (32 px, ink fill, paper text).
    for (const colorScheme of ["light", "dark"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      await open(page, "archive.zip");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      assert.equal(await page.getAttribute("#doc", "class"), "btn primary");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      const [h, background, text] = await doc(page);
      assert.equal(h, "32px", `${colorScheme}: Download is 32 px tall with a mouse`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      assert.equal(background, await colour(page, "var(--ink)"), `${colorScheme}: ink fill`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two schemes, checked in order.
      assert.equal(text, await colour(page, "var(--paper)"), `${colorScheme}: paper text`);
    }

    // Touch (coarse pointer): Download is at least 44 px tall; RX-01's About stays 32 px.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await open(page, "archive.zip");
      assert.equal(await page.evaluate(`matchMedia("(pointer: coarse)").matches`), true);
      assert.ok((await height(page, "#doc")) >= 44, "Download ≥ 44 px on touch");
      const about = await height(page, ".abt");
      assert.ok(Math.abs(about - 32) <= 1, `About stays 32 px on touch: ${about}`);
    }

    // Forced colours: Download keeps a visible ButtonText border.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
      await open(page, "archive.zip");
      const [, , , border] = await doc(page);
      assert.equal(border, await colour(page, "ButtonText"), "Download's border is ButtonText");
      await page.hover("#doc");
      const [, , , hovered] = await doc(page);
      assert.equal(hovered, border, "and stays ButtonText on hover");
      // A ghost family member (RX-06's later consumer), probed here: its transparent border is
      // forced too, so it must be ButtonText at rest and on hover, not LinkText.
      const ghostBorder = () =>
        page.evaluate(`getComputedStyle(document.getElementById("ghost-probe")).borderTopColor`);
      await page.evaluate(`(() => { const a = document.createElement("a");
        a.id = "ghost-probe"; a.className = "btn ghost"; a.href = "#"; a.textContent = "Ghost";
        document.getElementById("doc").after(a); })()`);
      assert.equal(String(await ghostBorder()), border, "a ghost button's border is ButtonText");
      await page.hover("#ghost-probe");
      assert.equal(String(await ghostBorder()), border, "and stays ButtonText on hover");
    }

    for (const log of logs) assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
