import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WAYPOINT_VERSION, buildInfo } from "../src/index.ts";

describe("build info", () => {
  it("matches the root package.json version", () => {
    const root: unknown = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(root).toMatchObject({ version: WAYPOINT_VERSION });
    expect(WAYPOINT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
  it("accepts a hex commit and drops anything else", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildInfo(sha)).toEqual({ version: WAYPOINT_VERSION, sha });
    expect(buildInfo(` ${sha.toUpperCase()}\n`).sha).toBe(sha);
    expect(buildInfo("abc1234").sha).toBe("abc1234");
    for (const raw of [
      undefined,
      null,
      "",
      "unknown",
      "abc123",
      `${sha}0`,
      "<script>",
      "g".repeat(40),
    ])
      expect(buildInfo(raw).sha).toBeNull();
  });
});
