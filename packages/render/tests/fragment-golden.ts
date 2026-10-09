// The Changes-page fragment fixture. Its rendered output hashes to FRAGMENT_GOLDEN_HASH. Fragments
// are rendered per request and never stored, so a change needs no RENDERER_VERSION bump, but it
// changes the Changes page: review it there and update the hash deliberately.
import { markWords, type FragmentLinks } from "../src/index.ts";

/** SHA-256 of every fragment input's rendered HTML, joined with NUL, in order. */
export const FRAGMENT_GOLDEN_HASH: string =
  "1463fd86fb50432886fc24cce64983166ed2ca7003bd4714057ffc4416aab1f3";

/** Markdown sources and the links they resolve against (`null`: no resolver). */
export function fragmentGoldenInputs(): [string, FragmentLinks | null][] {
  const alerts = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
    .map((kind) => `> [!${kind}]\n> ${kind} body.`)
    .join("\n\n");
  const links = [
    "b.md",
    "../b.md",
    "/top.md",
    "#x",
    "../../../escape.md",
    "//evil.example/x",
    "javascript:alert(1)",
    "a%20b.md",
    "x%2F..%2Fy.md",
    "dir/./z.md",
  ]
    .map((href, index) => `[link ${index}](${href})`)
    .join("\n");
  const marked = markWords([
    { op: "equal", text: "Retry for " },
    { op: "delete", text: "72" },
    { op: "insert", text: "24" },
    { op: "equal", text: " hours." },
  ]);
  const markedTable = `| Step | Time |\n| --- | --- |\n| Restore ${markWords([
    { op: "delete", text: "from backup" },
    { op: "insert", text: "from snapshot" },
  ])} | ${markWords([
    { op: "delete", text: "~1 h" },
    { op: "insert", text: "25 min" },
  ])} |`;
  const root: FragmentLinks = { root: "/c/c1/r/r1/", dir: "docs/" };
  const top: FragmentLinks = { root: "/c/c1/r/r1/", dir: "" };
  return [
    [alerts, null],
    ["> [!NOTE] text", null],
    [
      "| Name | Value |\n| :-- | --: |\n| `code` | *emphasis* and **strong** |\n| a \\| b | |",
      null,
    ],
    ["- [x] done\n- [ ] todo", null],
    [links, null],
    [links, root],
    [links, top],
    [marked, null],
    [markedTable, null],
    ["<aside>Raw</aside>\n\nText <b>bold</b>.", null],
    ["![Figure](./figure.png) and ![](x.png)", root],
  ];
}
