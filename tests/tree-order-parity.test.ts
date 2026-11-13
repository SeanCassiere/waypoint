import type { ManifestFileEntry } from "@waypoint/core";
import { renderPublicShell } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import { treeOf, type TreeNode } from "../apps/writer/src/viewer/tree-order.ts";

// D75: the public reader lists the files in the writer's Files tree order (D72). The reader also
// collapses single-folder chains and shows a one-file folder as its file, so the fixtures have
// neither; the head is at the top level, where both list it first.

const entry = (path: string): ManifestFileEntry => ({
  path,
  hash: `sha256:${path}`,
  mime: "text/markdown",
  size: 1,
  url: "",
});
/** The writer's rows below the head, top to bottom: at each level the folders, then the files. */
function flatten(node: TreeNode, out: string[] = []): string[] {
  for (const [, child] of node.folders) flatten(child, out);
  for (const file of node.files) out.push(file.path);
  return out;
}
function writerOrder(paths: readonly string[], head: string): string[] {
  const root = treeOf(paths.map(entry), head);
  // The head is pinned first in its folder, above the folders.
  const rest = { ...root, files: root.files.filter((file) => file.path !== head) };
  return [head, ...flatten(rest)];
}
function readerOrder(paths: readonly string[], head: string): string[] {
  const html = renderPublicShell({
    title: "Parity",
    files: paths.map((path) => ({ path })),
    head,
    current: head,
    fileHref: (path) => `./${path}`,
    frameBase: "https://reader.example.test/x/a.b/r/c/",
    updatedAt: null,
    snapshotAt: null,
  });
  const tree = html.slice(html.indexOf('<div class="tree">'), html.indexOf("</nav>"));
  return [...tree.matchAll(/data-p="([^"]+)"/g)].map((match) => match[1]!);
}

describe("reader and writer tree order", () => {
  it("lists the files in the same order", () => {
    const paths = [
      "README.md",
      "readme.md",
      "Zeta.md",
      "ch10.md",
      "ch2.md",
      "api.md",
      "_notes.md",
      "docs/guide-10.md",
      "docs/guide-2.md",
      "docs/Index.md",
      "docs/api/b.md",
      "docs/api/A.md",
      "Docs2/x.md",
      "Docs2/y.md",
      "img/fig 1.png",
      "img/fig 12.png",
      "img/fig 3.png",
      "v1.10/x.md",
      "v1.10/y.md",
      "v1.9/x.md",
      "v1.9/y.md",
      "café/a.md",
      "café/B.md",
      "cafe-b/a.md",
      "cafe-b/b.md",
    ];
    expect(readerOrder(paths, "README.md")).toEqual(writerOrder(paths, "README.md"));
  });

  it("lists a generated 2,000-file manifest in the same order", () => {
    const paths = [
      "index.md",
      ...Array.from({ length: 1999 }, (_, i) => `Part ${i % 7}/ch${i % 23}/Section-${i}.md`),
    ];
    expect(readerOrder(paths, "index.md")).toEqual(writerOrder(paths, "index.md"));
  });
});
