import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SENTINELS, relativeLinkResolver, renderFragment, renderFragments } from "../src/index.ts";
import { FRAGMENT_GOLDEN_HASH, fragmentGoldenInputs } from "./fragment-golden.ts";

const links = { root: "/c/c1/r/r1/", dir: "docs/" };
const linked = (markdown: string) => renderFragment(markdown, relativeLinkResolver(links));

describe("Changes-page fragments", () => {
  it("keeps the golden fragment output stable", () => {
    const output = fragmentGoldenInputs()
      .map(([source, at]) => renderFragment(source, at ? relativeLinkResolver(at) : undefined))
      .join("\0");
    expect(
      createHash("sha256").update(output).digest("hex"),
      "fragment output changed: review the Changes page and update FRAGMENT_GOLDEN_HASH deliberately; no RENDERER_VERSION bump, fragments aren't stored",
    ).toBe(FRAGMENT_GOLDEN_HASH);
  });

  it("renders GFM alerts as callouts", () => {
    const html = renderFragment("> [!WARNING]\n> text");
    expect(html).toMatch(
      /^<div class="markdown-alert markdown-alert-warning">\s*<p class="markdown-alert-title">Warning<\/p>\s*<p>text<\/p>\s*<\/div>$/,
    );
    expect(renderFragment("> [!NOTE] text")).toContain("<blockquote>");
  });

  it("marks an image's text inside a word mark", () => {
    const { delOpen, delClose, insOpen, insClose } = SENTINELS;
    expect(
      renderFragment(`${delOpen}![old](a.png) x${delClose}${insOpen}![new](a.png)${insClose}`),
    ).toBe("<p><del>[image: old]</del><del> x</del><ins>[image: new]</ins></p>");
    expect(renderFragment("![plain](a.png)")).toBe("<p>[image: plain]</p>");
  });

  it("resolves relative links to the head revision's writer path", () => {
    expect(linked("[next](b.md)")).toContain('<a href="/c/c1/r/r1/docs/b.md">next</a>');
    expect(linked("[up](../b.md)")).toContain('<a href="/c/c1/r/r1/b.md">up</a>');
    expect(linked("[top](/top.md#part)")).toContain('<a href="/c/c1/r/r1/top.md#part">top</a>');
    expect(linked("[x](a%20b.md)")).toContain('href="/c/c1/r/r1/docs/a%20b.md"');
    expect(linked("[x](a%20b.md)")).not.toContain("%2520");
    expect(linked("[x](dir/./z.md)")).toContain('href="/c/c1/r/r1/docs/dir/z.md"');
    expect(
      ["../../../escape.md", "#x", "x%2F..%2Fy.md"].map((href) => linked(`[x](${href})`)),
    ).toEqual(Array.from({ length: 3 }, () => '<p><span class="rel-link">x</span></p>'));
    for (const href of ["javascript:alert(1)", "//evil.example/x"])
      expect(linked(`[x](${href})`)).toBe('<p><span class="rel-link">x</span></p>');
    // Without a resolver, relative links stay text; absolute links open a new tab either way.
    expect(renderFragment("[next](b.md)")).toBe('<p><span class="rel-link">next</span></p>');
    expect(linked("[ext](https://example.com/)")).toBe(
      '<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer">ext</a></p>',
    );
  });

  it("points a changed link at the head side's destination", () => {
    const { insOpen, insClose, delOpen, delClose } = SENTINELS;
    const changed = `${delOpen}a${delClose}${insOpen}b${insClose}.md`;
    expect(linked(`[next](${changed})`)).toBe('<p><a href="/c/c1/r/r1/docs/b.md">next</a></p>');
    const table = linked(`| Link |\n| --- |\n| [next](${changed}#${insOpen}top${insClose}) |`);
    expect(table).toContain('<a href="/c/c1/r/r1/docs/b.md#top">next</a>');
    expect(table).not.toMatch(/%EE%80|[\uE000-\uE003]/i);
    // The author's encoding stays; a link whose host changed opens the head's host.
    expect(linked(`[x](a%20${delOpen}old${delClose}${insOpen}new${insClose}.md)`)).toContain(
      'href="/c/c1/r/r1/docs/a%20new.md"',
    );
    expect(
      renderFragment(`[x](https://${delOpen}old${delClose}${insOpen}new${insClose}.example/)`),
    ).toContain('href="https://new.example/"');
  });

  it("passes the resolver through a batch", () => {
    expect(renderFragments(["[a](b.md)", "[a](b.md)"], 1000, relativeLinkResolver(links))).toEqual([
      '<p><a href="/c/c1/r/r1/docs/b.md">a</a></p>',
      '<p><a href="/c/c1/r/r1/docs/b.md">a</a></p>',
    ]);
  });
});

describe("relativeLinkResolver", () => {
  const resolve = relativeLinkResolver(links);
  const top = relativeLinkResolver({ root: "/c/c1/r/r1/", dir: "" });

  it("resolves against the file's directory and the revision root", () => {
    expect(resolve("b.md")).toBe("/c/c1/r/r1/docs/b.md");
    expect(resolve("../b.md")).toBe("/c/c1/r/r1/b.md");
    expect(resolve("/top.md")).toBe("/c/c1/r/r1/top.md");
    expect(resolve("dir/./z.md")).toBe("/c/c1/r/r1/docs/dir/z.md");
    expect(resolve("sub/../c.md#h")).toBe("/c/c1/r/r1/docs/c.md#h");
    expect(resolve("b.md?raw=1#h")).toBe("/c/c1/r/r1/docs/b.md#h");
    expect(top("b.md")).toBe("/c/c1/r/r1/b.md");
    expect(top("/")).toBe("/c/c1/r/r1/");
  });

  it("keeps the author's percent-encoding as written", () => {
    expect(resolve("a%20b.md")).toBe("/c/c1/r/r1/docs/a%20b.md");
    expect(resolve("a%2e.md")).toBe("/c/c1/r/r1/docs/a%2e.md");
  });

  it("treats encoded dot segments as browsers do", () => {
    // The URL parser reads `%2e%2e`, `.%2E` and `%2e.` as `..` and `%2e` as `.`.
    expect(resolve("%2e%2e/b.md")).toBe("/c/c1/r/r1/b.md");
    expect(resolve("x/%2E/y.md")).toBe("/c/c1/r/r1/docs/x/y.md");
    for (const href of ["%2e%2e/%2E%2e/b.md", ".%2e/../b.md", "../%2e./b.md"])
      expect({ href, resolved: resolve(href) }).toEqual({ href, resolved: null });
    // What a browser makes of a resolved link stays inside the revision.
    for (const href of ["%2e%2e/b.md", "x/.%2E/y.md", "a/%2e/b.md", "%2e%2e/"]) {
      const resolved = resolve(href);
      expect(resolved).not.toBeNull();
      expect(new URL(resolved ?? "", "http://writer.example").pathname).toBe(resolved);
    }
  });

  it("leaves everything else as text", () => {
    for (const href of [
      "",
      "#x",
      "../../../escape.md",
      "../b.md".replace("..", "../.."),
      "//evil.example/x",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "mailto:a@example.com",
      "x%2F..%2Fy.md",
      "x%5c..%5cy.md",
      "a\\b.md",
      "a\u0000b.md",
      "a\nb.md",
      "a\u007fb.md",
      "a.md?x?y",
    ])
      expect({ href, resolved: resolve(href) }).toEqual({ href, resolved: null });
    expect(top("../b.md")).toBeNull();
  });
});
