// deploy/lib/reader-config.mjs: the Wrangler config each reader target deploys with.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "deploy/lib/reader-config.mjs");
const template = join(root, "apps/reader/wrangler.jsonc");
const target = [
  "--name",
  "example-reader",
  "--domain",
  "share.example.com",
  "--dataset",
  "example_access",
  "--ratelimit-namespace",
  "4242",
];

function render(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("reader config generator", () => {
  it("renders a target's config from the committed template", () => {
    const main = join(root, "apps/reader/dist/index.js");
    const result = render(["--template", template, "--main", main, ...target]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const config: unknown = JSON.parse(result.stdout);
    const committed = readFileSync(template, "utf8");
    const date = /"compatibility_date": "([^"]+)"/.exec(committed)?.[1];
    expect(config).toEqual({
      name: "example-reader",
      main,
      no_bundle: true,
      compatibility_date: date,
      observability: { enabled: false },
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "share.example.com", custom_domain: true }],
      analytics_engine_datasets: [{ binding: "ACCESS_LOG", dataset: "example_access" }],
      ratelimits: [
        {
          name: "TOKEN_MISS_LIMITER",
          namespace_id: "4242",
          simple: { limit: 30, period: 60 },
        },
      ],
    });
    const on = render(["--template", template, "--main", main, ...target, "--workers-dev", "true"]);
    expect(JSON.parse(on.stdout) as unknown).toMatchObject({
      workers_dev: true,
      preview_urls: false,
    });
  });

  it("keeps the committed template generic", () => {
    const committed = readFileSync(template, "utf8");
    expect(committed).not.toMatch(/"env"\s*:/);
    expect(committed).not.toMatch(/"routes"\s*:/);
    expect(committed).toMatch(/"workers_dev": false/);
    expect(committed).toMatch(/"preview_urls": false/);
  });

  it("refuses bad targets and templates it doesn't understand", () => {
    const main = "/srv/reader/index.js";
    for (const [flag, value] of [
      ["--domain", "Share.Example.com"],
      ["--domain", "share.example.com/x"],
      ["--name", "Bad_Name"],
      ["--dataset", "bad-dataset"],
      ["--ratelimit-namespace", "12a"],
      ["--workers-dev", "yes"],
    ]) {
      const args = ["--template", template, "--main", main, ...target, flag!, value!];
      const result = render(args);
      expect(result.status, `${flag} ${value}`).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect(render(["--template", template, "--main", "dist/index.js", ...target]).status).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "reader-config-"));
    const extra = join(dir, "wrangler.jsonc");
    writeFileSync(
      extra,
      readFileSync(template, "utf8").replace('"main"', '"kv_namespaces": [],\n  "main"'),
    );
    const result = render(["--template", extra, "--main", main, ...target]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kv_namespaces");
  });
});
