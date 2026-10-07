import { describe, expect, it } from "vitest";

import {
  deriveShareToken,
  hashShareToken,
  isShareToken,
  newShareToken,
  parseShareTokenKey,
  parseShareUrl,
  shareRawUrl,
  shareShellUrl,
} from "../src/index.js";

describe("deterministic share tokens", () => {
  // Bytes 0..31; the token below was computed with Python's hmac module.
  const keyText = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const linkId = "shl_01JZ8X3Q4K5M6N7P8R9S0T1V2W";
  it("parses a 32-byte base64url key, tolerating one padding character", () => {
    const key = parseShareTokenKey(keyText);
    expect(Array.from(key)).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(Array.from(parseShareTokenKey(`${keyText}=`))).toEqual(Array.from(key));
  });
  it("rejects keys of the wrong length or alphabet without echoing them", () => {
    const secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    expect(() => parseShareTokenKey("")).toThrow("32 bytes");
    for (const bad of [
      secret.slice(0, -1),
      `${secret}A`,
      `${secret}==`,
      `${secret.slice(0, -2)}+/`,
      `${secret.slice(0, -1)}.`,
      `${secret.slice(0, -1)}9`, // Non-canonical: the last character carries stray bits.
      ` ${secret}`,
      Buffer.alloc(16).toString("base64url"),
      Buffer.alloc(48).toString("base64url"),
    ]) {
      let message = "";
      try {
        parseShareTokenKey(bad);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("32 bytes");
      expect(message).not.toContain(bad.trim());
    }
  });
  it("derives a known-answer token that isShareToken accepts", async () => {
    const key = parseShareTokenKey(keyText);
    const token = await deriveShareToken(key, linkId);
    expect(token).toBe("wps_beKn1hOVbkpX2Y891_hOFffGpg3zHuN1YROOLENhke4");
    expect(isShareToken(token)).toBe(true);
    expect(await hashShareToken(token)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("is deterministic per key and link ID", async () => {
    const key = parseShareTokenKey(keyText);
    const other = crypto.getRandomValues(new Uint8Array(32));
    const token = await deriveShareToken(key, linkId);
    expect(await deriveShareToken(new Uint8Array(key), linkId)).toBe(token);
    expect(await deriveShareToken(key, `${linkId.slice(0, -1)}X`)).not.toBe(token);
    expect(await deriveShareToken(other, linkId)).not.toBe(token);
    const many = await Promise.all(
      Array.from({ length: 200 }, (_, index) => deriveShareToken(other, `shl_${index}`)),
    );
    expect(many.every(isShareToken)).toBe(true);
    expect(new Set(many).size).toBe(200);
    await expect(deriveShareToken(new Uint8Array(16), linkId)).rejects.toThrow("32 bytes");
    await expect(deriveShareToken(key, "")).rejects.toThrow("required");
  });
  it("builds path-less link URLs the reader parses as the head file", async () => {
    const token = await deriveShareToken(parseShareTokenKey(keyText), linkId);
    const base = "https://waypoint.pingstash.com";
    const latest = shareShellUrl(base, token, "0123456789ab");
    expect(latest).toBe(`${base}/s/${token}/c/0123456789ab/`);
    expect(parseShareUrl(latest)).toEqual({
      kind: "shell",
      token,
      collectionPublicId: "0123456789ab",
    });
    const pinned = shareShellUrl(base, token, "0123456789ab", "bcdefghjkmnp");
    expect(pinned).toBe(`${base}/s/${token}/c/0123456789ab/r/bcdefghjkmnp/`);
    expect(parseShareUrl(pinned)).toEqual({
      kind: "shell",
      token,
      collectionPublicId: "0123456789ab",
      revisionPublicId: "bcdefghjkmnp",
    });
  });
});

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
