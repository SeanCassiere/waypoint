import { describe, it, expect } from "vitest";

import { loadConfig } from "../apps/writer/src/config.js";
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
  });
  it("refuses local-only production and invalid values without exposing secrets", () => {
    expect(() => loadConfig({ WAYPOINT_ENV: "prod", WAYPOINT_SYNC: "off" })).toThrow(
      "only allowed in dev",
    );
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
      WAYPOINT_PUBLIC_BASE_URL: "https://waypoint-dev.pingstash.com",
    });
    expect(config.publicBaseUrl).toBe("https://waypoint-dev.pingstash.com");
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
});
