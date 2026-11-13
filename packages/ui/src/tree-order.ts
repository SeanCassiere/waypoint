/**
 * Names as a person sorts them: case-insensitive, accents ignored, digit runs compared as numbers
 * (`ch2.md` before `ch10.md`). The locale is fixed so the order doesn't depend on the server's
 * `LANG`; names equal under that rule (`README.md`, `readme.md`) fall back to code-unit order, so
 * the order is total and stable. The writer's Files tree and the public reader's both use it
 * (D72, D75).
 */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Sort keys for `compareNames` on printable ASCII (D75). Each printable ASCII character is one
 * collation element, so at this strength (case and accents ignored) a name compares as the
 * sequence of its characters' ranks, read once from the collator itself (without `numeric`).
 * Digit runs are zero-padded to one width first, so a run compares digit by digit as its number
 * does (leading zeros ignored) and against any other character as a digit (every digit ranks above
 * punctuation and below letters). ICU reads runs longer than 254 digits in pieces, so keys stop
 * at PAD_MAX digits, and other scripts have digits and contractions of their own, so any other
 * name sorts with `compareNames`. packages/ui/tests/tree-order.test.ts checks that they agree.
 */
const PAD_MAX = 32;
let ranks: Uint16Array | undefined;
function rankTable(): Uint16Array {
  if (ranks) return ranks;
  const plain = new Intl.Collator("en", { sensitivity: "base" });
  const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).toSorted(
    plain.compare,
  );
  ranks = new Uint16Array(128);
  let rank = 1;
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && plain.compare(chars[i - 1]!, chars[i]!) !== 0) rank++;
    ranks[chars[i]!.charCodeAt(0)] = rank;
  }
  return ranks;
}
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/** The key of an ASCII name whose digit runs are at most `width` long. */
function keyOf(text: string, width: number, table: Uint16Array, out: number[]): string {
  out.length = 0;
  for (let i = 0; i < text.length;) {
    if (!isDigit(text.charCodeAt(i))) {
      out.push(table[text.charCodeAt(i++)]!);
      continue;
    }
    let end = i + 1;
    while (end < text.length && isDigit(text.charCodeAt(end))) end++;
    for (let pad = end - i; pad < width; pad++) out.push(table[48]!);
    while (i < end) out.push(table[text.charCodeAt(i++)]!);
  }
  return String.fromCharCode(...out);
}

/**
 * `items` in `compareNames` order of `name(item)`: by sort keys when every name is printable ASCII
 * with digit runs of at most PAD_MAX digits (several times faster: the public reader sorts up to
 * 2,000 names inside its Worker CPU budget), else with `compareNames`.
 */
export function sortByName<T>(items: readonly T[], name: (item: T) => string): T[] {
  if (items.length < 2) return [...items];
  const slow = () => items.toSorted((a, b) => compareNames(name(a), name(b)));
  let width = 0;
  for (const item of items) {
    const text = name(item);
    let run = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 || code > 126) return slow();
      run = isDigit(code) ? run + 1 : 0;
      if (run > width) width = run;
    }
  }
  if (width > PAD_MAX) return slow();
  const table = rankTable();
  const out: number[] = [];
  return items
    .map((item) => {
      const text = name(item);
      return { item, text, key: keyOf(text, width, table, out) };
    })
    .toSorted((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0,
    )
    .map((entry) => entry.item);
}
