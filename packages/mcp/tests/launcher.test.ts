import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { cacheDirectory, candidates, launch, normalizedUrl } from "../src/launcher.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "waypoint-launcher-test-"));
  dirs.push(root);
  const embeddedPath = join(root, "embedded.mjs");
  await writeFile(
    embeddedPath,
    "export const LAUNCHER_API=1; export async function startServer() {}",
  );
  const env = { WAYPOINT_URL: "https://example.test/base/", WAYPOINT_MCP_CACHE_DIR: root };
  return { root, embeddedPath, env, dir: cacheDirectory(normalizedUrl(env.WAYPOINT_URL), env) };
}
const response = (body: string, sha = hash(body), status = 200) =>
  new Response(status === 304 ? null : body, {
    status,
    headers: { "X-Waypoint-Content-SHA256": sha, ETag: `"sha256-${sha}"` },
  });
it("isolates URLs, preserves paths, and never writes stdout", async () => {
  const { env, embeddedPath } = await setup();
  expect(normalizedUrl(env.WAYPOINT_URL)).toBe("https://example.test/base");
  expect(cacheDirectory("https://example.test/base", env)).not.toBe(
    cacheDirectory("https://example.test/other", env),
  );
  const out = vi.spyOn(process.stdout, "write");
  const fetcher = vi.fn<typeof fetch>((url) => {
    expect(url).toBe("https://example.test/base/mcp/server.mjs");
    return Promise.resolve(
      response("export const LAUNCHER_API=1; export async function startServer() {}"),
    );
  });
  try {
    await launch({ env, embeddedPath, fetcher });
    expect(out).not.toHaveBeenCalled();
  } finally {
    out.mockRestore();
  }
});
it("does not reuse a bundle cached for a different WAYPOINT_URL", async () => {
  const { env, embeddedPath } = await setup();
  await candidates({ env, embeddedPath, fetcher: () => Promise.resolve(response("// remote A")) });
  const other = { ...env, WAYPOINT_URL: "https://example.test/other" };
  const selected = await candidates({
    env: other,
    embeddedPath,
    fetcher: () => Promise.reject(new Error("offline")),
  });
  expect(selected[0]?.source).toBe("embedded");
});
it("sends ETag, accepts 304, validates the cached bytes and metadata", async () => {
  const { env, embeddedPath, dir } = await setup();
  const body = "export const LAUNCHER_API=1; export async function startServer() {}";
  const first = await candidates({
    env,
    embeddedPath,
    fetcher: () => Promise.resolve(response(body)),
  });
  expect(first[0]?.source).toBe("fresh");
  const metadata = z
    .object({ sha256: z.string(), etag: z.string(), fetched_at: z.string() })
    .parse(JSON.parse(await readFile(join(dir, "current.json"), "utf8")) as unknown);
  expect(metadata).toMatchObject({ sha256: hash(body), etag: `"sha256-${hash(body)}"` });
  expect(metadata.fetched_at).toBeTruthy();
  const second = await candidates({
    env,
    embeddedPath,
    fetcher: (_url, init) => {
      expect(new Headers(init?.headers).get("If-None-Match")).toBe(metadata.etag);
      return Promise.resolve(response("", hash(body), 304));
    },
  });
  expect(second[0]?.source).toBe("cache");
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
it("rejects mismatches and timeouts, then uses cache or embedded", async () => {
  const { env, embeddedPath } = await setup();
  const body = "export const LAUNCHER_API=1; export async function startServer() {}";
  await candidates({ env, embeddedPath, fetcher: () => Promise.resolve(response(body)) });
  expect(
    (
      await candidates({
        env,
        embeddedPath,
        fetcher: () => Promise.resolve(response("bad", hash(body))),
      })
    )[0]?.source,
  ).toBe("cache");
  expect(
    (
      await candidates({
        env,
        embeddedPath,
        timeoutMs: 10,
        fetcher: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            });
          }),
      })
    )[0]?.source,
  ).toBe("cache");
  expect(
    (
      await candidates({
        env: { ...env, WAYPOINT_MCP_CACHE_DIR: `${env.WAYPOINT_MCP_CACHE_DIR}/empty` },
        embeddedPath,
        fetcher: () => Promise.resolve(response("bad", hash(body))),
      })
    )[0]?.source,
  ).toBe("embedded");
});
it("retains at most three bundles", async () => {
  const { env, embeddedPath, dir } = await setup();
  for (let i = 0; i < 5; i++)
    await candidates({
      env,
      embeddedPath,
      fetcher: () => Promise.resolve(response(`// bundle ${i}`)),
    });
  expect((await readdir(dir)).filter((name) => name.endsWith(".mjs"))).toHaveLength(3);
});
it("skips incompatible and broken imports, and pinning skips fetch", async () => {
  const { env, embeddedPath } = await setup();
  const incompatible = "export const LAUNCHER_API=2; export async function startServer() {}";
  const broken = "this is not javascript";
  expect(
    (await launch({ env, embeddedPath, fetcher: () => Promise.resolve(response(incompatible)) }))
      .source,
  ).toBe("embedded");
  expect(
    (await launch({ env, embeddedPath, fetcher: () => Promise.resolve(response(broken)) })).source,
  ).toBe("embedded");
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await launch({ env: { ...env, WAYPOINT_MCP_PIN: "embedded" }, embeddedPath, fetcher })).source,
  ).toBe("embedded");
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps a verified fresh bundle usable when the cache is unwritable", async () => {
  const { root, env, embeddedPath } = await setup();
  const blocked = join(root, "blocked");
  await writeFile(blocked, "not a directory");
  const body = "export const LAUNCHER_API=1; export async function startServer() {}";
  const selected = await launch({
    env: { ...env, WAYPOINT_MCP_CACHE_DIR: blocked },
    embeddedPath,
    fetcher: () => Promise.resolve(response(body)),
  });
  expect(selected.source).toBe("fresh");
  expect(selected.sha).toBe(hash(body));
  expect(existsSync(selected.path)).toBe(false);
});

