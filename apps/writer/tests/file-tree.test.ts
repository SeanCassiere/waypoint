import type { ManifestFileEntry } from "@waypoint/core";
import { compareNames } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { FileTree, type TreeOptions } from "../src/viewer/components.tsx";
import { treeOf, type TreeNode } from "../src/viewer/tree-order.ts";

// D72: the Files tree lists the head first in its folder, then folders, then files (case-insensitive,
// numeric-aware), and its folders start collapsed except the ones holding the current file.

const entry = (path: string, mime = "text/markdown"): ManifestFileEntry => ({
  path,
  hash: `sha256:${path}`,
  mime,
  size: 1,
  url: "",
});
const files = [
  "readme.md",
  "README.md",
  "Zeta.md",
  "api.md",
  "ch10.md",
  "ch2.md",
  "notes/b.md",
  "notes/A.md",
  "notes/deep/x.md",
  "notes/Deep2/y.md",
  "assets/logo.svg",
  "Beta/c.md",
  "index.md",
].map((path) => entry(path));

async function tree(options: Partial<TreeOptions> = {}): Promise<string> {
  return String(
    await FileTree({
      files,
      head: "index.md",
      pub: "c",
      rpub: "r",
      pinned: false,
      current: "index.md",
      glyphs: null,
      ...options,
    }),
  );
}
/** Every row's name in document order: folders as "name/", files by their data-file path. */
function rows(html: string): string[] {
  return [...html.matchAll(/data-dir="([^"]+)"|data-file="([^"]+)"/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}
/** The folders rendered open. */
function opened(html: string): string[] {
  return [...html.matchAll(/<details open="" data-dir="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("compareNames", () => {
  it("sorts case-insensitively, numbers by value, ties by code unit", () => {
    expect(["readme.md", "Zeta.md", "api.md", "CHANGELOG.md"].toSorted(compareNames)).toEqual([
      "api.md",
      "CHANGELOG.md",
      "readme.md",
      "Zeta.md",
    ]);
    expect(["ch10.md", "ch2.md", "ch1.md"].toSorted(compareNames)).toEqual([
      "ch1.md",
      "ch2.md",
      "ch10.md",
    ]);
    expect(["readme.md", "README.md"].toSorted(compareNames)).toEqual(["README.md", "readme.md"]);
    expect(compareNames("a", "a")).toBe(0);
  });
});

describe("treeOf", () => {
  it("puts folders before files at every level, each sorted, the head first in its folder", () => {
    const names = (node: TreeNode): unknown => ({
      folders: node.folders.map(([name, child]) => [name, names(child)]),
      files: node.files.map((file) => file.path),
    });
    expect(names(treeOf(files, "notes/b.md"))).toEqual({
      folders: [
        ["assets", { folders: [], files: ["assets/logo.svg"] }],
        ["Beta", { folders: [], files: ["Beta/c.md"] }],
        [
          "notes",
          {
            folders: [
              ["deep", { folders: [], files: ["notes/deep/x.md"] }],
              ["Deep2", { folders: [], files: ["notes/Deep2/y.md"] }],
            ],
            files: ["notes/b.md", "notes/A.md"],
          },
        ],
      ],
      files: ["api.md", "ch2.md", "ch10.md", "index.md", "README.md", "readme.md", "Zeta.md"],
    });
  });
});

describe("FileTree", () => {
  it("renders the head, then folders, then files", async () => {
    expect(rows(await tree())).toEqual([
      "index.md",
      "assets/",
      "assets/logo.svg",
      "Beta/",
      "Beta/c.md",
      "notes/",
      "notes/deep/",
      "notes/deep/x.md",
      "notes/Deep2/",
      "notes/Deep2/y.md",
      "notes/A.md",
      "notes/b.md",
      "api.md",
      "ch2.md",
      "ch10.md",
      "README.md",
      "readme.md",
      "Zeta.md",
    ]);
  });

  it("starts every folder collapsed but the current file's", async () => {
    expect(opened(await tree())).toEqual([]);
    expect(opened(await tree({ current: "notes/deep/x.md" }))).toEqual(["notes/", "notes/deep/"]);
    // A small tree is collapsed too: there's no size threshold any more.
    expect(opened(await tree({ files: files.slice(0, 7), current: null }))).toEqual([]);
    // The gallery page has no current file and opens its own folder.
    expect(opened(await tree({ current: null, reveal: "notes/Deep2/" }))).toEqual([
      "notes/",
      "notes/Deep2/",
    ]);
  });

  it("leaves Expand all to the Files tab's tools row", async () => {
    expect(await tree()).not.toContain("data-tree-all");
  });

  it("keeps the filter for large trees only, above the tree", async () => {
    expect(await tree()).not.toContain("data-filter");
    const many = Array.from({ length: 201 }, (_, i) => entry(`d/f${i}.md`));
    const html = await tree({ files: many, head: "d/f0.md", current: "d/f0.md" });
    expect(html).toContain('placeholder="Filter 201 files"');
    expect(html.indexOf("data-filter")).toBeLessThan(html.indexOf('class="tree"'));
    // Numeric order: f2 before f10 before f100.
    const order = rows(html);
    expect(order.indexOf("d/f2.md")).toBeLessThan(order.indexOf("d/f10.md"));
    expect(order.indexOf("d/f10.md")).toBeLessThan(order.indexOf("d/f100.md"));
    expect(opened(html)).toEqual(["d/"]);
  });

  it("keeps View as gallery as the first row of its folder", async () => {
    const images = ["a", "b", "c", "d"].map((name) => entry(`shots/${name}.png`, "image/png"));
    const html = await tree({
      files: [...images, entry("index.md")],
      galleryHref: (dir) => `/g/${dir}`,
    });
    const inside = html.slice(html.indexOf('data-dir="shots/"'));
    expect(inside.indexOf("View as gallery (4)")).toBeLessThan(
      inside.indexOf('data-file="shots/a.png"'),
    );
  });
});
