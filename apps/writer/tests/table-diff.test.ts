import { markWords, renderFragment } from "@waypoint/render";
import { icon } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

import type { DiffBlock } from "../src/compare.ts";
import {
  cellWords,
  decorateTable,
  diffsWhole,
  isDelimiterRow,
  parseTableRow,
  tableFragment,
  tableParts,
  type TableMeta,
} from "../src/viewer/pages/changes/table-diff.ts";

// OW-12b: the table row model and the decoration of a rendered table fragment.

describe("parseTableRow", () => {
  it("drops the outer pipes and trims cells", () => {
    expect(parseTableRow("| A | B |")).toEqual(["A", "B"]);
    expect(parseTableRow("  |A|B|  ")).toEqual(["A", "B"]);
    expect(parseTableRow("A | B")).toEqual(["A", "B"]);
    expect(parseTableRow("| A | B")).toEqual(["A", "B"]);
  });
  it("keeps escaped pipes escaped and empty cells", () => {
    expect(parseTableRow("| a \\| b | `x\\|y` |")).toEqual(["a \\| b", "`x\\|y`"]);
    expect(parseTableRow("| a | b \\|")).toEqual(["a", "b \\|"]);
    expect(parseTableRow("|  | x |  |")).toEqual(["", "x", ""]);
  });
});

describe("isDelimiterRow", () => {
  it("accepts GFM delimiter rows with alignment colons", () => {
    expect(isDelimiterRow("| --- | :-: |")).toBe(true);
    expect(isDelimiterRow("|:--|--:|")).toBe(true);
    expect(isDelimiterRow("--- | ---")).toBe(true);
    expect(isDelimiterRow("| - |")).toBe(true);
  });
  it("rejects other rows", () => {
    expect(isDelimiterRow("| A | B |")).toBe(false);
    expect(isDelimiterRow("| --- | x |")).toBe(false);
    expect(isDelimiterRow("| : | - |")).toBe(false);
    expect(isDelimiterRow("|  |")).toBe(false);
  });
});

describe("cellWords", () => {
  it("diffs a replacement as a delete and an insert", () => {
    expect(cellWords("old", "new")).toEqual([
      { op: "delete", text: "old" },
      { op: "insert", text: "new" },
    ]);
    expect(cellWords("3.1:1", "5.2:1")).toEqual([
      { op: "delete", text: "3.1" },
      { op: "insert", text: "5.2" },
      { op: "equal", text: ":1" },
    ]);
    // Spaces or punctuation between replaced words join them; between insertions they don't.
    expect(cellWords(" ", "a b")).toEqual([
      { op: "insert", text: "a" },
      { op: "equal", text: " " },
      { op: "insert", text: "b" },
    ]);
    expect(cellWords("~1 h", "25 min")).toEqual([
      { op: "delete", text: "~1 h" },
      { op: "insert", text: "25 min" },
    ]);
    expect(cellWords("Restore from backup", "Restore from snapshot")).toEqual([
      { op: "equal", text: "Restore from " },
      { op: "delete", text: "backup" },
      { op: "insert", text: "snapshot" },
    ]);
  });
  it("gives up on a side over 1,024 characters", () => {
    expect(cellWords("a".repeat(1025), "b")).toBeUndefined();
    expect(cellWords("b", "a ".repeat(513))).toBeUndefined();
  });
});

const block = (op: DiffBlock["op"], base?: string, head?: string): DiffBlock => ({
  op,
  kind: "table",
  ...(base === undefined ? {} : { base_text: base }),
  ...(head === undefined ? {} : { head_text: head }),
});
const same = (text: string) => block("equal", text, text);

