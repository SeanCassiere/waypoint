import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VIEWER_CSS_PARTIALS } from "../src/viewer/css.ts";

// A ratchet on the writer's literal font sizes, radii and hex colours (VS-01b): the counts may only
// go down. Migrating the existing literals was cut; this stops new drift. When a change removes
// literals, it lowers the matching ceiling in the same commit.
export const FONT_SIZE_CEILING = 246;
export const RADIUS_CEILING = 98;
export const HEX_CEILING = 3;

const RATCHET_MESSAGE =
  "Use a token, or lower nothing: this ratchet only goes down. If you removed literals, lower the ceiling in the same commit.";

interface Declaration {
  partial: string;
  /** The nearest enclosing rule's selector, whitespace collapsed ("" at the top level). */
  selector: string;
  /** Every enclosing rule's selector, outermost first, joined by a space (CSS nesting). */
  ancestry: string;
  /** Every enclosing at-rule's prelude, outermost first. */
  atRules: string[];
  property: string;
  value: string;
}

/** Every declaration in a stylesheet, by brace depth: no dependency, enough for our partials. */
function declarations(partial: string, css: string): Declaration[] {
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const selectors = stack.filter((prelude) => !prelude.startsWith("@"));
    out.push({
      partial,
      selector: selectors.at(-1) ?? "",
      ancestry: selectors.join(" "),
      atRules: stack.filter((prelude) => prelude.startsWith("@")),
      property: text.slice(0, colon).trim().toLowerCase(),
      value: text.slice(colon + 1).trim(),
    });
  };
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, i + 1);
      const stop = end === -1 ? source.length : end;
      buffer += source.slice(i, stop + 1);
      i = stop;
    } else if (char === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === ";") flush();
    else if (char === "}") {
      flush();
      stack.pop();
    } else buffer += char;
  }
  return out;
}

