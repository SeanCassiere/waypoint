import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { brand } from "../packages/core/src/brand.js";
import {
  buildManifest,
  type CollectionId,
  type ContentHash,
  type RevisionId,
  type WaypointErrorLike,
  contentHashHex,
  deriveShareToken,
  displayNumbers,
  ERROR_STATUS,
  findCaseConflicts,
  findFileDirectoryConflicts,
  hashBytes,
  idTimestamp,
  inferMime,
  isContentHash,
  isMarkdown,
  isShareToken,
  isTextMime,
  isWaypointError,
  latestCollectionUrl,
  type ManifestEntry,
  manifestsEqual,
  mintRevisionId,
  newId,
  normalizeMime,
  normalizePath,
  parseId,
  parseWriterUrl,
  pinnedRevisionUrl,
  publicIdFor,
  rawUrl,
  validateClientId,
  validatePath,
  WaypointError,
} from "../packages/core/src/index.js";

const hash = brand<ContentHash>(`sha256:${"a".repeat(64)}`);
const entry: ManifestEntry = { hash, mime: "text/html", size: 5 };
const files = { "index.html": entry };
const now = Date.UTC(2026, 9, 7);
function capture(fn: () => unknown): WaypointErrorLike {
  try {
    fn();
  } catch (error) {
    // oxlint-disable-next-line vitest/no-conditional-expect -- This helper checks the shape of every caught error.
    expect(isWaypointError(error)).toBe(true);
    if (!isWaypointError(error)) throw error;
    return error;
  }
  throw new Error("Expected WaypointError");
}
function code(fn: () => unknown, expected: string) {
  expect(capture(fn).code).toBe(expected);
}

describe("IDs", () => {
  it("mints and validates UUIDv7 TypeIDs for all prefixes", () => {
    for (const prefix of ["col", "shl", "grt", "aud", "cmt"] as const) {
      const id = newId(prefix);
      expect(id).toHaveLength(30);
      expect(parseId(id, prefix).toString()).toBe(id);
      expect(idTimestamp(id)).toBeGreaterThan(0);
      code(() => parseId(id, prefix === "col" ? "rev" : "col"), "validation_failed");
      code(() => parseId(id.toUpperCase(), prefix), "validation_failed");
    }
  });
  it("mints after a parent even when the local clock is behind", () => {
    const parent = mintRevisionId({ now: now + 100 });
    const child = mintRevisionId({ now, parentId: parent });
    expect(idTimestamp(child)).toBe(now + 101);
    expect(child > parent).toBe(true);
    validateClientId(child, { prefix: "rev", now, parentId: parent });
  });
  it("enforces clock windows and parent ordering", () => {
    code(
      () =>
        validateClientId(mintRevisionId({ now: now + 300_001 }), {
          prefix: "rev",
          now,
        }),
      "clock_skew",
    );
    code(
      () =>
        validateClientId(mintRevisionId({ now: now - 7 * 86_400_000 - 1 }), {
          prefix: "rev",
          now,
        }),
      "stale_id",
    );
    const parent = mintRevisionId({ now });
    const error = capture(() => validateClientId(parent, { prefix: "rev", now, parentId: parent }));
    expect(error.code).toBe("id_before_parent");
    expect(error.details.parent_timestamp).toBe(now);
  });
  it("rejects a UUID of the wrong version", () => {
    const { fromUUID } = requireTypeId();
    code(
      () => parseId(fromUUID("rev", "00000000-0000-4000-8000-000000000000"), "rev"),
      "validation_failed",
    );
  });
});
function requireTypeId() {
  return {
    fromUUID: (prefix: string, uuid: string) => `${prefix}_${encodeUuid(uuid)}`,
  };
}
function encodeUuid(uuid: string): string {
  const hex = uuid.replaceAll("-", "");
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let n = BigInt(`0x${hex}`);
  let result = "";
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(n & 31n)] + result;
    n >>= 5n;
  }
  return result;
}

