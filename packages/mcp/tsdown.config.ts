import { defineConfig } from "tsdown";

// The MCP server bundle (dist/waypoint-mcp-server.mjs): one self-contained, minified ESM file
// that the writer serves at /mcp/server.mjs and the launcher imports. Every dependency is bundled,
// so they're all devDependencies. The launcher (dist/launcher.mjs) stays on esbuild
// (esbuild.config.ts): npx caches it indefinitely, so its build must not change.
export default defineConfig({
  entry: { "waypoint-mcp-server": "src/cli.ts" },
  platform: "node",
  target: "node24",
  minify: true,
  dts: false,
  deps: { onlyBundle: false },
  outputOptions: { codeSplitting: false },
});
