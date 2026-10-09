import { describe, expect, it } from "vitest";

import {
  CANONICAL_TOKENS,
  TOKEN_ALIASES,
  canonicalQuery,
  parseSearch,
  withoutToken,
} from "../src/search-query.ts";

describe("parseSearch (NAV-09a)", () => {
  it("parses every canonical token in input order", () => {
    const parsed = parseSearch(
      'rate project:"api team" tag:plan host:devbox is:public is:failed is:uploading is:unsynced in:trash',
    );
    expect(parsed).toMatchObject({
      text: "rate",
      project: "api team",
      tags: ["plan"],
      host: "devbox",
      public: true,
      failed: true,
      uploading: true,
      unsynced: true,
      trash: true,
      tokens: true,
    });
    expect(parsed.list.map((token) => token.text)).toEqual([
      'project:"api team"',
      "tag:plan",
      "host:devbox",
      "is:public",
      "is:failed",
      "is:uploading",
      "is:unsynced",
      "in:trash",
    ]);
    expect(parsed.list[0]).toEqual({
      key: "project",
      value: "api team",
      text: 'project:"api team"',
      raw: 'project:"api team"',
      at: 5,
    });
  });

  it("reads aliases as their canonical token and keeps what was typed", () => {
    const shared = parseSearch("is:shared");
    expect(shared.public).toBe(true);
    expect(shared.list[0]?.text).toBe("is:public");
    expect(shared.list[0]?.raw).toBe("is:shared");
    expect(shared.list[0]?.value).toBe("public");
    const pending = parseSearch("IS:Pending");
    expect(pending.uploading).toBe(true);
    expect(pending.list[0]?.text).toBe("is:uploading");
    expect(pending.list[0]?.raw).toBe("IS:Pending");
    expect(parseSearch("IN:Trash").list[0]?.text).toBe("in:trash");
  });

  it("leaves anything else as free text", () => {
    expect(parseSearch("plain words color:red")).toMatchObject({
      text: "plain words color:red",
      tokens: false,
      list: [],
    });
    expect(parseSearch("is:nothing")).toMatchObject({ text: "is:nothing", list: [] });
  });

  it("gives each occurrence an offset that slices back to what was typed", () => {
    const input = 'x  IS:Shared tag:a project:"b c"';
    for (const token of parseSearch(input).list)
      expect(input.slice(token.at, token.at + token.raw.length)).toBe(token.raw);
  });
});

describe("withoutToken", () => {
  it("removes one token and collapses the whitespace around it", () => {
    const input = "webhooks is:shared  tag:x";
    expect(withoutToken(input, parseSearch(input).list[0]!)).toBe("webhooks tag:x");
  });

  it("removes a quoted value with its quotes", () => {
    const input = 'rate project:"api team" tag:plan';
    expect(withoutToken(input, parseSearch(input).list[0]!)).toBe("rate tag:plan");
  });

  it("removes the exact occurrence of a repeated token", () => {
    const q = "is:shared x is:shared";
    const list = parseSearch(q).list;
    expect(list.map((token) => token.at)).toEqual([0, 12]);
    expect(withoutToken(q, list[1]!)).toBe("is:shared x");
    expect(withoutToken(q, list[0]!)).toBe("x is:shared");
    expect(withoutToken("other", list[0]!)).toBe("other");
  });
});

describe("canonicalQuery", () => {
  it("replaces aliases and leaves free text alone", () => {
    expect(canonicalQuery("x is:shared is:pending")).toBe("x is:public is:uploading");
    expect(canonicalQuery('IS:Shared  color:red project:"a b"')).toBe(
      'is:public  color:red project:"a b"',
    );
    expect(canonicalQuery("plain is:public")).toBe("plain is:public");
  });
});

describe("CANONICAL_TOKENS", () => {
  it("lists the canonical words in display order, each recognized and none an alias", () => {
    expect(CANONICAL_TOKENS.map((token) => token.text)).toEqual([
      "is:public",
      "is:failed",
      "is:uploading",
      "is:unsynced",
      "in:trash",
    ]);
    expect(CANONICAL_TOKENS.map((token) => token.label)).toEqual([
      "Public",
      "Failed",
      "Uploading",
      "Not synced yet",
      "In Trash",
    ]);
    for (const { text } of CANONICAL_TOKENS) {
      const parsed = parseSearch(text);
      expect(parsed.tokens).toBe(true);
      expect(parsed.list[0]?.text).toBe(text);
    }
    const texts = new Set<string>(CANONICAL_TOKENS.map((token) => token.text));
    for (const [alias, canonical] of Object.entries(TOKEN_ALIASES)) {
      expect(texts.has(alias)).toBe(false);
      expect(texts.has(canonical)).toBe(true);
    }
  });
});
