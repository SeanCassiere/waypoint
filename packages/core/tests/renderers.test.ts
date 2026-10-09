import { describe, expect, it } from "vitest";

import { RENDERER_NAMES, rendererFor } from "../src/index.ts";

describe("rendererFor", () => {
  it("picks each MIME type's renderer, or none", () => {
    const cases: [mime: string, renderer: string | null][] = [
      ["text/markdown", "markdown"],
      ["TEXT/MARKDOWN; charset=utf-8", "markdown"],
      ["text/csv", "csv"],
      ["text/tab-separated-values", "csv"],
      ["text/plain", "text"],
      ["text/x-shellscript", "text"],
      ["application/json", "text"],
      ["application/vnd.api+json", "text"],
      ["application/x-ndjson", "text"],
      ["application/yaml", "text"],
      ["application/toml", "text"],
      ["text/javascript", "text"],
      ["text/typescript", "text"],
      ["application/xml", "text"],
      ["text/html", null],
      ["application/xhtml+xml", null],
      ["image/svg+xml", null],
      ["image/png", null],
      ["application/pdf", null],
      ["application/octet-stream", null],
      ["application/gzip", null],
    ];
    expect(Object.fromEntries(cases.map(([mime]) => [mime, rendererFor(mime)]))).toEqual(
      Object.fromEntries(cases),
    );
  });

  it("never throws on an invalid MIME type", () => {
    expect(() => rendererFor("text/plain\n")).not.toThrow();
    expect(rendererFor("text/plain\n")).toBeNull();
    expect(rendererFor("")).toBeNull();
  });

  it("lists every renderer in backfill order", () => {
    expect(RENDERER_NAMES).toEqual(["markdown", "text", "csv"]);
  });
});
