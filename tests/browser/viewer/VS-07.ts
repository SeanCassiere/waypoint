// VS-07: documents on the warm Folio palette (markdown renderer v3). In light and dark, the
// Contents box, code wells and rules take the chrome's warm colours, links the public blue, and
// keyboard focus the chrome's 2px ink ring; alert hues and Shiki colours are unchanged, and the
// diff colour (--changed) isn't in the reading palette.
import type { Frame, Page } from "playwright";
import { z } from "zod";

import { assert, VIEWPORTS, type ViewerContext, type ViewerScenario } from "../harness.ts";

const DOC =
  "# Palette\n\n[Link](#one)\n\n## One\n\n```js\nlet x = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n" +
  "> [!WARNING]\n> Careful.\n\n## Two\n\n## Three\n\n## Four\n";

/** A `#rrggbb` colour as getComputedStyle reports it. */
const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

const SCHEMES = {
  light: { well: "#f4f2ee", rule: "#e7e3dc", link: "#1f5fd1", warn: "#9a6700", ink: "#1b1a17" },
  dark: { well: "#1e1d1a", rule: "#2b2a27", link: "#82adff", warn: "#e3b341", ink: "#ebe8e2" },
} as const;

const styles = z.object({
  tocBg: z.string(),
  tocBorder: z.string(),
  preBg: z.string(),
  h2Rule: z.string(),
  tocLink: z.string(),
  warnTitle: z.string(),
  changed: z.string(),
  shiki: z.object({ color: z.string(), own: z.string() }),
});
const ring = z.object({
  match: z.boolean(),
  style: z.string(),
  width: z.string(),
  offset: z.string(),
  color: z.string(),
  radius: z.string(),
});

/** The document frame once it has loaded `path`. */
async function docFrame(page: Page, path: string): Promise<Frame> {
  await page.waitForFunction(
    `(() => { const w = document.querySelector("[data-docwrap]");
      const f = document.querySelector("[data-frame]");
      return w.hasAttribute("data-loaded") && f.contentWindow.location.pathname.endsWith(${JSON.stringify(`/${path}`)}); })()`,
  );
  const frame = page
    .frames()
    .find((f) => f !== page.mainFrame() && new URL(f.url()).pathname.endsWith(`/${path}`));
  assert.ok(frame, `the frame shows ${path}`);
  await frame.waitForLoadState("load");
  return frame;
}

/** The focused element's ring, and whether it matches `selector`. */
const focusRing = async (frame: Frame, selector: string) =>
  ring.parse(
    await frame.evaluate(`(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      return { match: el.matches(${JSON.stringify(selector)}), style: s.outlineStyle,
        width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor,
        radius: s.borderTopLeftRadius };
    })()`),
  );

/** Presses Tab until the frame's focus matches `selector`, at most `left` more times. */
async function tabTo(page: Page, frame: Frame, selector: string, left: number): Promise<void> {
  if ((await focusRing(frame, selector)).match || left === 0) return;
  await page.keyboard.press("Tab");
  await tabTo(page, frame, selector, left - 1);
}

/** Opens the document in one colour scheme and checks its palette and focus ring. */
async function checkScheme(
  ctx: ViewerContext,
  url: string,
  colorScheme: keyof typeof SCHEMES,
): Promise<void> {
  const want = SCHEMES[colorScheme];
  const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme });
  await page.goto(url);
  const frame = await docFrame(page, "doc.md");

  const got = styles.parse(
    await frame.evaluate(`(() => {
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const token = document.querySelector("pre.shiki span.line > span[style*='--shiki-']");
      const own = getComputedStyle(token).getPropertyValue(${JSON.stringify(`--shiki-${colorScheme}`)}).trim();
      const probe = document.createElement("span");
      probe.style.color = own;
      document.body.append(probe);
      const ownColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        tocBg: cs("details.toc").backgroundColor,
        tocBorder: cs("details.toc").borderTopColor,
        preBg: cs("pre").backgroundColor,
        h2Rule: cs("h2:not(:first-of-type)").borderTopColor,
        tocLink: cs("details.toc a").color,
        warnTitle: cs(".markdown-alert-warning .markdown-alert-title").color,
        changed: getComputedStyle(document.documentElement).getPropertyValue("--changed"),
        shiki: { color: getComputedStyle(token).color, own: ownColor },
      };
    })()`),
  );
  assert.equal(got.tocBg, rgb(want.well), `${colorScheme}: the Contents box is a warm well`);
  assert.equal(got.tocBorder, rgb(want.rule), `${colorScheme}: the Contents border is a rule`);
  assert.equal(got.preBg, rgb(want.well), `${colorScheme}: code wells match the Contents box`);
  assert.equal(got.h2Rule, rgb(want.rule), `${colorScheme}: h2 rules are warm`);
  assert.equal(got.tocLink, rgb(want.link), `${colorScheme}: links are the public blue`);
  assert.equal(got.warnTitle, rgb(want.warn), `${colorScheme}: alert hues are unchanged`);
  assert.equal(got.changed, "", `${colorScheme}: --changed isn't in the reading palette`);
  assert.equal(got.shiki.color, got.shiki.own, `${colorScheme}: Shiki colours are unchanged`);

  // Keyboard focus: the first Contents link, then the Contents summary, take the ink ring.
  const ink = { style: "solid", width: "2px", offset: "2px", color: rgb(want.ink), radius: "4px" };
  await frame.locator("h1").click();
  await tabTo(page, frame, "details.toc a", 5);
  const { match: onLink, ...link } = await focusRing(frame, "details.toc a");
  assert.ok(onLink, `${colorScheme}: Tab reaches the first Contents link`);
  assert.deepEqual(link, ink, `${colorScheme}: the link has the 2px ink ring`);
  await page.keyboard.press("Shift+Tab");
  const { match: onSummary, ...summary } = await focusRing(frame, "details.toc > summary");
  assert.ok(onSummary, `${colorScheme}: Shift+Tab reaches the Contents summary`);
  assert.deepEqual(summary, ink, `${colorScheme}: the summary has the same ink ring`);

  // A code well (Shiki gives pre.shiki tabindex=0) keeps its own 8px corners under the ink ring.
  await tabTo(page, frame, "pre.shiki", 12);
  const { match: onWell, ...well } = await focusRing(frame, "pre.shiki");
  assert.ok(onWell, `${colorScheme}: Tab reaches the code well`);
  assert.deepEqual(
    well,
    { ...ink, radius: "8px" },
    `${colorScheme}: the code well has the ink ring with 8px corners`,
  );
}

export default {
  name: "VS-07 documents on the warm palette",
  async run(ctx) {
    const { base } = ctx.writer;
    const ref = await ctx.writer.write("doc.md", DOC);
    const created = await ctx.writer.api("/api/collections", {
      title: "VS-07 palette",
      files: [ref],
    });
    const url = `${base}${new URL(created.url).pathname}`;
    await checkScheme(ctx, url, "light");
    await checkScheme(ctx, url, "dark");
  },
} satisfies ViewerScenario;