describe("hashes and public IDs", () => {
  it("derives public IDs with an independent bit grouping reference", async () => {
    for (const id of ["col_01j9qz7x2bm4d8vk3np6rt9hcs", "rev_01j9qz8k7cfyva3xr6m2hg5e4n"]) {
      const digest = createHash("sha256").update(id, "utf8").digest();
      const bits = [...digest].map((byte) => byte.toString(2).padStart(8, "0")).join("");
      const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
      const expected = Array.from(
        { length: 12 },
        (_, i) => alphabet[Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)],
      ).join("");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each vector is checked against its own digest.
      expect(await publicIdFor(brand<CollectionId | RevisionId>(id))).toBe(expected);
    }
  });
  it("locks the documented public ID golden vector", async () => {
    expect(await publicIdFor(brand<CollectionId>("col_01j9qz7x2bm4d8vk3np6rt9hcs"))).toBe(
      "apwyysc2zcj6",
    );
  });
  it("hashes bytes and validates content hashes", async () => {
    const result = await hashBytes(new TextEncoder().encode("abc"));
    expect(result).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(contentHashHex(result)).toBe(result.slice(7));
    expect(isContentHash(result)).toBe(true);
    expect(isContentHash(result.toUpperCase())).toBe(false);
  });
});

describe("paths and MIME", () => {
  it("normalizes NFC and rejects invalid paths", () => {
    expect(normalizePath("cafe\u0301.md")).toBe("café.md");
    for (const path of [
      "",
      "/a",
      "a//b",
      "a/./b",
      "a/../b",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "a".repeat(513),
    ])
      code(() => validatePath(path), "path_invalid");
    expect(validatePath("dir/café.md")).toBe("dir/café.md");
    expect(findCaseConflicts(["A.md", "a.md", "other.md"])).toEqual([["A.md", "a.md"]]);
  });
  it("infers common types and markdown", () => {
    expect(inferMime("README.MD")).toBe("text/markdown");
    expect(inferMime("a.png")).toBe("image/png");
    expect(inferMime("a.unknown")).toBe("application/octet-stream");
    expect(inferMime("x.constructor")).toBe("application/octet-stream");
    expect(inferMime("x.__proto__")).toBe("application/octet-stream");
    expect(isMarkdown("text/markdown; charset=utf-8")).toBe(true);
    expect(isMarkdown("text/html")).toBe(false);
  });
});

describe("manifests", () => {
  it("merges, removes, replaces, infers, and detects no-ops", () => {
    const parent = buildManifest({ mode: "replace", files });
    expect(parent.headPath).toBe("index.html");
    const same = buildManifest({ mode: "merge", parent, files: {} });
    expect(manifestsEqual(parent, same)).toBe(true);
    const changed = buildManifest({
      mode: "merge",
      parent,
      remove: ["index.html"],
      files: { "index.md": { ...entry, mime: "text/markdown" } },
    });
    expect(changed.headPath).toBe("index.md");
    expect(manifestsEqual(parent, changed)).toBe(false);
    expect(
      Object.keys(
        buildManifest({
          mode: "replace",
          parent,
          files: { "README.md": entry },
        }).files,
      ),
    ).toEqual(["README.md"]);
  });
  it("rejects ambiguous heads, conflicts, malformed entries, and invalid removals", () => {
    code(() => buildManifest({ mode: "replace", files: {} }), "head_path_missing");
    code(
      () =>
        buildManifest({
          mode: "replace",
          files: { "a.md": entry, "b.md": entry },
        }),
      "head_path_ambiguous",
    );
    code(() => buildManifest({ mode: "replace", files, headPath: "other" }), "head_path_missing");
    code(
      () =>
        buildManifest({
          mode: "replace",
          files: { "A.md": entry, "a.md": entry },
        }),
      "path_case_conflict",
    );
    code(
      () => buildManifest({ mode: "replace", files, remove: ["index.html"] }),
      "validation_failed",
    );
    code(
      () =>
        buildManifest({
          mode: "merge",
          parent: { headPath: "index.html", files },
          files,
          remove: ["index.html"],
        }),
      "validation_failed",
    );
    code(
      () =>
        buildManifest({
          mode: "replace",
          files: { "a.md": { ...entry, size: -1 } },
        }),
      "validation_failed",
    );
  });
  it("enforces configurable limits", () => {
    code(
      () => buildManifest({ mode: "replace", files, limits: { maxBlobBytes: 4 } }),
      "blob_too_large",
    );
    code(
      () =>
        buildManifest({
          mode: "replace",
          files,
          limits: { maxRevisionBytes: 4 },
        }),
      "revision_too_large",
    );
    code(
      () => buildManifest({ mode: "replace", files, limits: { maxFiles: 0 } }),
      "revision_too_large",
    );
  });
});

