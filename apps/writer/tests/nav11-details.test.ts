import { describe, expect, it } from "vitest";

import { buildDetailsPatch, splitTags, type DetailsFields } from "../src/viewer/details-patch.ts";

// NAV-11: the Collection details dialog's PATCH body, built in the browser from its fields plus
// the Other metadata JSON. Pure: the same module runs in the client bundle.

const fields = (overrides: Partial<DetailsFields>): DetailsFields => ({
  title: "Title",
  project: "",
  tags: "",
  extra: "",
  keep: {},
  ...overrides,
});
/** What JSON.parse throws for `text` in this runtime. */
function parseError(text: string): string {
  try {
    JSON.parse(text);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("parsed");
}

describe("splitTags", () => {
  it("splits on commas, trims, drops empties and case-insensitive repeats, keeps order", () => {
    expect(splitTags("research, delivery,, Research , ops ,")).toEqual([
      "research",
      "delivery",
      "ops",
    ]);
    expect(splitTags("")).toEqual([]);
  });
  it("keeps the first spelling of a repeated tag", () => {
    expect(splitTags("Ops, ops, OPS")).toEqual(["Ops"]);
  });
});

describe("buildDetailsPatch", () => {
  it("lets the fields win over the extra JSON, keeps source_host and unknown keys", () => {
    expect(
      buildDetailsPatch({
        title: "  New ",
        project: " infra ",
        tags: "a, b",
        extra: '{"ticket":"W-12","project":"x","tags":["y"]}',
        keep: { source_host: "devbox" },
      }),
    ).toEqual({
      ok: true,
      body: {
        title: "New",
        metadata: { ticket: "W-12", source_host: "devbox", project: "infra", tags: ["a", "b"] },
      },
    });
  });
  it("leaves out an empty project and empty tags; blank extra is {} plus keep", () => {
    expect(
      buildDetailsPatch(
        fields({ project: "  ", tags: " , ", extra: "   ", keep: { source_host: "devbox" } }),
      ),
    ).toEqual({ ok: true, body: { title: "Title", metadata: { source_host: "devbox" } } });
    // The extra JSON can't bring project or tags back once the fields are cleared.
    const cleared = buildDetailsPatch(fields({ extra: '{"project":"x","tags":["y"],"a":1}' }));
    expect(cleared).toEqual({ ok: true, body: { title: "Title", metadata: { a: 1 } } });
  });
  it("asks for a title", () => {
    expect(buildDetailsPatch(fields({ title: "   " }))).toEqual({
      ok: false,
      field: "title",
      message: "Enter a title",
    });
  });
  it("reports invalid JSON with the engine's own message, unchanged", () => {
    const extra = '{"a": 1,\n  "b" 2}';
    expect(buildDetailsPatch(fields({ extra }))).toEqual({
      ok: false,
      field: "extra",
      message: parseError(extra),
    });
  });
  it("reports positions in the text as typed, leading blank lines included", () => {
    const extra = '\n\n  {"a": 1 "b": 2}';
    expect(buildDetailsPatch(fields({ extra }))).toEqual({
      ok: false,
      field: "extra",
      message: parseError(extra),
    });
  });
  it("keeps a project or tags the fields can't show (carried in keep) when the fields are empty", () => {
    const keep = { source_host: "devbox", project: 42, tags: ["a", { id: 1 }] };
    expect(buildDetailsPatch(fields({ project: "", tags: "", extra: "{}", keep }))).toEqual({
      ok: true,
      body: { title: "Title", metadata: keep },
    });
  });
  it("requires a JSON object", () => {
    for (const extra of ["[1]", "1", '"x"', "null"])
      expect(buildDetailsPatch(fields({ extra }))).toEqual({
        ok: false,
        field: "extra",
        message: "Other metadata must be a JSON object",
      });
  });
  it("keeps a __proto__ key as a plain key", () => {
    const patch = buildDetailsPatch(fields({ extra: '{"__proto__":{"x":1}}' }));
    if (!patch.ok) throw new Error(patch.message);
    expect(Object.getPrototypeOf(patch.body.metadata)).toBe(Object.prototype);
    expect(Object.keys(patch.body.metadata)).toEqual(["__proto__"]);
  });
});
