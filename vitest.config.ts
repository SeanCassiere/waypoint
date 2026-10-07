import { configDefaults, defineConfig } from "vitest/config";

const include = [
  "tests/**/*.test.ts",
  "packages/*/tests/**/*.test.ts",
  "apps/*/tests/**/*.test.ts",
];
// CPU-budget and wall-clock tests measure time, which a saturated machine inflates, so each
// group runs alone after every other test has finished: the reader's CPU budgets, then the
// writer's diff limits (which load worker threads of their own).
const cpu = ["tests/reader-cpu.test.ts"];
const timing = ["tests/compare-limits.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include, exclude: [...configDefaults.exclude, ...cpu, ...timing] },
      },
      { extends: true, test: { name: "cpu", include: cpu, sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: "timing", include: timing, sequence: { groupOrder: 2 } } },
    ],
  },
});
