import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CSV_LIMITS,
  CSV_RENDERER_NAME,
  CSV_RENDERER_VERSION,
  csvRenderer,
  renderCsv,
} from "../src/index.ts";
import { FRAME_REPORTER } from "../src/render.ts";
import { VIEW_SCRIPT } from "../src/view.ts";
import { CSV_GOLDEN_HASH, csvGoldenInputs, resultsCsv } from "./golden-text.ts";

function render(source: string, mime = "text/csv"): Promise<string | null> {
  return renderCsv(source, { mime, byteLength: Buffer.byteLength(source, "utf8") });
}
async function rendered(source: string, mime = "text/csv"): Promise<string> {
  const html = await render(source, mime);
  if (html === null) throw new Error("No rendition");
  return html;
}
/** Each body row's cells (after the row number), as their inner HTML. */
function rows(html: string): string[][] {
  const body = html.slice(html.indexOf("<tbody>") + 7, html.indexOf("</tbody>"));
  return body
    .split("<tr>")
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<td dir="auto"(?: class="num")?>(.*?)<\/td>/gsu)].map(
        (match) => match[1] ?? "",
      ),
    );
}

async function goldenHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const [source, mime] of csvGoldenInputs())
    // oxlint-disable-next-line eslint/no-await-in-loop -- One input at a time, in order, like render.test.ts.
    hash.update((await render(source, mime)) ?? "null");
  return hash.digest("hex");
}

