import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const manifest = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(await readFile("package.json", "utf8")));
const stage = "dist/package";
await rm(stage, { recursive: true, force: true });
await mkdir(`${stage}/bin`, { recursive: true });
await copyFile("dist/waypoint-mcp.mjs", `${stage}/bin/waypoint-mcp.mjs`);
await chmod(`${stage}/bin/waypoint-mcp.mjs`, 0o755);
await writeFile(
  `${stage}/package.json`,
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      type: "module",
      engines: { node: ">=24" },
      bin: { "waypoint-mcp": "bin/waypoint-mcp.mjs" },
    },
    null,
    2,
  ) + "\n",
);
const destination = resolve("dist");
await new Promise<void>((done, fail) => {
  const child = spawn("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: stage,
    stdio: "ignore",
    env: { ...process.env, npm_config_cache: "/tmp/npm-cache-waypoint" },
  });
  child.on("error", fail);
  child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`npm pack exited ${code}`))));
});
await rename(`dist/waypoint-mcp-${manifest.version}.tgz`, "dist/waypoint-mcp.tgz");