describe("tableParts", () => {
  it("counts rows, not the delimiter, and the header only when it changed", () => {
    const added = ["| A |", "| - |", "| 1 |", "| 2 |"].map((text) =>
      block("insert", undefined, text),
    );
    expect(tableParts(added)).toEqual(["2 added"]);
    expect(tableParts(added.slice(0, 2))).toEqual(["1 added"]);
    expect(
      tableParts([
        block("replace", "| A |", "| A | B |"),
        block("replace", "| - |", "| - | - |"),
        block("replace", "| 1 |", "| 1 | 2 |"),
        same("| 3 |"),
        block("delete", "| 4 |"),
      ]),
    ).toEqual(["2 rows changed", "1 removed"]);
  });

  it("counts a delimiter-shaped body row as a row, and shows the source for it", () => {
    const rows = [
      same("| A | B |"),
      same("| - | - |"),
      block("insert", undefined, "| - | - |"),
      block("replace", "| 1 | 2 |", "| 1 | 3 |"),
    ];
    expect(tableParts(rows)).toEqual(["1 row changed", "1 added"]);
    expect(
      tableParts([...rows.slice(0, 2), block("delete", "| - | - |"), same("| 1 | 2 |")]),
    ).toEqual(["1 removed"]);
    // It could be an adjacent table's delimiter (the same rows), so it isn't rendered as a table.
    expect(tableFragment(rows)).toBeNull();
    // A delimiter split into a removal and an addition is the delimiter on each side.
    expect(
      tableParts([
        same("| A |"),
        block("delete", "| --- |"),
        block("insert", undefined, "| :-: |"),
        block("insert", undefined, "| 2 |"),
      ]),
    ).toEqual(["1 added"]);
  });

  it("counts a changed delimiter when only the alignment changed", () => {
    const rows = [
      same("| A | B |"),
      block("replace", "| - | - |", "| :- | -: |"),
      same("| 1 | 2 |"),
    ];
    expect(tableParts(rows)).toEqual(["1 row changed"]);
    expect(tableFragment(rows)?.meta.caption).toBe("Table · 1 row changed");
  });
});

