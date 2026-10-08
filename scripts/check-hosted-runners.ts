// Fails if a workflow of this repository could run on a self-hosted runner (D58). This repository
// is public and takes pull requests from forks, and a self-hosted runner attached to it would run
// whatever a workflow change asks for on the host; instances deploy from their own private ops
// repository instead (deploy/ops/deploy.yml.example, which isn't scanned).
//
//   node scripts/check-hosted-runners.ts          .github/workflows/ of this repository (CI's lint job)
//   node scripts/check-hosted-runners.ts DIR...   the workflow files (*.yml, *.yaml) in these directories
//
// Exits 1 when a workflow fails the check, and 2 for a directory that doesn't exist or holds no
// workflow.
//
// Each file is parsed as YAML (the `yaml` package), so quoted keys, flow mappings and aliases are
// read the way GitHub reads them. The rules:
//   - the file is one YAML document that parses without an error or a warning, with a `jobs`
//     mapping, and no merge key (`<<`) or complex key anywhere;
//   - keys are compared without case (as GitHub compares context names; refusing more is the safe
//     side), and a mapping may not hold two keys that differ only by case;
//   - `self-hosted` may not appear as a word in any key or value (a label, a matrix value, an
//     input), comments aside;
//   - every job either calls a reusable workflow of this repository (`uses: ./.github/workflows/
//     NAME.yml`, which is checked as a file of its own), or has a `runs-on` that is one
//     GitHub-hosted label (`HOSTED` below), or `${{ matrix.NAME }}` where the job's own
//     `strategy.matrix` spells out every value NAME can take (its NAME list and its `include`
//     entries), and each of them is such a label.
// Anything else is refused: a label list, a `group:`/`labels:` mapping, a matrix that is an
// expression (`${{ fromJSON(...) }}`) or has one where a NAME value could come from, any other
// expression, a reusable workflow of another repository (its jobs pick their own runners), and a
// lone label that isn't on GitHub's list (that is how self-hosted runners are selected), even one
// shaped like GitHub's (`ubuntu-99.99`). A Linux or Windows larger runner (selected by a runner
// group), or a new image label GitHub adds, needs a change to HOSTED.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LineCounter,
  type Node,
  type YAMLMap,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
} from "yaml";

/**
 * GitHub's hosted-runner image labels, spelled out: the standard runners (docs.github.com, "GitHub-
 * hosted runners") and the macOS larger runners. A pattern such as `ubuntu-\d+.\d+` would also
 * accept a label GitHub doesn't have (`ubuntu-99.99`), which only a self-hosted runner could carry.
 * A label GitHub adds is added here, and one it retires is removed (a self-hosted runner could carry
 * that too).
 */
const HOSTED: ReadonlySet<string> = new Set([
  "ubuntu-latest",
  "ubuntu-slim",
  "ubuntu-26.04",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-26.04-arm",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
  "windows-latest",
  "windows-2025",
  "windows-2025-vs2026",
  "windows-2022",
  "windows-11-arm",
  "windows-11-vs2026-arm",
  "macos-latest",
  "macos-26",
  "macos-15",
  "macos-14",
  "macos-26-intel",
  "macos-15-intel",
  "macos-latest-large",
  "macos-26-large",
  "macos-15-large",
  "macos-14-large",
  "macos-latest-xlarge",
  "macos-26-xlarge",
  "macos-15-xlarge",
  "macos-14-xlarge",
]);
const MATRIX_VALUE = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/;
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[^@\s]+\.ya?ml$/;

const root = fileURLToPath(new URL("..", import.meta.url));

/** A key's value (`null` when it has none), and where to report it. */
interface Field {
  at: unknown;
  value: Node | null;
}

function workflowFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // Reported below.
    }
    if (!isDir) {
      console.error(`check-hosted-runners: no such directory: ${dir}`);
      process.exit(2);
    }
    for (const name of readdirSync(dir).toSorted()) {
      const file = join(dir, name);
      if (/\.ya?ml$/.test(name) && statSync(file).isFile()) files.push(file);
    }
  }
  if (files.length === 0) {
    console.error(`check-hosted-runners: no workflow files in ${dirs.join(" ")}`);
    process.exit(2);
  }
  return files;
}

