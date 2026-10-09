import { describe, expect, it } from "vitest";

import {
  attachmentDisposition,
  inferMime,
  isTextMime,
  PLAIN_TEXT_RAW_TYPES,
  rawContentType,
  WaypointError,
} from "../src/index.ts";

describe("rawContentType", () => {
  it("serves CSV and TSV as plain text and every other type as before", () => {
    expect([...PLAIN_TEXT_RAW_TYPES]).toEqual(["text/csv", "text/tab-separated-values"]);
    const cases: [mime: string, header: string][] = [
      ["text/csv", "text/plain; charset=utf-8"],
      ["text/csv; header=present", "text/plain; charset=utf-8"],
      ["TEXT/CSV", "text/plain; charset=utf-8"],
      ["text/tab-separated-values", "text/plain; charset=utf-8"],
      ["text/markdown", "text/markdown; charset=utf-8"],
      ["text/html", "text/html; charset=utf-8"],
      ["text/plain", "text/plain; charset=utf-8"],
      ["application/json", "application/json; charset=utf-8"],
      ["image/svg+xml", "image/svg+xml; charset=utf-8"],
      ["image/png", "image/png"],
      ["application/octet-stream", "application/octet-stream"],
      ["application/vnd.apache.parquet", "application/vnd.apache.parquet"],
    ];
    expect(Object.fromEntries(cases.map(([mime]) => [mime, rawContentType(mime)]))).toEqual(
      Object.fromEntries(cases),
    );
  });
  it("throws like isTextMime on an invalid type", () => {
    let error: unknown;
    try {
      rawContentType("text/csv\n");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WaypointError);
    expect(error).toMatchObject({ code: "validation_failed" });
  });
  it("leaves every other inferred type's header unchanged", () => {
    const paths = [
      "a.html",
      "a.htm",
      "a.md",
      "a.markdown",
      "a.txt",
      "a.log",
      "a.css",
      "a.js",
      "a.mjs",
      "a.ts",
      "a.tsx",
      "a.py",
      "a.sh",
      "a.json",
      "a.jsonl",
      "a.diff",
      "a.toml",
      "a.ini",
      "a.svg",
      "a.png",
      "a.jpg",
      "a.gif",
      "a.webp",
      "a.ico",
      "a.pdf",
      "a.xml",
      "a.yaml",
      "a.wasm",
      "a.mp4",
      "a.mp3",
      "a.zip",
      "a.tar",
      "a.gz",
      "a.tsv",
      "a.parquet",
      "noext",
    ];
    const inferred = paths.map(inferMime);
    expect(inferred.map(rawContentType)).toEqual(
      inferred.map((m) => (isTextMime(m) ? `${m}; charset=utf-8` : m)),
    );
  });
});

describe("attachmentDisposition (RX-06)", () => {
  const safe = /^attachment; filename\*=UTF-8''[A-Za-z0-9%._~!$&+,=@-]*$/;
  it("names the attachment after the base name, percent-encoded as filename* only", () => {
    expect(attachmentDisposition("plan.md")).toBe("attachment; filename*=UTF-8''plan.md");
    expect(attachmentDisposition("docs/a b'(1)*.md")).toBe(
      "attachment; filename*=UTF-8''a%20b%27%281%29%2A.md",
    );
    expect(attachmentDisposition("café.md")).toBe("attachment; filename*=UTF-8''caf%C3%A9.md");
  });
  it("shows bidi and control characters as U+FFFD", () => {
    expect(attachmentDisposition("x/invoice\u202efdp.exe")).toBe(
      "attachment; filename*=UTF-8''invoice%EF%BF%BDfdp.exe",
    );
    expect(attachmentDisposition("a\u2066b\u0000c\u007f.txt")).toBe(
      "attachment; filename*=UTF-8''a%EF%BF%BDb%EF%BF%BDc%EF%BF%BD.txt",
    );
  });
  it("never lets a quote, semicolon or line break through", () => {
    const names = [
      'a"b.md',
      "a;b.md",
      "a\r\nSet-Cookie: x=1.md",
      'x/"; filename=evil.exe',
      "\ud800lone.md",
      "",
      "d/",
      "~!$&+,=@-._.md",
    ];
    for (const name of names) {
      const header = attachmentDisposition(name);
      expect(header).toMatch(safe);
      const value = header.slice(header.indexOf("filename*=") + "filename*=".length);
      expect(value).not.toMatch(/["; \r\n]/);
    }
  });
});
