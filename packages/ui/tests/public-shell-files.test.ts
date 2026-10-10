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
import { filesCss, menuCss } from "../src/public-shell/css.ts";

// A11Y-07: the Files popover (a bottom sheet on phones), tab rows, the `.prow` row and the scrim.
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

describe("Files popover", () => {
  it("opens the tree from a Files button, focusing the current row", () => {
    const html = markup(shell(twelve, "a/b3.md"));
    expect(count(html, 'popovertarget="files"')).toBe(2);
    expect(count(html, '<button type="button" class="fbtn" popovertarget="files"')).toBe(1);
    const button = /<button type="button" class="fbtn"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(button?.[0]).toContain('aria-describedby="files-cur"');
    expect(button?.[1]?.replace(/<[^>]*>/g, "")).toMatch(/^Files 12/);
    expect(html).toContain('<div id="files" class="menu files" popover="auto">');
    expect(html).toContain('<div class="mbox tree" role="group" aria-labelledby="files-h">');
    expect(html).toContain('<h2 id="files-h">Files <span class="n">12</span></h2>');
    expect(html).toContain(
      '<button type="button" class="done" popovertarget="files" popovertargetaction="hide">Done</button>',
    );
    expect(count(html, "autofocus")).toBe(1);
    expect(html).toMatch(/<a [^>]*data-p="a\/b3\.md" aria-current="page" autofocus>/);
    for (const banned of [
      "<details class=",
      "<summary>Files",
      'class="row"',
      'class="ti"',
      'class="nm"',
      'class="sz"',
    ])
      expect(html).not.toContain(banned);
    // Every row is a bare link: no classes, no wrapper spans; one sprite icon after the opening
    // tag, and a download marker only on files that can't be previewed (RX-03).
    const rows = html.match(/<a href="[^"]*" data-p="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(12);
    for (const row of rows)
      expect(row).toMatch(
        /^<a href="[^"]*" data-p="[^"]*"(?: aria-current="page"(?: autofocus)?)?><svg class="ic ti" aria-hidden="true"><use href="#i-[a-z]+"\/><\/svg>[^<]*(?:<small> download[^<]*<\/small>)?<\/a>$/,
      );
  });
  it("puts autofocus on the head row when the head is the current file", () => {
    const html = markup(shell(twelve));
    expect(count(html, "autofocus")).toBe(1);
    const menu = html.slice(html.indexOf('<div class="mbox tree"'));
    const head = menu.slice(0, menu.indexOf("<hr>"));
    expect(head).toMatch(
      /<a href="[^"]*" data-p="index\.md" aria-current="page" autofocus><svg [^>]*><use href="#i-doc"\/><\/svg>index\.md<\/a>$/,
    );
  });
  it("uses tabs in a .prow row for 2–8 files, without popover or autofocus", () => {
    const html = markup(shell(three));
    // The row is the Files landmark, so its Download control is inside one too (A11Y-AUDIT).
    expect(html).toContain('<nav class="prow" aria-label="Files"><div class="ptabs2">');
    // The letterhead's About popover (RX-01) is not part of the Files row.
    expect(html.slice(html.indexOf("</header>"))).not.toContain("popover");
    expect(html).not.toContain("autofocus");
  });
  it("has no row for one file", () => {
    const html = markup(shell(["index.md"]));
    expect(html).not.toContain('class="prow"');
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
      const menu = html.slice(html.indexOf('<div id="files"'));
      expect(count(menu, "data-p=")).toBe(2000);
      expect(count(menu, "<use href=")).toBeGreaterThanOrEqual(2000);
      expect(html).not.toContain('class="more"');
    }
  });
  it("lists most of the repository shape on a page 9 folders deep, and says how many are missing", () => {
    // Decision c-2: the reader links with "../" once per folder level, so rows grow with depth.
    // A file of this shape sits 9 folders deep; its page lists 1,756 of 2,000 at 340,000. Pin a
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
    const menu = html.slice(html.indexOf('<div id="files"'));
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
    expect(html).toContain("archive/build-output.tar.gz<small> download · 4.1 MB</small></a>");
    expect(html).toContain("y.bin<small> download</small></a>");
    const rows = html.match(/<a href="[^"]*" data-p="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row.includes("<small>"))).toHaveLength(2);
    for (const file of typed) {
      const row = rows.find((r) => r.includes(`data-p="${file.path}"`)) ?? "";
      expect(row.slice(row.indexOf(">") + 1)).toMatch(
        new RegExp(`^${iconUse(shellFileKind(file.mime))}`),
      );
    }
    const summaries = html.match(/<summary dir="auto">[\s\S]*?<\/summary>/g) ?? [];
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries)
      expect(summary.startsWith(`<summary dir="auto">${iconUse("folder")}`)).toBe(true);
    expect(html).toContain(`id="files-cur">${iconUse("doc")}<span class="t"`);
    expect(markup(typedShell("data/x.csv"))).toContain(
      `id="files-cur">${iconUse("table")}<span class="t"`,
    );
  });
  it("emits one sprite before the scrim, and none for one file", () => {
    const html = typedShell();
    expect(count(html, "<symbol")).toBe(6);
    expect([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "i-doc",
      "i-image",
      "i-table",
      "i-code",
      "i-binary",
      "i-folder",
    ]);
    expect(html).toContain(
      `${iconSprite(["doc", "image", "table", "code", "binary", "folder"])}<div class="pop-scrim"`,
    );
    expect(html).toContain('<body><a class="skip"');
    expect(count(shell(three), "<symbol")).toBe(6);
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
  it("pins the .prow row and moves the column off the navs", () => {
    expect(filesCss).toContain(
      ".prow{display:flex;align-items:flex-end;gap:8px;max-width:1120px;margin:0 auto;padding:0 16px}",
    );
    expect(filesCss).toMatch(
      /@media\s*\(max-width:\s*599\.98px\)\s*\{[^@]*\.prow\{padding:0 10px\}/,
    );
    expect(filesCss).toContain(".ptabs2,.pfiles{min-width:0;flex:1 1 auto}");
    expect(filesCss).not.toMatch(/\.ptabs2\{[^}]*max-width/);
    expect(filesCss).not.toMatch(/\.pfiles\{[^}]*max-width/);
  });
  it("adds no motion, and has the scrim and the phone breakpoint", () => {
    expect(filesCss + menuCss).not.toMatch(/transition|animation|view-transition/);
    expect(publicShellCss).toContain(".pop-scrim");
    expect(publicShellCss).toMatch(/\(max-width: ?599\.98px\)/);
  });
});
