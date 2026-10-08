// Writes THIRD_PARTY_NOTICES.md: the third-party packages each distributed artifact inlines, and
// the writer image's npm dependencies that ship no license file of their own, with every package's
// full license text, read from the installed package (or, for a package that ships none, kept in
// scripts/license-texts/ from its source repository). Run it after `pnpm install`:
//
//   pnpm notices          rewrite THIRD_PARTY_NOTICES.md
//   pnpm notices:check    fail if it's out of date (CI's lint job)
//
// The packages each bundle inlines are listed in scripts/inlined-packages.json, by the workspace
// package that builds the bundle. The builds hold the list to what they inline: the MCP server
// build fails on a package that isn't listed (tsdown's `deps.onlyBundle`, packages/mcp/
// tsdown.config.ts), and a test compares the reader bundle's source map with its list
// (tests/inlined-packages.test.ts). The file ships beside LICENSE in the writer image, each
// release bundle and the MCP launcher package, and heads the MCP server bundle.
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath decodes the URL: a checkout path with a space or a non-ASCII character works.
const root = fileURLToPath(new URL("..", import.meta.url));
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

function isInlined(value: unknown): value is Inlined {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    (!("via" in value) || typeof value.via === "string")
  );
}

const inlined: unknown = JSON.parse(
  await readFile(join(root, "scripts", "inlined-packages.json"), "utf8"),
);
function listed(from: string): Inlined[] {
  const list: unknown =
    typeof inlined === "object" && inlined !== null
      ? Object.entries(inlined).find(([key]) => key === from)?.[1]
      : undefined;
  if (!Array.isArray(list) || !list.every(isInlined))
    throw new Error(`scripts/inlined-packages.json: no valid list for ${from}`);
  return list;
}

const bundles: Bundle[] = [
  {
    title:
      "**The public reader Worker** (`apps/reader/dist/index.js`, and `reader/index.js` in each release bundle) inlines:",
    from: "apps/reader",
    packages: listed("apps/reader"),
  },
  {
    title:
      "**The MCP server bundle** (`/mcp/server.mjs` on a writer) and **the MCP launcher package** (`/mcp/waypoint-mcp.tgz`, which embeds a copy of the server bundle) inline:",
    from: "packages/mcp",
    packages: listed("packages/mcp"),
  },
];

// Packages whose npm tarball has no license file: the license text from their source repository,
// kept in scripts/license-texts/. The writer image's dependencies are checked for this too (see
// `writerImage` below), not only the bundles' inlined packages.
interface MissingLicenseFile {
  /** The SPDX id, checked against the package's manifest where it's installed. */
  license: string;
  /** Where the text comes from. */
  source: string;
  /** The file in scripts/license-texts/. */
  file: string;
}
const awsSdk: MissingLicenseFile = {
  license: "Apache-2.0",
  source: "`LICENSE` of https://github.com/aws/aws-sdk-js-v3",
  file: "aws-sdk-js-v3.LICENSE.txt",
};
const turso: MissingLicenseFile = {
  license: "MIT",
  source: "`LICENSE.md` of https://github.com/tursodatabase/turso",
  file: "turso.LICENSE.md.txt",
};
const missingLicenseFiles = new Map<string, MissingLicenseFile>(
  Object.entries({
    "@aws-sdk/credential-provider-http": awsSdk,
    "@aws-sdk/credential-provider-login": awsSdk,
    "@aws-sdk/nested-clients": awsSdk,
    "@tursodatabase/database": turso,
    "@tursodatabase/database-common": turso,
    // The native builds: the image installs the one for its architecture (linux/amd64, linux/arm64).
    "@tursodatabase/database-linux-arm64-gnu": turso,
    "@tursodatabase/database-linux-x64-gnu": turso,
    "@tursodatabase/serverless": turso,
    "@tursodatabase/sync": turso,
    "@tursodatabase/sync-common": turso,
    "@tursodatabase/sync-linux-arm64-gnu": turso,
    "@tursodatabase/sync-linux-x64-gnu": turso,
    // Its manifest has the old `licenses: [{ type: "MIT" }]` form, and format.js only a header.
    format: {
      license: "MIT",
      source: "`License.md` of https://github.com/samsonjs/format",
      file: "format.License.md.txt",
    },
  }),
);

