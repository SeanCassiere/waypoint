// scripts/check-hosted-runners.sh: no workflow of this repository may run on a self-hosted
// runner (D58). CI's lint job runs it on .github/workflows; these samples check that it refuses
// every way a workflow can select a self-hosted runner, and accepts the forms the repository uses.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/check-hosted-runners.sh");
const scratch = mkdtempSync(join(tmpdir(), "waypoint-hosted-runners-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
/** Runs the check on a directory holding one workflow with these jobs. */
function check(jobs: string, file = "workflow.yml") {
  const dir = mkdtempSync(join(scratch, `${String(count++)}-`));
  writeFileSync(join(dir, file), `name: Sample\non: push\njobs:\n${jobs}`);
  return spawnSync("bash", [script, dir], { encoding: "utf8" });
}

describe("check-hosted-runners.sh", () => {
  it("passes on this repository's workflows", () => {
    const result = spawnSync("bash", [script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["a hosted label", "    runs-on: ubuntu-latest\n"],
    ["a quoted label with a comment", "    runs-on: 'ubuntu-24.04-arm' # arm64\n"],
    ["windows and macOS labels", "    runs-on: windows-2025\n  b:\n    runs-on: macos-15\n"],
    [
      "a matrix of hosted labels",
      [
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - runner: ubuntu-latest",
        '          - runner: "ubuntu-24.04-arm"',
        "    runs-on: ${{ matrix.runner }}",
        "    steps:",
        "      - run: gh attestation verify --deny-self-hosted-runners x # self-hosted is fine here",
        "",
      ].join("\n"),
    ],
    [
      "a flow-list matrix of hosted labels",
      "    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-15]\n    runs-on: ${{ matrix.os }}\n",
    ],
  ])("accepts %s", (_, jobs) => {
    const result = check(`  a:\n${jobs}`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["the self-hosted label", "    runs-on: self-hosted\n"],
    ["a label list", "    runs-on: [self-hosted, waypoint-deploy]\n"],
    ["a hosted label in a list", "    runs-on: [ubuntu-latest]\n"],
    ["a block list", "    runs-on:\n      - self-hosted\n      - linux\n"],
    ["a runner group", "    runs-on:\n      group: deployers\n"],
    ["a flow mapping", "    runs-on: { group: deployers }\n"],
    ["a lone custom label", "    runs-on: waypoint-deploy\n"],
    ["a quoted custom label", '    runs-on: "deploy-box"\n'],
    ["an expression other than a matrix value", "    runs-on: ${{ inputs.runner }}\n"],
    [
      "a matrix value that isn't hosted",
      "    strategy:\n      matrix:\n        runner: [ubuntu-latest, waypoint-deploy]\n    runs-on: ${{ matrix.runner }}\n",
    ],
    ["a matrix value it can't see", "    runs-on: ${{ matrix.runner }}\n"],
    [
      "self-hosted in a matrix",
      "    strategy:\n      matrix:\n        runner: ['self-hosted']\n    runs-on: ubuntu-latest\n",
    ],
  ])("refuses %s", (_, jobs) => {
    const result = check(`  a:\n${jobs}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/workflow\.yml:\d+: /);
    expect(result.stderr).toContain("GitHub-hosted runners only");
  });

  it("checks .yaml files too", () => {
    expect(check("  a:\n    runs-on: self-hosted\n", "workflow.yaml").status).toBe(1);
  });

  it("fails on a directory without workflows", () => {
    const empty = mkdtempSync(join(scratch, "empty-"));
    expect(spawnSync("bash", [script, empty], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync("bash", [script, join(scratch, "missing")], { encoding: "utf8" }).status).toBe(
      2,
    );
  });
});
