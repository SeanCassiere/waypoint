import { describe, expect, it } from "vitest";

import {
  hashShareToken,
  isShareToken,
  newShareToken,
  parseShareUrl,
  shareRawUrl,
  shareShellUrl,
} from "../src/index.js";

describe("share tokens and URLs", () => {
  it("mints 32 random bytes and hashes a canonical token", async () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^wps_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isShareToken(a)).toBe(true);
    expect(await hashShareToken(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(hashShareToken("wps_invalid")).rejects.toThrow("Invalid share token");
  });
  it("round trips encoded and reserved paths", () => {
    const token = newShareToken();
    const base = "https://waypoint.pingstash.com";
    const collection = "0123456789ab";
    const revision = "bcdefghjkmnp";
    const path = `raw/${revision}/a b#c?.md`;
    const latest = shareShellUrl(base, token, collection, undefined, path);
    expect(latest).toContain("/raw/");
    expect(parseShareUrl(latest)).toEqual({
      kind: "shell",
      token,
      collectionPublicId: collection,
      path,
    });
    expect(parseShareUrl(shareShellUrl(base, token, collection, revision, path))).toEqual({
      kind: "shell",
      token,
      collectionPublicId: collection,
      revisionPublicId: revision,
      path,
    });
    expect(parseShareUrl(shareRawUrl(base, token, revision, path))).toEqual({
      kind: "raw",
      token,
      revisionPublicId: revision,
      path,
    });
    expect(() => parseShareUrl(`/s/${token}/c/${collection}/%2e%2e/x`)).toThrow("Invalid path");
    expect(() => shareShellUrl(base, token, collection, undefined, `r/${revision}/x`)).toThrow(
      "Invalid path",
    );
  });
});
