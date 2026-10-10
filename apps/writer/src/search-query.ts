// Search tokens for the viewer's search field (spec §4.3, B6): project: tag: host: is:shared
// is:unsynced is:pending in:trash. Everything else is free text. Values may be quoted.
export interface ParsedSearch {
  text: string;
  project?: string;
  tags: string[];
  host?: string;
  shared: boolean;
  unsynced: boolean;
  pending: boolean;
  trash: boolean;
  /** True when at least one token was recognized. */
  tokens: boolean;
}

export function parseSearch(input: string): ParsedSearch {
  const result: ParsedSearch = {
    text: "",
    tags: [],
    shared: false,
    unsynced: false,
    pending: false,
    trash: false,
    tokens: false,
  };
  const words: string[] = [];
  for (const match of input.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const key = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key && value) {
      const lower = value.toLowerCase();
      if (key === "project") result.project = value;
      else if (key === "tag") result.tags.push(value);
      else if (key === "host") result.host = value;
      else if (key === "is" && lower === "shared") result.shared = true;
      else if (key === "is" && lower === "unsynced") result.unsynced = true;
      else if (key === "is" && lower === "pending") result.pending = true;
      else if (key === "in" && lower === "trash") result.trash = true;
      else {
        words.push(match[0]);
        continue;
      }
      result.tokens = true;
      continue;
    }
    words.push(match[4] ?? match[5] ?? match[0]);
  }
  result.text = words.join(" ").trim();
  return result;
}
