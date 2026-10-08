// scripts/check-hosted-runners.ts: no workflow of this repository may run on a self-hosted
// runner (D58). CI's lint job runs it on .github/workflows; these samples check that it refuses
// every way a workflow can select a self-hosted runner (including YAML forms a line match would
// miss: quoted keys, flow mappings, aliases), and accepts the forms the repository uses.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/check-hosted-runners.ts");
const scratch = mkdtempSync(join(tmpdir(), "waypoint-hosted-runners-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
/** Runs the check on these directories (default: this repository's workflows). */
function run(...dirs: string[]) {
  return spawnSync(process.execPath, [script, ...dirs], { encoding: "utf8" });
}

/** A refusal names the file and line of a finding, then the rule. */
const refusal = /workflow\.yml:\d+: .+\n[\s\S]*GitHub-hosted runners only/;

/** Runs the check on a directory holding one workflow with these jobs. */
function check(jobs: string, file = "workflow.yml", head = "name: Sample\non: push\njobs:\n") {
  const dir = mkdtempSync(join(scratch, `${String(count++)}-`));
  writeFileSync(join(dir, file), `${head}${jobs}`);
  return run(dir);
}

describe("check-hosted-runners.ts", () => {
  it("passes on this repository's workflows", () => {
    const result = run();
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
    [
      "a matrix name in another case, and a dynamic axis runs-on doesn't use",
      [
        "    strategy:",
        "      matrix:",
        "        OS: [ubuntu-24.04, windows-11-arm, macos-15-intel]",
        "        node: ${{ fromJSON(inputs.nodes) }}",
        "        exclude:",
        "          - node: 22",
        "    runs-on: ${{ matrix.os }}",
        "",
      ].join("\n"),
    ],
    [
      "an alias of a hosted label",
      "    env:\n      R: &runner ubuntu-latest\n    runs-on: *runner\n",
    ],
    ["a reusable workflow of this repository", "    uses: ./.github/workflows/reusable.yml\n"],
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
    ["a custom label with a hosted prefix", "    runs-on: ubuntu-deploy\n"],
    ["a double-quoted runs-on key", '    "runs-on": deploy-box\n'],
    ["a single-quoted runs-on key", "    'runs-on': deploy-box\n"],
    ["a runs-on key in another case", "    Runs-On: deploy-box\n"],
    ["runs-on twice", "    runs-on: ubuntu-latest\n    RUNS-ON: deploy-box\n"],
    ["an alias of a custom label", "    env:\n      R: &runner deploy-box\n    runs-on: *runner\n"],
    ["a merge key", "    <<: { runs-on: deploy-box }\n    steps: []\n"],
    ["no runs-on", "    steps:\n      - run: true\n"],
    ["an empty runs-on", "    runs-on:\n"],
    [
      "a dynamic matrix",
      "    strategy:\n      matrix: ${{ fromJSON(needs.plan.outputs.m) }}\n    runs-on: ${{ matrix.runner }}\n",
    ],
    [
      "a dynamic matrix axis",
      "    strategy:\n      matrix:\n        runner: ${{ fromJSON(inputs.runners) }}\n    runs-on: ${{ matrix.runner }}\n",
    ],
    [
      "a dynamic include",
      [
        "    strategy:",
        "      matrix:",
        "        runner: [ubuntu-latest]",
        "        include: ${{ fromJSON(inputs.extra) }}",
        "    runs-on: ${{ matrix.runner }}",
        "",
      ].join("\n"),
    ],
    [
      "a dynamic include entry",
      [
        "    strategy:",
        "      matrix:",
        "        runner: [ubuntu-latest]",
        "        include:",
        "          - ${{ fromJSON(inputs.extra) }}",
        "    runs-on: ${{ matrix.runner }}",
        "",
      ].join("\n"),
    ],
    [
      "a quoted include key that isn't hosted",
      [
        "    strategy:",
        "      matrix:",
        "        runner: [ubuntu-latest]",
        "        include:",
        '          - "runner": deploy-box',
        "    runs-on: ${{ matrix.runner }}",
        "",
      ].join("\n"),
    ],
    [
      "a matrix key in another case that isn't hosted",
      "    strategy:\n      matrix:\n        Runner: [deploy-box]\n    runs-on: ${{ matrix.runner }}\n",
    ],
    [
      "a strategy that is an expression",
      "    strategy: ${{ fromJSON(inputs.strategy) }}\n    runs-on: ${{ matrix.runner }}\n",
    ],
    [
      "a reusable workflow of another repository",
      "    uses: example/repo/.github/workflows/deploy.yml@0123456789abcdef0123456789abcdef01234567\n",
    ],
  ])("refuses %s", (_, jobs) => {
    const result = check(`  a:\n${jobs}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(refusal);
  });

  it.each([
    ["a flow-style job", "  a: { runs-on: deploy-box, steps: [{ run: echo hi }] }\n"],
    ["a flow-style jobs mapping", "  { a: { 'runs-on': deploy-box } }\n"],
    [
      // The matrix rule reads the job's own matrix, never another job's.
      "a dynamic matrix beside another job that defines the same matrix key",
      [
        "  plan:",
        "    strategy:",
        "      matrix:",
        "        runner: [ubuntu-latest]",
        "    runs-on: ${{ matrix.runner }}",
        "  deploy:",
        "    needs: plan",
        "    strategy:",
        "      matrix: ${{ fromJSON(needs.plan.outputs.m) }}",
        "    runs-on: ${{ matrix.runner }}",
        "",
      ].join("\n"),
    ],
    [
      "a matrix that only another job defines",
      [
        "  a:",
        "    strategy:",
        "      matrix:",
        "        runner: [ubuntu-latest]",
        "    runs-on: ${{ matrix.runner }}",
        "  b:",
        "    runs-on: ${{ matrix.runner }}",
        "",
      ].join("\n"),
    ],
  ])("refuses %s", (_, jobs) => {
    const result = check(jobs);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(refusal);
  });

  it.each([
    ["a file that doesn't parse", "name: Sample\njobs:\n  a: [\n"],
    [
      "two documents",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n---\njobs:\n  b:\n    runs-on: deploy-box\n",
    ],
    ["a duplicate key", "jobs:\n  a:\n    runs-on: ubuntu-latest\n  a:\n    runs-on: deploy-box\n"],
    ["a file without jobs", "name: Sample\non: push\n"],
    ["a quoted jobs key", '"jobs":\n  a:\n    "runs-on": deploy-box\n'],
  ])("refuses %s", (_, source) => {
    const result = check(source, "workflow.yml", "");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(refusal);
  });

  it("checks .yaml files too", () => {
    expect(check("  a:\n    runs-on: self-hosted\n", "workflow.yaml").status).toBe(1);
  });

  it("reports the line of a finding", () => {
    const result = check("  a:\n    runs-on: ubuntu-latest\n  b:\n    'runs-on': deploy-box\n");
    expect(result.stderr).toContain("workflow.yml:7: job b: runs-on: deploy-box");
  });

  it("fails on a directory without workflows", () => {
    const empty = mkdtempSync(join(scratch, "empty-"));
    expect(run(empty).status).toBe(2);
    expect(run(join(scratch, "missing")).status).toBe(2);
  });
});
