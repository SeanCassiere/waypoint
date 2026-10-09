import { describe, expect, it } from "vitest";

import {
  encodeLinkPath,
  publicShellCss,
  renderPublicShell,
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
    // Every row is a bare link: no classes, no wrapper spans.
    const rows = html.match(/<a href="[^"]*" data-p="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(12);
    for (const row of rows)
      expect(row).toMatch(
        /^<a href="[^"]*" data-p="[^"]*"(?: aria-current="page"(?: autofocus)?)?>[^<]*<\/a>$/,
      );
  });
  it("puts autofocus on the head row when the head is the current file", () => {
    const html = markup(shell(twelve));
    expect(count(html, "autofocus")).toBe(1);
    const menu = html.slice(html.indexOf('<div class="mbox tree"'));
    const head = menu.slice(0, menu.indexOf("<hr>"));
    expect(head).toMatch(
      /<a href="[^"]*" data-p="index\.md" aria-current="page" autofocus>index\.md<\/a>$/,
    );
  });
  it("uses tabs in a .prow row for 2–8 files, without popover or autofocus", () => {
    const html = markup(shell(three));
    expect(html).toContain('<div class="prow"><nav class="ptabs2" aria-label="Files">');
    expect(html).not.toContain("popover");
    expect(html).not.toContain("autofocus");
  });
  it("has no row for one file", () => {
    const html = markup(shell(["index.md"]));
    expect(html).not.toContain('class="prow"');
    expect(html).not.toContain("popover=");
  });
  it("emits the scrim once on every page", () => {
    for (const paths of [["index.md"], three, twelve])
      expect(count(shell(paths), '<div class="pop-scrim" aria-hidden="true"></div>')).toBe(1);
  });
  it("lists every file of 2,000-file manifests within the budget", () => {
    const shapes = [
      (i: number) => `dir${i % 40}/file-${i}.html`,
      (i: number) => `a${i % 13}/b${i % 17}/c${i % 7}/d/e/f/g/h/i/f${i}.ts`,
    ];
    for (const shape of shapes) {
      const paths = Array.from({ length: 2000 }, (_, i) => shape(i)).toSorted();
      const html = renderPublicShell({
        ...base,
        files: paths.map((path) => ({ path })),
        head: paths[0]!,
        current: paths[7]!,
      });
      const menu = html.slice(html.indexOf('<div id="files"'));
      expect(count(menu, "data-p=")).toBe(2000);
      expect(html).not.toContain('class="more"');
    }
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
