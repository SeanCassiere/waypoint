#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MCP_LAUNCHER_API } from "@waypoint/core";

import { startServer } from "./index.js";

export const LAUNCHER_API = MCP_LAUNCHER_API;
export { startServer };

function isMain(): boolean {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}
if (isMain())
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
