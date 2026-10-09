import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// VS-03: icons come from packages/ui/src/icons.ts, never from Unicode glyphs or emoji. The guard
// scans the writer viewer and client, the shared UI package and the public reader as text,
// comments included, so a glyph can't come back in a comment either.

const root = new URL("..", import.meta.url).pathname;
const SOURCES = [
  "apps/writer/src/viewer",
  "apps/writer/src/client",
  "packages/ui/src",
  "apps/reader/src",
];
const SKIP_FILES = new Set([
  join(root, "packages/ui/src/icons.ts"),
  join(root, "apps/reader/src/csp-hashes.ts"),
]);

// The banned glyphs, as escapes so this file passes its own scan. Allowed, and so not listed:
// keycaps (⇧ ← → ↑ ↓ ↵), the prose arrows → and ›, typography (· … – — “ ” ’ × −) and the diff
// marks (+ − ~ =).
const BANNED = [
  "\u2630", // trigram (panel)
  "\u22EF", // midline ellipsis (more)
  "\u25BE", // small down triangle
  "\u25B8", // small right triangle
  "\u25B4", // small up triangle
  "\u25C2", // small left triangle
  "\u2315", // telephone recorder (search)
  "\u232B", // erase to the left
  "\u25CD", // circle with vertical fill
  "\u26AF", // unmarried partnership
  "\u25C9", // fisheye
  "\u25CE", // bullseye
  "\u29C9", // two joined squares (copy)
  "\u2197", // north east arrow (external)
  "\u21BA", // anticlockwise open circle arrow
  "\u21BB", // clockwise open circle arrow
  "\u21C4", // right arrow over left arrow
  "\u2713", // check mark
  "\u2714", // heavy check mark
  "\u2715", // multiplication x (close)
  "\u2717", // ballot x
  "\u2716", // heavy multiplication x
  "\u25A6", // square with crosshatch fill (grid)
  "\u25CC", // dotted circle (pending)
  "\u25F7", // circle with upper right quadrant (history)
  "\u25CF", // black circle (dot)
  "\u24D8", // circled latin small i (info)
  "\u2442", // OCR fork (branch)
  "\u27F2", // anticlockwise gapped circle arrow
  "\u270E", // lower right pencil
  "\u2399", // print screen symbol
  "\u2303", // up arrowhead
  "\u2304", // down arrowhead
  "\u2039", // single left-pointing angle quotation mark (back)
] as const;
const BANNED_SET: ReadonlySet<string> = new Set(BANNED);
const EMOJI = /\p{Extended_Pictographic}/u;
// A bang used as a status glyph: alone in an aria-hidden element, or leading status text. These
// run over the whole file, not line by line, because formatted JSX puts the bang on its own line.
const BANGS = [/aria-hidden="true">\s*!\s*</g, /(["'`]|>)\s*! [#A-Z]/g];

/** Exemptions: file (repo-relative), character and why. Empty, and kept empty (VS-03b). */
const EXEMPT: readonly { file: string; char: string; why: string }[] = [];

/** Banned glyphs and emoji on one line of `file`. */
function glyphs(file: string, line: string, at: number): string[] {
  const found: string[] = [];
  for (const char of line) {
    if (EXEMPT.some((exempt) => exempt.file === file && exempt.char === char)) continue;
    if (BANNED_SET.has(char) || EMOJI.test(char))
      found.push(`${file}:${at}: U+${char.codePointAt(0)!.toString(16).toUpperCase()} ${char}`);
  }
  return found;
}

/** Status bangs anywhere in `text`, each reported at the line of its `!`. */
function bangs(file: string, text: string): string[] {
  return BANGS.flatMap((bang) =>
    [...text.matchAll(bang)].map((match) => {
      const at = text.slice(0, match.index + match[0].indexOf("!")).split("\n").length;
      return `${file}:${at}: status bang: ${match[0].replace(/\s+/g, " ").trim()}`;
    }),
  );
}

function scan(file: string, text: string): string[] {
  return [
    ...text.split("\n").flatMap((line, index) => glyphs(file, line, index + 1)),
    ...bangs(file, text),
  ];
}

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) return files(full);
      return Promise.resolve(
        /\.(?:ts|tsx|css|mjs)$/.test(entry.name) && !SKIP_FILES.has(full) ? [full] : [],
      );
    }),
  );
  return nested.flat();
}

describe("no glyph icons (VS-03)", () => {
  it("finds no icon glyph, emoji or status bang in the UI sources", async () => {
    const paths = (await Promise.all(SOURCES.map((source) => files(join(root, source))))).flat();
    expect(paths.length).toBeGreaterThan(50);
    const texts = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const found = texts.flatMap((text, at) => scan(paths[at]!.slice(root.length), text));
    expect(found).toEqual([]);
  });

  it("exempts nothing", () => {
    expect(EXEMPT).toEqual([]);
  });

  it("catches each banned character, emoji and status bangs", () => {
    expect(
      BANNED.filter((char) => scan("sample.tsx", `<span>${char} Label</span>`).length !== 1),
    ).toEqual([]);
    expect(BANNED_SET.size).toBe(BANNED.length);
    expect(scan("sample.ts", 'const done = "\u{1F389} Done";')).toHaveLength(1);
    expect(scan("sample.tsx", '<span class="bang" aria-hidden="true">!</span>')).toHaveLength(1);
    // oxfmt puts the bang on its own line; the guard still sees it, at the bang's line.
    expect(
      scan("sample.tsx", '<span class="bang" aria-hidden="true">\n          !\n        </span>'),
    ).toEqual(['sample.tsx:2: status bang: aria-hidden="true"> ! <']);
    expect(scan("sample.tsx", "<span>\n  ! #6 failed to sync\n</span>")).toHaveLength(1);
    expect(scan("sample.tsx", 'text: "! #6 failed to sync",')).toHaveLength(1);
    expect(scan("sample.tsx", "<span>! Nothing has synced</span>")).toHaveLength(1);
    expect(scan("sample.css", 'content: "Details \u25BE";')).toHaveLength(1);
  });

  it("allows prose arrows, keycaps, typography and diff marks, but not \u2039", () => {
    expect(scan("sample.css", 'content: "\u203A" / "";')).toEqual([]);
    expect(scan("sample.tsx", "<a>See its collections \u203A</a>")).toEqual([]);
    expect(scan("sample.tsx", "<span>#2 \u2192 #7 changes</span>")).toEqual([]);
    expect(scan("sample.tsx", "<kbd>\u21E7C</kbd> <kbd>\u2190</kbd> <kbd>\u21B5</kbd>")).toEqual(
      [],
    );
    expect(
      scan("sample.tsx", "a \u00B7 b \u2026 \u2013 \u2014 \u201Cq\u201D it\u2019s 3\u00D7"),
    ).toEqual([]);
    expect(scan("sample.tsx", "<span>+2 \u22121 ~3 =</span>")).toEqual([]);
    expect(scan("sample.tsx", 'if (!ok) return "Not public";')).toEqual([]);
    expect(scan("sample.tsx", "<a>\u2039 Back</a>")).toHaveLength(1);
  });
});
