import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/waypoint-mcp-server.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "bundle",
  minify: true,
  external: ["node:*"],
});

await build({
  entryPoints: ["src/launcher.ts"],
  outfile: "dist/launcher.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["node:*"],
  minify: true,
  banner: { js: "// Cached indefinitely by npx. Keep this launcher backward-compatible." },
});
