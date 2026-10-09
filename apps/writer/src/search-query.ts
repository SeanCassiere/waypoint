// Search tokens for the viewer's search field (spec §4.3, B6; canonical words NAV-09a):
// project: tag: host: is:public is:failed is:uploading is:unsynced in:trash. The old spellings
// is:shared and is:pending still parse as aliases but are never displayed. Everything else is
// free text. Values may be quoted.
export type SearchTokenKey = "project" | "tag" | "host" | "is" | "in";

export interface SearchToken {
  key: SearchTokenKey;
  /** Canonical value: "public", "failed", "uploading", "unsynced", "trash", or the
   *  project/tag/host value as typed. */
  value: string;
  /** Canonical token text, e.g. "is:public" or 'project:"api team"'. */
  text: string;
  /** The exact substring typed, e.g. "IS:Shared". */
  raw: string;
  /** Start offset of `raw` in the parsed input; withoutToken splices [at, at + raw.length). */
  at: number;
}

export interface ParsedSearch {
  text: string;
  project?: string;
  tags: string[];
  host?: string;
  public: boolean;
  failed: boolean;
  uploading: boolean;
  unsynced: boolean;
  trash: boolean;
  /** True when at least one token was recognized. */
  tokens: boolean;
  /** Recognized tokens in input order, once per occurrence. */
  list: SearchToken[];
}

type CanonicalText = "is:public" | "is:failed" | "is:uploading" | "is:unsynced" | "in:trash";

/** Display order for hints, chips and the Find token row. */
export const CANONICAL_TOKENS: readonly { text: CanonicalText; label: string }[] = [
  { text: "is:public", label: "Public" },
  { text: "is:failed", label: "Failed" },
  { text: "is:uploading", label: "Uploading" },
  { text: "is:unsynced", label: "Not synced yet" },
  { text: "in:trash", label: "In Trash" },
];

const ALIASES: Readonly<Record<string, CanonicalText>> = {
  "is:shared": "is:public",
  "is:pending": "is:uploading",
};

/** Old spellings that still parse; they're never shown. */
export const TOKEN_ALIASES: Readonly<Record<string, string>> = ALIASES;

const FLAG_TOKENS = new Map<string, CanonicalText>([
  ...CANONICAL_TOKENS.map(({ text }): [string, CanonicalText] => [text, text]),
  ...Object.entries(ALIASES),
]);

/** `key:value`, quoting the value when it contains whitespace. */
function tokenText(key: string, value: string): string {
  return `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
}

export function parseSearch(input: string): ParsedSearch {
  const result: ParsedSearch = {
    text: "",
    tags: [],
    public: false,
    failed: false,
    uploading: false,
    unsynced: false,
    trash: false,
    tokens: false,
    list: [],
  };
  const words: string[] = [];
  for (const match of input.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const key = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key && value) {
      let token: Omit<SearchToken, "raw" | "at"> | undefined;
      if (key === "project" || key === "tag" || key === "host") {
        if (key === "project") result.project = value;
        else if (key === "tag") result.tags.push(value);
        else result.host = value;
        token = { key, value, text: tokenText(key, value) };
      } else if (key === "is" || key === "in") {
        const text = FLAG_TOKENS.get(`${key}:${value.toLowerCase()}`);
        if (text === "is:public") result.public = true;
        else if (text === "is:failed") result.failed = true;
        else if (text === "is:uploading") result.uploading = true;
        else if (text === "is:unsynced") result.unsynced = true;
        else if (text === "in:trash") result.trash = true;
        if (text) token = { key, value: text.slice(key.length + 1), text };
      }
      if (token) {
        result.list.push({ ...token, raw: match[0], at: match.index });
        result.tokens = true;
        continue;
      }
      words.push(match[0]);
      continue;
    }
    words.push(match[4] ?? match[5] ?? match[0]);
  }
  result.text = words.join(" ").trim();
  return result;
}

/** `input` without the occurrence `token` was parsed from, its surrounding whitespace collapsed
 *  to one space. Unchanged when `token` came from another input. */
export function withoutToken(input: string, token: SearchToken): string {
  const end = token.at + token.raw.length;
  if (input.slice(token.at, end) !== token.raw) return input;
  return [input.slice(0, token.at).trimEnd(), input.slice(end).trimStart()]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** `input` with every alias (is:shared, is:pending, in any case) replaced by its canonical text;
 *  free text and other tokens untouched. */
export function canonicalQuery(input: string): string {
  let out = input;
  for (const token of parseSearch(input).list.toReversed()) {
    if (token.key !== "is" && token.key !== "in") continue;
    // An alias is an is:/in: token whose typed value isn't its canonical value.
    const typed = unquote(token.raw.slice(token.key.length + 1)).toLowerCase();
    if (typed === token.value) continue;
    out = out.slice(0, token.at) + token.text + out.slice(token.at + token.raw.length);
  }
  return out;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).trim() : value;
}
