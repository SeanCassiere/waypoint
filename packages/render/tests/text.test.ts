import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import {
  renderText,
  TEXT_LIMITS,
  TEXT_RENDERER_NAME,
  TEXT_RENDERER_VERSION,
  textRenderer,
} from "../src/index.ts";
import { FRAME_REPORTER, readingCss } from "../src/render.ts";
import { VIEW_SCRIPT } from "../src/view.ts";
import {
  bigLog,
  DRAIN_SCRIPT,
  METRICS_JSON,
  TEXT_GOLDEN_HASH,
  textGoldenInputs,
  TROJAN_JS,
} from "./golden-text.ts";

function render(source: string, mime: string): Promise<string | null> {
  return renderText(source, { mime, byteLength: Buffer.byteLength(source, "utf8") });
}
async function rendered(source: string, mime: string): Promise<string> {
  const html = await render(source, mime);
  if (html === null) throw new Error("No rendition");
  return html;
}
function decode(html: string): string {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}
/** The text of each line's `.c` cell, tags stripped and entities decoded. */
function lineTexts(html: string): string[] {
  const code = html.slice(html.indexOf("<code"), html.indexOf("</code>"));
  return code
    .split(
      /<span class="l" id="L\d+"><span class="n" aria-hidden="true">\d+<\/span><span class="c">/u,
    )
    .slice(1)
    .map((cell) => decode(cell.slice(0, -"</span></span>".length).replace(/<[^>]+>/gu, "")));
}

/** Runs VIEW_SCRIPT for a frame at `pathname`: the header name it sets and the title. */
function runViewScript(pathname: string): { name: string; title: string } {
  const name = { textContent: "" };
  const document = {
    title: "Shell script",
    querySelector: (selector: string) => (selector === ".fh .fn" ? name : null),
  };
  runInNewContext(VIEW_SCRIPT, { document, location: { pathname } });
  return { name: name.textContent, title: document.title };
}

async function goldenHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const [source, mime] of textGoldenInputs())
    // oxlint-disable-next-line eslint/no-await-in-loop -- One input at a time, in order, like render.test.ts.
    hash.update((await render(source, mime)) ?? "null");
  return hash.digest("hex");
}

