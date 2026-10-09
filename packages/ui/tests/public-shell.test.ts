import { describe, expect, it } from "vitest";

import {
  ICON_NAMES,
  icon,
  encodeLinkPath,
  encodePathSegments,
  PUBLIC_SHELL_LIST_BUDGET,
  formatShellTime,
  iconUse,
  publicShellCss,
  publicShellScript,
  renderPublicShell,
  type PublicShellOptions,
} from "../src/index.ts";

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
    const iconTags = ICON_NAMES.flatMap((name) =>
      [...icon(name).matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]),
    );
    const allowed = [
      ..."a b body button circle defs details div h1 h2 head header hr html iframe li main meta nav p path rect small span summary svg symbol time title ul use".split(
        " ",
      ),
      ...iconTags,
    ];
    for (const tag of tags) expect(allowed).toContain(tag);
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
    // Page navigation is never animated (owner feedback 1).
    expect(publicShellCss).not.toMatch(/view-transition/);
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
      `Files <span class="n">9</span><span class="cur" id="files-cur">${iconUse("doc")}<span class="t" dir="auto">a/b/y.md</span></span>`,
    );
    const menu = tree.slice(tree.indexOf('<div class="mbox tree"'));
    expect(menu.indexOf('data-p="index.md"')).toBeLessThan(menu.indexOf("<details"));
    expect(menu).toContain(
      `<details open><summary dir="auto">${iconUse("folder")}a/</summary><div class="in"><details open><summary dir="auto">${iconUse("folder")}b/</summary><div class="in">`,
    );
    expect(menu).toContain(
      `data-p="a/b/y.md" aria-current="page" autofocus>${iconUse("doc")}y.md</a>`,
    );
    // Balanced folders: the Files popover isn't a <details>.
    expect((menu.match(/<details/g) ?? []).length).toBe((menu.match(/<\/details>/g) ?? []).length);
    expect(renderPublicShell(base)).not.toContain('aria-label="Files"');
  });
  it("collapses folders in large manifests except the current file's", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `d${i % 3}/f${i}.md` }));
    const html = renderPublicShell({ ...base, files, current: "d1/f4.md" });
    expect(html).toContain(`<details open><summary dir="auto">${iconUse("folder")}d1/</summary>`);
    expect(html).toContain(`<details><summary dir="auto">${iconUse("folder")}d0/</summary>`);
    expect(html).toContain(`<details><summary dir="auto">${iconUse("folder")}d2/</summary>`);
  });
  it("says Snapshot for single-revision links and Updated for latest", () => {
    const at = Date.UTC(2026, 9, 7, 22, 8);
    expect(formatShellTime(at)).toBe("7 Oct 2026, 22:08 UTC");
    const latest = renderPublicShell(base);
    expect(latest).toContain(
      `Updated <time datetime="2026-10-07T22:08:00.000Z" data-t="rel">7 Oct 2026, 22:08 UTC</time>`,
    );
    const snapshot = renderPublicShell({ ...base, updatedAt: null, snapshotAt: at });
    expect(snapshot).toContain("Snapshot");
    expect(snapshot).toContain("Taken <time");
    expect(snapshot).toContain('data-t="date"');
    expect(snapshot).not.toContain("Snapshot from");
    expect(snapshot).not.toContain('class="pin"');
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
const menuOf = (html: string): string => html.slice(html.indexOf('<div class="mbox tree"'));
describe("tree limits", () => {
  it("collapses single-folder chains and single-file folders", () => {
    const paths = [
      "index.md",
      "a/b/c/d/x.md",
      "a/b/c/d/y.md",
      "solo/only.md",
      ...Array.from({ length: 7 }, (_, i) => `z${i}.md`),
    ];
    const menu = menuOf(renderPublicShell({ ...base, files: paths.map((path) => ({ path })) }));
    expect(menu).toContain(`<summary dir="auto">${iconUse("folder")}a/b/c/d/</summary>`);
    expect(menu).not.toContain(`${iconUse("folder")}b/`);
    expect(menu).toContain(`data-p="solo/only.md">${iconUse("doc")}solo/only.md</a>`);
    expect(menu).not.toContain("solo/</summary>");
  });
  it("nests at most 6 folders deep and puts deeper folders in the label", () => {
    const deep = `${"a/".repeat(250)}f.md`;
    const paths = [
      "index.md",
      deep,
      `${"a/".repeat(250)}g.md`,
      ...Array.from({ length: 7 }, (_, i) => `z${i}.md`),
    ];
    const menu = menuOf(renderPublicShell({ ...base, files: paths.map((path) => ({ path })) }));
    expect(menu).toContain(`<summary dir="auto">${iconUse("folder")}${"a/".repeat(6)}</summary>`);
    expect((menu.match(/<details/g) ?? []).length).toBe(1);
    expect(menu).toContain(`data-p="${deep}">`);
    // The label is the rest of the path, shortened in the middle.
    expect(menu).toMatch(/>(?:a\/){19}…(?:a\/){17}f\.md<\/a>/);
  });
  it("stops the list at the budget and says how many files aren't listed", () => {
    const paths = Array.from(
      { length: 2000 },
      (_, i) => `${String(i).padStart(4, "0")}/${"x".repeat(500)}.md`,
    );
    const html = renderPublicShell({
      ...base,
      files: paths.map((path) => ({ path })),
      head: paths[0]!,
    });
    const listed = (html.match(/<a href=/g) ?? []).length;
    expect(listed).toBeGreaterThan(100);
    expect(listed).toBeLessThan(2000);
    expect(html).toContain(
      `<p class="more">${2000 - listed} more files aren&#39;t listed here.</p>`.replace(
        "&#39;",
        "'",
      ),
    );
    // The rest of the page (style, script, letterhead and About) is about 31 KB.
    expect(html.length).toBeLessThan(PUBLIC_SHELL_LIST_BUDGET + 32_000);
    // Ordinary 2,000-file manifests fit entirely.
    const ordinary = Array.from(
      { length: 2000 },
      (_, i) => `dir${i % 40}/file-${i}.html`,
    ).toSorted();
    const full = renderPublicShell({
      ...base,
      files: ordinary.map((path) => ({ path })),
      head: ordinary[0]!,
      fileHref: (path) => `./${encodeLinkPath(path)}`,
    });
    expect((full.match(/<a href=/g) ?? []).length).toBe(2000);
    expect(full).not.toContain('class="more"');
  });
  it("requires frameBase to end with a slash", () => {
    expect(() =>
      renderPublicShell({ ...base, frameBase: "https://reader.example/x/a.b/r/c" }),
    ).toThrow("frameBase must end with /");
  });
  it("shows bidi controls in names and titles instead of applying them", () => {
    const html = renderPublicShell({
      ...base,
      title: "Report \u202eexe.pdf",
      files: [{ path: "index.md" }, { path: "invoice\u202efdp.exe" }],
    });
    const visible = markup(html);
    expect(visible).toContain(
      `data-p="invoice\u202efdp.exe">${iconUse("doc")}invoice\ufffdfdp.exe</a>`,
    );
    expect(visible).toContain('<h1 dir="auto">Report \ufffdexe.pdf</h1>');
    expect(visible.replace(/data-p="[^"]*"/g, "")).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(publicShellCss).toContain(".ptabs2 a{unicode-bidi:plaintext}");
    expect(publicShellCss).toContain(".tree a{unicode-bidi:plaintext}");
  });
  it("shows bidi controls in the download card and the frame title", () => {
    const spoof = "docs/invoice‮fdp.exe";
    const card = markup(
      renderPublicShell({
        ...base,
        files: [{ path: "index.md" }, { path: spoof }],
        current: spoof,
        download: { mime: "application/octet-stream", size: 10 },
      }),
    );
    expect(card).toContain("<h2>docs/invoice�fdp.exe</h2>");
    expect(card).toContain('download="invoice�fdp.exe"');
    // The link target keeps the real name, percent-encoded.
    expect(card).toContain(`href="${base.frameBase}docs/invoice%E2%80%AEfdp.exe"`);
    expect(card.replace(/data-p="[^"]*"/g, "")).not.toMatch(/[‪-‮⁦-⁩]/);
    const frame = markup(
      renderPublicShell({
        ...base,
        files: [{ path: "index.md" }, { path: spoof }],
        current: spoof,
      }),
    );
    expect(frame).toContain('title="docs/invoice�fdp.exe"');
    expect(frame.replace(/data-p="[^"]*"/g, "")).not.toMatch(/[‪-‮⁦-⁩]/);
  });
});
describe("encodeLinkPath", () => {
  it("leaves names readable but resolves to the same path", () => {
    const shell = "https://reader.example/s/t/c/p/";
    for (const path of [
      "a b/c#d?.md",
      "100%/x.md",
      "文/ü.md",
      "q\"<x>'.md",
      "a\\b.md",
      "t\tn\n.md",
      "a:b.md",
    ]) {
      const href = `./${encodeLinkPath(path)}`;
      const url = new URL(href, shell);
      expect(url.search + url.hash).toBe("");
      const decoded = url.pathname
        .slice("/s/t/c/p/".length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      expect(decoded).toBe(path);
    }
    expect(encodeLinkPath("文/ü.md")).toBe("文/ü.md");
  });
});