// Optional (platform-specific) writer dependencies the image never installs: it runs on Debian
// (glibc) Linux, amd64 or arm64. Any other optional dependency that isn't installed here must be
// listed here or in missingLicenseFiles, so a checkout on one platform still vouches for the other.
const notInImage = new Set([
  "@tursodatabase/database-darwin-arm64",
  "@tursodatabase/database-win32-x64-msvc",
  "@tursodatabase/sync-darwin-arm64",
  "@tursodatabase/sync-win32-x64-msvc",
]);

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
  /** The scripts/license-texts/ file the text is from, when the package ships no license file. */
  fallback?: string;
}

type Manifest = Record<string, unknown>;

async function manifestOf(dir: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${relative(root, dir)}/package.json isn't an object`);
  return Object.fromEntries(Object.entries(value));
}

/** The manifest's license: `license`, or the old `licenses: [{ type }]` form with one entry. */
function declaredLicense(manifest: Manifest): string {
  if (typeof manifest.license === "string") return manifest.license;
  const list: unknown = manifest.licenses;
  if (!Array.isArray(list) || list.length !== 1) return "";
  const entry: unknown = list[0];
  return typeof entry === "object" &&
    entry !== null &&
    "type" in entry &&
    typeof entry.type === "string"
    ? entry.type
    : "";
}

/** The names in a manifest's dependency map (`dependencies`, `optionalDependencies`, ...). */
function depNames(map: unknown): string[] {
  return typeof map === "object" && map !== null ? Object.keys(map) : [];
}

async function fromFallback(name: string, fallback: MissingLicenseFile): Promise<Resolved> {
  const text = await readFile(join(root, "scripts", "license-texts", fallback.file), "utf8");
  return {
    name,
    license: fallback.license,
    source: `${fallback.source}, the package's repository (the npm package ships no license file)`,
    texts: [text],
    fallback: fallback.file,
  };
}

