import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "oxc", "vitest"],
  categories: { correctness: "error", suspicious: "error", perf: "warn" },
  options: { typeAware: true, typeCheck: true },
  ignorePatterns: [
    "**/dist/**",
    "**/coverage/**",
    "**/.tools/**",
    "**/node_modules/**",
    "packages/core/tests/fixtures/core-denied-import/**",
  ],
  rules: {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    "typescript/restrict-template-expressions": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "typescript/require-await": "error",
  },
  overrides: [
    {
      files: ["packages/core/src/**", "packages/ui/src/**", "apps/reader/src/**"],
      rules: { "import/no-nodejs-modules": "error" },
    },
    {
      files: ["tests/**", "*/*/tests/**"],
      rules: { "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "code"] }] },
    },
    { files: ["packages/core/tests/fixtures/**"], rules: { "import/no-unassigned-import": "off" } },
  ],
});