describe("URLs and display numbers", () => {
  const base = "https://writer.example";
  const col = "0123456789ab";
  const rev = "abcdefghjkmn";
  it("builds and parses latest, pinned and raw routes", () => {
    const latest = latestCollectionUrl(base, col, "a b/é.md");
    expect(latest).toBe(`${base}/c/${col}/a%20b/%C3%A9.md`);
    expect(parseWriterUrl(latest)).toEqual({
      kind: "latest",
      collectionPublicId: col,
      path: "a b/é.md",
    });
    const pinned = pinnedRevisionUrl(base, col, rev);
    expect(parseWriterUrl(pinned)).toEqual({
      kind: "pinned",
      collectionPublicId: col,
      revisionPublicId: rev,
    });
    expect(parseWriterUrl(rawUrl(base, rev, "a/b.md"))).toEqual({
      kind: "raw",
      revisionPublicId: rev,
      path: "a/b.md",
    });
    expect(parseWriterUrl(`/c/${col.toUpperCase()}/`)).toEqual({
      kind: "latest",
      collectionPublicId: col,
    });
    code(() => parseWriterUrl(`/raw/r/${rev}/`), "path_invalid");
  });
  it("orders display numbers by ID", () => {
    const first = mintRevisionId({ now });
    const second = mintRevisionId({ now, parentId: first });
    expect(displayNumbers([second, first])).toEqual({ [first]: 1, [second]: 2 });
  });
});

function uuidBytesFromId(id: string): Uint8Array {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let value = 0n;
  for (const char of id.split("_")[1] ?? "") value = value * 32n + BigInt(alphabet.indexOf(char));
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number((value >> BigInt((15 - index) * 8)) & 255n),
  );
}

describe("UUIDv7 boundaries", () => {
  it("sets RFC version and variant bits and preserves 48-bit timestamps", () => {
    for (const timestamp of [2 ** 32 + 123, 2 ** 48 - 1]) {
      const id = mintRevisionId({ now: timestamp });
      const bytes = uuidBytesFromId(id);
      expect((bytes[6] ?? 0) >> 4).toBe(7);
      expect((bytes[8] ?? 0) >> 6).toBe(2);
      expect(idTimestamp(id)).toBe(timestamp);
    }
    code(() => mintRevisionId({ now: 2 ** 48 }), "validation_failed");
    code(() => mintRevisionId({ now: 1.5 }), "validation_failed");
  });
  it("uses now when parent is old, advances at same millisecond, and chains 1000 times", () => {
    const old = mintRevisionId({ now: now - 10 });
    expect(idTimestamp(mintRevisionId({ now, parentId: old }))).toBe(now);
    let parent = mintRevisionId({ now });
    for (let i = 1; i <= 1000; i++) {
      const child = mintRevisionId({ now, parentId: parent });
      expect(idTimestamp(child)).toBe(now + i);
      expect(child > parent).toBe(true);
      parent = child;
    }
  });
  it("validates exact clock boundaries and parent prefixes", () => {
    validateClientId(mintRevisionId({ now: now + 300_000 }), {
      prefix: "rev",
      now,
    });
    code(
      () =>
        validateClientId(mintRevisionId({ now: now + 300_001 }), {
          prefix: "rev",
          now,
        }),
      "clock_skew",
    );
    validateClientId(mintRevisionId({ now: now - 7 * 86_400_000 }), {
      prefix: "rev",
      now,
    });
    code(
      () =>
        validateClientId(mintRevisionId({ now: now - 7 * 86_400_000 - 1 }), {
          prefix: "rev",
          now,
        }),
      "stale_id",
    );
    const parent = mintRevisionId({ now });
    const before = capture(() =>
      validateClientId(parent, { prefix: "rev", now, parentId: parent }),
    );
    expect(before.code).toBe("id_before_parent");
    expect(before.details.parent_timestamp).toBe(now);
    const earlyChild = mintRevisionId({ now: now - 1 });
    const earlyError = capture(() =>
      validateClientId(earlyChild, { prefix: "rev", now, parentId: parent }),
    );
    expect(earlyError.code).toBe("id_before_parent");
    expect(earlyError.details.parent_timestamp).toBe(now);
    code(
      () =>
        validateClientId(parent, {
          prefix: "rev",
          now,
          parentId: newId("col"),
        }),
      "validation_failed",
    );
  });
  it("rejects malformed TypeIDs and newId revision calls", () => {
    const id = mintRevisionId({ now });
    for (const invalid of [
      `rev_8${id.slice(5)}`,
      id.slice(0, -1),
      id.toUpperCase(),
      ...["i", "l", "o", "u"].map((letter) => `${id.slice(0, -1)}${letter}`),
    ]) {
      code(() => parseId(invalid, "rev"), "validation_failed");
    }
    // @ts-expect-error Revision IDs must be minted with mintRevisionId.
    expect(() => newId("rev")).toThrow("Use mintRevisionId");
  });
});

