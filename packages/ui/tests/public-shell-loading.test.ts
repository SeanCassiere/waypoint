import { describe, expect, it } from "vitest";

import { renderPublicShell, type PublicShellOptions } from "../src/index.ts";
import { documentCss } from "../src/public-shell/css.ts";
import { loadingScript } from "../src/public-shell/script.ts";

// A11Y-08: an empty role=status line behind the transparent document frame; the shell script
// fills it only after 300 ms and marks main busy until the frame loads (8 s at most).
const base: PublicShellOptions = {
  title: "Plan",
  files: [{ path: "index.md" }],
  head: "index.md",
  current: "index.md",
  fileHref: (path) => `/s/t/c/p/${path}`,
  frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
  updatedAt: null,
  snapshotAt: null,
};
const markup = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
const only = (path: string): PublicShellOptions => ({
  ...base,
  files: [{ path }],
  head: path,
  current: path,
});
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);

describe("public shell loading line", () => {
  // Markup only: the shell's style and script name these classes and attributes too.
  it("wraps the frame with an empty status line, and nothing is busy in server HTML", () => {
    const html = markup(renderPublicShell(base));
    expect(html).toContain(
      '<main id="main"><div class="docwrap"><div class="loading"><p id="loading" role="status"></p></div><iframe id="doc" class="pframe"',
    );
    expect(html).toContain("</iframe></div></main>");
    expect(html).not.toContain("aria-busy");
  });

  it("leaves download cards and images without a loading line", () => {
    const download = markup(
      renderPublicShell({
        ...only("data/events.parquet"),
        download: { mime: "application/octet-stream", size: 10 },
      }),
    );
    const image = markup(
      renderPublicShell({ ...only("shots/a.png"), image: { mime: "image/png", size: 2970 } }),
    );
    for (const html of [download, image]) {
      expect(html).not.toContain("docwrap");
      expect(html).not.toContain('id="loading"');
      expect(html).not.toContain("aria-busy");
    }
  });

  it("emits a readable script: 300 ms, 8 s, busy, loaded; no interval, no comments", () => {
    expect(() => parse(loadingScript)).not.toThrow();
    for (const part of ["300", "8000", "aria-busy", "data-loaded", '"Opening "', "\\u2026"])
      expect(loadingScript).toContain(part);
    expect(loadingScript).not.toContain("setInterval");
    expect(loadingScript).not.toContain("//");
    expect(loadingScript).not.toContain("/*");
    for (const line of loadingScript.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("hides the line once loaded, without motion", () => {
    expect(documentCss).toContain(".docwrap[data-loaded]>.loading{display:none}");
    expect(documentCss).toContain(".docwrap:not([data-loaded])>.pframe{background:transparent}");
    expect(documentCss).toMatch(/\.loading\{[^}]*pointer-events:none/);
    expect(documentCss).toMatch(/\.loading p\{[^}]*overflow-wrap:anywhere/);
    expect(documentCss).not.toMatch(/transition|animation/);
  });
});
