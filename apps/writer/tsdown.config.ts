import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";
import { z } from "zod";

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});
const manifest = (directory: URL): z.infer<typeof Manifest> =>
  Manifest.parse(JSON.parse(readFileSync(new URL("package.json", directory), "utf8")));

// The @waypoint/* packages (devDependencies) are inlined from their dist; npm dependencies stay
// external and are installed next to the bundle (`pnpm deploy`). So the writer must depend on
// every npm package an inlined workspace package uses, with the same version spec.
const writer = manifest(new URL("./", import.meta.url));
const seen = new Set<string>();
function checkInlined(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  const inlined = manifest(new URL(`./node_modules/${name}/`, import.meta.url));
  for (const [dependency, spec] of Object.entries(inlined.dependencies ?? {})) {
    if (dependency.startsWith("@waypoint/")) checkInlined(dependency);
    else if (writer.dependencies?.[dependency] !== spec)
      throw new Error(
        `@waypoint/writer must depend on ${dependency}@${spec}, like the inlined ${name}`,
      );
  }
}
for (const name of Object.keys(writer.devDependencies ?? {}))
  if (name.startsWith("@waypoint/")) checkInlined(name);

// The server: dist/main.js, plus the two worker-thread entries it starts from the same
// directory (src/layout.ts, @waypoint/render). The viewer's browser assets in dist/viewer/ are
// built separately (`build:viewer`, viewer.build.ts), so cleaning leaves them alone.
export default defineConfig({
  entry: {
    main: "src/main.ts",
    "compare-worker": "src/compare-worker.ts",
    "render-worker": "src/render-worker.ts",
  },
  platform: "node",
  target: "node24",
  fixedExtension: false,
  dts: false,
  clean: ["dist/*", "!dist/viewer"],
  // Nothing from node_modules is bundled: an npm package the writer doesn't declare fails here.
  deps: { onlyBundle: [] },
});
