/** @jsxImportSource hono/jsx */
import { isTextMime, type ManifestFileEntry } from "@waypoint/core";
import type { Child } from "hono/jsx";

import { shellPath } from "../viewer-paths.js";

export const fmtDate = (time: number | null): Child =>
  time == null ? (
    "Never"
  ) : (
    <time datetime={new Date(time).toISOString()}>{new Date(time).toISOString()}</time>
  );
export function badge(state: string) {
  return <span class={`badge ${state}`}>{state}</span>;
}
export function fileTree(
  files: ManifestFileEntry[],
  head: string,
  pub: string,
  rpub: string,
  pinned: boolean,
  current: string,
) {
  type Node = { folders: Map<string, Node>; files: ManifestFileEntry[] };
  const root: Node = { folders: new Map(), files: [] };
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
  const render = (node: Node, prefix: string): Child => (
    <>
      {[...node.folders]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <details open>
            <summary>{name}</summary>
            {render(child, `${prefix}${name}/`)}
          </details>
        ))}
      {node.files.map((file) => (
        <a
          class={`file ${file.path === current ? "current" : ""}`}
          data-file={file.path}
          aria-current={file.path === current ? "page" : undefined}
          data-embed={String(isEmbeddable(file.mime))}
          href={shellPath(pub, rpub, file.path, pinned, head)}
        >
          {file.path.slice(prefix.length)}
          {file.path === head && <span class="headmark">head</span>}
        </a>
      ))}
    </>
  );
  return render(root, "");
}
export function isEmbeddable(mime: string): boolean {
  return isTextMime(mime) || mime.startsWith("image/") || mime === "application/pdf";
}
