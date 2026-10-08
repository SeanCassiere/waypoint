import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ICON_NAMES, type IconName } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

// Every icon in the set has a consumer: a source under apps/ or packages/ui/src that passes the
// name as a string literal to icon(…) or iconUse(…), or lists it literally in an iconSprite([…])
// array. Lives here, not in packages/ui, because it reads apps/.

const root = new URL("..", import.meta.url).pathname;
const SOURCES = ["apps", "packages/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", ".turbo", ".wrangler"]);
const SKIP_FILES = new Set([join(root, "packages/ui/src/icons.ts")]);

// Icons with no consumer yet. Only shrinks; VS-03b empties it. Lanes don't edit it.
const NOT_YET_CONSUMED_ICONS: readonly IconName[] = [
  "search",
  "more",
  "panel",
  "chevronDown",
  "chevronLeft",
  "chevronRight",
  "close",
  "check",
  "copy",
  "external",
  "download",
  "history",
  "grid",
  "alert",
  "clock",
  "okcircle",
  "dot",
  "globe",
  "branch",
  "follow",
  "pin",
  "lock",
  "info",
  "doc",
  "image",
  "table",
  "code",
  "binary",
  "folder",
];

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

  it("leaves no icon unused outside the not-yet-consumed list", async () => {
    const consumed = await consumedNames();
    expect(
      ICON_NAMES.filter((name) => !consumed.has(name) && !NOT_YET_CONSUMED_ICONS.includes(name)),
    ).toEqual([]);
  });

  it("lists only icons in the set, each once", () => {
    const known: ReadonlySet<string> = new Set(ICON_NAMES);
    expect(NOT_YET_CONSUMED_ICONS.filter((name) => !known.has(name))).toEqual([]);
    expect(new Set(NOT_YET_CONSUMED_ICONS).size).toBe(NOT_YET_CONSUMED_ICONS.length);
  });
});
