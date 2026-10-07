import { describe, expect, it } from "vitest";

import {
  encodePathSegments,
  formatShellTime,
  publicShellCss,
  publicShellScript,
  renderPublicShell,
  type PublicShellOptions,
} from "../src/index.js";

const base: PublicShellOptions = {
  title: "Plan",
  files: [{ path: "index.md" }],
  head: "index.md",
  current: "index.md",
  fileHref: (path) => `/s/t/c/p/${path.split("/").map(encodeURIComponent).join("/")}`,
  frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
  updatedAt: Date.UTC(2026, 9, 7, 22, 8),
  snapshotAt: null,
};
const markup = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");

describe("public shell", () => {
  it("escapes agent-controlled titles and paths everywhere", () => {
    const evil = `"><script>alert(1)</script><img src=x onerror=alert(1)>`;
    const html = renderPublicShell({
      ...base,
      title: evil,
      files: [{ path: "index.md" }, { path: `${evil}.md` }, { path: `d/'x".md` }],
      current: `${evil}.md`,
    });
    // Only the shell's own elements exist; the payload survives only as escaped text.
    const tags = new Set([...markup(html).matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]));
    const allowed =
      "a body details div h1 head header hr html iframe main meta nav p path span summary svg time title";
    for (const tag of tags) expect(allowed.split(" ")).toContain(tag);
    expect(tags.has("img")).toBe(false);
    // Every tag is well-formed with double-quoted values, and none has a handler or style.
    const open = [...markup(html).matchAll(/<[a-z]/gi)].length;
    const parsed = [
      ...markup(html).matchAll(/<[a-z][a-z0-9]*((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi),
    ];
    expect(parsed).toHaveLength(open);
    const names = parsed.flatMap((m) =>
      [...(m[1] ?? "").matchAll(/\s([a-z-]+)(?:="[^"]*")?/g)].map((a) => a[1]),
    );
    expect(names.filter((name) => name?.startsWith("on") || name === "style")).toEqual([]);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('data-p="d/&#39;x&quot;.md"');
    expect(html).toContain(
      `src="https://reader.example/x/shl_a.cap/r/rpub/${`${evil}.md`.split("/").map(encodeURIComponent).join("/")}"`,
    );
  });
  it("has no style attributes, handlers, or external assets by default", () => {
    const html = renderPublicShell({
      ...base,
      files: Array.from({ length: 12 }, (_, i) => ({ path: `a/b${i}.md` })),
      current: "a/b3.md",
    });
    expect(markup(html)).not.toMatch(/\sstyle=|\son[a-z]+=|<link\b|<script\s+src/i);
    expect(html).toContain(`<style>${publicShellCss}</style>`);
    expect(html).toContain(`<script>${publicShellScript}</script>`);
    expect(publicShellCss).toContain("@view-transition{navigation:auto}");
    expect(publicShellCss).toMatch(
      /@media\(prefers-reduced-motion:reduce\)\{@view-transition\{navigation:none\}/,
    );
  });
  it("uses tabs up to 8 files with the head first, and a tree above", () => {
    const tabs = renderPublicShell({
      ...base,
      files: ["b.md", "a.md", "index.md"].map((path) => ({ path })),
    });
    expect([...tabs.matchAll(/data-p="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "index.md",
      "a.md",
      "b.md",
    ]);
    const paths = [
      "index.md",
      "z.md",
      "a/x.md",
      "a/b/y.md",
      "a/b/z.md",
      "c/w.md",
      "c/v.md",
      "q.md",
      "r.md",
    ];
    const tree = renderPublicShell({
      ...base,
      files: paths.map((path) => ({ path })),
      current: "a/b/y.md",
    });
    expect(tree).toContain(
      '<summary>Files <span class="n">(9)</span><span class="cur">a/b/y.md</span>',
    );
    const menu = tree.slice(tree.indexOf('<div class="pmenu tree">'));
    expect(menu.indexOf('data-p="index.md"')).toBeLessThan(menu.indexOf("<details"));
    expect(menu).toContain(
      '<details open><summary>a/</summary><div class="in"><details open><summary>b/</summary><div class="in">',
    );
    expect(menu).toContain('data-p="a/b/y.md" aria-current="page">y.md</a>');
    // Balanced folders; the extra close is the Files dropdown itself.
    expect((menu.match(/<details/g) ?? []).length + 1).toBe(
      (menu.match(/<\/details>/g) ?? []).length,
    );
    expect(renderPublicShell(base)).not.toContain('aria-label="Files"');
  });
  it("collapses folders in large manifests except the current file's", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `d${i % 3}/f${i}.md` }));
    const html = renderPublicShell({ ...base, files, current: "d1/f4.md" });
    expect(html).toContain("<details open><summary>d1/</summary>");
    expect(html).toContain("<details><summary>d0/</summary>");
    expect(html).toContain("<details><summary>d2/</summary>");
  });
  it("says Snapshot for single-revision links and Updated for latest", () => {
    const at = Date.UTC(2026, 9, 7, 22, 8);
    expect(formatShellTime(at)).toBe("7 Oct 2026, 22:08 UTC");
    const latest = renderPublicShell(base);
    expect(latest).toContain(
      `Updated <time datetime="2026-10-07T22:08:00.000Z">7 Oct 2026, 22:08 UTC</time>`,
    );
    const snapshot = renderPublicShell({ ...base, updatedAt: null, snapshotAt: at });
    expect(snapshot).toContain('<svg class="pin"');
    expect(snapshot).toContain("Snapshot from <time");
    expect(snapshot).not.toContain("Updated");
  });
  it("sandboxes the frame and offers a download card for binaries", () => {
    const html = renderPublicShell(base);
    expect(html).toContain(
      'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"',
    );
    expect(html).not.toContain("allow-same-origin");
    const card = renderPublicShell({
      ...base,
      files: [{ path: "x.zip" }],
      current: "x.zip",
      download: { mime: "application/zip", size: null },
    });
    expect(card).not.toContain("<iframe");
    expect(card).toContain("<p>application/zip · can&#39;t be previewed in the browser</p>");
  });
});
describe("encodePathSegments", () => {
  it("matches per-segment encodeURIComponent", () => {
    for (const path of [
      "a/b c/d.md",
      "%2F/x%2fy",
      "café/ü?#&=+.md",
      "a//b",
      "/lead",
      "x/y/",
      "A-z_0.9~/b",
      "it's (1)!*.md",
    ])
      expect(encodePathSegments(path)).toBe(path.split("/").map(encodeURIComponent).join("/"));
  });
});
