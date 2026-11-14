// deploy/upgrade.sh rerender's watch of a writer that re-renders by itself, against a stubbed
// Docker (scripts/rerender-watch-test.sh): it ends the post-start delay only of the container and
// image it began on, so a release deployed during the watch keeps its delay (D89).
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

it("ends only the watched build's rerender delay", () => {
  const result = spawnSync("bash", [join(root, "scripts/rerender-watch-test.sh")], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("all rerender watch scenarios passed");
});
