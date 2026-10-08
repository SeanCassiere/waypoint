import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { publicShellCss } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
// The writer viewer, its browser client, the shared UI package and the public reader.
const SOURCES = [
  "apps/writer/src",
  "apps/writer/viewer.build.ts",
  "packages/ui/src",
  "apps/reader/src",
];
const PATTERN = /view-transition|viewTransition|startViewTransition|pageswap|pagereveal/i;

async function files(path: string): Promise<string[]> {
  const full = join(root, path);
  if (/\.[cm]?[jt]sx?$|\.css$/.test(path)) return [full];
  const entries = await readdir(full, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? files(join(path, entry.name))
        : /\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)
          ? Promise.resolve([join(full, entry.name)])
          : Promise.resolve([]),
    ),
  );
  return nested.flat();
}

describe("motion (owner feedback)", () => {
  it("never animates page navigation: no view transitions anywhere in the UI", async () => {
    const paths = (await Promise.all(SOURCES.map((source) => files(source)))).flat();
    const texts = await Promise.all(paths.map((file) => readFile(file, "utf8")));
    const found = texts.flatMap((text, at) =>
      text
        .split("\n")
        .flatMap((line, index) =>
          PATTERN.test(line)
            ? [`${paths[at]?.slice(root.length)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(found).toEqual([]);
    expect(publicShellCss).not.toMatch(PATTERN);
  });
  it("keeps popover and dialog motion under 150 ms and off under reduced motion", async () => {
    const css = await readFile(join(root, "apps/writer/src/viewer/viewer.css"), "utf8");
    const durations = [...css.matchAll(/(\d+)ms/g)].map((match) => Number(match[1]));
    // The spinner's 1 s rotation is a progress indicator, not a transition.
    expect(durations.filter((ms) => ms > 150)).toEqual([]);
    const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(motion).toBeGreaterThan(0);
    // Every transition lives inside the no-preference block.
    const before = css.slice(0, motion);
    expect(before).not.toMatch(/\btransition:/);
  });
});