async function licenseOf(name: string, dir: string): Promise<Resolved> {
  const license = declaredLicense(await manifestOf(dir));
  if (!permissive.has(license))
    throw new Error(`${name}: license ${JSON.stringify(license)} isn't on the permissive list`);
  // The license, then (Apache-2.0, section 4(d)) any NOTICE file.
  const files = (await readdir(dir))
    .filter((f) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(f))
    .toSorted(
      (a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b),
    );
  if (files.length === 0) {
    const fallback = missingLicenseFiles.get(name);
    if (!fallback)
      throw new Error(
        `${name} (${relative(root, dir)}) ships no license file: add the license text from its source repository to scripts/license-texts/, and the package to missingLicenseFiles in this script`,
      );
    if (fallback.license !== license)
      throw new Error(
        `${name}: its manifest says ${JSON.stringify(license)}, missingLicenseFiles says ${fallback.license}`,
      );
    return fromFallback(name, fallback);
  }
  const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  const source = `the package's ${files.map((f) => `\`${f}\``).join(" and ")}`;
  return { name, license, source, texts };
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

/**
 * The writer image's npm dependencies that ship no license file. Walks the writer's installed
 * production dependency tree (what `pnpm deploy --prod` puts in the image's node_modules/), and
 * fails on a package whose license isn't permissive, or that ships no license file and isn't in
 * missingLicenseFiles. An optional dependency that isn't installed on this platform must be in
 * missingLicenseFiles (the image may install it) or notInImage (it never does).
 */
async function writerImage(): Promise<Resolved[]> {
  const seen = new Set<string>();
  const without = new Map<string, Resolved>();
  const walk = async (dir: string): Promise<void> => {
    const manifest = await manifestOf(dir);
    const deps = [
      ...depNames(manifest.dependencies).map((name) => ({ name, kind: "required" })),
      ...depNames(manifest.optionalDependencies).map((name) => ({ name, kind: "optional" })),
      // A peer (optional or not) ships when it's installed, which is when something depends on it.
      ...depNames(manifest.peerDependencies).map((name) => ({ name, kind: "peer" })),
    ];
    const visit = async ({ name, kind }: { name: string; kind: string }): Promise<void> => {
      if (notInImage.has(name)) return;
      const child = await resolvePackage(name, dir).catch((error: unknown) => {
        if (kind === "required") throw error;
        return undefined;
      });
      if (child === undefined) {
        // An optional dependency for another platform may still ship, on the image's other
        // architecture: it needs an entry, checked against its npm package.
        if (kind === "peer") return;
        const fallback = missingLicenseFiles.get(name);
        if (!fallback)
          throw new Error(
            `${name}, an optional dependency of ${String(manifest.name)}, isn't installed on this platform: add it to notInImage in this script if the writer image (glibc Linux, amd64 or arm64) never installs it, or else check its npm package: add it to missingLicenseFiles if it ships no license file (if it ships one, nothing here can read it: extend this check)`,
          );
        without.set(name, await fromFallback(name, fallback));
        return;
      }
      // Claimed before the first await below, so a package two dependents share is read once.
      if (seen.has(child)) return;
      seen.add(child);
      const resolved = await licenseOf(name, child);
      if (resolved.fallback) without.set(name, resolved);
      await walk(child);
    };
    await Promise.all(deps.map(visit));
  };
  await walk(join(root, "apps", "writer"));
  return [...without.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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
  const table = (resolved: Resolved[]): void => {
    lines.push("", "  | Package | License |", "  | --- | --- |");
    for (const r of resolved) {
      lines.push(`  | [\`${r.name}\`](#${anchor(r.name)}) | ${r.license} |`);
      all.set(r.name, r);
    }
    lines.push("");
  };
  lines.push(
    "# Third-party notices",
    "",
    "<!-- Generated by scripts/third-party-notices.ts from the installed packages; don't edit it by hand. `pnpm notices` rewrites it, and CI fails when it's out of date (`pnpm notices:check`). -->",
    "",
    "Waypoint is MIT-licensed ([LICENSE](LICENSE)). Some of what it distributes contains third-party code, all under permissive licenses. No copyleft (GPL, LGPL, AGPL) or unlicensed package is shipped. Each package's full license text, as it ships in the package (or from its source repository, for a package that ships none), is under [Licenses](#licenses).",
    "",
    "This file and [LICENSE](LICENSE) ship in the writer image (`/app/`), in each release bundle and in the MCP launcher package, and head the MCP server bundle as a comment.",
    "",
    "## What ships where",
    "",
    "- **The writer image** (`ghcr.io/seancassiere/waypoint-writer`) installs the writer's production npm dependencies unmodified in `node_modules/`. Only Waypoint's own packages (`@waypoint/*`) are inlined into the writer bundle. The image's base layers are the official `node` Debian image, under its own licenses. It also serves the MCP server bundle and launcher package below. Each npm dependency carries its own license file, except these, whose npm packages ship none (the image installs the native `linux-x64-gnu` or `linux-arm64-gnu` build, by its architecture):",
  );
  table(await writerImage());
  for (const bundle of bundles) {
    lines.push(`- ${bundle.title}`);
    table(await resolveBundle(bundle));
  }
  const unused = [...missingLicenseFiles.keys()].filter((name) => !all.has(name));
  if (unused.length > 0)
    throw new Error(
      `missingLicenseFiles lists packages that nothing ships: ${unused.join(", ")}; remove them`,
    );
  lines.push(
    "## Checking it again",
    "",
    "After a dependency change, list the licenses of what can ship:",
    "",
    "```bash",
    "pnpm -r licenses list --prod    # the dependencies of the writer, the reader and the MCP bundles",
    "```",
    "",
    "The packages each bundle inlines are listed in `scripts/inlined-packages.json`, and nothing ships that the list misses: the MCP server build fails when it would inline a package that isn't listed, and a test (`tests/inlined-packages.test.ts`) fails when the reader bundle's source map names packages other than the reader's list. When a bundle starts inlining another package, add it to the list (with `via`, the package it's a dependency of, if it isn't the bundle's own dependency) and run `pnpm notices`. The writer image's npm dependencies are checked too: `pnpm notices` walks the writer's installed production dependency tree, and fails on a package that ships no license file unless `scripts/third-party-notices.ts` lists it, with its license text from its source repository in `scripts/license-texts/`. A license that isn't permissive fails `pnpm notices` and needs a decision first.",
    "",
    "## Licenses",
  );
  // A text several packages share (one repository's license) is printed once.
  const printed = new Map<string, string>();
  for (const r of all.values()) {
    lines.push("", `### ${r.name}`, "", `${r.license}, from ${r.source}.`);
    const first = r.fallback === undefined ? undefined : printed.get(r.fallback);
    if (first !== undefined) {
      lines.push("", `The same text as [\`${first}\`](#${anchor(first)}).`);
      continue;
    }
    if (r.fallback !== undefined) printed.set(r.fallback, r.name);
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
      "THIRD_PARTY_NOTICES.md is out of date (a shipped package changed its license text, or scripts/inlined-packages.json changed): run `pnpm notices` and commit it.",
    );
    process.exit(1);
  }
} else {
  await writeFile(output, next);
}
