import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { markdownRenderer, renderMarkdown, RENDERER_NAME, RENDERER_VERSION } from "../src/index.js";
import { processor } from "../src/render.js";

describe("markdown rendition", () => {
  it("uses stable heading anchors and selects the first H1 as title", async () => {
    const html = await renderMarkdown("## Intro\n# Hello *world*\n# Hello world\n# Hello world");
    expect(html).toContain("<title>Hello world</title>");
    expect(html).toContain('id="intro"');
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('id="hello-world-1"');
    expect(html).toContain('id="hello-world-2"');
  });

  it("supports GFM tables, tasks, strikethrough, autolinks, and footnotes", async () => {
    const html = await renderMarkdown(
      "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ https://example.com\n\nNote[^1].\n\n[^1]: Footnote text.",
    );
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("Footnote text.");
    expect(html).toContain('id="user-content-fn-1"');
  });

  it("preserves raw HTML and relative links and images", async () => {
    const html = await renderMarkdown(
      '<aside data-kind="note">Raw</aside>\n\n[Next](./chapter.md) ![Plot](../img/plot.png)',
    );
    expect(html).toContain('<aside data-kind="note">Raw</aside>');
    expect(html).toContain('href="./chapter.md"');
    expect(html).toContain('src="../img/plot.png"');
  });

  it("highlights known languages, escapes unknown languages, and leaves Mermaid inert", async () => {
    const html = await renderMarkdown(
      "```ts\nconst value: number = 1;\n```\n\n```python\nprint('hi')\n```\n\n```oddlang\n<x>&\n```\n\n```mermaid\ngraph TD; A-->B\n```",
    );
    expect(html.match(/class="shiki/g)).toHaveLength(2);
    expect(html).toContain("--shiki-light:");
    expect(html).toContain("--shiki-dark:");
    expect(html).not.toContain('<span class="line"></span>');
    expect(html).toContain('class="language-oddlang"');
    expect(html).toContain("&#x3C;x>&#x26;");
    expect(html).toContain('<pre class="mermaid">graph TD; A-->B');
  });

  it("uses explicit and fallback titles with HTML escaping", async () => {
    expect(await renderMarkdown("plain")).toContain("<title>Untitled</title>");
    expect(await renderMarkdown("# Heading", { title: '<Title & "more">' })).toContain(
      "<title>&lt;Title &amp; &quot;more&quot;&gt;</title>",
    );
  });

  it("renders only normalized Markdown MIME and strips the UTF-8 BOM", async () => {
    expect(RENDERER_NAME).toBe("markdown");
    expect(RENDERER_VERSION).toBe(1);
    expect(await markdownRenderer.render(new Uint8Array(), "text/plain")).toBeNull();
    const result = await markdownRenderer.render(
      new TextEncoder().encode("\uFEFF# Title"),
      "Text/Markdown; charset=utf-8",
    );
    expect(result?.mime).toBe("text/html");
    expect(new TextDecoder().decode(result?.bytes)).toContain("<title>Title</title>");
  });

  it("adds no external resources or scripts", async () => {
    const html = await renderMarkdown("# Title\n\n![Local](./img.png)\n\n```js\nlet x = 1\n```");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<(?:link|script|img)\b[^>]*(?:src|href)=["']https?:\/\//i);
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("is byte-identical for concurrent first calls and long-line fences", async () => {
    const source = "```js\n" + "const x = ".repeat(700) + "\n```";
    const results = await Promise.all(Array.from({ length: 4 }, () => renderMarkdown(source)));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain("const x = ");
    expect(results[0]).not.toContain("--shiki-light:#D73A49");
  });

  it("uses deterministic size and nesting fallbacks", async () => {
    const cases = [
      ["x".repeat(1_000_001), "file too large to render"],
      [">".repeat(5000), "nesting too deep to render"],
      ["<div>".repeat(20_000), "nesting too deep to render"],
      ["*".repeat(10_000), "nesting too deep to render"],
    ] as const;
    await Promise.all(
      cases.map(async ([source, reason]) => {
        const first = await renderMarkdown(source);
        expect(first).toContain(`Shown as plain text: ${reason}`);
        expect(first).toContain('class="source-fallback"');
        expect(await renderMarkdown(source)).toBe(first);
      }),
    );
  });

  it("leaves fences over 100 KB as escaped plain code", async () => {
    const html = await renderMarkdown(`\`\`\`js\n${"<x>&".repeat(26_000)}\n\`\`\``);
    expect(html.includes('class="language-js"')).toBe(true);
    expect(html.includes("&#x3C;x>&#x26;")).toBe(true);
    expect(html.includes('class="shiki')).toBe(false);
  });

  it("uses the deterministic fallback when the pipeline throws", async () => {
    const parse = vi.spyOn(processor, "parse").mockImplementationOnce(() => {
      throw new Error("pipeline failure");
    });
    const html = await renderMarkdown("# Source");
    parse.mockRestore();
    expect(html).toContain("Shown as plain text: could not be rendered");
    expect(html).toContain('<pre class="source-fallback"># Source</pre>');
  });

  it("normalizes title whitespace, entities, setext headings, and empty titles", async () => {
    expect(await renderMarkdown("text\n\nHeading &amp;   more\n====================")).toContain(
      "<title>Heading &amp; more</title>",
    );
    expect(await renderMarkdown("#   ")).toContain("<title>Untitled</title>");
    expect(await renderMarkdown("# Hi", { title: "  My \n title  " })).toContain(
      "<title>My title</title>",
    );
    expect(await renderMarkdown("# Hi", { title: "  " })).toContain("<title>Untitled</title>");
  });

  it("handles inert Mermaid text, plain fences, aliases, uppercase labels, and special property labels", async () => {
    const html = await renderMarkdown(
      "```mermaid\n</pre><script>alert(1)</script>\n```\n\n```\nplain\n```\n\n```sh\necho hi\n```\n\n```yml\na: b\n```\n\n```TS\nlet x = 1\n```\n\n```constructor\nx\n```\n\n```__proto__\ny\n```",
    );
    expect(html).toContain("&#x3C;/pre>&#x3C;script>alert(1)&#x3C;/script>");
    expect(html.match(/class="shiki/g)).toHaveLength(3);
    expect(html).toContain("<pre><code>plain");
    expect(html).toContain('class="language-constructor"');
    expect(html).toContain('class="language-__proto__"');
  });

  it("preserves only the second of two leading BOMs and keeps invalid UTF-8 deterministic", async () => {
    const doubleBom = await markdownRenderer.render(
      new TextEncoder().encode("\uFEFF\uFEFF# Title"),
      "text/markdown",
    );
    const doubleHtml = new TextDecoder().decode(doubleBom?.bytes);
    expect(doubleHtml).toContain("\uFEFF");
    const mid = await markdownRenderer.render(
      new TextEncoder().encode("# A\uFEFFB"),
      "text/markdown",
    );
    expect(new TextDecoder().decode(mid?.bytes)).toContain("A\uFEFFB");
    const invalid = new Uint8Array([35, 32, 255]);
    const first = await markdownRenderer.render(invalid, "text/markdown");
    expect(new TextDecoder().decode(first?.bytes)).toContain("�");
    expect((await markdownRenderer.render(invalid, "text/markdown"))?.bytes).toEqual(first?.bytes);
    expect(await markdownRenderer.render(invalid, "")).toBeNull();
    expect(await markdownRenderer.render(invalid, "text/markdown;")).toBeNull();
  });

  it("renders YAML front matter in a disclosure", async () => {
    const html = await renderMarkdown("---\nname: Example & Test\n---\n# Heading");
    expect(html).toContain(
      '<details class="front-matter"><summary>Front matter</summary><pre>name: Example &#x26; Test</pre></details>',
    );
    expect(html).toContain("<title>Heading</title>");
  });

  it("matches the worker output and recovers after a worker crash", async () => {
    const source = "# Worker\n\n```go\npackage main\n```";
    const bytes = new TextEncoder().encode(source);
    expect(
      new TextDecoder().decode((await markdownRenderer.render(bytes, "text/markdown"))?.bytes),
    ).toBe(await renderMarkdown(source));
    const send = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
      this: Worker,
    ) {
      void this.terminate();
    });
    const failed = await markdownRenderer.render(bytes, "text/markdown");
    send.mockRestore();
    expect(new TextDecoder().decode(failed?.bytes)).toContain(
      "Shown as plain text: could not be rendered",
    );
    expect(
      new TextDecoder().decode((await markdownRenderer.render(bytes, "text/markdown"))?.bytes),
    ).toBe(await renderMarkdown(source));
  });

  it("keeps the golden renderer output stable", async () => {
    const languages = [
      "typescript",
      "javascript",
      "tsx",
      "jsx",
      "json",
      "bash",
      "python",
      "go",
      "rust",
      "sql",
      "yaml",
      "toml",
      "html",
      "css",
      "diff",
      "markdown",
      "dockerfile",
    ];
    const fences = languages
      .map((language) => `\`\`\`${language}\nconst value = 1\n\`\`\``)
      .join("\n\n");
    const fixture = `---\ntitle: Test\n---\n# Golden &amp; title\n# Golden &amp; title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ https://example.com\n\nNote[^1].\n\n[^1]: Footnote.\n\n<aside>Raw</aside>\n\n${fences}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``;
    const hash = createHash("sha256");
    hash.update(await renderMarkdown(fixture));
    hash.update(await renderMarkdown(fixture, { title: " Golden override " }));
    hash.update(await renderMarkdown("x".repeat(1_000_001)));
    hash.update(await renderMarkdown(">".repeat(101)));
    expect(
      hash.digest("hex"),
      "renderer output changed: bump RENDERER_VERSION and update the golden hash",
    ).toBe("508d79e0fa89aa487d1e4ee957d5641e7d246d55929d22b88954aa77bec1bf01");
  });

  it.skipIf(process.env.CI === "true")(
    "renders a code-heavy 200 KB document after warm-up",
    async () => {
      await renderMarkdown("```js\nconst x = 1;\n```");
      const source = "```js\nconst value = 42;\n```\n\n".repeat(7000).slice(0, 210_000);
      expect(new TextEncoder().encode(source).length).toBeGreaterThan(200_000);
      const start = performance.now();
      await renderMarkdown(source);
      expect(performance.now() - start).toBeLessThan(10_000);
    },
  );
});