describe("new path invariants", () => {
  it("measures normalized UTF-8 bytes and rejects malformed Unicode and controls", () => {
    expect(validatePath("é".repeat(256))).toBe("é".repeat(256));
    code(() => validatePath(`${"é".repeat(256)}a`), "path_invalid");
    expect(validatePath("e\u0301".repeat(256))).toBe("é".repeat(256));
    for (const path of ["\ud800", "\udc00", "a\u007f", "a\u0080", "a\u009f", "a/", "r/x", "r"])
      code(() => validatePath(path), "path_invalid");
    expect(validatePath("rx/y")).toBe("rx/y");
    expect(validatePath("x/r/y")).toBe("x/r/y");
  });
  it("finds directory spelling and file hierarchy conflicts", () => {
    expect(findCaseConflicts(["Img/a.png", "img/b.png"])).toEqual([["Img/a.png", "img/b.png"]]);
    expect(findCaseConflicts(["café/a", "cafe\u0301/a"])).toEqual([["café/a", "cafe\u0301/a"]]);
    expect(findFileDirectoryConflicts(["a", "a/b"])).toEqual([["a", "a/b"]]);
    code(
      () => buildManifest({ mode: "replace", files: { a: entry, "a/b": entry } }),
      "path_invalid",
    );
    code(
      () =>
        buildManifest({
          mode: "replace",
          files: { "Img/a.png": entry, "img/b.png": entry },
        }),
      "path_case_conflict",
    );
  });
});

describe("manifest edge cases", () => {
  const parent = {
    headPath: "cafe\u0301.md",
    files: { "café.md": entry, "z.md": entry },
  };
  it("inherits a normalized head in merge and replace", () => {
    expect(buildManifest({ mode: "merge", parent, files: {} }).headPath).toBe("café.md");
    expect(buildManifest({ mode: "replace", parent, files: { "café.md": entry } }).headPath).toBe(
      "café.md",
    );
    expect(buildManifest({ mode: "merge", parent, remove: ["café.md"], files: {} }).headPath).toBe(
      "z.md",
    );
    code(
      () =>
        buildManifest({
          mode: "merge",
          parent,
          remove: ["café.md"],
          files: {},
          headPath: "café.md",
        }),
      "head_path_missing",
    );
  });
  it("rejects missing parent, missing removal, and removal in replace", () => {
    code(
      () => buildManifest({ mode: "merge", files: { "index.html": entry } }),
      "validation_failed",
    );
    code(
      () => buildManifest({ mode: "merge", parent, files: {}, remove: ["absent"] }),
      "validation_failed",
    );
    code(
      () =>
        buildManifest({
          mode: "replace",
          parent,
          files: { "z.md": entry },
          remove: ["café.md"],
        }),
      "validation_failed",
    );
  });
  it("allows a case rename only when the old spelling is removed", () => {
    const first = buildManifest({ mode: "replace", files: { "A.md": entry } });
    expect(
      buildManifest({
        mode: "merge",
        parent: first,
        files: { "a.md": entry },
        remove: ["A.md"],
      }).headPath,
    ).toBe("a.md");
    code(
      () =>
        buildManifest({
          mode: "merge",
          parent: first,
          files: { "a.md": entry },
        }),
      "path_case_conflict",
    );
  });
  it("accepts exact limits and validates limit values", () => {
    const many = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`f${i}.md`, { ...entry, size: 0 }]),
    );
    expect(
      Object.keys(buildManifest({ mode: "replace", files: many, headPath: "f0.md" }).files),
    ).toHaveLength(2000);
    const fifty = 50 * 1024 * 1024;
    const full = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`f${i}.md`, { ...entry, size: fifty }]),
    );
    expect(
      buildManifest({ mode: "replace", files: full, headPath: "f0.md" }).files["f0.md"]?.size,
    ).toBe(fifty);
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
      code(
        () =>
          buildManifest({
            mode: "replace",
            files,
            limits: { maxFiles: value },
          }),
        "validation_failed",
      );
  });
  it("ignores key order but detects MIME and head changes", () => {
    const a = { headPath: "a.md", files: { "a.md": entry, "b.md": entry } };
    const b = { headPath: "a.md", files: { "b.md": entry, "a.md": entry } };
    expect(manifestsEqual(a, b)).toBe(true);
    expect(manifestsEqual(a, { ...b, headPath: "b.md" })).toBe(false);
    expect(
      manifestsEqual(a, {
        ...b,
        files: { ...b.files, "a.md": { ...entry, mime: "text/markdown" } },
      }),
    ).toBe(false);
  });
});