const LENGTH = /\b\d*\.?\d+(px|em|rem)\b/;
/** A number with any CSS length unit or a percentage, not part of a name like `--r-2xl`. */
const LENGTH_OR_PERCENT = /(?<![\w.-])(\d*\.?\d+)(?:[a-z]+|%)/gi;
const RADIUS_PROPERTY = /^border(-[a-z]+-[a-z]+)?-radius$/;
const HEX = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const STATE =
  /\.(dead|del|gone|inactive|removed)\b|\[disabled\]|:disabled\b|\[aria-disabled|\[aria-current/;

function counts(list: readonly Declaration[]): { fontSize: number; radius: number; hex: number } {
  let fontSize = 0;
  let radius = 0;
  let hex = 0;
  for (const { property, value } of list) {
    if ((property === "font-size" || property === "font") && LENGTH.test(value)) fontSize++;
    if (
      RADIUS_PROPERTY.test(property) &&
      [...value.matchAll(LENGTH_OR_PERCENT)].some(([, n]) => Number(n) !== 0)
    )
      radius++;
    hex += value.match(HEX)?.length ?? 0;
  }
  return { fontSize, radius, hex };
}

/** "partial: selector { opacity: n }" for each state selector dimmed with opacity below 1. */
function dimmedStates(list: readonly Declaration[]): string[] {
  return list
    .filter(
      (d) =>
        d.partial !== "95-motion.css" &&
        !d.atRules.some((at) => /^@(-\w+-)?keyframes\b/.test(at)) &&
        STATE.test(d.ancestry) &&
        d.property === "opacity" &&
        Number.parseFloat(d.value) / (d.value.includes("%") ? 100 : 1) < 1,
    )
    .map((d) => `${d.partial}: ${d.ancestry} { opacity: ${d.value} }`);
}

const viewer = VIEWER_CSS_PARTIALS.flatMap((name) =>
  declarations(name, readFileSync(new URL(`../src/viewer/css/${name}`, import.meta.url), "utf8")),
);

const sample = (css: string, partial = "00-sample.css") => declarations(partial, css);
/** The ratchet's failure, if a count went over its ceiling. */
const overCeiling = (count: number, ceiling: number): string[] =>
  count <= ceiling ? [] : [`${count} > ${ceiling}. ${RATCHET_MESSAGE}`];

describe("viewer CSS literal ratchet", () => {
  const measured = counts(viewer);

  it("parses the viewer's declarations", () => {
    expect(viewer.length).toBeGreaterThan(1000);
  });
  it("adds no literal font size", () => {
    expect(overCeiling(measured.fontSize, FONT_SIZE_CEILING)).toEqual([]);
  });
  it("adds no literal border radius", () => {
    expect(overCeiling(measured.radius, RADIUS_CEILING)).toEqual([]);
  });
  it("adds no hex colour", () => {
    expect(overCeiling(measured.hex, HEX_CEILING)).toEqual([]);
  });
  it("never dims a state selector with opacity", () => {
    expect(dimmedStates(viewer)).toEqual([]);
  });
});

describe("the ratchet's own counters", () => {
  it("counts one font size per declaration with a length", () => {
    const list = sample(
      ".a{font-size:13px}.b{font:700 26px/1.15 var(--sans)}.c{font:inherit;font-size:.9em}" +
        ".d{font-size:var(--x)}@media (max-width:760px){.e{font-size:1.2rem;line-height:20px}}",
    );
    expect(counts(list).fontSize).toBe(4);
  });
  it("counts radii with a non-zero length or percentage", () => {
    const list = sample(
      ".a{border-radius:8px}.b{border-radius:0}.c{border-radius:var(--r-md)}.d{border-radius:50%}" +
        ".e{border-top-left-radius:4px 2px}.f{border-radius:0 0 6px 6px}.g{border-start-end-radius:0px}" +
        ".h{border-radius:1ch}.i{border-radius:2vw}.j{border-radius:0 .5lh}.k{border-radius:var(--r-2xl)}" +
        ".l{border-radius:0vw 0cqi}",
    );
    expect(counts(list).radius).toBe(7);
  });
  it("counts every hex colour in values, not in selectors or comments", () => {
    const list = sample(
      "/* #abc */#main{color:#fff;box-shadow:0 0 0 1px #00000014,0 1px #1b1a17}.x{background:var(--a,#abcd)}" +
        ".y{content:'#'}",
    );
    expect(counts(list).hex).toBe(4);
  });
  it("keeps strings and nested blocks apart from declarations", () => {
    const list = sample('.a{content:"{;}";color:red}.b{&:hover{@starting-style{opacity:0}}}');
    expect(list.map((d) => `${d.selector}|${d.atRules.join(",")}|${d.property}`)).toEqual([
      ".a||content",
      ".a||color",
      "&:hover|@starting-style|opacity",
    ]);
  });
  it("flags opacity below 1 on state selectors only", () => {
    expect(
      dimmedStates(
        sample(
          "@keyframes x{from{opacity:0}}.expiry input{opacity:0}.lnk.gone{opacity:.6}" +
            ".row.del{opacity:1}.btn[disabled]{opacity:50%}.b:disabled{color:red}" +
            "@media (hover:hover){a[aria-current]{opacity:0.8}}",
        ),
      ),
    ).toEqual([
      "00-sample.css: .lnk.gone { opacity: .6 }",
      "00-sample.css: .btn[disabled] { opacity: 50% }",
      "00-sample.css: a[aria-current] { opacity: 0.8 }",
    ]);
    expect(
      dimmedStates(
        sample(".dead{&:hover{opacity:.6}}.x{&.gone{opacity:.5}}.y{&:hover{opacity:.5}}"),
      ),
    ).toEqual([
      "00-sample.css: .dead &:hover { opacity: .6 }",
      "00-sample.css: .x &.gone { opacity: .5 }",
    ]);
    expect(dimmedStates(sample(".lnk.dead{opacity:0}", "95-motion.css"))).toEqual([]);
    expect(dimmedStates(sample("@keyframes fade{from{opacity:0}to{opacity:1}}"))).toEqual([]);
  });
});
