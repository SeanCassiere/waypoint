// Writes THIRD_PARTY_NOTICES.md: the third-party packages each distributed artifact inlines, with
// every package's full license text, read from the installed package. Run it after `pnpm install`:
//
//   pnpm notices          rewrite THIRD_PARTY_NOTICES.md
//   pnpm notices:check    fail if it's out of date (CI's lint job)
//
// The list below is maintained by hand. When a bundle starts inlining another package, add it
// (THIRD_PARTY_NOTICES.md, "Checking it again", says how to list what a bundle inlines). The file
// ships beside LICENSE in the writer image, each release bundle and the MCP launcher package, and
// heads the MCP server bundle (packages/mcp/tsdown.config.ts).
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const output = join(root, "THIRD_PARTY_NOTICES.md");

interface Inlined {
  /** The npm package. */
  name: string;
  /** The package it's a dependency of (resolved from there); default: the bundle's own package. */
  via?: string;
}

interface Bundle {
  title: string;
  /** The workspace package that builds it, relative to the repository root. */
  from: string;
  packages: Inlined[];
}

const bundles: Bundle[] = [
  {
    title:
      "**The public reader Worker** (`apps/reader/dist/index.js`, and `reader/index.js` in each release bundle) inlines:",
    from: "apps/reader",
    packages: [{ name: "hono" }, { name: "@tursodatabase/serverless" }, { name: "aws4fetch" }],
  },
  {
    title:
      "**The MCP server bundle** (`/mcp/server.mjs` on a writer) and **the MCP launcher package** (`/mcp/waypoint-mcp.tgz`, which embeds a copy of the server bundle) inline:",
    from: "packages/mcp",
    packages: [
      { name: "@modelcontextprotocol/sdk" },
      { name: "zod" },
      { name: "zod-to-json-schema", via: "@modelcontextprotocol/sdk" },
      { name: "ajv", via: "@modelcontextprotocol/sdk" },
      { name: "ajv-formats", via: "@modelcontextprotocol/sdk" },
      { name: "fast-deep-equal", via: "ajv" },
      { name: "json-schema-traverse", via: "ajv" },
      { name: "fast-uri", via: "ajv" },
      { name: "typeid-js", via: "@waypoint/core" },
      { name: "uuid", via: "typeid-js" },
    ],
  },
];

// Packages whose npm tarball has no license file: the text from their source repository.
const missingLicenseFiles: Record<string, { source: string; text: string }> = {
  "@tursodatabase/serverless": {
    source: "LICENSE.md of https://github.com/tursodatabase/turso (the package's repository)",
    text: `MIT License

Copyright 2024 the Turso authors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`,
  },
};

// Anything else (copyleft, unknown, custom) needs a decision before it ships.
const permissive = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0"]);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Node's lookup: <dir>/node_modules/<name> in `from` and each of its ancestors. */
async function resolvePackage(name: string, from: string): Promise<string> {
  let dir = await realpath(from);
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (await exists(join(candidate, "package.json"))) return realpath(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`can't find ${name} from ${relative(root, from)}`);
    dir = parent;
  }
}

interface Resolved {
  name: string;
  license: string;
  /** Where the texts come from, for the reader of the notices. */
  source: string;
  texts: string[];
}

async function licenseOf(name: string, dir: string): Promise<Resolved> {
  const manifest: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const field =
    typeof manifest === "object" && manifest !== null && "license" in manifest
      ? manifest.license
      : undefined;
  const license = typeof field === "string" ? field : "";
  if (!permissive.has(license))
    throw new Error(`${name}: license ${JSON.stringify(license)} isn't on the permissive list`);
  // The license, then (Apache-2.0, section 4(d)) any NOTICE file.
  const files = (await readdir(dir))
    .filter((f) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(f))
    .toSorted(
      (a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b),
    );
  if (files.length === 0) {
    const fallback = missingLicenseFiles[name];
    if (!fallback) throw new Error(`${name} ships no license file; add its text to this script`);
    return { name, license, source: fallback.source, texts: [fallback.text] };
  }
  const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  return { name, license, source: files.map((f) => `\`${f}\``).join(" and "), texts };
}

