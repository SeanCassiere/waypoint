// The reader Worker bundle (Wrangler's dry-run build, apps/reader/dist) inlines exactly the npm
// packages listed for it in scripts/inlined-packages.json, the list THIRD_PARTY_NOTICES.md is
// generated from, so a dependency update that pulls a new package into the reader fails here
// instead of shipping without that package's license text. The MCP server build checks its own
// list (deps.onlyBundle in packages/mcp/tsdown.config.ts). Turbo builds the reader before this
// suite.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

function read(path: string): unknown {
  const url = new URL(path, import.meta.url);
  if (!existsSync(url)) throw new Error(`${fileURLToPath(url)} is missing: run pnpm build`);
  return JSON.parse(readFileSync(url, "utf8"));
}

function listedNames(from: string): string[] {
  const inlined = read("../scripts/inlined-packages.json");
  const list: unknown =
    typeof inlined === "object" && inlined !== null
      ? Object.entries(inlined).find(([key]) => key === from)?.[1]
      : undefined;
  if (!Array.isArray(list)) throw new Error(`no list for ${from}`);
  return list.map((entry: unknown) =>
    typeof entry === "object" && entry !== null && "name" in entry ? String(entry.name) : "",
  );
}

/** The npm package of each source under a node_modules directory (the innermost one). */
function packagesOf(sources: string[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    const at = source.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const [scope = "", name = ""] = source.slice(at + "node_modules/".length).split("/");
    names.add(scope.startsWith("@") ? `${scope}/${name}` : scope);
  }
  return [...names].toSorted();
}

it("finds package names in source map paths", () => {
  expect(
    packagesOf([
      "../src/index.ts",
      "../../../packages/core/dist/paths.js",
      "../../../node_modules/.pnpm/hono@4.0.0/node_modules/hono/dist/hono.js",
      "../../../node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/dist/index.js",
      "../node_modules/a/node_modules/b/index.js",
    ]),
  ).toEqual(["@scope/pkg", "b", "hono"]);
});

it("the reader bundle inlines exactly the packages listed for it", () => {
  const map = read("../apps/reader/dist/index.js.map");
  const sources: unknown =
    typeof map === "object" && map !== null && "sources" in map ? map.sources : undefined;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string"))
    throw new Error("apps/reader/dist/index.js.map has no sources");
  expect(packagesOf(sources)).toEqual(listedNames("apps/reader").toSorted());
});
