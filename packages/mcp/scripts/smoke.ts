import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const tarball = fileURLToPath(new URL("../dist/waypoint-mcp.tgz", import.meta.url));
const runDir = await mkdtemp(join(tmpdir(), "waypoint-mcp-smoke-"));
const child = spawn("npx", ["-y", "--package", `file:${tarball}`, "waypoint-mcp"], {
  cwd: runDir,
  env: {
    ...process.env,
    WAYPOINT_URL: "http://127.0.0.1:1",
    npm_config_cache: "/tmp/npm-cache-waypoint",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
let errors = "";
child.stderr.on("data", (chunk: Buffer) => {
  errors += chunk.toString();
});
const messages: Array<Record<string, unknown>> = [];
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
  while (output.includes("\n")) {
    const index = output.indexOf("\n");
    const line = output.slice(0, index);
    output = output.slice(index + 1);
    if (line) messages.push(z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
  }
});
function send(message: Record<string, unknown>): void {
  child.stdin.write(JSON.stringify(message) + "\n");
}
async function waitFor(id: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 150; i++) {
    const message = messages.find((item) => item.id === id);
    if (message) return message;
    if (child.exitCode !== null) throw new Error(`MCP process exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for MCP response ${id}: ${errors}`);
}
try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  });
  const initialized = await waitFor(1);
  if (!initialized.result) throw new Error(`Initialize failed: ${JSON.stringify(initialized)}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await waitFor(2);
  const result = listed.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("tools" in result) ||
    !Array.isArray(result.tools) ||
    result.tools.length !== 8
  )
    throw new Error(`Expected eight tools: ${JSON.stringify(listed)}`);
  console.log(`MCP initialize and tools/list passed (${result.tools.length} tools)`);
} finally {
  child.kill();
  await rm(runDir, { recursive: true, force: true });
}
