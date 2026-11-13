import { describe, expect, it } from "vitest";

import {
  encodeLinkPath,
  iconSprite,
  iconUse,
  publicShellCss,
  renderPublicShell,
  shellFileKind,
  type PublicShellFile,
  type PublicShellOptions,
} from "../src/index.ts";
import { panelCss, treeCss } from "../src/panel-css.ts";
import { filesCss, menuCss, sidebarCss } from "../src/public-shell/css.ts";

// A11Y-07 and D74: the Files row, the file panel (a popover below WIDE_MIN, a bottom sheet on
// phones) and the scrim.
const base: PublicShellOptions = {
  title: "Plan",
  files: [{ path: "index.md" }],
  head: "index.md",
  current: "index.md",
  fileHref: (path) => `./${encodeLinkPath(path)}`,
  frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
  updatedAt: null,
  snapshotAt: null,
};
const shell = (paths: readonly string[], current = "index.md"): string =>
  renderPublicShell({ ...base, files: paths.map((path) => ({ path })), current });
const markup = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
const count = (html: string, text: string): number => html.split(text).length - 1;
const twelve = ["index.md", ...Array.from({ length: 11 }, (_, i) => `a/b${i}.md`)];
const three = ["index.md", "a.md", "b.md"];
/** A row's type icon: a sprite reference drawn by `.tree a>svg`, so without a class of its own. */
const rowIcon = (kind: string): string => `<svg aria-hidden="true"><use href="#i-${kind}"/></svg>`;
/** One file row: a bare link, its sprite icon, the label in a `b`, an optional download marker. */
const ROW =
  /^<a href="[^"]*" data-p="[^"]*"(?: aria-current="page")?><svg aria-hidden="true"><use href="#i-[a-z]+"\/><\/svg><b>[^<]*<\/b>(?:<small> download[^<]*<\/small>)?<\/a>$/;

describe("Files panel", () => {
  it("puts the tree in a Files panel beside the document, opened from the Files button", () => {
    const html = markup(shell(twelve, "a/b3.md"));
    expect(count(html, 'popovertarget="files"')).toBe(2);
    const button = /<button type="button" class="fbtn ptog"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(button?.[0]).toContain('popovertarget="files" aria-controls="files"');
    expect(button?.[0]).toContain('aria-describedby="files-cur"');
    expect(button?.[1]).toMatch(/^<svg class="ic" /);
    expect(button?.[1]?.replace(/<[^>]*>/g, "")).toMatch(/^Files 12/);
    expect(html).toContain('<body class="pan">');
    expect(html).toContain(`<header class="pwrap"><div class="lh">`);
    expect(html).toMatch(/<\/div><div class="prow"><button type="button" class="fbtn ptog"/);
    expect(html).toContain(
      '</header><div id="shell" class="shell"><nav id="files" class="panel" popover="auto" aria-label="Files"><div class="shd"><h2 id="files-h">Files <span class="n">12</span></h2>',
    );
    expect(html).toContain(
      '<button type="button" class="done" popovertarget="files" popovertargetaction="hide">Done</button></div><div class="pbody"><div class="tree">',
    );
    expect(html).toMatch(
      /<\/div><\/div><\/nav><main id="main">[\s\S]*<\/main><div class="peek-edge" aria-hidden="true"><\/div><\/div><svg/,
    );
    // The script puts autofocus on the current row after parsing: a docked panel must not take
    // the focus from the skip link at load.
    expect(html).not.toContain("autofocus");
    expect(html).toMatch(/<a [^>]*data-p="a\/b3\.md" aria-current="page">/);
    for (const banned of [
      "<details class=",
      "<summary>Files",
      'class="row"',
      'class="ti"',
      'class="nm"',
      'class="sz"',
      'class="in"',
      "title=",
    ])
      expect(html.slice(html.indexOf('<div class="tree">'), html.indexOf("</nav>"))).not.toContain(
        banned,
      );
    // Every row is a bare link: no classes, no wrapper spans; one sprite icon after the opening
    // tag, and a download marker only on files that can't be previewed (RX-03).
    const rows = html.match(/<a href="[^"]*" data-p="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(row).toMatch(ROW);
  });
  it("lists the head first, above a rule", () => {
    const html = markup(shell(twelve));
    const tree = html.slice(html.indexOf('<div class="tree">'));
    const head = tree.slice(0, tree.indexOf("<hr>"));
    expect(head).toMatch(
      /<a href="[^"]*" data-p="index\.md" aria-current="page"><svg [^>]*><use href="#i-doc"\/><\/svg><b>index\.md<\/b><\/a>$/,
    );
  });
  it("uses the panel for two files too: no tab strip", () => {
    const html = markup(shell(three));
    expect(html).toContain('<nav id="files" class="panel" popover="auto" aria-label="Files">');
    expect(html).not.toContain("ptabs2");
    expect(count(html, 'aria-label="Files"')).toBe(1);
    expect(markup(shell(["index.md", "a.md"]))).toContain('id="shell"');
  });
  it("has no row, panel or shell for one file", () => {
    const html = markup(shell(["index.md"]));
    expect(html).not.toContain('class="prow"');
    expect(html).not.toContain('id="shell"');
    expect(html).not.toContain('class="pan"');
    expect(html).toContain('</header><main id="main">');
    expect(html.slice(html.indexOf("</header>"))).not.toContain("popover=");
  });
  it("emits the scrim once on every page", () => {
    for (const paths of [["index.md"], three, twelve])
      expect(count(shell(paths), '<div class="pop-scrim" aria-hidden="true"></div>')).toBe(1);
  });
  it("lists every file of 2,000-file manifests within the budget, icons included", () => {
    // Realistic and repository shapes (RX-03: with their type icons), relative links.
    const shapes: [(i: number) => string, string][] = [
      [(i) => `dir${i % 40}/file-${i}.html`, "text/html"],
      [(i) => `a${i % 13}/b${i % 17}/c${i % 7}/d/e/f/g/h/i/f${i}.ts`, "text/typescript"],
    ];
    for (const [shape, mime] of shapes) {
      const paths = Array.from({ length: 2000 }, (_, i) => shape(i)).toSorted();
      const html = renderPublicShell({
        ...base,
        files: paths.map((path) => ({ path, mime, size: 1 })),
        head: paths[0]!,
        current: paths[7]!,
      });
      const menu = html.slice(html.indexOf('<nav id="files"'));
      expect(count(menu, "data-p=")).toBe(2000);
      expect(count(menu, "<use href=")).toBeGreaterThanOrEqual(2000);
      expect(html).not.toContain('class="more"');
    }
  });
  it("lists most of the repository shape on a page 9 folders deep, and says how many are missing", () => {
    // Decision c-2: the reader links with "../" once per folder level, so rows grow with depth.
    // A file of this shape sits 9 folders deep; its page lists 1,822 of 2,000 at 340,000. Pin a
    // floor so a markup change that shrinks the list further fails here.
    const paths = Array.from(
      { length: 2000 },
      (_, i) => `a${i % 13}/b${i % 17}/c${i % 7}/d/e/f/g/h/i/f${i}.ts`,
    ).toSorted();
    const html = renderPublicShell({
      ...base,
      files: paths.map((path) => ({ path, mime: "text/typescript", size: 1 })),
      head: paths[0]!,
      current: paths[7]!,
      fileHref: (path) => `${"../".repeat(9)}${encodeLinkPath(path)}`,
    });
    const menu = html.slice(html.indexOf('<nav id="files"'));
    const listed = count(menu, "data-p=");
    expect(listed).toBeGreaterThanOrEqual(1700);
    expect(listed).toBeLessThan(2000);
    expect(menu).toContain(`<p class="more">${2000 - listed} more files aren't listed here.</p>`);
  });
});
// RX-03: type icons from one sprite, the download marker and the per-file title.
const titled = (current: string, title = "Plan"): string =>
  renderPublicShell({
    ...base,
    title,
    files: [...new Set(["checklist.md", "docs/notes-3.md", current])].map((path) => ({ path })),
    current,
  });