describe("URL edge cases", () => {
  const col = "0123456789ab";
  const rev = "abcdefghjkmn";
  const path = "? # % ü ' ( ) * !.md";
  it("round trips special characters and base prefixes", () => {
    for (const base of ["https://x", "https://x/s/wps_tok"]) {
      const latest = latestCollectionUrl(base, col, path);
      expect(latest.startsWith(`${base}/c/`)).toBe(true);
      expect(parseWriterUrl(latest)).toEqual({
        kind: "latest",
        collectionPublicId: col,
        path,
      });
      expect(parseWriterUrl(pinnedRevisionUrl(base, col, rev, path))).toEqual({
        kind: "pinned",
        collectionPublicId: col,
        revisionPublicId: rev,
        path,
      });
      expect(parseWriterUrl(rawUrl(base, rev, path))).toEqual({
        kind: "raw",
        revisionPublicId: rev,
        path,
      });
    }
    expect(parseWriterUrl(`/c/${col}`)).toEqual({
      kind: "latest",
      collectionPublicId: col,
    });
    expect(parseWriterUrl(`/raw/r/${rev}/a.md?source`)).toEqual({
      kind: "raw",
      revisionPublicId: rev,
      path: "a.md",
    });
    expect(parseWriterUrl(`/c/${col.toUpperCase()}/`)).toEqual({
      kind: "latest",
      collectionPublicId: col,
    });
  });
  it("rejects unsafe schemes and encodings", () => {
    for (const input of [
      `ftp://x/c/${col}/`,
      `//c/${col}/`,
      `https:/c/${col}/`,
      `https:///c/${col}/`,
      `/c/${col}/bad%`,
      `/c/${col}/%2e%2e/a`,
      `/c/${col}/a%2Fb`,
      `/c/${col}/a%5Cb`,
    ]) {
      expect(isWaypointError(capture(() => parseWriterUrl(input)))).toBe(true);
    }
    code(() => latestCollectionUrl("https://x", col, "r/a"), "path_invalid");
    code(() => latestCollectionUrl(`https://x/c/${col}`, col), "validation_failed");
    code(() => latestCollectionUrl("https://x/raw/r", col), "validation_failed");
    for (const base of [
      "https://x/?q=1",
      "https://x/?",
      "https://x/#fragment",
      "https://x/#",
      "https://user@x/",
      "https://@x/",
      "https://x:pass@x/",
    ])
      code(() => latestCollectionUrl(base, col), "validation_failed");
  });
});

