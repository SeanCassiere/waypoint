import { describe, expect, it } from "vitest";

import {
  encodeLinkPath,
  encodePathSegments,
  icon,
  ICON_NAMES,
  publicShellScript,
  renderPublicShell,
  type PublicShellOptions,
} from "../src/index.ts";
import { filesCss } from "../src/public-shell/css.ts";
import { downloadLink } from "../src/public-shell/download.ts";

// RX-06: the current file's Download control, at the end of the tab or Files row, or in the
// letterhead actions for a one-file link.
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
const shell = (paths: readonly string[], current = paths[0] ?? "index.md"): string =>
  renderPublicShell({ ...base, files: paths.map((path) => ({ path })), current });
const markup = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
const controls = (html: string): string[] =>
  markup(html).match(/<a class="btn dlb[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** The `.prow` row's markup, up to its matching `</nav>`. */
function row(html: string): string {
  const start = html.indexOf('<nav class="prow" aria-label="Files">');
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const tags = /<\/?nav\b[^>]*>/g;
  tags.lastIndex = start;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  throw new Error("unbalanced .prow");
}
const three = ["index.md", "docs/a b.md", "notes/day-1.md"];
const twelve = ["index.md", ...Array.from({ length: 11 }, (_, i) => `a/b${i}.md`)];

describe("Download control (RX-06)", () => {
  it("ends the tab row of a 3-file shell", () => {
    const html = markup(shell(three, "docs/a b.md"));
    const found = controls(html);
    expect(found).toHaveLength(1);
    const control = found[0]!;
    const prow = row(html);
    expect(prow.endsWith(`</div>${control}</nav>`)).toBe(true);
    expect(attribute(control, "href")).toBe(
      `${base.frameBase}${encodePathSegments("docs/a b.md")}?download`,
    );
    expect(attribute(control, "href")).toBe(`${base.frameBase}docs/a%20b.md?download`);
    expect(attribute(control, "download")).toBe("a b.md");
    expect(attribute(control, "aria-label")).toBe("Download docs/a b.md");
    expect(control).toContain(icon("download"));
    expect(control).toContain('<span class="lbl">Download</span>');
    expect(control.startsWith('<a class="btn dlb" ')).toBe(true);
    expect(html.slice(html.indexOf('<div class="acts">'), html.indexOf("</header>"))).not.toContain(
      "dlb",
    );
  });
  it("ends the Files row of a 12-file shell, after the Files nav", () => {
    const html = markup(shell(twelve, "a/b3.md"));
    const found = controls(html);
    expect(found).toHaveLength(1);
    const control = found[0]!;
    expect(row(html).endsWith(`</div></div></div>${control}</nav>`)).toBe(true);
    expect(attribute(control, "href")).toBe(`${base.frameBase}a/b3.md?download`);
    expect(attribute(control, "download")).toBe("b3.md");
    expect(attribute(control, "aria-label")).toBe("Download a/b3.md");
  });
  it("leads the letterhead actions of a one-file shell, labelled with the path in mono", () => {
    const html = markup(shell(["plan.md"]));
    expect(html).not.toContain('class="prow"');
    const found = controls(html);
    expect(found).toHaveLength(1);
    const control = found[0]!;
    expect(control.startsWith('<a class="btn dlb one" ')).toBe(true);
    expect(html).toContain(`<div class="acts">${control}<span class="ro">`);
    expect(control).toContain('<span class="lbl nm">plan.md</span>');
    expect(attribute(control, "href")).toBe(`${base.frameBase}plan.md?download`);
    expect(attribute(control, "download")).toBe("plan.md");
    expect(attribute(control, "aria-label")).toBe("Download plan.md");
    expect(downloadLink({ ...base, current: "plan.md" }, "letterhead")).toBe(control);
  });
  it("never puts the control in the letterhead of a multi-file shell", () => {
    const html = markup(shell(["a.md", "b.md"]));
    const acts = html.slice(html.indexOf('<div class="acts">'), html.indexOf("</header>"));
    expect(acts).not.toContain("dlb");
    expect(controls(html)).toHaveLength(1);
  });
  it("shows bidi controls in the saved and accessible names as U+FFFD", () => {
    const current = "x/invoice‮fdp.exe";
    for (const paths of [[current], ["index.md", current]]) {
      const control = controls(shell(paths, current))[0]!;
      expect(attribute(control, "download")).toBe("invoice�fdp.exe");
      expect(attribute(control, "aria-label")).toBe("Download x/invoice�fdp.exe");
      expect(control).not.toContain("‮f");
      expect(attribute(control, "href")).toBe(
        `${base.frameBase}x/invoice%E2%80%AEfdp.exe?download`,
      );
    }
  });
  it("keeps a hostile name escaped", () => {
    const evil = `"><script>x</script>.md`;
    for (const paths of [[evil], ["index.md", evil]]) {
      const html = markup(shell(paths, evil));
      const tags = new Set([...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]));
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
      const control = controls(html)[0]!;
      expect(control).not.toContain("<script>");
      // The name after the payload's own "/" is the saved name.
      expect(attribute(control, "download")).toBe("script&gt;.md");
      expect(attribute(control, "aria-label")).toBe(
        "Download &quot;&gt;&lt;script&gt;x&lt;/script&gt;.md",
      );
      expect(control).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    }
  });
  it("styles placement only, on top of the shared .btn", () => {
    expect(filesCss).toContain(".prow>.dlb{margin-left:auto;flex:none;");
    expect(filesCss).toMatch(/\.btn\.dlb\.one \.nm\{[^}]*font:12px\/16px var\(--mono\)/);
    // A long single-file name wraps instead of being cut, so the file name always shows.
    expect(filesCss).not.toMatch(/\.dlb[^{]*\{[^}]*text-overflow/);
    expect(filesCss).toMatch(
      /\.btn\.dlb\.one \.nm\{[^}]*white-space:normal;overflow-wrap:anywhere/,
    );
    // Forced colours keep the border while hovered (the phone ghost hover is transparent).
    expect(filesCss).toMatch(
      /@media\(forced-colors:active\)\{[^@]*\.btn\.dlb,\.btn\.dlb:hover\{border-color:ButtonText\}/,
    );
    expect(filesCss).toMatch(
      /@media\s*\(max-width:\s*599\.98px\)\s*\{[^@]*\.btn\.dlb,\.btn\.dlb:hover\{width:var\(--tap\);height:var\(--tap\);[^}]*border-color:transparent;background:none\}/,
    );
    expect(filesCss).toMatch(/\.btn\.dlb \.lbl\{display:none\}/);
    expect(filesCss).not.toMatch(/(?:^|[}\s,])\.btn\{/);
  });
  it("follows in-frame navigation from the link's own data-p", () => {
    expect(publicShellScript).toContain('document.querySelector(".prow > .dlb")');
    expect(publicShellScript).toContain("const p = hit.dataset.p;");
    expect(publicShellScript).toContain(
      'base + p.split("/").map(encodeURIComponent).join("/") + "?download"',
    );
  });
});
