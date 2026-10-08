import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { markdownRenderer, renderMarkdown, RENDERER_NAME, RENDERER_VERSION } from "../src/index.ts";
import { FRAME_REPORTER, processor, TOC_MIN_H2 } from "../src/render.ts";

function h2s(count: number): string {
  return Array.from({ length: count }, (_, index) => `## Part *${index + 1}*\n\ntext`).join("\n\n");
}

function body(html: string): string {
  return html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
}

function goldenInputs(): Array<[string, string | null]> {
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
  const alerts = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
    .map((kind) => `> [!${kind}]\n> ${kind} body.`)
    .join("\n\n");
  const sections = ["One", "Two", "Three", "Four"]
    .map((name) => `## ${name}\n\nText with \`code\`.`)
    .join("\n\n");
  const fixture = `---\ntitle: Test\n---\n# Golden &amp; title\n# Golden &amp; title\n\n${sections}\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ https://example.com\n\nNote[^1].\n\n[^1]: Footnote.\n\n<aside>Raw</aside>\n\n${alerts}\n\n> Quote\n\n![Figure](./figure.png)\n\n${fences}\n\n\`\`\`oddlang\nx\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``;
  return [
    [fixture, null],
    [fixture, " Golden override "],
    ["x".repeat(1_000_001), null],
    [">".repeat(101), null],
  ];
}
async function goldenHash(): Promise<string> {
  const hash = createHash("sha256");
  const outputs = await Promise.all(
    goldenInputs().map(([source, title]) =>
      renderMarkdown(source, title === null ? undefined : { title }),
    ),
  );
  for (const output of outputs) hash.update(output);
  return hash.digest("hex");
}

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
    expect(RENDERER_VERSION).toBe(2);
    expect(await markdownRenderer.render(new Uint8Array(), "text/plain")).toBeNull();
    const result = await markdownRenderer.render(
      new TextEncoder().encode("\uFEFF# Title"),
      "Text/Markdown; charset=utf-8",
    );
    expect(result?.mime).toBe("text/html");
    expect(new TextDecoder().decode(result?.bytes)).toContain("<title>Title</title>");
  });

  it("adds no external resources and only the inline frame reporter script", async () => {
    const html = await renderMarkdown(
      "# Title\n\n![Local](./img.png)\n\n| a |\n| - |\n| 1 |\n\n> [!NOTE]\n> n\n\n```js\nlet x = 1\n```\n\n" +
        "## A\n## B\n## C\n## D\n\n---\nx: 1",
    );
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/<(?:link|iframe|object|embed)\b/i);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(["<script>"]);
    expect(html).toContain(`<script>${FRAME_REPORTER}</script>\n</body>`);
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme:dark");
    for (const fallback of [
      await renderMarkdown("x".repeat(1_000_001)),
      await renderMarkdown(">".repeat(101)),
    ]) {
      expect(fallback).not.toMatch(/https?:/i);
      expect(fallback.match(/<script\b[^>]*>/g)).toEqual(["<script>"]);
    }
  });

  it("frame reporter posts only the path and fragment to the parent", () => {
    type Message = { data: Record<string, unknown>; target: string };
    function run(options: {
      framed: boolean;
      readyState: string;
      narrow: boolean;
      width?: number;
    }) {
      const posted: Message[] = [];
      const handlers = new Map<string, (() => void)[]>();
      const listeners = new Map<string, () => void>();
      const toc: { open: boolean; onclick?: () => void } = { open: true };
      const media: { matches: boolean; onchange?: () => void } = { matches: options.narrow };
      const parent = {
        postMessage(data: Record<string, unknown>, target: string) {
          posted.push({ data: structuredClone(data), target });
        },
      };
      const location = {
        href: "https://reader.example/x/shl_secret.CAPABILITY/r/rev/doc.md?source=1#intro",
        origin: "https://reader.example",
        pathname: "/x/shl_secret.CAPABILITY/r/rev/doc.md",
        search: "?source=1",
        hash: "#intro",
      };
      const context: Record<string, unknown> = {
        location,
        document: {
          readyState: options.readyState,
          referrer: "https://reader.example/s/wps_SHARE_TOKEN/c/col/doc.md",
          cookie: "session=secret",
          title: "Secret title",
          documentElement: { clientWidth: options.width ?? (options.narrow ? 390 : 1100) },
          querySelector: (selector: string) => (selector === "details.toc" ? toc : null),
        },
        matchMedia: () => media,
        requestAnimationFrame: (callback: () => void) => callback(),
        addEventListener: (type: string, listener: () => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), listener]);
          listeners.set(type, () => {
            for (const handler of handlers.get(type) ?? []) handler();
          });
        },
      };
      context.window = context;
      context.parent = options.framed ? parent : context;
      runInNewContext(FRAME_REPORTER, context);
      return { posted, listeners, toc, location, media };
    }

    // The contents block is checked after layout, not while the iframe still has its default
    // 300px width, and follows the width until the reader toggles it.
    const sized = run({ framed: true, readyState: "loading", narrow: true, width: 300 });
    expect(sized.toc.open).toBe(true);
    sized.media.matches = false;
    sized.listeners.get("load")?.();
    expect(sized.toc.open).toBe(true);
    const phone = run({ framed: true, readyState: "loading", narrow: true });
    phone.listeners.get("load")?.();
    expect(phone.toc.open).toBe(false);
    phone.media.matches = false;
    phone.media.onchange?.();
    expect(phone.toc.open).toBe(true);
    phone.toc.onclick?.();
    phone.media.matches = true;
    phone.media.onchange?.();
    expect(phone.toc.open).toBe(true);
    const hidden = run({ framed: true, readyState: "complete", narrow: true, width: 0 });
    expect(hidden.toc.open).toBe(true);

    const loaded = run({ framed: true, readyState: "loading", narrow: false });
    expect(loaded.posted).toEqual([]);
    expect(loaded.toc.open).toBe(true);
    loaded.listeners.get("load")?.();
    loaded.location.hash = "#usage";
    loaded.listeners.get("hashchange")?.();
    expect(loaded.posted).toEqual([
      {
        data: { type: "waypoint:location", href: "/x/shl_secret.CAPABILITY/r/rev/doc.md#intro" },
        target: "*",
      },
      {
        data: { type: "waypoint:location", href: "/x/shl_secret.CAPABILITY/r/rev/doc.md#usage" },
        target: "*",
      },
    ]);
    const serialized = JSON.stringify(loaded.posted);
    for (const secret of ["reader.example", "source=1", "wps_SHARE_TOKEN", "session", "Secret"])
      expect(serialized).not.toContain(secret);
    for (const message of loaded.posted)
      expect(Object.keys(message.data).toSorted()).toEqual(["href", "type"]);

    const complete = run({ framed: true, readyState: "complete", narrow: true });
    expect(complete.posted).toHaveLength(1);
    expect(complete.toc.open).toBe(false);

    const top = run({ framed: false, readyState: "complete", narrow: false });
    expect(top.posted).toEqual([]);
    expect(top.listeners.size).toBe(0);
    expect(new TextEncoder().encode(FRAME_REPORTER).length).toBeLessThan(512);
  });

  it("renders GitHub alerts as callouts and leaves near misses as blockquotes", async () => {
    const kinds = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
    const html = body(
      await renderMarkdown(
        kinds.map((kind) => `> [!${kind}]\n> Body of *${kind.toLowerCase()}*.`).join("\n\n"),
      ),
    );
    for (const kind of kinds) {
      const title = kind[0] + kind.slice(1).toLowerCase();
      expect(html).toContain(
        `<div class="markdown-alert markdown-alert-${kind.toLowerCase()}">\n<p class="markdown-alert-title" dir="auto">${title}</p>\n<p dir="auto">Body of <em>${kind.toLowerCase()}</em>.</p>\n</div>`,
      );
    }
    expect(html).not.toContain("<blockquote>");
    const lower = body(await renderMarkdown("> [!warning]\n>\n> - one\n> - two"));
    expect(lower).toContain('<div class="markdown-alert markdown-alert-warning">');
    expect(lower).toContain('<li dir="auto">one</li>');
    const misses = body(
      await renderMarkdown(
        "> [!NOTE] same line\n\n> [!WARNING]\n\n> [!OTHER]\n> text\n\n> text\n> [!NOTE]\n\n<blockquote>\n\n[!TIP]\nraw\n\n</blockquote>",
      ),
    );
    expect(misses).not.toContain("markdown-alert");
    expect(misses.match(/<blockquote dir="auto">/g)).toHaveLength(5);
    const nested = body(await renderMarkdown("- item\n\n  > [!TIP]\n  > nested"));
    expect(nested).toContain('<div class="markdown-alert markdown-alert-tip">');
  });

  it(`adds a contents block after the first h1 only with ${TOC_MIN_H2} or more h2s`, async () => {
    const three = await renderMarkdown(`# Doc\n\n${h2s(3)}\n\nNote[^1]\n\n[^1]: Footnote.`);
    expect(three).not.toContain('class="toc"');
    const four = body(await renderMarkdown(`# Doc\n\nIntro.\n\n${h2s(4)}`));
    expect(four).toContain(
      '</h1>\n<details class="toc" open><summary>Contents</summary><ol><li dir="auto"><a href="#part-1">Part 1</a></li><li dir="auto"><a href="#part-2">Part 2</a></li><li dir="auto"><a href="#part-3">Part 3</a></li><li dir="auto"><a href="#part-4">Part 4</a></li></ol></details>\n<p dir="auto">Intro.</p>',
    );
    const noH1 = body(await renderMarkdown(`---\na: b\n---\nIntro.\n\n${h2s(4)}`));
    expect(noH1).toMatch(
      /^<body>\n<details class="front-matter">.*?<\/details>\n<details class="toc" open>/su,
    );
    expect(await renderMarkdown(`# Doc\n\n${h2s(4)}`)).toContain("<title>Doc</title>");
  });

  it("adds heading anchors without changing ids or titles", async () => {
    const html = body(
      await renderMarkdown(
        "# Hello *world*\n\n### Deep [link](./x.md)\n\n###### Six\n\nNote[^1]\n\n[^1]: F.",
      ),
    );
    expect(html).toContain(
      '<h1 id="hello-world" dir="auto"><a class="anchor" href="#hello-world" aria-hidden="true" tabindex="-1">#</a>Hello <em>world</em></h1>',
    );
    expect(html).toContain(
      '<h3 id="deep-link" dir="auto"><a class="anchor" href="#deep-link" aria-hidden="true" tabindex="-1">#</a>Deep <a href="./x.md">link</a></h3>',
    );
    expect(html).toContain('<h6 id="six" dir="auto"><a class="anchor" href="#six"');
    expect(html).toContain('<h2 class="sr-only" id="footnote-label" dir="auto">Footnotes</h2>');
    expect(await renderMarkdown("# Hello *world*")).toContain("<title>Hello world</title>");
  });

  it("wraps tables in a focusable scroll region, outermost only", async () => {
    const html = body(
      await renderMarkdown(
        "| A | B |\n| - | - |\n| 1 | 2 |\n\n<table><tr><td><table><tr><td>in</td></tr></table></td></tr></table>",
      ),
    );
    expect(
      html.match(/<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>/g),
    ).toHaveLength(2);
    expect(html.match(/class="table-wrap"/g)).toHaveLength(2);
    expect(html).toContain('<td dir="auto"><table>');
  });

  it("labels code blocks, turns lone images into figures, and keeps task lists", async () => {
    const html = body(
      await renderMarkdown(
        '```ts\nlet x = 1\n```\n\n```oddlang\nx\n```\n\n```\nplain\n```\n\n```"><x>\ny\n```\n\n' +
          "![Plot](./plot.png)\n\n[![Linked](./a.png)](./a.png)\n\nInline ![icon](./i.png) image.\n\n- [x] done\n- [ ] todo",
      ),
    );
    expect(html).toMatch(/<pre class="shiki[^"]*"[^>]*data-lang="ts"><code>/);
    expect(html).toContain('<pre data-lang="oddlang"><code class="language-oddlang">');
    expect(html).toContain("<pre><code>plain");
    expect(html).not.toContain('data-lang="&');
    expect(html).toContain('<figure class="image"><img src="./plot.png" alt="Plot"></figure>');
    expect(html).toContain(
      '<figure class="image"><a href="./a.png"><img src="./a.png" alt="Linked"></a></figure>',
    );
    expect(html).toContain('<p dir="auto">Inline <img src="./i.png" alt="icon"> image.</p>');
    expect(html).toContain(
      '<li class="task-list-item" dir="auto"><input type="checkbox" checked disabled> done</li>',
    );
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
    // Policy: any change to this hash needs a RENDERER_VERSION bump (see render.ts).
    expect(
      await goldenHash(),
      "renderer output changed: bump RENDERER_VERSION and update the golden hash",
    ).toBe("7277152229f0f7c7aa8a1d1f4df263d2fd963ebab5b0dd014e22cbcc64a0d055");
  });

  it("produces byte-identical golden output in a fresh process", async () => {
    // Uses the built package, like the worker pool does; run `pnpm build` after editing src.
    const module = new URL("../dist/render.js", import.meta.url).href;
    const script = `import { createHash } from "node:crypto";
import { text } from "node:stream/consumers";
const { renderMarkdown } = await import(${JSON.stringify(module)});
const hash = createHash("sha256");
for (const [source, title] of JSON.parse(await text(process.stdin)))
  hash.update(await renderMarkdown(source, title === null ? undefined : { title }));
process.stdout.write(hash.digest("hex"));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.stdin.end(JSON.stringify(goldenInputs()));
    const [stdout, code] = await Promise.all([
      text(child.stdout),
      new Promise<number | null>((resolve) => child.on("exit", resolve)),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe(await goldenHash());
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
