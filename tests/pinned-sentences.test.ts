import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// NAV-09b: the sentences the owner pinned (spec freeze §3.8) stay in their owners' sources as one
// contiguous literal each, so a later edit can't reword them or build them from parts. The
// sentences with revision numbers in them are checked as rendered (tests/browser/viewer/NAV-09b.ts).

const root = new URL("..", import.meta.url).pathname;

/** Each pinned string and the source trees one of which must hold it. */
const PINNED: readonly { text: string; owner: string; in: readonly string[] }[] = [
  {
    text: "A newer version is being synced. It will appear here once it has uploaded.",
    owner: "RX-11",
    in: ["packages/ui/src/public-shell", "apps/reader/src"],
  },
  {
    text: "Newer version syncing",
    owner: "RX-11",
    in: ["packages/ui/src/public-shell", "apps/reader/src"],
  },
  ...[
    "To confirm, type the title or the public ID",
    "Copy title",
    "Copy public ID",
    "Matches the title",
    "Matches the public ID",
    "Purge permanently",
  ].map((text) => ({ text, owner: "OW-14", in: ["apps/writer/src"] })),
];

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) return files(full);
      return Promise.resolve(/\.(?:ts|tsx)$/.test(entry.name) ? [full] : []);
    }),
  );
  return nested.flat();
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `source` with every possible comment blanked to spaces (newlines kept), so a pinned string only
 *  a comment quotes can't keep the guard green. This repo's TypeScript (the native TS 7 build) has
 *  no JS parser API, so instead of telling code from strings this blanks too much, provably: every
 *  real comment starts at some `//` or `/*` in the text and ends where that opener alone decides (its
 *  line's end, or the first `*\/` after it), so blanking that span after *every* `//` and `/*`,
 *  wherever it sits (a string, a regex, JSX text, a URL, another comment), covers every comment
 *  whatever quotes, backticks or slashes come first. It never pairs quotes, so nothing can mislead
 *  it. The cost is strictness: after a `//` in a string, the rest of that line doesn't count, and
 *  after a `/*` in a string or a line comment, nothing up to the next `*\/` counts. That only ever
 *  fails the guard, never lets a comment pass it. */
function blankComments(source: string): string {
  const out = source.split("");
  for (const opener of ["//", "/*"]) {
    let i = source.indexOf(opener);
    while (i !== -1) {
      const end = opener === "/*" ? source.indexOf("*/", i + 2) : source.indexOf("\n", i);
      const stop = end === -1 ? source.length : opener === "/*" ? end + 2 : end;
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = source.indexOf(opener, i + 1);
    }
  }
  return out.join("");
}

/** Whether `text` holds `pinned` as one contiguous whole-word run outside every possible comment. */
function holds(text: string, pinned: string): boolean {
  // Whole words: "Copy title" mustn't be satisfied by "Copy titles".
  return new RegExp(`(?<![\\w])${escape(pinned)}(?![\\w])`).test(blankComments(text));
}

describe("pinned sentences (NAV-09b)", () => {
  it("keeps every pinned string as one literal in its owner's source", async () => {
    const trees = [...new Set(PINNED.flatMap((pinned) => pinned.in))];
    const sources = new Map(
      await Promise.all(
        trees.map(async (tree): Promise<[string, string[]]> => {
          const paths = await files(join(root, tree));
          return [tree, await Promise.all(paths.map((path) => readFile(path, "utf8")))];
        }),
      ),
    );
    const missing = PINNED.filter(
      (pinned) =>
        !pinned.in.some((tree) => sources.get(tree)?.some((text) => holds(text, pinned.text))),
    ).map((pinned) => `${pinned.owner}: "${pinned.text}" (in ${pinned.in.join(" or ")})`);
    expect(missing).toEqual([]);
  });

  it("counts a pinned string in code, never one only quoted by a comment", () => {
    const counts = [
      `const hint = "Copy title";`,
      `<button>Copy title</button>`,
      `// Copy title\nconst b = "Copy title";`,
      `/* a */ const b = "Copy title"; /* b */`,
      `const url = "https://x";\nconst b = "Copy title";`,
      // A `/*` in a string or regex blanks only up to the next `*\/` in the file.
      `const glob = "**/*.md";\n/** b */\nconst b = "Copy title";`,
      `const re = /a\\/*/;\n/* x */ const b = "Copy title";`,
      `const t = \`\${n} /* \${"x"}\`;\n// */\nconst b = "Copy title";`,
      `const t = \`a \${f({ k: "Copy title" })} b\`;`,
      `<p>It won't</p>\n<b>Copy title</b>`,
      `<p>It won't</p> <b>Copy title</b>`,
    ];
    expect(counts.filter((source) => !holds(source, "Copy title"))).toEqual([]);
    const comments = [
      `  // "Copy title"\n`,
      `/* Copy title */`,
      `/**\n * Copy title is pinned\n */`,
      `  {/* Copy title */}`,
      `label(); // Copy title`,
      `const x = 0; /* Copy title */`,
      `const x = 0; /*\n  Copy title\n*/`,
      `const x = 0; //Copy title`,
      `const t = \`\${n}\`; // Copy title`,
      `const s = "a // b"; // Copy title`,
      `const a = "Copy titles";`,
      // An apostrophe in JSX text and quotes in a regex literal aren't strings (review round 4).
      `const x = <p>It won't {/* Copy title */}</p>;`,
      `const quote = /['"]/; /* Copy title */`,
      `<p>It won't {/*\n  Copy title\n*/}</p>`,
      `const quote = /['"]/; /*\n  Copy title\n*/`,
      `<p>Don't {/* Copy title */} won't</p>`,
      `const quote = /'|'/; // Copy title`,
      // A block comment opened after mis-paired quotes or a stray backtick (review round 5).
      `<p>Don't {/* won't\n  Copy title\n*/}</p>`,
      `const re = /'/; /* it's\n Copy title\n*/`,
      `const quote = /\`/; /*\n Copy title\n*/`,
      `const x = <p>\` {/*\n Copy title\n*/}</p>;`,
      // A block comment opened after a `//` in a string, a URL or JSX text (review round 6).
      `const quote = /\`/; const url = "https://example.test"; /*\n Copy title\n*/`,
      `<p>See https://example.com {/*\n Copy title\n*/}</p>`,
      `const u = <a href="x">http://x</a>; /*\n Copy title\n*/`,
      `<p>a // b {/*\n Copy title\n*/}</p>`,
      `const s = "a // b"; /* c\n Copy title */`,
    ];
    expect(comments.filter((source) => holds(source, "Copy title"))).toEqual([]);
  });

  it("is stricter, never looser, after a `//` or `/*` that isn't a comment", () => {
    // The documented cost (see `blankComments`): these literals are code, but don't count.
    const strict = [
      `const glob = "**/*.md";\nconst b = "Copy title";`,
      `const re = /a\\/*/;\nconst b = "Copy title";`,
      `const t = \`\${n} /* \${"x"}\`;\nconst b = "Copy title";`,
      `// a glob like **/*.md\nconst b = "Copy title";`,
      `const url = "https://x"; const b = "Copy title";`,
    ];
    expect(strict.filter((source) => holds(source, "Copy title"))).toEqual([]);
  });
});
