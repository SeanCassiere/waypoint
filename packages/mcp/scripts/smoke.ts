import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const tarball = fileURLToPath(new URL("../dist/waypoint-mcp.tgz", import.meta.url));
const bundle = await readFile(new URL("../dist/waypoint-mcp-server.mjs", import.meta.url));
// The license and third-party notices travel with both artifacts (docs/decisions.md D57): at the
// head of the server bundle, which the writer serves on its own, and in the launcher package.
const notices = await Promise.all(
  ["LICENSE", "THIRD_PARTY_NOTICES.md"].map(async (file) =>
    (await readFile(new URL(`../../../${file}`, import.meta.url), "utf8")).trim(),
  ),
);
const banner = `/*!\n${notices.join("\n\n").replaceAll("*/", "*\\/")}\n*/`;
if (
  !bundle
    .toString("utf8")
    .replace(/^#!.*\n/, "")
    .startsWith(banner)
)
  throw new Error("The server bundle doesn't start with LICENSE and THIRD_PARTY_NOTICES.md");
const packed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  if (!packed.includes(`package/${file}`)) throw new Error(`The launcher package lacks ${file}`);
const marked = Buffer.concat([bundle, Buffer.from("\n// fake writer smoke marker\n")]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const runDir = await mkdtemp(join(tmpdir(), "waypoint-mcp-smoke-"));
const cache = join(runDir, "bundle-cache");
let server: ReturnType<typeof createServer> | undefined;
const packageServer = createServer((_request, response) => {
  response.setHeader("content-type", "application/octet-stream");
  void readFile(tarball).then(
    (bytes) => response.end(bytes),
    () => response.writeHead(500).end(),
  );
});
await new Promise<void>((resolve) => packageServer.listen(0, "127.0.0.1", resolve));
const packageAddress = packageServer.address();
if (!packageAddress || typeof packageAddress === "string")
  throw new Error("No package server address");
const packagePort = packageAddress.port;
let port = 0;
let mismatch = false;
async function startWriter(): Promise<void> {
  server = createServer((request, response) => {
    if (request.url === "/mcp/server.mjs") {
      response.setHeader("X-Waypoint-Content-SHA256", mismatch ? "0".repeat(64) : sha(marked));
      response.setHeader("ETag", `"sha256-${sha(marked)}"`);
      response.end(marked);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server?.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fake writer address");
  port = address.port;
}
async function stopWriter(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
async function run(label: string, expectedSource: string, cacheDir = cache): Promise<void> {
  console.log(`Starting ${label}`);
  const child = spawn(
    "npx",
    ["--prefer-offline", "-y", `http://127.0.0.1:${packagePort}/mcp/waypoint-mcp.tgz`],
    {
      cwd: runDir,
      env: {
        ...process.env,
        WAYPOINT_URL: `http://127.0.0.1:${port}`,
        WAYPOINT_MCP_CACHE_DIR: cacheDir,
        npm_config_cache: join(runDir, `npm-${label}`),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  const messages: Array<Record<string, unknown>> = [];
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    while (output.includes("\n")) {
      const index = output.indexOf("\n");
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      if (line) messages.push(z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    }
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify(message) + "\n");
  async function waitFor(id: number): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const message = messages.find((item) => item.id === id);
      if (message) return message;
      if (child.exitCode !== null) throw new Error(`${label}: MCP exited: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: timeout: ${errors}`);
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
    if (!(await waitFor(1)).result) throw new Error(`${label}: initialization failed`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await waitFor(2);
    const tools = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(listed.result).tools;
    const names = tools.map((tool) => tool.name);
    const expected = [
      "create_collection",
      "add_revision",
      "get_collection",
      "search_collections",
      "wait_for_revision",
      "list_revisions",
      "read_file",
      "resolve_url",
      "waypoint_status",
    ];
    if (
      JSON.stringify(names) !== JSON.stringify(expected) ||
      !errors.includes(`using ${expectedSource} bundle`)
    )
      throw new Error(`${label}: expected ${expectedSource} and ${expected.join(", ")}: ${errors}`);
    console.log(`${label}: ${expectedSource}, ${tools.length} tools`);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
  }
}
try {
  await startWriter();
  await run("fresh", "fresh");
  await stopWriter();
  await run("cached", "cache");
  await run("embedded", "embedded", join(runDir, "empty-cache"));
  mismatch = true;
  await startWriter();
  await run("mismatch", "embedded", join(runDir, "mismatch-cache"));
} finally {
  if (server) await stopWriter();
  await new Promise<void>((resolve) => packageServer.close(() => resolve()));
  await rm(runDir, { recursive: true, force: true });
}
