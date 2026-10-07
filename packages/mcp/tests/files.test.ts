import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LIMITS, hashBytes } from "@waypoint/core";
import { expect, it } from "vitest";

import { prepareFiles, walkSourceDir } from "../src/files.js";
import { limitsFromEnv } from "../src/index.js";

it("walks real and symlinked roots with basename and nested excludes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-walk-"));
  await mkdir(join(dir, "sub"));
  await mkdir(join(dir, ".git"));
  await mkdir(join(dir, "dist"));
  await mkdir(join(dir, "sub", "dist"));
  await mkdir(join(dir, "sub", "node_modules"));
  await mkdir(join(dir, ".hidden"));
  await writeFile(join(dir, "sub", "keep.txt"), "keep");
  await writeFile(join(dir, "sub", "skip.log"), "skip");
  await writeFile(join(dir, ".git", "secret"), "x");
  await writeFile(join(dir, "dist", "output.js"), "x");
  await writeFile(join(dir, "sub", "dist", "nested.js"), "x");
  await writeFile(join(dir, "sub", "node_modules", "dep"), "x");
  await writeFile(join(dir, ".hidden", "file"), "x");
  await symlink(join(dir, "sub", "keep.txt"), join(dir, "link.txt"));
  const linked = `${dir}-link`;
  await symlink(dir, linked);
  const expected = ["sub/dist/nested.js", "sub/keep.txt"];
  for (const root of [dir, linked, `${linked}/`]) {
    expect(
      (await walkSourceDir({ dir: root, exclude: ["*.log", "./dist/**"] })).map(
        (file) => file.path,
      ),
    ).toEqual(expected);
  }
  expect(
    (await walkSourceDir({ dir, exclude: ["./sub/*.log", "./dist/**"] })).map((file) => file.path),
  ).toEqual(expected);
  expect(
    (await walkSourceDir({ dir, exclude: ["*.log", "/dist/"] })).map((file) => file.path),
  ).toEqual(expected);
  expect(
    (await walkSourceDir({ dir, exclude: ["/dist", "*.log"] })).map((file) => file.path),
  ).toEqual(expected);
  const files = await prepareFiles([{ path: "sub/keep.txt", content: "override" }], {
    dir,
    exclude: ["*.log", "./dist/**"],
  });
  expect(files.find((file) => file.path === "sub/keep.txt")?.hash).toBe(
    await hashBytes(new TextEncoder().encode("override")),
  );
});

it("detects normalized collisions and aborts the walk at the file limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-normalize-"));
  await writeFile(join(dir, "e\u0301.txt"), "two");
  expect((await walkSourceDir({ dir })).map((file) => file.path)).toEqual(["é.txt"]);
  await writeFile(join(dir, "é.txt"), "one");
  await expect(walkSourceDir({ dir })).rejects.toMatchObject({ code: "path_case_conflict" });
  const other = await mkdtemp(join(tmpdir(), "waypoint-limit-"));
  await writeFile(join(other, "a.txt"), "a");
  await writeFile(join(other, "b.txt"), "b");
  await expect(
    walkSourceDir({ dir: other }, { ...DEFAULT_LIMITS, maxFiles: 1 }),
  ).rejects.toMatchObject({ code: "revision_too_large" });
  await expect(walkSourceDir({ dir: "relative" })).rejects.toThrow("absolute");
  const invalid = await mkdtemp(join(tmpdir(), "waypoint-invalid-name-"));
  await mkdir(join(invalid, "r"));
  await writeFile(join(invalid, "r", "file.txt"), "x");
  await expect(walkSourceDir({ dir: invalid })).rejects.toMatchObject({
    code: "path_invalid",
    message: "Invalid source_dir filename: r/file.txt",
  });
});

it("validates local paths, exactly one source, limits, MIME, and stream hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-input-"));
  const path = join(dir, "source.json");
  await writeFile(path, '{"ok":true}');
  const [file] = await prepareFiles([{ path: "source.json", source_path: path }]);
  expect(file).toMatchObject({
    mime: "application/json",
    hash: await hashBytes(new TextEncoder().encode('{"ok":true}')),
  });
  await expect(prepareFiles([{ path: "x", source_path: "relative" }])).rejects.toThrow("absolute");
  await expect(prepareFiles([{ path: "x", source_path: "~/file" }])).rejects.toThrow("absolute");
  await expect(prepareFiles([{ path: "x" }])).rejects.toThrow("Exactly one");
  await expect(prepareFiles([{ path: "x", source_path: path, content: "both" }])).rejects.toThrow(
    "Exactly one",
  );
  await expect(
    prepareFiles([{ path: "source.json", source_path: path }], undefined, {
      ...DEFAULT_LIMITS,
      maxBlobBytes: 1,
    }),
  ).rejects.toMatchObject({ code: "blob_too_large" });
  await expect(
    prepareFiles(
      [
        { path: "x", content: "abc" },
        { path: "y", content: "def" },
      ],
      undefined,
      { maxFiles: 2, maxBlobBytes: 3, maxRevisionBytes: 5 },
    ),
  ).rejects.toMatchObject({ code: "revision_too_large" });
});

it("reads configurable limits from the MCP environment", () => {
  expect(
    limitsFromEnv({
      WAYPOINT_MAX_FILES: "3",
      WAYPOINT_MAX_BLOB_MB: "2",
      WAYPOINT_MAX_REVISION_MB: "7",
    }),
  ).toEqual({ maxFiles: 3, maxBlobBytes: 2 * 1024 * 1024, maxRevisionBytes: 7 * 1024 * 1024 });
  expect(() => limitsFromEnv({ WAYPOINT_MAX_FILES: "0" })).toThrow(
    "WAYPOINT_MAX_FILES must be a positive integer",
  );
});
