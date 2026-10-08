import { z } from "zod";

import { assert, axe, VIEWPORTS, type ViewerScenario } from "../harness.ts";

// Every code block: its pre's text, its Copy button's text, the tallest token over the line height,
// and the pre's computed word-break.
const BLOCKS = `[...document.querySelectorAll(".codeblock")].map((block) => {
  const pre = block.querySelector("pre");
  const lineHeight = parseFloat(getComputedStyle(pre).lineHeight);
  const tallest = Math.max(0, ...[...pre.querySelectorAll(".tk")].map((tk) => tk.getBoundingClientRect().height));
  return {
    pre: pre.textContent,
    text: block.querySelector("button[data-action=copy-text]").dataset.text,
    lines: pre.querySelectorAll(".ln").length,
    tokens: pre.querySelectorAll(".tk").length,
    over: tallest - lineHeight,
    wordBreak: getComputedStyle(pre).wordBreak,
  };
})`;
const blocksOf = z.array(
  z.object({
    pre: z.string(),
    text: z.string(),
    lines: z.number(),
    tokens: z.number(),
    over: z.number(),
    wordBreak: z.string(),
  }),
);
const heightsOf = z.array(z.number());
// Lines whose first token starts below the line's top: the line broke after its indent, which
// reads as a blank line.
const DROPPED = `[...document.querySelectorAll(".codeblock .ln")].filter((ln) => {
  const tk = ln.querySelector(".tk");
  return tk && Math.abs(tk.getBoundingClientRect().top - ln.getBoundingClientRect().top) > 1;
}).map((ln) => ln.textContent)`;
// A machine with a long name, added to the list: its name must stay inside its own cell.
const LONG_HOST = `(() => {
  let list = document.querySelector("ul.hosts");
  if (!list) {
    list = document.createElement("ul");
    list.className = "hosts";
    document.querySelector("h2.sec").after(list);
  }
  const li = document.createElement("li");
  li.innerHTML = '<a href="/?q=host%3Along"><span class="mono">buildrunner0123456789abcdefghijklmnopqrstuvwxyz0123456789internal</span><span class="m">3 revisions · last 2 h ago</span><span class="go">See its collections <span aria-hidden="true">›</span></span></a>';
  list.prepend(li);
  const a = li.querySelector("a");
  // The text's own extent (a range), not its grid cell's, which overflowing text doesn't widen.
  const [host, meta] = [...a.querySelectorAll(".mono, .m")].map((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  });
  const box = a.getBoundingClientRect();
  const overlap = host.right > meta.left + 0.5 && host.bottom > meta.top + 0.5 && meta.bottom > host.top + 0.5;
  return { overlap, inside: host.left >= box.left - 0.5 && host.right <= box.right + 0.5 };
})()`;
// The requirement line naming a long (valid) writer address: it takes more than one line, and the
// page doesn't scroll sideways.
const LONG_ADDRESS = `(() => {
  const mono = document.querySelector(".mcp .req .mono");
  mono.textContent = "https://waypoint.abcdefghijklmnopqrstuvwxyz1234.example-tailnet.ts.net";
  const range = document.createRange();
  range.selectNodeContents(mono);
  const root = document.documentElement;
  return {
    lines: range.getClientRects().length > 1,
    overflow: Math.max(0, root.scrollWidth - root.clientWidth),
  };
})()`;
const HEIGHTS = (selector: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getBoundingClientRect().height)`;

const scenario: ViewerScenario = {
  name: "NAV-13 connect an agent: wrap-safe commands, named Copy buttons, 44 px on touch",
  async run(ctx) {
    const { base } = ctx.writer;
    const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
    await page.goto(`${base}/mcp`);
    assert.equal(await page.locator("main.mcp ol.steps > li").count(), 3);

    // Tokens never split, wrapping is display-only, and the pre holds exactly what Copy copies.
    const blocks = blocksOf.parse(await page.evaluate(BLOCKS));
    assert.equal(blocks.length, 2);
    for (const block of blocks) {
      assert.ok(block.tokens > 0);
      assert.ok(block.over <= 1, `a token wraps: ${block.over}px over one line`);
      assert.equal(block.wordBreak, "normal");
      assert.equal(block.pre, block.text);
    }

    // Step 1's Copy: the clipboard gets the command, the button says Copied, the toast names it.
    const copy = page.getByRole("button", { name: "Copy Claude Code command" });
    await copy.click();
    await page.waitForFunction(
      'document.querySelector(".codeblock [data-action=copy-text]").textContent.includes("Copied")',
    );
    assert.equal(await page.evaluate("navigator.clipboard.readText()"), blocks[0]!.text);
    assert.equal(
      blocks[0]!.text,
      `claude mcp add waypoint --env WAYPOINT_URL=${base} -- npx --prefer-offline -y ${base}/mcp/waypoint-mcp.tgz`,
    );
    await page.getByText("Copied Claude Code command").waitFor();

    // 44 px tap targets on touch.
    const touch = heightsOf.parse(
      await page.evaluate(HEIGHTS(".mcp [data-action=copy-text], .mcp .tabs2 a")),
    );
    assert.equal(touch.length, 3 + 3); // three Copy buttons and three tabs
    for (const height of touch) assert.ok(height >= 44, `a ${height}px control on touch`);

    // A long machine name wraps inside its cell; a keyboard focus ring isn't clipped by the list.
    assert.deepEqual(await page.evaluate(LONG_HOST), { overlap: false, inside: true });
    // A long writer address wraps inside the requirement line instead of widening the page.
    assert.deepEqual(await page.evaluate(LONG_ADDRESS), { lines: true, overflow: 0 });
    const hostLink = page.locator("ul.hosts > li > a").first();
    await page.keyboard.press("Tab"); // a keyboard interaction, so focus shows its ring
    await hostLink.focus();
    const ring = z.object({ visible: z.boolean(), offset: z.number(), width: z.number() }).parse(
      await page.evaluate(`(() => {
        const a = document.activeElement;
        const style = getComputedStyle(a);
        return {
          visible: a.matches("ul.hosts a:focus-visible"),
          offset: parseFloat(style.outlineOffset),
          width: parseFloat(style.outlineWidth),
        };
      })()`),
    );
    assert.ok(ring.visible, "the host link shows a focus ring");
    assert.ok(ring.offset + ring.width <= 0, `the host focus ring sits outside: ${ring.offset}px`);

    // The Codex tab installs only the Codex skill; Other's JSON is pretty-printed.
    await page.goto(`${base}/mcp?client=codex`);
    const codex = blocksOf.parse(await page.evaluate(BLOCKS));
    assert.match(codex[1]!.text, /\.codex\/skills/);
    assert.doesNotMatch(codex[1]!.text, /\.claude\/skills/);
    await page.goto(`${base}/mcp?client=other`);
    const other = blocksOf.parse(await page.evaluate(BLOCKS));
    assert.ok(other[0]!.lines > 5, `${other[0]!.lines} lines of JSON`);
    assert.equal(other[0]!.pre, other[0]!.text);
    assert.equal(
      await page.locator('.tabs2 a[aria-current="page"]').textContent(),
      "Other MCP client",
    );
    // No line breaks after its indent, even where its first token (the tarball URL) is wider than
    // the block.
    assert.deepEqual(await page.evaluate(DROPPED), []);
    // The JSON block is wider than a phone: a keyboard can focus it and scroll it.
    const json = page.locator(".codeblock pre").first();
    const wide = await page.evaluate(
      `(() => { const pre = document.querySelector(".codeblock pre"); return pre.scrollWidth > pre.clientWidth; })()`,
    );
    assert.equal(wide, true, "the phone JSON block scrolls sideways");
    await json.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(`document.querySelector(".codeblock pre").scrollLeft > 0`);
    assert.deepEqual(await axe(page, { rules: ["scrollable-region-focusable"] }), []);

    // Forced colours: only the current tab is underlined.
    const forced = await ctx.newPage({ ...VIEWPORTS.desktop, forcedColors: "active" });
    await forced.page.goto(`${base}/mcp?client=codex`);
    const underlines = z
      .array(z.object({ current: z.boolean(), color: z.string() }))
      .parse(
        await forced.page.evaluate(
          `[...document.querySelectorAll(".tabs2 a")].map((a) => ({ current: a.getAttribute("aria-current") === "page", color: getComputedStyle(a).borderBottomColor }))`,
        ),
      );
    // The numbered circles keep an outline there too.
    const circle = z.object({ width: z.number(), color: z.string() }).parse(
      await forced.page.evaluate(`(() => {
        const style = getComputedStyle(document.querySelector(".steps h2"), "::before");
        return { width: parseFloat(style.borderTopWidth), color: style.borderTopColor };
      })()`),
    );
    assert.ok(circle.width > 0, "the step circles have no border in forced colours");
    assert.notEqual(circle.color, "rgba(0, 0, 0, 0)", "the step circles vanish in forced colours");
    const current = underlines.filter((underline) => underline.current);
    assert.equal(current.length, 1);
    for (const underline of underlines.filter((each) => !each.current))
      assert.notEqual(
        underline.color,
        current[0]!.color,
        "a non-current tab is underlined in forced colours",
      );

    // Desktop, mouse: the Copy buttons keep the small size, and axe finds nothing on the page. The
    // one exception is the bar's health pill (its aria-label doesn't start with its visible text):
    // that is layout's, and OW-10b renames it and removes this filter.
    const desktop = await ctx.newPage(VIEWPORTS.desktop);
    await desktop.page.goto(`${base}/mcp`);
    const small = heightsOf.parse(
      await desktop.page.evaluate(HEIGHTS(".mcp [data-action=copy-text]")),
    );
    assert.equal(small.length, 3);
    for (const height of small) assert.ok(height === 26 || height === 28, `${height}px Copy`);
    const violations = (await axe(desktop.page)).filter(
      (violation) =>
        violation.id !== "label-content-name-mismatch" ||
        violation.nodes.some((node) => !/^<button[^>]* class="health\b/.test(node.html)),
    );
    assert.deepEqual(violations, []);
  },
};
export default scenario;