describe("file type icons", () => {
  it("maps stored types to icon kinds", () => {
    const table: [string | undefined, string][] = [
      [undefined, "doc"],
      ["text/markdown", "doc"],
      ["text/html", "doc"],
      ["text/plain", "doc"],
      ["image/png", "image"],
      ["image/svg+xml", "image"],
      ["text/csv", "table"],
      ["TEXT/CSV; header=present", "table"],
      ["text/tab-separated-values", "table"],
      ["application/json", "code"],
      ["application/ld+json", "code"],
      ["application/x-ndjson", "code"],
      ["text/typescript", "code"],
      ["text/x-shellscript", "code"],
      ["application/gzip", "binary"],
      ["application/octet-stream", "binary"],
      ["application/pdf", "binary"],
      ["application/vnd.apache.parquet", "binary"],
    ];
    for (const [mime, kind] of table) expect([mime, shellFileKind(mime)]).toEqual([mime, kind]);
  });
  const typed: PublicShellFile[] = [
    { path: "index.md", mime: "text/markdown", size: 10 },
    { path: "archive/build-output.tar.gz", mime: "application/gzip", size: 4_300_000 },
    { path: "data/x.csv", mime: "text/csv", size: 10 },
    { path: "y.bin", mime: "application/octet-stream", size: null },
    ...Array.from({ length: 8 }, (_, i) => ({
      path: `notes/n${i}.md`,
      mime: "text/markdown",
      size: 10,
    })),
  ];
  const typedShell = (current = "index.md"): string =>
    renderPublicShell({ ...base, files: typed, current });
  it("puts the kind's icon on every row, and the download marker only where it can't preview", () => {
    const html = markup(typedShell());
    expect(html).toContain(
      "<b>archive/build-output.tar.gz</b><small> download · 4.1 MB</small></a>",
    );
    expect(html).toContain("<b>y.bin</b><small> download</small></a>");
    const rows = html.match(/<a href="[^"]*" data-p="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row.includes("<small>"))).toHaveLength(2);
    for (const file of typed) {
      const row = rows.find((r) => r.includes(`data-p="${file.path}"`)) ?? "";
      expect(row.slice(row.indexOf(">") + 1)).toMatch(
        new RegExp(`^${rowIcon(shellFileKind(file.mime))}`),
      );
    }
    const summaries = html.match(/<summary dir="auto">[\s\S]*?<\/summary>/g) ?? [];
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries)
      expect(
        summary.startsWith(
          `<summary dir="auto">${iconUse("chevronDown", "sm")}${iconUse("folder")}`,
        ),
      ).toBe(true);
    expect(html).toContain(`id="files-cur">${iconUse("doc")}<span class="t"`);
    expect(markup(typedShell("data/x.csv"))).toContain(
      `id="files-cur">${iconUse("table")}<span class="t"`,
    );
  });
  it("emits one sprite before the scrim, and none for one file", () => {
    const html = typedShell();
    expect(count(html, "<symbol")).toBe(7);
    expect([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "i-doc",
      "i-image",
      "i-table",
      "i-code",
      "i-binary",
      "i-folder",
      "i-chevronDown",
    ]);
    expect(html).toContain(
      `${iconSprite(["doc", "image", "table", "code", "binary", "folder", "chevronDown"])}<div class="pop-scrim"`,
    );
    expect(html).toContain('<body class="pan"><a class="skip"');
    expect(shell(["index.md"])).toContain('<body><a class="skip"');
    expect(count(shell(three), "<symbol")).toBe(7);
    expect(shell(["index.md"])).not.toContain("<symbol");
  });
  it("titles the page with the current file's name and the collection title", () => {
    expect(titled("checklist.md")).toContain("<title>checklist.md · Plan</title>");
    expect(titled("docs/notes-3.md")).toContain("<title>notes-3.md · Plan</title>");
    expect(titled("a/in\u202evoice.md", "<b>")).toContain(
      "<title>in\ufffdvoice.md · &lt;b&gt;</title>",
    );
  });
});
describe("Files CSS", () => {
  it("pins the .prow row, full width beside a panel, and drops the tab strip", () => {
    expect(filesCss).toContain(
      ".prow{display:flex;align-items:flex-end;gap:8px;max-width:1120px;margin:0 auto;padding:0 16px}",
    );
    expect(filesCss).toContain(".pan .lh,.pan .prow{max-width:none}");
    expect(filesCss).toMatch(
      /@media\s*\(max-width:\s*599\.98px\)\s*\{[^@]*\.prow\{padding:0 10px\}/,
    );
    expect(publicShellCss).not.toMatch(/ptabs2|pfiles|\.files\b/);
  });
  it("docks the panel from WIDE_MIN without opening it, and hides a closed sheet below", () => {
    expect(publicShellCss).toContain(panelCss + treeCss + sidebarCss);
    expect(sidebarCss).toContain(
      "@media(min-width:1100px){.panel{display:flex;position:static;width:auto}",
    );
    expect(sidebarCss).toContain("html:not(.js) .ptog{display:none}");
    expect(sidebarCss).toContain(
      "@media(max-width:1099.98px){.panel:not(:popover-open){display:none}",
    );
  });
  it("adds no motion, and has the scrim and the phone breakpoint", () => {
    expect(filesCss + menuCss).not.toMatch(/transition|animation|view-transition/);
    expect(publicShellCss).toContain(".pop-scrim");
    expect(publicShellCss).toMatch(/\(max-width: ?599\.98px\)/);
  });
});
