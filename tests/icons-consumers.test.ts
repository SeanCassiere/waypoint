import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ICON_NAMES } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

// Every icon in the set has a consumer: a source under apps/ or packages/ui/src that passes the
// name as a string literal to icon(…) or iconUse(…), or lists it literally in an iconSprite([…])
// array. Lives here, not in packages/ui, because it reads apps/.

const root = new URL("..", import.meta.url).pathname;
const SOURCES = ["apps", "packages/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", ".turbo", ".wrangler"]);
const SKIP_FILES = new Set([join(root, "packages/ui/src/icons.ts")]);

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? Promise.resolve([]) : files(full);
      return Promise.resolve(
        /\.(?:ts|tsx|mjs)$/.test(entry.name) && !SKIP_FILES.has(full) ? [full] : [],
      );
    }),
  );
  return nested.flat();
}

/** Icon names passed as literals to icon(…), iconUse(…) or inside an iconSprite([…]) array. */
async function consumedNames(): Promise<Set<string>> {
  const paths = (await Promise.all(SOURCES.map((source) => files(join(root, source))))).flat();
  const texts = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const names = new Set<string>();
  for (const text of texts) {
    for (const [, name] of text.matchAll(/\bicon(?:Use)?\(\s*["'`]([A-Za-z]+)["'`]/g))
      names.add(name!);
    for (const [, list] of text.matchAll(/\biconSprite\(\s*\[([^\]]*)\]/g))
      for (const [, name] of list!.matchAll(/["'`]([A-Za-z]+)["'`]/g)) names.add(name!);
  }
  return names;
}

describe("icon consumers", () => {
  it("names only icons in the set", async () => {
    const known: ReadonlySet<string> = new Set(ICON_NAMES);
    expect([...(await consumedNames())].filter((name) => !known.has(name))).toEqual([]);
  });

  it("leaves no icon unused", async () => {
    const consumed = await consumedNames();
    expect(ICON_NAMES.filter((name) => !consumed.has(name))).toEqual([]);
  });
});
