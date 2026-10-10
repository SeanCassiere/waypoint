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
    // Written by scripts/third-party-notices.ts.
    "THIRD_PARTY_NOTICES.md",
    // Written by release-please, in its own style.
    "CHANGELOG.md",
  ],
});
