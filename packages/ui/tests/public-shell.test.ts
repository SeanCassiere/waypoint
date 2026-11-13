import { describe, expect, it } from "vitest";

import { chromeFontPreload } from "../src/font.ts";
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
/** A folder name longer than a row shows; `c` sits where the row shortens it. */
const long = (c: string): string => `${"x".repeat(60)}${c}${"y".repeat(60)}/`;
const menuOf = (html: string): string => html.slice(html.indexOf('<div class="tree">'));
/** A folder row: the fold chevron, the folder icon, the label. */
const summary = (name: string): string =>
  `<summary dir="auto">${iconUse("chevronDown", "sm")}${iconUse("folder")}${name}</summary>`;
/** A file row's icon (drawn by `.tree a>svg`, so no class of its own). */
const doc = '<svg aria-hidden="true"><use href="#i-doc"/></svg>';

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
      ..."a b body button circle defs details div h1 h2 head header hr html iframe li link main meta nav p path rect small span summary svg symbol time title ul use".split(
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
  it("puts an escaped version on <html> for the script to expose, or none when omitted", () => {
    expect(renderPublicShell(base)).toContain('<!doctype html><html lang="en"><head>');
    expect(renderPublicShell({ ...base, version: '1.2.3"><x' })).toContain(
      '<html lang="en" data-waypoint-version="1.2.3&quot;&gt;&lt;x"><head>',
    );
    expect(publicShellScript).toContain("window._WAYPOINT_VERSION = version;");
  });
  it("has no style attributes, handlers, or external assets but the font's preload", () => {
    const html = renderPublicShell({
      ...base,
      files: Array.from({ length: 12 }, (_, i) => ({ path: `a/b${i}.md` })),
      current: "a/b3.md",
    });
    // The one resource is the chrome's font (D76), preloaded with no Referer before the style.
    expect(html.split(chromeFontPreload)).toHaveLength(2);
    expect(html).toContain(`${chromeFontPreload}<style>`);
    expect(markup(html.replace(chromeFontPreload, ""))).not.toMatch(
      /\sstyle=|\son[a-z]+=|<link\b|<script\s+src/i,
    );
    expect(html).toContain(`<style>${publicShellCss}</style>`);
    expect(html).toContain(`<script>${publicShellScript}</script>`);
    // The script follows #shell's start tag, before the panel (the stored state applies before the
    // shell paints); without a panel it follows the banner.
    expect(html).toContain(
      `<div id="shell" class="shell"><script>${publicShellScript}</script><nav`,
    );
    expect(renderPublicShell(base)).toContain(
      `</header><script>${publicShellScript}</script><main`,
    );
    // Page navigation is never animated (owner feedback 1).
    expect(publicShellCss).not.toMatch(/view-transition/);
  });
  it("lists the head first, then the tree, for any number of files", () => {
    const small = renderPublicShell({
      ...base,
      files: ["b.md", "a.md", "index.md"].map((path) => ({ path })),
    });
    expect([...small.matchAll(/data-p="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "index.md",
      "a.md",
      "b.md",
    ]);
    expect(small).toContain('data-p="index.md" aria-current="page">');
    expect(small.indexOf("<hr>")).toBeGreaterThan(small.indexOf('data-p="index.md"'));
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
    const menu = menuOf(tree);
    expect(menu.indexOf('data-p="index.md"')).toBeLessThan(menu.indexOf("<details"));
    expect(menu).toContain(
      `<details open data-dir="a/">${summary("a/")}<div><details open data-dir="a/b/">${summary("b/")}<div>`,
    );
    expect(menu).toContain(`data-p="a/b/y.md" aria-current="page">${doc}<b>y.md</b></a>`);
    // Balanced folders: the Files panel isn't a <details>.
    expect((menu.match(/<details/g) ?? []).length).toBe((menu.match(/<\/details>/g) ?? []).length);
    expect(renderPublicShell(base)).not.toContain('aria-label="Files"');
  });
  it("folds every folder but the current file's, whatever the manifest's size (D75)", () => {
    for (const length of [9, 300]) {
      const files = Array.from({ length }, (_, i) => ({ path: `d${i % 3}/f${i}.md` }));
      const html = renderPublicShell({ ...base, files, current: "d1/f4.md" });
      expect(html).toContain(`<details open data-dir="d1/">${summary("d1/")}`);
      expect(html).toContain(`<details data-dir="d0/">${summary("d0/")}`);
      expect(html).toContain(`<details data-dir="d2/">${summary("d2/")}`);
    }
    // The head file's page opens no folder.
    const files = ["index.md", "a/x.md", "a/y.md"].map((path) => ({ path }));
    expect(renderPublicShell({ ...base, files })).not.toContain("<details open");
  });
  it("names each folder by its full path, which its shortened row text can't do (D75)", () => {
    // Two long names that differ only where the row shortens them, a bidi control, a chain.
    const paths = [
      "index.md",
      `${long("1")}a.md`,
      `${long("1")}b.md`,
      `${long("2")}a.md`,
      `${long("2")}b.md`,
      "r\u202eev/a.md",
      "r\u202eev/b.md",
      "p/q/r/a.md",
      "p/q/r/b.md",
      'q"&</a.md',
      'q"&</b.md',
    ];
    const menu = menuOf(renderPublicShell({ ...base, files: paths.map((path) => ({ path })) }));
    const dirs = [...menu.matchAll(/<details data-dir="([^"]*)">/g)].map((m) => m[1]);
    expect(dirs).toHaveLength(5);
    expect(dirs).toEqual(
      expect.arrayContaining([long("1"), long("2"), "r\u202eev/", "p/q/r/", "q&quot;&amp;&lt;/"]),
    );
    // The two long folders' rows read the same.
    const rows = [...menu.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((m) => m[1]);
    expect(new Set(rows).size).toBeLessThan(rows.length);
  });
  it("orders the tree like the writer's: folders first, then files, in name order (D75)", () => {
    const paths = [
      "index.md",
      "Zeta.md",
      "ch10.md",
      "ch2.md",
      "README.md",
      "readme.md",
      "api.md",
      "notes/b.md",
      "Docs/x.md",
      "Docs/y.md",
      "docs2/p/q/r.md",
      "docs2/p/q/s.md",
      "solo/only.md",
      "émoji/a.md",
      "émoji/b.md",
    ];
    const html = renderPublicShell({ ...base, files: paths.map((path) => ({ path })) });
    expect([...html.matchAll(/data-p="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "index.md",
      "Docs/x.md",
      "Docs/y.md",
      "docs2/p/q/r.md",
      "docs2/p/q/s.md",
      "émoji/a.md",
      "émoji/b.md",
      "notes/b.md",
      "solo/only.md",
      "api.md",
      "ch2.md",
      "ch10.md",
      "README.md",
      "readme.md",
      "Zeta.md",
    ]);
    // A collapsed chain and a folder shown as its one file sort among the folders by name.
    const menu = menuOf(html);
    expect(menu.indexOf(summary("docs2/p/q/"))).toBeGreaterThan(menu.indexOf(summary("Docs/")));
    expect(menu).toContain(`data-p="notes/b.md">${doc}<b>notes/b.md</b></a>`);
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
    expect(menu).toContain(summary("a/b/c/d/"));
    expect(menu).not.toContain(`${iconUse("folder")}b/`);
    expect(menu).toContain(`data-p="solo/only.md">${doc}<b>solo/only.md</b></a>`);
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
    expect(menu).toContain(summary("a/".repeat(6)));
    expect((menu.match(/<details/g) ?? []).length).toBe(1);
    expect(menu).toContain(`data-p="${deep}">`);
    // The label is the rest of the path, shortened in the middle.
    expect(menu).toMatch(/><b>(?:a\/){19}…(?:a\/){17}f\.md<\/b><\/a>/);
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
    // The rest of the page (the font's preload, style with the font faces and the shared controls,
    // script, letterhead and About, the panel's CSS and script, the tree's folds and their saved
    // state) and the last row's overshoot come to about 48.7 KB.
    expect(html.length).toBeLessThan(PUBLIC_SHELL_LIST_BUDGET + 48_700);
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
      `data-p="invoice\u202efdp.exe">${doc}<b>invoice\ufffdfdp.exe</b></a>`,
    );
    expect(visible).toContain('<h1 dir="auto">Report \ufffdexe.pdf</h1>');
    expect(visible.replace(/data-p="[^"]*"/g, "")).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
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
