import type { ManifestFileEntry } from "@waypoint/core";
import { compareNames } from "@waypoint/ui";

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** One folder of the Files tree: its subfolders by name and its own files, both sorted. */
export interface TreeNode {
  folders: [name: string, node: TreeNode][];
  files: ManifestFileEntry[];
}

/**
 * The Files tree (D72): at every level, the head file if it's in that folder, then the folders,
 * then the other files, each sorted by `compareNames`.
 */
export function treeOf(files: readonly ManifestFileEntry[], head: string): TreeNode {
  type Building = { folders: Map<string, Building>; files: ManifestFileEntry[] };
  const root: Building = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const sorted = (node: Building): TreeNode => ({
    folders: [...node.folders]
      .toSorted(([a], [b]) => compareNames(a, b))
      .map(([name, child]) => [name, sorted(child)]),
    files: node.files.toSorted((a, b) =>
      a.path === head ? -1 : b.path === head ? 1 : compareNames(base(a.path), base(b.path)),
    ),
  });
  return sorted(root);
}
