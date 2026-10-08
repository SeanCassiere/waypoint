import { describe, expect, it } from "vitest";

import type { ReaderEnv } from "../src/app.ts";
import { blobUrl, bucketBaseUrl, probeUrl } from "../src/bucket-url.ts";

const env: ReaderEnv = {
  TURSO_DATABASE_URL: "turso://test",
  TURSO_READONLY_TOKEN: "test",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_READER_ACCESS_KEY_ID: "test",
  R2_READER_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "notes-prod",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const hash = `sha256:${"a".repeat(64)}`;

describe("bucket URLs", () => {
  it("defaults to the R2 account endpoint, path-style, with any bucket name", () => {
    expect(bucketBaseUrl(env)).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/notes-prod",
    );
    expect(blobUrl(env, hash)).toBe(
      `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/notes-prod/blobs/sha256/${"a".repeat(64)}`,
    );
    expect(probeUrl(env)).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/notes-prod?list-type=2&max-keys=0",
    );
  });
  it("uses WAYPOINT_S3_ENDPOINT without R2_ACCOUNT_ID", () => {
    const { R2_ACCOUNT_ID: _, ...rest } = env;
    for (const endpoint of ["http://minio.example.test:9000", "http://minio.example.test:9000/"])
      expect(blobUrl({ ...rest, WAYPOINT_S3_ENDPOINT: endpoint }, hash)).toBe(
        `http://minio.example.test:9000/notes-prod/blobs/sha256/${"a".repeat(64)}`,
      );
    expect(probeUrl({ ...rest, WAYPOINT_S3_ENDPOINT: "https://s3.example.test/base/" })).toBe(
      "https://s3.example.test/base/notes-prod?list-type=2&max-keys=0",
    );
  });
  it("rejects non-hashes and endpoints that would redirect the signed request", () => {
    expect(blobUrl(env, "sha256:../../etc")).toBeNull();
    expect(blobUrl(env, `sha256:${"A".repeat(64)}`)).toBeNull();
    const { R2_ACCOUNT_ID: _, ...rest } = env;
    expect(() => bucketBaseUrl(rest)).toThrow("R2_ACCOUNT_ID or WAYPOINT_S3_ENDPOINT");
    expect(() => bucketBaseUrl({ ...env, R2_ACCOUNT_ID: "evil.example.test/x?" })).toThrow(
      "R2_ACCOUNT_ID or WAYPOINT_S3_ENDPOINT",
    );
    for (const endpoint of [
      "ftp://s3.example.test",
      "https://user:pass@s3.example.test",
      "https://s3.example.test/?x=1",
    ])
      expect(() => bucketBaseUrl({ ...env, WAYPOINT_S3_ENDPOINT: endpoint })).toThrow(
        "WAYPOINT_S3_ENDPOINT must be an HTTP URL",
      );
    expect(() => bucketBaseUrl({ ...env, WAYPOINT_S3_ENDPOINT: "not a url" })).toThrow(
      "Invalid URL",
    );
  });
});
