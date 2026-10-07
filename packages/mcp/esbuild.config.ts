import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/waypoint-mcp.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "bundle",
  minify: true,
  external: ["node:*"],
});
