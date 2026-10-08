// The reader Worker bundle (Wrangler's dry-run build, apps/reader/dist) inlines exactly the npm
// packages listed for it in scripts/inlined-packages.json, the list THIRD_PARTY_NOTICES.md is
// generated from, so a dependency update that pulls a new package into the reader fails here
// instead of shipping without that package's license text. The MCP server build checks its own
// list (deps.onlyBundle in packages/mcp/tsdown.config.ts). Turbo builds the reader before this
// suite.
//
// Every package a bundle inlines is a `dependency`, not a `devDependency`, of the package that
// brings it in, so Dependabot titles its updates `fix(deps)` and they make a release (D57).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

function read(path: string): unknown {
  const url = new URL(path, import.meta.url);
  if (!existsSync(url)) throw new Error(`${fileURLToPath(url)} is missing: run pnpm build`);
  return JSON.parse(readFileSync(url, "utf8"));
}

interface Listed {
  name: string;
  via?: string;
}

function listed(from: string): Listed[] {
  const inlined = read("../scripts/inlined-packages.json");
  const list: unknown =
    typeof inlined === "object" && inlined !== null
      ? Object.entries(inlined).find(([key]) => key === from)?.[1]
      : undefined;
  if (!Array.isArray(list)) throw new Error(`no list for ${from}`);
  return list.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry))
      throw new Error(`a ${from} entry has no name`);
    const via = "via" in entry ? String(entry.via) : undefined;
    return via === undefined ? { name: String(entry.name) } : { name: String(entry.name), via };
  });
}

function listedNames(from: string): string[] {
  return listed(from).map((entry) => entry.name);
}

interface Manifest {
  name: string;
  dependencies: string[];
  devDependencies: string[];
}

function manifest(dir: string): Manifest {
  const json = read(`../${dir}/package.json`);
  const field = (key: string): string[] => {
    const value: unknown =
      typeof json === "object" && json !== null
        ? Object.entries(json).find(([name]) => name === key)?.[1]
        : undefined;
    return typeof value === "object" && value !== null ? Object.keys(value) : [];
  };
  const name: unknown =
    typeof json === "object" && json !== null && "name" in json ? json.name : "";
  return {
    name: String(name),
    dependencies: field("dependencies"),
    devDependencies: field("devDependencies"),
  };
}

/** The workspace's apps and packages, by package name. */
function workspace(): Map<string, Manifest> {
  const root = new URL("../", import.meta.url);
  const manifests = new Map<string, Manifest>();
  for (const group of ["apps", "packages"])
    for (const dir of readdirSync(new URL(group, root)))
      if (existsSync(new URL(`${group}/${dir}/package.json`, root))) {
        const m = manifest(`${group}/${dir}`);
        manifests.set(m.name, m);
      }
  return manifests;
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

it.each(["apps/reader", "packages/mcp"])(
  "every package the %s bundle inlines is a dependency of what brings it in",
  (from) => {
    const packages = workspace();
    const bundler = manifest(from);
    const misplaced: string[] = [];
    for (const { name, via } of listed(from)) {
      // A package inlined through another npm package comes with that package's update; one
      // inlined through a workspace package is that package's dependency, and the workspace
      // package is the bundler's.
      if (via !== undefined && !via.startsWith("@waypoint/")) continue;
      const owner = via === undefined ? bundler : packages.get(via);
      if (owner === undefined)
        throw new Error(`${from}: ${name} comes via ${via}, not in the workspace`);
      if (via !== undefined && !bundler.dependencies.includes(via))
        misplaced.push(`${via} (in ${bundler.name})`);
      if (!owner.dependencies.includes(name) || owner.devDependencies.includes(name))
        misplaced.push(`${name} (in ${owner.name})`);
    }
    expect(misplaced).toEqual([]);
  },
);
