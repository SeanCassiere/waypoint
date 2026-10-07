import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  sortImports: true,
  ignorePatterns: [
    "**/dist/**",
    "**/coverage/**",
    "spikes/**",
    "**/node_modules/**",
    "pnpm-lock.yaml",
    "docs/**",
    "README.md",
  ],
});
