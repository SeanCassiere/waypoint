import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  sortImports: true,
  ignorePatterns: [
    "**/dist/**",
    "**/coverage/**",
    "**/node_modules/**",
    "pnpm-lock.yaml",
    "docs/**",
    "README.md",
    // Written by release-please, in its own style.
    "CHANGELOG.md",
  ],
});