describe("text rendition", () => {
  it("has its own name, version and limits", () => {
    expect(TEXT_RENDERER_NAME).toBe("text");
    expect(TEXT_RENDERER_VERSION).toBe(1);
    expect(TEXT_LIMITS).toEqual({
      maxBytes: 2_097_152,
      maxLines: 50_000,
      highlightBytes: 262_144,
      highlightLines: 5_000,
      formatJsonMinChars: 200,
    });
  });

  it("keeps the golden text output stable", async () => {
    // Policy: any change to this hash needs a TEXT_RENDERER_VERSION bump (see text.ts).
    expect(
      await goldenHash(),
      "text renderer output changed: bump TEXT_RENDERER_VERSION and update TEXT_GOLDEN_HASH",
    ).toBe(TEXT_GOLDEN_HASH);
  });

  it("shows a script with its kind, size, numbered lines and highlighting", async () => {
    expect(Buffer.byteLength(DRAIN_SCRIPT)).toBe(1094);
    const html = await rendered(DRAIN_SCRIPT, "text/x-shellscript");
    expect(html).toContain('<body class="tv">');
    expect(html).toContain(
      '<header class="fh"><b class="fn" dir="auto"></b><span class="k">Shell script</span><span class="m">37 lines · 1.1 KB</span></header>',
    );
    for (let line = 1; line <= 37; line++) expect(html).toContain(`id="L${line}"`);
    expect(html).not.toContain('id="L38"');
    expect(html).toContain('<pre class="lines shiki"><code class="gw2">');
    expect(html).toContain("--shiki-dark:");
    expect(html.match(/<span class="n" aria-hidden="true">/gu)).toHaveLength(37);
    expect(html).not.toMatch(/<\/span>\s+<span class="l"/u);
    expect(lineTexts(html)).toEqual(DRAIN_SCRIPT.slice(0, -1).split("\n"));
    // Only validated colours reach the style attribute.
    for (const [, style] of html.matchAll(/style="([^"]*)"/gu))
      expect(style).toMatch(/^--shiki-light:#[0-9a-fA-F]{3,8};--shiki-dark:#[0-9a-fA-F]{3,8}$/u);
  });

  it("formats a long one-line JSON lexically, with a note pointing at Download", async () => {
    expect(Buffer.byteLength(METRICS_JSON)).toBe(570);
    const html = await rendered(METRICS_JSON, "application/json");
    expect(html).toContain(
      '<span class="m">50 lines formatted · 1 line in the original · 570 B</span>',
    );
    expect(html).toContain(
      '<p class="fmt">Formatted for reading: the original is one 570-byte line. Download (above) gives you the file exactly as it was shared.</p>',
    );
    expect(html.indexOf('<p class="fmt">')).toBeGreaterThan(html.indexOf("</header>"));
    expect(html.indexOf('<p class="fmt">')).toBeLessThan(html.indexOf("<pre"));
    expect(lineTexts(html).join("\n")).toBe(JSON.stringify(JSON.parse(METRICS_JSON), null, 2));

    const precise = `{"n":12345678901234567890,"s":"\\u00e9","k":1,"k":2,"pad":"${"p".repeat(200)}"}`;
    const lines = lineTexts(await rendered(precise, "application/json"));
    expect(lines).toEqual([
      "{",
      '  "n": 12345678901234567890,',
      '  "s": "\\u00e9",',
      '  "k": 1,',
      '  "k": 2,',
      `  "pad": "${"p".repeat(200)}"`,
      "}",
    ]);
    expect(
      lineTexts(
        await rendered(`{"a":{},"b":[],"c":[{}],"pad":"${"p".repeat(200)}"}\n`, "application/json"),
      ),
    ).toEqual(JSON.stringify({ a: {}, b: [], c: [{}], pad: "p".repeat(200) }, null, 2).split("\n"));
  });

  it("shows pretty, short, invalid and line-delimited JSON as authored", async () => {
    for (const [source, mime] of [
      ['{\n  "a": 1\n}\n', "application/json"],
      ['{"a":1}\n', "application/json"],
      [`{"a":"${"x".repeat(300)}"\n`, "application/json"],
      ['{"id":1,"kind":"deploy"}\n{"id":2}\n{"id":3}\n', "application/x-ndjson"],
      [`[${"1,".repeat(150)}1]\n`, "text/plain"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A few inputs, checked in order.
      const html = await rendered(source, mime);
      expect(html).not.toContain('class="fmt"');
      expect(lineTexts(html)).toEqual(source.slice(0, -1).split("\n"));
    }
    expect(
      await rendered('{"id":1,"kind":"deploy"}\n{"id":2}\n{"id":3}\n', "application/x-ndjson"),
    ).toContain('<span class="k">JSON lines</span>');
  });

  it("formats qualifying JSON even when it fits on one line", async () => {
    // One line over 200 characters that parses: formatted, with the note, though it stays 1 line.
    const spaced = `${" ".repeat(201)}{}`;
    const html = await rendered(spaced, "application/json");
    expect(lineTexts(html)).toEqual(["{}"]);
    expect(html).toContain(
      '<span class="m">1 line formatted · 1 line in the original · 203 B</span>',
    );
    expect(html).toContain(
      '<p class="fmt">Formatted for reading: the original is one 203-byte line. Download (above) gives you the file exactly as it was shared.</p>',
    );
    const string = `"${"s".repeat(201)}"\n`;
    const scalar = await rendered(string, "application/json");
    expect(lineTexts(scalar)).toEqual([string.slice(0, -1)]);
    expect(scalar).toContain('class="fmt"');
  });

  it("bounds its output: deep JSON shows as authored, a view too long is no rendition", async () => {
    // Indentation grows with depth: formatted, this 16 KB would be over a hundred megabytes.
    const nested = `${"[".repeat(8000)}0${"]".repeat(8000)}`;
    const html = await rendered(nested, "application/json");
    expect(html).not.toContain('class="fmt"');
    expect(lineTexts(html)).toEqual([nested]);
    expect(html.length).toBeLessThan(100_000);
    // Deeper still must not throw (a string too long for the engine).
    const deeper = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
    expect(await rendered(deeper, "application/json")).not.toContain('class="fmt"');
    // Every NUL is a visible marker, so 600 KB of them would be a view of about 19 M characters.
    expect(await render("\u0000".repeat(600_000), "text/plain")).toBeNull();
  });

  it("shows plain text and logs uncoloured, a long line in one cell", async () => {
    const html = await rendered(bigLog(), "text/plain");
    expect(html).toContain('<span class="k">Plain text</span>');
    expect(html).toContain('<span class="m">41 lines · 6.9 KB</span>');
    expect(html).not.toContain("lines shiki"); // The template CSS names .shiki; the class must be absent.
    expect(html).not.toContain("style=");
    const lines = lineTexts(html);
    expect(lines).toHaveLength(41);
    expect(lines[40]).toHaveLength(5000);
  });

  it("escapes every character and marks controls", async () => {
    const html = await rendered(TROJAN_JS, "text/javascript");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html.match(/<\/pre>/gu)).toHaveLength(1);
    expect(html).toContain('<span class="cc">⟪U+202E⟫</span>');
    for (const marker of ["⟪U+202C⟫", "⟪U+200B⟫", "⟪U+0000⟫", "⟪U+000D⟫"])
      expect(html).toContain(marker);
    for (const raw of ["\u202E", "\u200B", "\u0000"]) expect(html).not.toContain(raw);
    // Every marked range, through the whole document.
    expect(html).not.toMatch(
      // oxlint-disable-next-line eslint/no-control-regex -- No raw control may remain in the output.
      /[\u0000-\u0008\u000b-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u,
    );
    expect(lineTexts(html)[2]).toBe("⟪U+200B⟫⟪U+0000⟫x⟪U+000D⟫y");
  });

  it("reads CRLF and a BOM as ordinary lines", async () => {
    const html = await rendered("\uFEFFa\r\nb\r\n", "text/plain");
    expect(lineTexts(html)).toEqual(["a", "b"]);
    expect(html).not.toContain("\r");
    expect(html).not.toContain("\uFEFF");
    expect(html).not.toContain("⟪U+000D⟫");
    expect(lineTexts(await rendered("a\nb", "text/plain"))).toEqual(["a", "b"]);
    expect(await rendered("a\n", "text/plain")).toContain('<span class="m">1 line · 2 B</span>');
  });

  it("shows an empty file as 0 lines", async () => {
    const html = await rendered("", "text/plain");
    expect(html).toContain('<span class="m">0 lines · 0 B</span>');
    expect(html).toContain('<pre class="lines"><code class="gw1"></code></pre>');
  });

  it("leaves big files uncoloured and returns null over the bounds", async () => {
    const python = `${Array.from({ length: 6000 }, (_, i) => `x_${i} = ${i}`).join("\n")}\n`;
    const html = await rendered(python, "text/x-python");
    expect(html).toContain('<code class="gw4">');
    expect(html).toContain('<span class="k">Python</span>');
    expect(html).toContain('<span class="m">6,000 lines · ');
    expect(html).not.toContain("lines shiki"); // The template CSS names .shiki; the class must be absent.
    expect(await render("x".repeat(2_097_153), "text/plain")).toBeNull();
    expect(await render("a\n".repeat(50_001), "text/plain")).toBeNull();
    expect(await render("a\n".repeat(50_000), "text/plain")).toContain('<code class="gw5">');
    // The bound is the file's byte length, whatever was decoded.
    expect(await renderText("a", { mime: "text/plain", byteLength: 2_097_153 })).toBeNull();
  });

  it("labels every kind of text and highlights the ones it knows", async () => {
    const kinds: [mime: string, label: string, coloured: boolean][] = [
      ["text/x-shellscript", "Shell script", true],
      ["application/json", "JSON", true],
      ["application/vnd.api+json", "JSON", true],
      ["application/x-ndjson", "JSON lines", true],
      ["application/ndjson", "JSON lines", true],
      ["text/javascript", "JavaScript", true],
      ["application/javascript", "JavaScript", true],
      ["application/x-javascript", "JavaScript", true],
      ["text/typescript", "TypeScript", true],
      ["application/typescript", "TypeScript", true],
      ["text/x-python", "Python", true],
      ["application/yaml", "YAML", true],
      ["application/x-yaml", "YAML", true],
      ["text/yaml", "YAML", true],
      ["text/x-yaml", "YAML", true],
      ["application/vnd.foo+yaml", "YAML", true],
      ["application/toml", "TOML", true],
      ["application/x-toml", "TOML", true],
      ["text/x-diff", "Diff", true],
      ["text/css", "CSS", true],
      ["text/x-go", "Go", true],
      ["text/x-rust", "Rust", true],
      ["text/x-sql", "SQL", true],
      ["text/x-dockerfile", "Dockerfile", true],
      ["application/xml", "XML", false],
      ["text/xml", "XML", false],
      ["application/atom+xml", "XML", false],
      ["text/plain", "Plain text", false],
      ["text/plain; charset=utf-8", "Plain text", false],
      ["text/x-anything", "Text", false],
    ];
    const seen = await Promise.all(
      kinds.map(async ([mime]): Promise<[string, string, boolean]> => {
        const html = await rendered("a = 1\n", mime);
        const label = /<span class="k">([^<]*)<\/span>/u.exec(html)?.[1] ?? "";
        expect(html).toContain(`<title>${label}</title>`);
        return [mime, label, html.includes('class="lines shiki"')];
      }),
    );
    expect(seen).toEqual(kinds);
  });

  it("renders only text types without their own renderer", async () => {
    const mimes = [
      "text/markdown",
      "text/csv",
      "text/tab-separated-values",
      "text/html",
      "image/svg+xml",
      "image/png",
      "bad mime",
    ];
    const outputs = await Promise.all(mimes.map((mime) => render("x\n", mime)));
    expect(outputs).toEqual(mimes.map(() => null));
  });

  it("adds no external resources and one script: the view script and the frame reporter", async () => {
    for (const [source, mime] of textGoldenInputs()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Every golden input, checked in order.
      const html = await render(source, mime);
      if (html === null) continue;
      expect(html).not.toMatch(/https?:/i);
      expect(html).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(html).not.toMatch(/@import|url\(/i);
      expect(html).not.toMatch(/<(?:link|iframe|object|embed)\b/i);
      expect(html.match(/<script\b[^>]*>/g)).toEqual(["<script>"]);
      expect(html.startsWith("<!doctype html>\n")).toBe(true);
      expect(html).toContain(`<style>${readingCss}\n`);
      expect(html).toContain(
        `<script>${VIEW_SCRIPT}${FRAME_REPORTER}</script>\n</body>\n</html>\n`,
      );
      expect(html).not.toMatch(/<a\b/u);
    }
  });

  it("is deterministic, also for concurrent first calls", async () => {
    const inputs = textGoldenInputs().slice(0, 8);
    const first = await Promise.all(inputs.map(([source, mime]) => render(source, mime)));
    const second = await Promise.all(inputs.map(([source, mime]) => render(source, mime)));
    expect(second).toEqual(first);
  });

  it("renders through the worker pool only for text types", async () => {
    const bytes = new TextEncoder().encode(DRAIN_SCRIPT);
    const others = ["text/markdown", "text/csv", "text/html", "image/svg+xml"];
    const outputs = await Promise.all(others.map((mime) => textRenderer.render(bytes, mime)));
    expect(outputs).toEqual(others.map(() => null));
    const result = await textRenderer.render(new TextEncoder().encode("plain\n"), "text/plain");
    expect(result?.mime).toBe("text/html");
    expect(new TextDecoder().decode(result?.bytes)).toBe(await render("plain\n", "text/plain"));
    expect(
      new TextDecoder().decode((await textRenderer.render(bytes, "text/x-shellscript"))?.bytes),
    ).toBe(await render(DRAIN_SCRIPT, "text/x-shellscript"));
    const bom = new TextEncoder().encode("\uFEFFa\r\n");
    expect(new TextDecoder().decode((await textRenderer.render(bom, "text/plain"))?.bytes)).toBe(
      await renderText("\uFEFFa\r\n", { mime: "text/plain", byteLength: bom.byteLength }),
    );
    expect(await textRenderer.render(new Uint8Array(2_097_153), "text/plain")).toBeNull();
  });

  it("returns no rendition after a worker crash and recovers on the next call", async () => {
    const bytes = new TextEncoder().encode("echo hi\n");
    const send = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
      this: Worker,
    ) {
      void this.terminate();
    });
    expect(await textRenderer.render(bytes, "text/x-shellscript")).toBeNull();
    send.mockRestore();
    expect(
      new TextDecoder().decode((await textRenderer.render(bytes, "text/x-shellscript"))?.bytes),
    ).toBe(await render("echo hi\n", "text/x-shellscript"));
  });

  it("fills the header's file name from the frame URL", () => {
    expect(VIEW_SCRIPT).not.toMatch(/[\u202A-\u202E\u2066-\u2069\uFFFD]/u);
    expect(runViewScript("/x/a.b/r/p/dir/caf%C3%A9%E2%80%AE.sh")).toEqual({
      name: "café\uFFFD.sh",
      title: "café\uFFFD.sh",
    });
    expect(runViewScript("/x/a.b/r/p/bad%E0%A4%A.txt")).toEqual({
      name: "bad%E0%A4%A.txt",
      title: "bad%E0%A4%A.txt",
    });
    expect(runViewScript("/x/a.b/r/p/")).toEqual({ name: "", title: "Shell script" });
    // No header (not a view document): the script does nothing.
    expect(() => {
      runInNewContext(VIEW_SCRIPT, {
        document: { querySelector: () => null },
        location: { pathname: "/a" },
      });
    }).not.toThrow();
  });
});
