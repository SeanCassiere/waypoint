import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript source (the `@waypoint/source` export
// condition), so tests never need a build. The rest are Vitest's default server conditions
// (Vite's without `module`). Vitest also passes them to its test processes as `--conditions`.
const conditions = ["@waypoint/source", "node", "development|production"];

/**
 * The Vitest config of a workspace package: its `tests/**\/*.test.ts` files (or `include`). `timing` files
 * measure CPU or wall-clock time, which a saturated machine inflates, so they're a project of
 * their own (`vitest run --project timing`, turbo's `test:timing`) that runs alone, after every
 * other test; `vitest run --project unit` (turbo's `test`) runs the rest.
 */
export function packageTests({
  include = ["tests/**/*.test.ts"],
  timing = [],
}: { include?: string[]; timing?: string[] } = {}): ViteUserConfig {
  return defineConfig({
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            include,
            exclude: [...configDefaults.exclude, ...timing],
          },
        },
        ...(timing.length ? [{ extends: true, test: { name: "timing", include: timing } }] : []),
      ],
    },
  });
}