/** A one-row table whose first cell changed, rendered and decorated. */
/** An external link's opening tag, as fragments render it. */
const link = (url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">`;
const changed = (base: string, head: string): string => {
  const table = tableFragment([
    same("| A | B |"),
    same("| - | - |"),
    block("replace", `| ${base} | x |`, `| ${head} | x |`),
  ]);
  return decorateTable(renderFragment(table?.markdown ?? ""), table!.meta) ?? "";
};

const whole = (base: string, head: string) => diffsWhole(base, head, cellWords(base, head)!);
describe("diffsWhole", () => {
  it("diffs a cell whole when either side holds a construct a word mark could break", () => {
    const cases = [
      ["link", "see [docs](a.md) now", "see [docs](a.md) later"],
      ["image", "![logo](a.png) old", "![logo](a.png) new"],
      ["reference image", "![logo][l] old", "![logo][l] new"],
      ["angle autolink", "<https://a.example> old", "<https://a.example> new"],
      ["angle email autolink", "<1@a.example> old", "<1@a.example> new"],
      ["https URL", "https://old.example", "https://new.example"],
      ["http URL", "at http://a.example old", "at http://a.example new"],
      ["www URL", "www.old.example", "www.new.example"],
      ["mailto", "mailto:a old", "mailto:a new"],
      ["email", "ops@old.example", "ops@new.example"],
      ["named reference", "a &amp; old", "a &amp; new"],
      ["decimal reference", "&#65; old", "&#65; new"],
      ["hex reference", "&#x41; old", "&#x41; new"],
      ["code span", "`old`", "`new`"],
      ["code span, one side", "old", "`new`"],
      ["HTML tag", "<b>old</b>", "<b>new</b>"],
      ["closing tag", "old</b>", "new</b>"],
      ["HTML comment", "old <!-- c -->", "new <!-- c -->"],
      ["emphasis added", "one", "**one**"],
      ["emphasis removed", "_one_", "one"],
      ["emphasis moved", "**a** b", "a **b**"],
      ["strike added", "old", "~~old~~"],
      ["escape changed", "a \\| b", "a b"],
      ["spaces inside emphasis", "Wait *2* min", "Wait * 2 * min"],
      ["spaces inside strike", "~~deprecated~~ flag", "~~ deprecated ~~ flag"],
      ["space before emphasis removed", "foo _bar_", "foo_bar_"],
      ["word beside emphasis", "**Note** old", "**Note**: old"],
    ] as const;
    // The constructs that would get word marks: none.
    expect(cases.filter(([, base, head]) => !whole(base, head)).map(([name]) => name)).toEqual([]);
  });
  it("keeps word marks for plain text and unchanged emphasis", () => {
    const cases = [
      ["~1 h downtime", "~1 h outage"],
      ["Postgres 15", "Postgres 16"],
      ["a < b", "a < c"],
      ["**one** old", "**one** new"],
      ["snake_case old", "snake_case new"],
      ["*Wait* 2 min", "*Wait* 3 min"],
    ] as const;
    expect(cases.filter(([base, head]) => whole(base, head))).toEqual([]);
  });
});

describe("tableFragment", () => {
  it("shows changed rows with one row of context either side and gaps for the rest", () => {
    const rows = [
      same("| N | Value |"),
      same("| - | -: |"),
      ...Array.from({ length: 10 }, (_, index) =>
        index === 4 ? block("replace", "| 5 | old |", "| 5 | new |") : same(`| ${index + 1} | v |`),
      ),
    ];
    const table = tableFragment(rows);
    expect(table?.meta).toEqual({
      rows: [3, "ctx", "mod", "ctx", 4],
      columns: 2,
      caption: "Table · 1 row changed",
      marked: [[], [], [], [1], [], []],
      whole: [[], [], [], [], [], []],
    });
    expect(table?.markdown).toBe(
      [
        "| N | Value |",
        "| - | -: |",
        "|  |  |",
        "| 4 | v |",
        `| 5 | ${markWords([
          { op: "delete", text: "old" },
          { op: "insert", text: "new" },
        ])} |`,
        "| 6 | v |",
        "|  |  |",
      ].join("\n"),
    );
  });
  it("pads every row to the widest and copies the delimiter from the head", () => {
    const table = tableFragment([
      block("replace", "| A |", "| A | B |"),
      block("replace", "| :- |", "| :- | -: |"),
      block("insert", undefined, "| 1 | 2 | 3 |"),
    ]);
    expect(table?.markdown.split("\n").slice(1)).toEqual(["| :- | -: | --- |", "| 1 | 2 | 3 |"]);
    expect(table?.meta.columns).toBe(3);
  });
  it("shows an unchanged table plain, every row", () => {
    const table = tableFragment(["| A |", "| - |", "| 1 |", "| 2 |", "| 3 |"].map(same));
    expect(table?.meta).toEqual({
      rows: ["ctx", "ctx", "ctx"],
      columns: 1,
      caption: null,
      marked: [[], [], [], []],
      whole: [[], [], [], []],
    });
  });
  it("shows the first row as context under a changed header or alignment", () => {
    const body = ["| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |"].map(same);
    const header = tableFragment([
      block("replace", "| Old | B |", "| New | B |"),
      same("| - | - |"),
      ...body,
    ]);
    expect(header?.meta.rows).toEqual(["ctx", 2]);
    expect(header?.meta.marked).toEqual([[0], [], []]);
    expect(header?.markdown.split("\n")[2]).toBe("| 1 | 2 |");
    const html = decorateTable(renderFragment(header?.markdown ?? ""), header!.meta) ?? "";
    expect(html).toContain('<tr class="r-ctx"><td class="g"></td>');
    expect(html).toContain("<del>Old</del><ins>New</ins>");
    expect(html).toContain(`${icon("more", "sm")} 2 unchanged rows`);
    const align = tableFragment([
      same("| A | B |"),
      block("replace", "| - | - |", "| - | -: |"),
      ...body,
    ]);
    expect(align?.meta.rows).toEqual(["ctx", 2]);
  });
  it("diffs a cell whole when its formatting or a link changed, so the change shows", () => {
    // Word marks around the `**` alone would be swallowed by the parser and show the old bold.
    expect(changed("**one**", "one")).toContain(
      '<span class="dc"><strong><del>one</del></strong><ins>one</ins></span>',
    );
    expect(changed("one", "**one**")).toContain(
      '<span class="dc"><del>one</del><strong><ins>one</ins></strong></span>',
    );
    expect(changed("`one`", "one")).toContain(
      '<span class="dc"><code><del>one</del></code><ins>one</ins></span>',
    );
    expect(changed("*one* two", "one two")).toContain("<em><del>one</del></em><del> two</del>");
    // A changed destination alone would land in the href, with nothing marked.
    expect(changed("[a](https://a.example/x)", "[a](https://a.example/y)")).toMatch(
      /<a href="https:\/\/a\.example\/x"[^>]*><del>a<\/del><\/a><a href="https:\/\/a\.example\/y"[^>]*><ins>a<\/ins><\/a>/,
    );
    // Words still diff where the change isn't syntax.
    expect(changed("**one** old", "**one** new")).toContain(
      "<strong>one</strong> <del>old</del><ins>new</ins>",
    );
  });
  it("diffs a cell whole when it holds a character reference, so the reference stays whole", () => {
    expect(changed("a &amp; b", "a &lt; b")).toContain(
      '<span class="dc"><del>a &#x26; b</del><ins>a &#x3C; b</ins></span>',
    );
    expect(changed("&#65;", "&#66;")).toContain('<span class="dc"><del>A</del><ins>B</ins></span>');
    expect(changed("&#x41; x", "&#x41; y")).toContain("<del>A x</del><ins>A y</ins>");
  });
  it("shows the source when syntax pairs across the old and new halves of a cell", () => {
    // An unmatched delimiter in the old cell would close on the new one: the old literal would
    // show as code or bold, and the new formatting as literal text.
    for (const [base, head] of [
      ["`one", "`one`"],
      ["**one", "**one**"],
      ["*one", "*one*"],
      ["[one", "one](https://e.example/)"],
    ] as const) {
      const table = tableFragment([
        same("| A |"),
        same("| - |"),
        block("replace", `| ${base} |`, `| ${head} |`),
      ]);
      expect(table?.meta.whole).toEqual([[], [0]]);
      expect(decorateTable(renderFragment(table?.markdown ?? ""), table!.meta)).toBeNull();
    }
    // A `_` against a mark can't open or close emphasis, nor a `*` or `~` run against
    // punctuation: no table, so the source shows.
    for (const [base, head] of [
      ["_one_", "one"],
      ["a", "**Required.**"],
      ["one", "**`--check`**"],
      ["`a`", "*`b`*"],
      ["a", "~~`x`~~"],
      ["**[l](u)**", "x"],
    ] as const)
      expect(
        tableFragment([
          same("| A |"),
          same("| - |"),
          block("replace", `| ${base} |`, `| ${head} |`),
        ]),
      ).toBeNull();
    // Emphasis against letters or digits still renders.
    expect(changed("~1 h", "25 min")).toContain(
      '<span class="dc"><del>~1 h</del><ins>25 min</ins>',
    );
    expect(changed("one", "**bold**")).toContain("<del>one</del><strong><ins>bold</ins></strong>");
    // Self-contained halves still render, with the split removed.
    const html = changed("`one`", "**one**");
    expect(html).toContain(
      '<span class="dc"><code><del>one</del></code><strong><ins>one</ins></strong></span>',
    );
    expect(html).not.toMatch(/[\uE000-\uE004]/);
  });
  it("diffs a cell with a code span whole, keeping its edge spaces", () => {
    // The head's code is "b": its content's edge spaces are stripped, which a mark at the edge
    // would stop.
    expect(changed("` a`", "` b `")).toContain(
      '<span class="dc"><code><del> a</del></code><code><ins>b</ins></code>',
    );
    expect(changed("`a`", "` a `")).toContain(
      '<span class="dc"><code><del>a</del></code><code><ins>a</ins></code>',
    );
    expect(changed("`old`", "`new`")).toContain(
      '<span class="dc"><code><del>old</del></code><code><ins>new</ins></code></span>',
    );
    expect(changed("`a b`", "`a c`")).toContain(
      '<span class="dc"><code><del>a b</del></code><code><ins>a c</ins></code></span>',
    );
  });
  it("marks an image's text in a cell diffed whole", () => {
    expect(changed("![old](a.png) same", "![new](a.png) same")).toContain(
      '<span class="dc"><del>[image: old]</del><del> same</del><ins>[image: new]</ins><ins> same</ins></span>',
    );
  });
  it("diffs a cell with a bare autolink whole, each side linking to its own destination", () => {
    // Word marks don't end an autolink: one starting in the deleted words would run on into the
    // inserted ones and point at a URL in neither revision.
    expect(changed("https://old.example", "www.new.example")).toContain(
      `<span class="dc">${link("https://old.example")}<del>https://old.example</del></a><ins>www.new.example</ins></span>`,
    );
    expect(changed("https://a.example/x", "https://a.example/y")).toContain(
      `<span class="dc">${link("https://a.example/x")}<del>https://a.example/x</del></a>${link("https://a.example/y")}<ins>https://a.example/y</ins></a></span>`,
    );
    // GFM leaves trailing punctuation out of the link, on both sides.
    expect(changed("see https://a.example/x.", "see https://a.example/y.")).toContain(
      `<span class="dc"><del>see </del>${link("https://a.example/x")}<del>https://a.example/x</del></a><del>.</del><ins>see </ins>${link("https://a.example/y")}<ins>https://a.example/y</ins></a><ins>.</ins></span>`,
    );
    expect(changed("HTTP://old.example", "plain")).toContain(
      `<span class="dc">${link("HTTP://old.example")}<del>HTTP://old.example</del></a><ins>plain</ins></span>`,
    );
    expect(changed("ops@old.example", "ops@new.example")).toContain(
      `<span class="dc">${link("mailto:ops@old.example")}<del>ops@old.example</del></a>${link("mailto:ops@new.example")}<ins>ops@new.example</ins></a></span>`,
    );
    expect(changed("ops@old.example", "ops@new.example")).not.toMatch(/<!--|&#x3C;!/);
    // A link that would still run into the other side shows the source.
    for (const [base, head] of [
      ["https://old.example\\", "x"],
      ["`https://old.example", "x`"],
    ] as const) {
      const table = tableFragment([
        same("| A |"),
        same("| - |"),
        block("replace", `| ${base} |`, `| ${head} |`),
      ]);
      expect(decorateTable(renderFragment(table?.markdown ?? ""), table!.meta)).toBeNull();
    }
  });
  it("is null without a header or with two tables", () => {
    expect(tableFragment([same("| a |"), same("| b |")])).toBeNull();
    expect(
      tableFragment(["| A |", "| - |", "| 1 |", "| B |", "| - |", "| 2 |"].map(same)),
    ).toBeNull();
  });
});

const fragment = "| A | B |\n| :- | -: |\n| `x` | *y* |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |";
const meta: TableMeta = {
  rows: ["ctx", 2, "mod", "add"],
  columns: 2,
  caption: "Table · 1 row changed, 1 added",
};

const marks = (marked: readonly (readonly number[])[]) =>
  decorateTable(renderFragment(fragment), { ...meta, marked });

describe("decorateTable", () => {
  it("wraps the table and adds the caption, gutter, row classes and gap rows", () => {
    const html = decorateTable(renderFragment(fragment), meta) ?? "";
    expect(html).toMatch(/^<div class="dtwrap"><table class="dt"><caption class="srcnote">/);
    expect(html).toContain('<caption class="srcnote">Table · 1 row changed, 1 added</caption>');
    expect(html).toContain('<tr><th class="g"><span class="vh">Change</span></th>\n<th');
    expect(html.match(/<tr class="r-[a-z]+">/g)).toEqual([
      '<tr class="r-ctx">',
      '<tr class="r-gap">',
      '<tr class="r-mod">',
      '<tr class="r-add">',
    ]);
    expect(html).toContain('<tr class="r-ctx"><td class="g"></td>');
    expect(html).toContain(
      `<tr class="r-gap"><td class="g"></td><td colspan="2">${icon("more", "sm")} 2 unchanged rows</td></tr>`,
    );
    expect(html).toContain(
      '<tr class="r-mod"><td class="g"><span aria-hidden="true">~</span><span class="vh">changed row</span></td>',
    );
    expect(html).toContain(
      '<tr class="r-add"><td class="g"><span aria-hidden="true">+</span><span class="vh">added row</span></td>',
    );
    expect(html).toMatch(/<\/table><\/div>$/);
  });
  it("puts every content cell's children in span.dc, keeping align", () => {
    const html = decorateTable(renderFragment(fragment), meta) ?? "";
    expect(html).toContain('<th align="left"><span class="dc">A</span></th>');
    expect(html).toContain('<td align="left"><span class="dc"><code>x</code></span></td>');
    expect(html).toContain('<td align="right"><span class="dc"><em>y</em></span></td>');
    const cells = [...html.matchAll(/<(?:th|td)(?: [^>]*)?>(<span class="dc">)?/g)].map(
      ([open, dc]) => ({ gutterOrGap: /class="g"|colspan/.test(open), dc: dc !== undefined }),
    );
    // 2 header and 6 body content cells; 1 header and 4 body gutter cells, and 1 gap cell.
    expect(cells.filter((cell) => !cell.gutterOrGap)).toEqual(
      Array.from({ length: 8 }, () => ({ gutterOrGap: false, dc: true })),
    );
    expect(cells.filter((cell) => cell.gutterOrGap)).toEqual(
      Array.from({ length: 6 }, () => ({ gutterOrGap: true, dc: false })),
    );
  });
  it("renders a plain table without gutter or caption", () => {
    const html = decorateTable(renderFragment("| A |\n| - |\n| 1 |"), {
      rows: ["ctx"],
      columns: 1,
      caption: null,
    });
    expect(html).toBe(
      '<div class="dtwrap"><table class="dt">\n<thead>\n<tr>\n<th><span class="dc">A</span></th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td><span class="dc">1</span></td>\n</tr>\n</tbody>\n</table></div>',
    );
  });
  it("ignores tags inside attribute values", () => {
    const html = decorateTable(
      renderFragment('| A |\n| - |\n| [x](https://e.example/ "<td>x</td>") |'),
      { rows: ["mod"], columns: 1, caption: "Table · 1 row changed" },
    );
    expect(html).toContain('title="<td>x</td>"');
    expect(html?.match(/<span class="dc">/g)).toHaveLength(2);
  });
  it("is null for anything but one table with the expected rows", () => {
    expect(decorateTable(renderFragment("Just text"), meta)).toBeNull();
    expect(
      decorateTable(renderFragment(fragment), { ...meta, rows: ["ctx", 2, "mod"] }),
    ).toBeNull();
    expect(
      decorateTable(renderFragment(fragment), { ...meta, rows: [...meta.rows, "add"] }),
    ).toBeNull();
    expect(decorateTable(renderFragment(`${fragment}\n\nAfter.`), meta)).toBeNull();
    expect(decorateTable(renderFragment(`${fragment}\n\n${fragment}`), meta)).toBeNull();
    // A gap row needs the gutter column.
    expect(decorateTable(renderFragment(fragment), { ...meta, caption: null })).toBeNull();
  });
  it("is null when a cell that should show a word mark renders without one", () => {
    expect(marks([[], [], [], [], [], []])).not.toBeNull();
    // The row "| 1 | 2 |" (header 0, then body rows) has no marks.
    expect(marks([[], [], [], [1], [], []])).toBeNull();
    // Marks swallowed by the parser around `**`: the cell renders bold, unmarked.
    const swallowed = `| A |\n| - |\n| ${markWords([
      { op: "delete", text: "**" },
      { op: "equal", text: "one" },
      { op: "delete", text: "**" },
    ])} |`;
    expect(renderFragment(swallowed)).toContain("<td><strong>one</strong></td>");
    expect(
      decorateTable(renderFragment(swallowed), {
        rows: ["mod"],
        columns: 1,
        caption: "Table · 1 row changed",
        marked: [[], [0]],
      }),
    ).toBeNull();
  });
});
