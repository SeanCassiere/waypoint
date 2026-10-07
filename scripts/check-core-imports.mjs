import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";

const forbidden = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const denied = [
  "@aws-sdk/",
  "@hono/node-server",
  "@smithy/node-http-handler",
  "@tursodatabase/sync",
  "@tursodatabase/database",
  "better-sqlite3",
];
/** @param {string} specifier @param {string} location */
function assertAllowed(specifier, location) {
  const bare = specifier.replace(/^node:/, "").split("/", 1)[0] ?? "";
  if (
    specifier.startsWith("node:") ||
    forbidden.has(specifier.replace(/^node:/, "")) ||
    forbidden.has(bare) ||
    denied.some((name) => specifier.startsWith(name))
  ) {
    const area = location.includes("reader") ? "reader" : location.includes("ui") ? "ui" : "core";
    throw new Error(`Node-only import in ${area}: ${specifier} (${location})`);
  }
}
/** @param {string} directory */
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Stop at the first forbidden import for a clear failure.
    if (entry.isDirectory()) await check(path);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read each source before checking its imports.
      const source = await readFile(path, "utf8");
      const imports = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
      for (const match of source.matchAll(imports)) assertAllowed(match[1] ?? "", path);
    }
  }
}
const core = new URL("../packages/core/", import.meta.url);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const reader = new URL("../apps/reader/", import.meta.url);
const ui = new URL("../packages/ui/", import.meta.url);
for (const { name, directory } of [
  { name: "core", directory: core },
  { name: "reader", directory: reader },
  { name: "ui", directory: ui },
]) {
  const parsedPackage = /** @type {unknown} */ (
    JSON.parse(await readFile(new URL("package.json", directory), "utf8"))
  );
  if (!isRecord(parsedPackage)) throw new Error(`Invalid ${name} package.json`);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = parsedPackage[field];
    if (dependencies && typeof dependencies === "object") {
      for (const dependency of Object.keys(dependencies))
        assertAllowed(dependency, `${name} package.json ${field}`);
    }
  }
}
await check(process.argv[2] ?? new URL("src/", core).pathname);
await check(new URL("src/", reader).pathname);
await check(new URL("src/", ui).pathname);