/** The findings for one workflow file, each `LINE: message`. */
function check(source: string): string[] {
  const findings: string[] = [];
  const lines = new LineCounter();
  const docs = parseAllDocuments(source, { lineCounter: lines, prettyErrors: false });
  const lineOf = (node: unknown): number =>
    isNode(node) && node.range ? lines.linePos(node.range[0]).line : 1;
  const report = (node: unknown, message: string) =>
    findings.push(`${String(lineOf(node))}: ${message}`);

  const [doc] = docs;
  if (docs.length !== 1 || !doc) return ["1: must hold exactly one YAML document"];
  for (const problem of [...doc.errors, ...doc.warnings]) {
    const at = lines.linePos(problem.pos[0]).line;
    findings.push(
      `${String(at)}: doesn't parse cleanly: ${problem.message.split("\n")[0] ?? problem.code}`,
    );
  }
  if (findings.length > 0) return findings;

  const deref = (node: unknown): Node | undefined => {
    const resolved: unknown = isAlias(node) ? node.resolve(doc) : node;
    return isNode(resolved) ? resolved : undefined;
  };
  const text = (node: unknown): string | undefined => {
    const n = deref(node);
    return isScalar(n) && typeof n.value === "string" ? n.value : undefined;
  };
  const keyOf = (node: unknown): string | undefined => {
    const n = deref(node);
    return isScalar(n) ? String(n.value).toLowerCase() : undefined;
  };
  /** A key's value: undefined without the key, and `null` for the key with no value. */
  const get = (map: YAMLMap, key: string): Field | undefined => {
    const pair = map.items.find((item) => keyOf(item.key) === key);
    return pair
      ? { at: deref(pair.value) ?? pair.key, value: deref(pair.value) ?? null }
      : undefined;
  };

  // Every mapping's keys, and every scalar's words.
  visit(doc, {
    Map(_, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const key = keyOf(pair.key);
        if (key === undefined) report(pair.key, "a complex key isn't allowed here");
        else if (key === "<<") report(pair.key, "a merge key (<<) isn't allowed here");
        else if (seen.has(key)) report(pair.key, `key ${key} appears twice (ignoring case)`);
        else seen.add(key);
      }
    },
    Scalar(_, scalar) {
      const words = String(scalar.value)
        .toLowerCase()
        .split(/[\s,[\]{}:"']+/);
      if (words.includes("self-hosted")) report(scalar, "names a self-hosted runner");
    },
  });

  const top = deref(doc.contents);
  const jobs = isMap(top) ? get(top, "jobs") : undefined;
  if (!isMap(jobs?.value)) {
    report(jobs?.at ?? top, "has no jobs mapping");
    return findings;
  }

  const label = (field: Field, what: string) => {
    const value = text(field.value);
    if (value === undefined) report(field.at, `${what} must be one GitHub-hosted label`);
    else if (!HOSTED.has(value)) report(field.at, `${what}: ${value} is not a GitHub-hosted label`);
  };

  for (const pair of jobs.value.items) {
    const id = keyOf(pair.key) ?? "?";
    const job = deref(pair.value);
    if (!isMap(job)) {
      report(job ?? pair.key, `job ${id} must be a mapping`);
      continue;
    }
    const uses = get(job, "uses");
    const runsOn = get(job, "runs-on");
    if (uses !== undefined) {
      const target = text(uses.value);
      if (target === undefined || !LOCAL_WORKFLOW.test(target))
        report(uses.at, `job ${id} calls a workflow outside this repository's .github/workflows`);
      if (runsOn === undefined) continue;
    }
    if (runsOn === undefined) {
      report(job, `job ${id} has no runs-on`);
      continue;
    }
    const value = text(runsOn.value);
    if (value === undefined) {
      report(
        runsOn.at,
        `job ${id}: runs-on must be one GitHub-hosted label, not a list or mapping`,
      );
      continue;
    }
    if (HOSTED.has(value)) continue;
    const ref = MATRIX_VALUE.exec(value);
    if (!ref?.[1]) {
      report(runsOn.at, `job ${id}: runs-on: ${value} is not a single GitHub-hosted label`);
      continue;
    }

    // ${{ matrix.NAME }}: every value NAME can take, from this job's own literal matrix.
    const name = ref[1].toLowerCase();
    if (name === "include" || name === "exclude") {
      report(runsOn.at, `job ${id}: runs-on: matrix.${name} isn't a matrix value`);
      continue;
    }
    const strategy = get(job, "strategy");
    const matrix = isMap(strategy?.value) ? get(strategy.value, "matrix") : undefined;
    if (!isMap(matrix?.value)) {
      report(
        (matrix ?? strategy ?? runsOn).at,
        `job ${id}: runs-on: matrix.${name} needs a strategy.matrix in this job that isn't an expression`,
      );
      continue;
    }
    let values = 0;
    for (const entry of matrix.value.items) {
      const key = keyOf(entry.key);
      const axis = deref(entry.value);
      const at = axis ?? entry.key;
      if (key === "include") {
        if (!isSeq(axis)) {
          report(at, `job ${id}: matrix include must be a list, not an expression`);
          continue;
        }
        for (const item of axis.items) {
          const combination = deref(item);
          if (!isMap(combination)) {
            report(combination ?? at, `job ${id}: matrix include entries must be mappings`);
            continue;
          }
          const override = get(combination, name);
          if (override === undefined) continue;
          values++;
          label(override, `job ${id}: matrix.${name}`);
        }
      } else if (key === name) {
        if (!isSeq(axis)) {
          report(at, `job ${id}: matrix.${name} must be a list, not an expression`);
          continue;
        }
        for (const item of axis.items) {
          values++;
          label({ at: deref(item) ?? at, value: deref(item) ?? null }, `job ${id}: matrix.${name}`);
        }
      }
      // exclude only removes combinations, and other axes don't reach runs-on.
    }
    if (values === 0)
      report(runsOn.at, `job ${id}: runs-on: matrix.${name} has no values in this job's matrix`);
  }
  return findings;
}

function main(args: string[]) {
  const files = workflowFiles(args.length > 0 ? args : [join(root, ".github/workflows")]);
  let failed = false;
  for (const file of files) {
    const shown = relative(root, file).startsWith("..") ? file : relative(root, file);
    let findings: string[];
    try {
      findings = check(readFileSync(file, "utf8"));
    } catch (error) {
      findings = [`1: can't be checked: ${error instanceof Error ? error.message : String(error)}`];
    }
    for (const finding of findings) console.error(`${shown}:${finding}`);
    if (findings.length > 0) failed = true;
  }
  if (failed) {
    console.error(
      "Workflows here must run on GitHub-hosted runners only (D58, docs/trust-model.md#deploy-pipeline).",
    );
    process.exit(1);
  }
}

main(process.argv.slice(2));