it("does not attach another server after startServer rejects", async () => {
  const { env, embeddedPath } = await setup();
  const failing =
    'export const LAUNCHER_API=1; export async function startServer() { throw new Error("start failed") }';
  await writeFile(
    embeddedPath,
    'export const LAUNCHER_API=1; export async function startServer() { throw new Error("embedded started") }',
  );
  await expect(
    launch({ env, embeddedPath, fetcher: () => Promise.resolve(response(failing)) }),
  ).rejects.toThrow("start failed");
});

it("warns for plain HTTP away from loopback and ts.net", async () => {
  const { env, embeddedPath } = await setup();
  const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await candidates({
      env: { ...env, WAYPOINT_URL: "http://example.com" },
      embeddedPath,
      fetcher: () => Promise.reject(new Error("offline")),
    });
    expect(
      written.mock.calls.some((call) =>
        String(call[0]).includes("warning: WAYPOINT_URL uses plain HTTP"),
      ),
    ).toBe(true);
    written.mockClear();
    await candidates({
      env: { ...env, WAYPOINT_URL: "http://127.0.0.1:7410" },
      embeddedPath,
      fetcher: () => Promise.reject(new Error("offline")),
    });
    expect(
      written.mock.calls.some((call) =>
        String(call[0]).includes("warning: WAYPOINT_URL uses plain HTTP"),
      ),
    ).toBe(false);
  } finally {
    written.mockRestore();
  }
});

it("survives concurrent starts while the writer changes bundles and cache pruning races", async () => {
  const { env, embeddedPath } = await setup();
  const versions = Array.from(
    { length: 9 },
    (_, i) => `export const LAUNCHER_API=1; export async function startServer() {} // version ${i}`,
  );
  const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const started = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        launch({
          env,
          embeddedPath,
          fetcher: () =>
            Promise.resolve(response(versions[i % versions.length] ?? versions[0] ?? "")),
        }),
      ),
    );
    expect(started).toHaveLength(200);
    expect(started.every((item) => ["fresh", "cache", "embedded"].includes(item.source))).toBe(
      true,
    );
  } finally {
    written.mockRestore();
  }
});
