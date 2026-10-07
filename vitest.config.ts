import { configDefaults, defineConfig } from "vitest/config";

const include = [
  "tests/**/*.test.ts",
  "packages/*/tests/**/*.test.ts",
  "apps/*/tests/**/*.test.ts",
];
// CPU-budget tests measure thread CPU time, which a saturated machine inflates, so they run in a
// second group after every other test has finished.
const cpu = ["tests/reader-cpu.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include, exclude: [...configDefaults.exclude, ...cpu] },
      },
      { extends: true, test: { name: "cpu", include: cpu, sequence: { groupOrder: 1 } } },
    ],
  },
});
