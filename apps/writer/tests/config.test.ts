import { WAYPOINT_VERSION } from "@waypoint/core";
import { describe, it, expect } from "vitest";

import { loadConfig } from "../src/config.ts";
describe("writer config", () => {
  it("expands home and validates local development mode", () => {
    const config = loadConfig({
      WAYPOINT_ENV: "dev",
      WAYPOINT_SYNC: "off",
      WAYPOINT_DATA_DIR: "~/waypoint-test",
      WAYPOINT_PORT: "7411",
    });
    expect(config.dataDir).toContain("/waypoint-test");
    expect(config.port).toBe(7411);
    expect(config.baseUrl).toBe("http://127.0.0.1:7411");
    expect(config.sync).toBe(false);
    expect(config.host).toBe("127.0.0.1");
  });
  it("listens on loopback unless WAYPOINT_HOST names another address", () => {
    const base = { WAYPOINT_ENV: "dev", WAYPOINT_SYNC: "off" };
    expect(loadConfig({ ...base, WAYPOINT_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadConfig({ ...base, WAYPOINT_HOST: "::" }).host).toBe("::");
    expect(loadConfig({ ...base, WAYPOINT_HOST: "" }).host).toBe("127.0.0.1");
    // A base URL derived from the port stays on loopback, whatever the listen address.
    expect(loadConfig({ ...base, WAYPOINT_HOST: "0.0.0.0" }).baseUrl).toBe("http://127.0.0.1:7410");
    for (const host of ["localhost", "example.test", "0.0.0.0:7410"])
      expect(() => loadConfig({ ...base, WAYPOINT_HOST: host })).toThrow("WAYPOINT_HOST");
  });
  it("allows local-only production and keeps WAYPOINT_ENV required", () => {
    const config = loadConfig({
      WAYPOINT_ENV: "prod",
      WAYPOINT_SYNC: "off",
      WAYPOINT_DATA_DIR: "/tmp/waypoint-prod-test",
    });
    expect(config).toMatchObject({ environment: "prod", sync: false });
    expect(config.tursoUrl).toBeUndefined();
    expect(config.s3Endpoint).toBeUndefined();
    expect(() => loadConfig({ WAYPOINT_SYNC: "off" })).toThrow("WAYPOINT_ENV must be dev or prod");
    expect(loadConfig({ WAYPOINT_ENV: "prod", WAYPOINT_SYNC: "off" }).dataDir).toMatch(
      /\/\.local\/share\/waypoint\/prod$/,
    );
  });
  it("reports the build version and only a well-formed commit", () => {
    const base = { WAYPOINT_ENV: "dev", WAYPOINT_SYNC: "off" };
    expect(loadConfig(base).build).toEqual({ version: WAYPOINT_VERSION, sha: null });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(loadConfig({ ...base, WAYPOINT_BUILD_SHA: sha }).build?.sha).toBe(sha);
    expect(loadConfig({ ...base, WAYPOINT_BUILD_SHA: "unknown" }).build?.sha).toBeNull();
  });
  it("accepts any bucket name and an optional S3-compatible endpoint", () => {
    const cloud = {
      WAYPOINT_ENV: "prod",
      WAYPOINT_BASE_URL: "https://writer.example.test",
      TURSO_DATABASE_URL: "libsql://db.example.test",
      TURSO_AUTH_TOKEN: "token",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "my-notes",
    };
    expect(() => loadConfig(cloud)).toThrow("R2_ACCOUNT_ID is required");
    const r2 = loadConfig({ ...cloud, R2_ACCOUNT_ID: "abc123" });
    expect(r2).toMatchObject({
      r2Bucket: "my-notes",
      r2AccountId: "abc123",
      s3Endpoint: "https://abc123.r2.cloudflarestorage.com",
      s3Region: "auto",
    });
    // The owner's existing names still work, for either environment.
    expect(
      loadConfig({ ...cloud, WAYPOINT_ENV: "dev", R2_ACCOUNT_ID: "abc", R2_BUCKET: "waypoint-dev" })
        .r2Bucket,
    ).toBe("waypoint-dev");
    expect(() => loadConfig({ ...cloud, R2_ACCOUNT_ID: "evil.example.test/x?" })).toThrow(
      "R2_ACCOUNT_ID must be",
    );
    const minio = loadConfig({
      ...cloud,
      WAYPOINT_S3_ENDPOINT: "http://minio.example.test:9000/",
      WAYPOINT_S3_REGION: "us-east-1",
    });
    expect(minio).toMatchObject({
      s3Endpoint: "http://minio.example.test:9000",
      s3Region: "us-east-1",
    });
    expect(minio.r2AccountId).toBeUndefined();
    for (const endpoint of [
      "minio:9000",
      "https://user:pass@s3.example.test",
      "https://s3.example.test/?a=1",
    ])
      expect(() => loadConfig({ ...cloud, WAYPOINT_S3_ENDPOINT: endpoint })).toThrow(
        "WAYPOINT_S3_ENDPOINT",
      );
    expect(() =>
      loadConfig({ ...cloud, R2_ACCOUNT_ID: "abc", WAYPOINT_S3_REGION: "US East" }),
    ).toThrow("WAYPOINT_S3_REGION");
  });
  it("refuses invalid values without exposing secrets", () => {
    expect(() =>
      loadConfig({ WAYPOINT_ENV: "dev", WAYPOINT_SYNC: "off", WAYPOINT_PORT: "abc" }),
    ).toThrow("WAYPOINT_PORT");
    const secret = "do-not-print-this";
    let message = "";
    try {
      loadConfig({
        WAYPOINT_ENV: "dev",
        WAYPOINT_BASE_URL: "https://writer.example",
        TURSO_AUTH_TOKEN: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("TURSO_DATABASE_URL");
    expect(message).not.toContain(secret);
  });
  it("accepts an optional public URL and rejects credentials or fragments", () => {
    const config = loadConfig({
      WAYPOINT_ENV: "dev",
      WAYPOINT_SYNC: "off",
      WAYPOINT_PUBLIC_BASE_URL: "https://reader-dev.example.test",
    });
    expect(config.publicBaseUrl).toBe("https://reader-dev.example.test");
    expect(() =>
      loadConfig({
        WAYPOINT_ENV: "dev",
        WAYPOINT_SYNC: "off",
        WAYPOINT_PUBLIC_BASE_URL: "https://user:secret@reader.example",
      }),
    ).toThrow("WAYPOINT_PUBLIC_BASE_URL");
    expect(() =>
      loadConfig({
        WAYPOINT_ENV: "dev",
        WAYPOINT_SYNC: "off",
        WAYPOINT_PUBLIC_BASE_URL: "https://reader.example/#x",
      }),
    ).toThrow("WAYPOINT_PUBLIC_BASE_URL");
  });
  it("parses an optional share token key and never echoes an invalid one", () => {
    const base = { WAYPOINT_ENV: "dev", WAYPOINT_SYNC: "off" };
    expect(loadConfig(base).shareTokenKey).toBeUndefined();
    expect(loadConfig({ ...base, WAYPOINT_SHARE_TOKEN_KEY: "" }).shareTokenKey).toBeUndefined();
    const key = Buffer.alloc(32, 7);
    const parsed = loadConfig({ ...base, WAYPOINT_SHARE_TOKEN_KEY: key.toString("base64url") });
    expect(parsed.shareTokenKey && Buffer.from(parsed.shareTokenKey)).toEqual(key);
    for (const secret of [
      Buffer.alloc(31, 9).toString("base64url"),
      Buffer.alloc(33, 9).toString("base64url"),
      `${key.toString("base64url").slice(0, -2)}+/`,
    ]) {
      let message = "";
      try {
        loadConfig({ ...base, WAYPOINT_SHARE_TOKEN_KEY: secret });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("WAYPOINT_SHARE_TOKEN_KEY must be 32 bytes, base64url-encoded");
      expect(message).not.toContain(secret);
    }
  });
});