async function resolveBundle(bundle: Bundle): Promise<Resolved[]> {
  const from = join(root, bundle.from);
  const dirs = new Map<string, string>();
  const dirOf = async (name: string | undefined): Promise<string> => {
    if (!name) return from;
    const known = dirs.get(name);
    if (known) return known;
    const dir = await resolvePackage(name, from);
    dirs.set(name, dir);
    return dir;
  };
  const resolved: Resolved[] = [];
  for (const { name, via } of bundle.packages) {
    const dir = await resolvePackage(name, await dirOf(via));
    dirs.set(name, dir);
    resolved.push(await licenseOf(name, dir));
  }
  return resolved;
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}text\n${text.replace(/\s+$/, "")}\n${ticks}`;
}

function anchor(name: string): string {
  return name
    .replace(/[^a-z0-9 -]/gi, "")
    .replace(/ /g, "-")
    .toLowerCase();
}

async function render(): Promise<string> {
  const lines: string[] = [];
  const all = new Map<string, Resolved>();
  lines.push(
    "# Third-party notices",
    "",
    "<!-- Generated by scripts/third-party-notices.ts from the installed packages; don't edit it by hand. `pnpm notices` rewrites it, and CI fails when it's out of date (`pnpm notices:check`). -->",
    "",
    "Waypoint is MIT-licensed ([LICENSE](LICENSE)). Some of what it distributes contains third-party code, all under permissive licenses. No copyleft (GPL, LGPL, AGPL) or unlicensed package is shipped. Each package's full license text, as it ships in the package, is under [Licenses](#licenses).",
    "",
    "This file and [LICENSE](LICENSE) ship in the writer image (`/app/`), in each release bundle and in the MCP launcher package, and head the MCP server bundle as a comment.",
    "",
    "## What ships where",
    "",
    "- **The writer image** (`ghcr.io/seancassiere/waypoint-writer`) installs the writer's production npm dependencies unmodified in `node_modules/`, each with its own license file. Only Waypoint's own packages (`@waypoint/*`) are inlined into the writer bundle. The image's base layers are the official `node` Debian image, under its own licenses. It also serves the MCP server bundle and launcher package below.",
  );
  for (const bundle of bundles) {
    const resolved = await resolveBundle(bundle);
    lines.push(`- ${bundle.title}`, "", "  | Package | License |", "  | --- | --- |");
    for (const r of resolved) {
      lines.push(`  | [\`${r.name}\`](#${anchor(r.name)}) | ${r.license} |`);
      all.set(r.name, r);
    }
    lines.push("");
  }
  lines.push(
    "## Checking it again",
    "",
    "After a dependency change, list the licenses of what can ship:",
    "",
    "```bash",
    "pnpm -r licenses list --prod    # the dependencies of the writer, the reader and the MCP bundles",
    "```",
    "",
    "To see exactly which packages a bundle inlines, read the `sources` of its source map: `apps/reader/dist/index.js.map` for the reader, and for the MCP server `pnpm --filter @waypoint/mcp exec tsdown --sourcemap -d /tmp/mcp-map`. If a bundle inlines a new package, or anything isn't permissive, update the list in `scripts/third-party-notices.ts` and run `pnpm notices`.",
    "",
    "## Licenses",
  );
  for (const r of all.values()) {
    lines.push("", `### ${r.name}`, "", `${r.license}, from the package's ${r.source}.`);
    for (const text of r.texts) lines.push("", fence(text));
  }
  return lines.join("\n") + "\n";
}

const check = process.argv.includes("--check");
const next = await render();
if (check) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== next) {
    console.error(
      "THIRD_PARTY_NOTICES.md is out of date (an inlined package changed its license text, or the list in scripts/third-party-notices.ts changed): run `pnpm notices` and commit it.",
    );
    process.exit(1);
  }
} else {
  await writeFile(output, next);
}