describe("errors and MIME", () => {
  it("maps every error to the documented status and serializes the body", () => {
    const expected: Record<string, number> = {
      validation_failed: 400,
      forbidden: 403,
      unsupported_media_type: 415,
      conflict: 409,
      internal_error: 500,
      path_invalid: 400,
      path_case_conflict: 400,
      head_path_missing: 400,
      head_path_ambiguous: 400,
      blob_missing: 422,
      blob_hash_mismatch: 422,
      bucket_corrupt: 502,
      bucket_unavailable: 503,
      blob_too_large: 413,
      revision_too_large: 413,
      clock_skew: 400,
      stale_id: 400,
      id_before_parent: 400,
      revision_conflict: 409,
      collection_not_found: 404,
      collection_deleted: 410,
      collection_purged: 410,
      parent_not_found: 422,
      parent_failed: 422,
      not_found: 404,
    };
    expect(ERROR_STATUS).toEqual(expected);
    for (const [codeName, status] of Object.entries(expected)) {
      const error = new WaypointError(brand<keyof typeof ERROR_STATUS>(codeName), "message", {
        a: 1,
      });
      expect(error.httpStatus).toBe(status);
      expect(error.toBody()).toEqual({
        error: { code: codeName, message: "message", details: { a: 1 } },
      });
      expect(
        isWaypointError({ name: "WaypointError", code: codeName, message: "message", details: {} }),
      ).toBe(false);
      expect(
        isWaypointError({
          name: "WaypointError",
          code: codeName,
          message: "message",
          details: {},
          httpStatus: status,
          toBody: () => error.toBody(),
        }),
      ).toBe(true);
    }
    code(() => contentHashHex(brand<ContentHash>("bad")), "validation_failed");
  });
  it("normalizes MIME and recognizes common text and binary outputs", () => {
    expect(normalizeMime(" Text/Markdown ; Charset=UTF-8 ")).toBe("text/markdown");
    for (const invalid of [
      "text",
      "text/",
      "text /plain",
      "text/plain\r\nheader: x",
      "text/plain; nonsense",
      "garbage!",
    ])
      code(() => normalizeMime(invalid), "validation_failed");
    expect(isMarkdown(" Text/Markdown ; Charset=UTF-8 ")).toBe(true);
    expect(isMarkdown("text/markdown-extra")).toBe(false);
    expect(
      buildManifest({
        mode: "replace",
        files: {
          "a.md": { ...entry, mime: " Text/Markdown ; Charset=UTF-8 " },
        },
      }).files["a.md"]?.mime,
    ).toBe("text/markdown");
    for (const ext of [
      "log",
      "ts",
      "tsx",
      "jsx",
      "cjs",
      "mts",
      "cts",
      "py",
      "sh",
      "jsonl",
      "diff",
      "patch",
      "toml",
      "ini",
      "mp4",
      "webm",
      "mp3",
      "wav",
      "zip",
      "tar",
      "gz",
    ])
      expect(inferMime(`a.${ext}`)).not.toBe("application/octet-stream");
    for (const mime of [
      "text/plain",
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "text/javascript",
      "image/svg+xml",
    ])
      expect(isTextMime(mime)).toBe(true);
    expect(isTextMime("image/png")).toBe(false);
  });
});

describe("display numbers", () => {
  it("deduplicates revisions and orders a fork by ID", () => {
    const parent = mintRevisionId({ now });
    const forkA = mintRevisionId({ now, parentId: parent });
    const forkB = mintRevisionId({ now, parentId: parent });
    const ids = [forkB, parent, forkA, forkA];
    const numbers = displayNumbers(ids);
    expect(Object.values(numbers).toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(numbers[parent]).toBe(1);
  });
});

function runGuard(directory: string) {
  return spawnSync(process.execPath, ["scripts/check-core-imports.mjs", directory], {
    encoding: "utf8",
  });
}
describe("deterministic share tokens against node:crypto", () => {
  it("equals wps_ + base64url(HMAC-SHA256(key, link ID)) for random keys and IDs", async () => {
    const cases = Array.from({ length: 100 }, () => ({
      key: randomBytes(32),
      id: newId("shl"),
    }));
    const derived = await Promise.all(
      cases.map(({ key, id }) => deriveShareToken(new Uint8Array(key), id)),
    );
    expect(derived).toEqual(
      cases.map(
        ({ key, id }) => `wps_${createHmac("sha256", key).update(id, "utf8").digest("base64url")}`,
      ),
    );
    expect(derived.every(isShareToken)).toBe(true);
  });
});

describe("core import guard", () => {
  it("accepts the real core source", () => {
    const result = runGuard("packages/core/src");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
  it("rejects a bare Node builtin and a denied package with specific errors", () => {
    const builtin = runGuard("tests/fixtures/core-node-import");
    expect(builtin.status).not.toBe(0);
    expect(builtin.stderr).toContain("Node-only import in core: fs");
    const denied = runGuard("tests/fixtures/core-denied-import");
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("Node-only import in core: @aws-sdk/client-s3");
  });
  it("fails if the fixture directory is missing", () => {
    const result = runGuard("tests/fixtures/does-not-exist");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
  });
});