describe("csv rendition", () => {
  it("has its own name, version and limits", () => {
    expect(CSV_RENDERER_NAME).toBe("csv");
    expect(CSV_RENDERER_VERSION).toBe(1);
    expect(CSV_LIMITS).toEqual({ maxBytes: 2_097_152, rows: 500, cellChars: 65_536 });
  });

  it("keeps the golden CSV output stable", async () => {
    // Policy: any change to this hash needs a CSV_RENDERER_VERSION bump (see csv.ts).
    expect(
      await goldenHash(),
      "csv renderer output changed: bump CSV_RENDERER_VERSION and update CSV_GOLDEN_HASH",
    ).toBe(CSV_GOLDEN_HASH);
  });

  it("shows the first 500 rows of a results file with numeric columns aligned", async () => {
    const html = await rendered(resultsCsv());
    expect(html).toContain('<body class="cv">');
    expect(html).toContain(
      '<header class="fh"><b class="fn" dir="auto"></b><span class="k">Table</span><span class="m">1,284 rows × 6 columns · first 500 shown</span></header>',
    );
    expect(html).toContain("<title>Table</title>");
    expect(html.match(/<tbody>.*<\/tbody>/su)?.[0].match(/<tr>/gu)).toHaveLength(500);
    expect(html).toContain('<td class="rn">1</td>');
    expect(html).toContain('<td class="rn">500</td>');
    expect(html).not.toContain('<td class="rn">501</td>');
    expect(html).toContain(
      '<p class="more">784 more rows aren\'t shown. Download the file to see them all.</p>',
    );
    expect(html).toContain(
      '<thead><tr><th class="rn" scope="col">#</th><th scope="col" dir="auto">query_id</th><th scope="col" dir="auto">query</th><th scope="col" dir="auto" class="num">ndcg@10</th><th scope="col" dir="auto" class="num">mrr</th><th scope="col" dir="auto" class="num">recall@50</th><th scope="col" dir="auto" class="num">latency_ms</th></tr></thead>',
    );
    expect(html).toContain(
      '<tr><td class="rn">1</td><td dir="auto">q-0001</td><td dir="auto">refund policy for annual plan</td><td dir="auto" class="num">0.637</td>',
    );
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html).toContain(`<script>${VIEW_SCRIPT}${FRAME_REPORTER}</script>`);
  });

  it("keeps quoted commas, quotes and newlines in one cell", async () => {
    const html = await rendered('name,note\n"Smith, J.","said ""hi""\nthen left"\nLee,ok\n');
    expect(html).toContain('<span class="m">2 rows × 2 columns</span>');
    expect(rows(html)).toEqual([
      ["Smith, J.", "said &quot;hi&quot;\nthen left"],
      ["Lee", "ok"],
    ]);
    // Text after a closing quote is kept; a quote inside an unquoted field is literal.
    expect(rows(await rendered('a,b\n"x"y,z"q\r\n'))).toEqual([["xy", "z&quot;q"]]);
    // CRLF records, a blank line skipped, a trailing delimiter adds an empty field.
    expect(rows(await rendered("a,b\r\n1,2\r\n\r\n3,\n"))).toEqual([
      ["1", "2"],
      ["3", ""],
    ]);
  });

  it("pads ragged rows to the widest record", async () => {
    const html = await rendered("a,b,c\n1\n2,3\n4,5,6,7\n");
    expect(html).toContain('<span class="m">3 rows × 4 columns</span>');
    expect(rows(html).map((row) => row.length)).toEqual([4, 4, 4]);
    expect(html.match(/<th scope="col"/gu)).toHaveLength(4);
  });

  it("uses singular forms", async () => {
    expect(await rendered(resultsCsv(501))).toContain(
      '<p class="more">1 more row isn\'t shown. Download the file to see them all.</p>',
    );
    expect(await rendered(resultsCsv(501))).toContain(
      '<span class="m">501 rows × 6 columns · first 500 shown</span>',
    );
    expect(await rendered("a\n1\n")).toContain('<span class="m">1 row × 1 column</span>');
    expect(await rendered(resultsCsv(500))).not.toContain('class="more"');
    const header = await rendered("only,a,header\n");
    expect(header).toContain('<span class="m">0 rows × 3 columns</span>');
    expect(header).toContain("<tbody></tbody>");
  });

  it("marks only columns whose shown cells are all numbers", async () => {
    const html = await rendered(
      'n,pct,sci,mixed,empty,dash\n1,050%,1e5,1,,-\n"1,234.5",+2.5%,-3.2E-4,x,,-\n,,.5,2,,\n',
    );
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    expect(
      [...head.matchAll(/<th scope="col" dir="auto"( class="num")?>/gu)].map((m) => !!m[1]),
    ).toEqual([true, true, true, false, false, false]);
  });

  it("falls back to the text view on an unterminated quote or an empty file", async () => {
    const broken = await rendered('a,b\n"unterminated,1\n');
    expect(broken).toContain('<body class="tv">');
    expect(broken).toContain('<span class="k">CSV</span>');
    expect(broken).toContain('<span class="m">2 lines · 20 B</span>');
    expect(broken).toContain('<pre class="lines"><code class="gw1">');
    const tsv = await rendered('a\tb\n"unterminated\t1\n', "text/tab-separated-values");
    expect(tsv).toContain('<span class="k">TSV</span>');
    const empty = await rendered("");
    expect(empty).toContain('<body class="tv">');
    expect(empty).toContain('<span class="m">0 lines · 0 B</span>');
  });

  it("reads TSV with tabs, not commas", async () => {
    const html = await rendered(
      "region\trequests\nwest, coast\t12\neast\t34\n",
      "text/tab-separated-values",
    );
    expect(html).toContain('<span class="k">Table</span>');
    expect(html).toContain('<span class="m">2 rows × 2 columns</span>');
    expect(rows(html)[0]).toEqual(["west, coast", "12"]);
    // A comma-separated file under the TSV type is one column (no sniffing).
    expect(await rendered("a,b\n1,2\n", "text/tab-separated-values")).toContain("1 row × 1 column");
  });

  it("escapes every cell and marks controls", async () => {
    const html = await rendered("name,value\n\u202Eevil,</td><script>alert(1)</script>\n");
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<span class="cc">⟪U+202E⟫</span>');
    expect(html).not.toContain("\u202E");
  });

  it("cuts long cells and returns null over the bounds", async () => {
    const html = await rendered(`long\n${"y".repeat(70_000)}\n`);
    const cell = rows(html)[0]?.[0] ?? "";
    expect(cell).toHaveLength(65_537);
    expect(cell.endsWith("y…")).toBe(true);
    expect(await render(`big\n${"z".repeat(2_097_148)}\n`)).toBeNull();
    expect(await renderCsv("a\n1\n", { mime: "text/csv", byteLength: 2_097_153 })).toBeNull();
  });

  it("shows a table too large to build as the text view", async () => {
    // 6,000 columns padded over 500 rows would be about 60 MB of empty cells from 7 KB.
    const source = `${",".repeat(5999)}\n${"x\n".repeat(500)}`;
    const html = await rendered(source);
    expect(html).toContain('<body class="tv">');
    expect(html).toContain('<span class="k">CSV</span>');
    expect(html).toContain('<span class="m">501 lines · 6.8 KB</span>');
    expect(html.length).toBeLessThan(200_000);
    // A wide table that fits is still a table.
    expect(await rendered(`${",".repeat(199)}\n${"x\n".repeat(500)}`)).toContain(
      '<span class="m">500 rows × 200 columns</span>',
    );
  });

  it("renders only CSV and TSV", async () => {
    const mimes = ["text/plain", "text/markdown", "application/json", "text/html"];
    const outputs = await Promise.all(mimes.map((mime) => render("a,b\n1,2\n", mime)));
    expect(outputs).toEqual(mimes.map(() => null));
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    expect(await csvRenderer.render(bytes, "text/plain")).toBeNull();
    const result = await csvRenderer.render(bytes, "text/csv");
    expect(result?.mime).toBe("text/html");
    expect(new TextDecoder().decode(result?.bytes)).toBe(await render("a,b\n1,2\n"));
  });
});
