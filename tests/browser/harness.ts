// Shared harness for the real-Chromium suites. The runners (tests/viewer-browser.ts and
// tests/reader-browser.ts) run every scenario file in tests/browser/viewer/ or
// tests/browser/reader/: the numbered baseline files first, then one file per item, named after
// its ID. Browser-side code stays strings: this package type-checks without the DOM lib.
import strict from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";

import { createReaderApp, type ReaderEnv } from "../../apps/reader/src/app.ts";
import { waypointMigrations } from "../../apps/writer/src/migrations.ts";
import { SHARD_WEIGHTS } from "./shard-weights.ts";
import { assignShards, parseShard } from "./shards.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// Assertions -------------------------------------------------------------------------------------

let assertions = 0;
const wrapped = new Map<PropertyKey, unknown>();
/** node:assert/strict, counting every call made through it (direct calls and every method). */
export const assert: typeof strict = new Proxy(strict, {
  apply(target, thisArg: unknown, args: unknown[]): unknown {
    assertions += 1;
    return Reflect.apply(target, thisArg, args);
  },
  get(target, property, receiver): unknown {
    const value: unknown = Reflect.get(target, property, receiver);
    // assert.strict is node:assert/strict itself: hand back this counting proxy.
    if (value === target) return receiver;
    if (typeof value !== "function" || property === "AssertionError") return value;
    if (!wrapped.has(property))
      wrapped.set(
        property,
        new Proxy(value, {
          apply(method, thisArg: unknown, args: unknown[]): unknown {
            assertions += 1;
            return Reflect.apply(method, thisArg, args);
          },
        }),
      );
    return wrapped.get(property);
  },
});
export function assertionCount(): number {
  return assertions;
}

// Pages ------------------------------------------------------------------------------------------

export interface PageOptions {
  width?: number; // default 1280
  height?: number; // default 800
  touch?: boolean; // hasTouch; default false
  mobile?: boolean; // isMobile (mobile viewport meta, mobile UA); default false
  colorScheme?: "light" | "dark";
  reducedMotion?: "reduce" | "no-preference";
  forcedColors?: "active" | "none";
}
/** The spot-check viewports. */
export const VIEWPORTS: {
  readonly desktop: { readonly width: 1280; readonly height: 800; readonly touch: false };
  readonly tablet: { readonly width: 820; readonly height: 1180; readonly touch: true };
  readonly phone: { readonly width: 390; readonly height: 844; readonly touch: true };
} = {
  desktop: { width: 1280, height: 800, touch: false },
  tablet: { width: 820, height: 1180, touch: true },
  phone: { width: 390, height: 844, touch: true },
};

export interface ScenarioContext {
  readonly browser: Browser;
  /** Script errors; the runner fails the run if any are recorded. */
  readonly pageErrors: string[];
  /** A new browser context (clipboard-read/-write granted) and page; its page errors are recorded
   *  as "<scenario file>: <message>". Per-scenario only: closed by the runner when the calling
   *  scenario ends, so never use it for a context shared across scenarios (see _baseline.ts). */
  newPage(options?: PageOptions): Promise<{ context: BrowserContext; page: Page }>;
  /** Record a page's errors (for pages a scenario opens itself). */
  watchErrors(page: Page, label?: string): void;
}
export interface ViewerContext extends ScenarioContext {
  /** The suite's shared writer (see startWriter's defaults). Other scenarios add data to it. */
  readonly writer: WriterHandle;
}
export type ReaderContext = ScenarioContext;
export interface Scenario<C extends ScenarioContext> {
  readonly name: string;
  run(ctx: C): Promise<void>;
}
export type ViewerScenario = Scenario<ViewerContext>;
export type ReaderScenario = Scenario<ReaderContext>;

// Writers ----------------------------------------------------------------------------------------

export type WriteResult = { collection_id: string; url: string; latest_url: string };
function writeResult(value: unknown): WriteResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("collection_id" in value) ||
    !("url" in value) ||
    !("latest_url" in value) ||
    typeof value.collection_id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.latest_url !== "string"
  )
    throw new Error("Invalid write result");
  return { collection_id: value.collection_id, url: value.url, latest_url: value.latest_url };
}
export interface FileRef {
  path: string;
  hash: string;
  mime?: string;
}
export interface WriterHandle {
  readonly base: string; // http://127.0.0.1:<port>
  readonly dataDir: string;
  logs(): string; // the child's stderr and stdout so far
  /** PUT /api/blobs/<sha256>; asserts 200 (a counted assertion, as today); mime only when given. */
  write(path: string, content: string | Uint8Array, mime?: string): Promise<FileRef>;
  /** POST JSON; throws `API <status>: <body>` unless 200; validates the write result. */
  api(path: string, body: object): Promise<WriteResult>;
  /** fetch relative to base. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `url` every `interval` ms until it answers 200, at most `attempts` times. */
async function waitForOk(
  url: string,
  attempts: number,
  interval: number,
  logs: () => string,
  what: string,
): Promise<void> {
  if (attempts === 0) throw new Error(`${what} did not boot: ${logs()}`);
  try {
    if ((await fetch(url)).ok) return;
  } catch {
    /* booting */
  }
  await delay(interval);
  return waitForOk(url, attempts - 1, interval, logs, what);
}

/** A child process's stdout and stderr, and a stop that sends SIGTERM and awaits its exit. */
function supervise(child: ChildProcess): { logs: () => string; stop: () => Promise<void> } {
  let output = "";
  const append = (chunk: unknown) => {
    output += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let stopping: Promise<void> | undefined;
  return {
    logs: () => output,
    stop() {
      stopping ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
      })();
      return stopping;
    },
  };
}

function writerHandle(base: string, dataDir: string, child: ChildProcess): WriterHandle {
  const { logs, stop: stopChild } = supervise(child);
  let stopping: Promise<void> | undefined;
  const handle: WriterHandle = {
    base,
    dataDir,
    logs,
    async write(path, content, mime) {
      const bytes = Buffer.from(content);
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const response = await fetch(`${base}/api/blobs/${hash}`, { method: "PUT", body: bytes });
      assert.equal(response.status, 200);
      return mime === undefined ? { path, hash } : { path, hash, mime };
    },
    async api(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status !== 200)
        throw new Error(`API ${response.status}: ${await response.text()}`);
      return writeResult(await response.json());
    },
    fetch: (path, init) => fetch(`${base}${path}`, init),
    stop() {
      stopping ??= (async () => {
        await stopChild();
        await rm(dataDir, { recursive: true, force: true });
      })();
      return stopping;
    },
  };
  onCleanup(() => handle.stop());
  return handle;
}

/** The built writer (apps/writer/dist/main.js) on a free port and a fresh mkdtemp data dir, with
 *  WAYPOINT_ENV=dev, WAYPOINT_SYNC=off, WAYPOINT_PUBLIC_BASE_URL=https://reader-dev.example.test,
 *  WAYPOINT_SHARE_TOKEN_KEY=KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio (32 bytes of 42), plus env. */
export async function startWriter(options?: {
  env?: Record<string, string>;
}): Promise<WriterHandle> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-viewer-browser-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(repo, "apps/writer/dist/main.js")], {
    env: {
      ...process.env,
      WAYPOINT_ENV: "dev",
      WAYPOINT_SYNC: "off",
      WAYPOINT_DATA_DIR: dir,
      WAYPOINT_PORT: String(port),
      WAYPOINT_PUBLIC_BASE_URL: "https://reader-dev.example.test",
      // A fixed test key (never a real one): 32 bytes of 42.
      WAYPOINT_SHARE_TOKEN_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio",
      ...options?.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writer = writerHandle(base, dir, child);
  await waitForOk(`${base}/healthz`, 100, 50, () => writer.logs(), "Writer");
  return writer;
}

/** `process.execPath tsx/cli <args>` from the repository root (tsx is a root devDependency). */
function spawnTsx(args: string[], env?: Record<string, string>): ChildProcess {
  const cli = createRequire(join(repo, "package.json")).resolve("tsx/cli");
  return spawn(process.execPath, [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** scripts/demo-writer.ts (from source, through tsx) on a free port and a fresh data dir: the seeded
 *  demo (fork, failed #6, uploading #7, share links in every state, Trash). Ready when /healthz is. */
export async function startDemoWriter(options?: {
  env?: Record<string, string>;
}): Promise<WriterHandle> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-demo-browser-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawnTsx(
    [
      "--tsconfig",
      "apps/writer/tsconfig.json",
      "--conditions=@waypoint/source",
      "scripts/demo-writer.ts",
      String(port),
      dir,
    ],
    options?.env,
  );
  const writer = writerHandle(base, dir, child);
  // Seeding takes seconds.
  await waitForOk(`${base}/healthz`, 600, 100, () => writer.logs(), "Demo writer");
  return writer;
}

/** scripts/demo-reader.ts over a writer's data dir. */
export async function startDemoReader(
  writerDataDir: string,
  port?: number,
): Promise<{ readonly origin: string; stop(): Promise<void> }> {
  const listen = port ?? (await freePort());
  const origin = `http://127.0.0.1:${listen}`;
  const child = spawnTsx([
    "--tsconfig",
    "apps/reader/tsconfig.json",
    "--conditions=@waypoint/source",
    "scripts/demo-reader.ts",
    String(listen),
    writerDataDir,
  ]);
  const { logs, stop } = supervise(child);
  onCleanup(stop);
  await waitForOk(`${origin}/`, 200, 100, logs, "Demo reader");
  return { origin, stop };
}

// Readers ----------------------------------------------------------------------------------------

/** The reader env the existing reader suite uses (fake cloud values; RAW_CAP_KEY = 32 zero bytes). */
export const READER_TEST_ENV: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

/** In-memory node:sqlite DB with every waypointMigrations entry applied. */
export function readerTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of waypointMigrations) db.exec(m.sql);
  return db;
}

/** The reader's raw capability for a link and revision under READER_TEST_ENV's key
 *  (HMAC-SHA256 over `${linkId}\n${revisionPublicId}`, base64url, first 22 chars). */
export function rawCap(linkId: string, revisionPublicId: string): string {
  return createHmac("sha256", Buffer.alloc(32))
    .update(`${linkId}\n${revisionPublicId}`)
    .digest("base64url")
    .slice(0, 22);
}

export interface ReaderHandle {
  readonly origin: string;
  /** The Referer header of every request served. */
  readonly referers: string[];
  stop(): Promise<void>;
}

/** Closes a server and its open connections. */
function closeServer(server: {
  close(callback: () => void): unknown;
  closeAllConnections?: () => void;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** createReaderApp over a fixture DB and blob function, served on 127.0.0.1:0 with READER_TEST_ENV. */
export async function startReader(options: {
  db: DatabaseSync;
  blob: (hash: string) => Response | Promise<Response>;
  now?: () => number;
}): Promise<ReaderHandle> {
  const { db, blob, now } = options;
  const app = createReaderApp({
    db: () => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      all: (sql, args = []) => Promise.resolve(db.prepare(sql).all(...args) as never),
    }),
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: (hash) => Promise.resolve(blob(hash)),
    }),
    ...(now ? { now } : {}),
  });
  const referers: string[] = [];
  const listening = Promise.withResolvers<number>();
  const server = serve(
    {
      fetch: (req) => {
        referers.push(req.headers.get("referer") ?? "");
        return app.fetch(req, READER_TEST_ENV);
      },
      port: 0,
      hostname: "127.0.0.1",
    },
    (info) => listening.resolve(info.port),
  );
  const origin = `http://127.0.0.1:${await listening.promise}`;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= closeServer(server));
  onCleanup(stop);
  return { origin, referers, stop };
}

/** A plain HTTP server on 127.0.0.1:0 (a second origin: hostile documents, framing pages,
 *  popups). Registered with onCleanup. */
export async function startHttpServer(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<{ readonly origin: string; readonly port: number; stop(): Promise<void> }> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no port");
  const port = address.port;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= closeServer(server));
  onCleanup(stop);
  return { origin: `http://127.0.0.1:${port}`, port, stop };
}

// Page helpers -----------------------------------------------------------------------------------

/** Browser-side expression: is the popover open? (today's openState). */
export function openState(id: string): string {
  return `document.getElementById(${JSON.stringify(id)})?.matches(":popover-open") === true`;
}

/** Collects "<type>: <text>" console lines and "pageerror: <message>" from a page. */
export function collectConsole(page: Page): string[] {
  const log: string[] = [];
  page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  return log;
}

/** The lines of a collected log that report a CSP refusal or a page error. */
export function cspProblems(log: readonly string[]): string[] {
  return log.filter((l) => /Content Security Policy|Refused|pageerror/i.test(l));
}

// axe-core ---------------------------------------------------------------------------------------

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; html: string }[];
}
const axeViolations = z.array(
  z.object({
    id: z.string(),
    impact: z
      .string()
      .nullish()
      .transform((impact) => impact ?? null),
    help: z.string(),
    nodes: z.array(
      z.object({
        // A target inside shadow DOM is a list of selectors, outermost first.
        target: z.array(
          z.union([z.string(), z.array(z.string()).transform((path) => path.join(" >>> "))]),
        ),
        html: z.string(),
      }),
    ),
  }),
);
let axeSource: Promise<string> | undefined;
/** Runs axe-core on the page's top document (iframes: false). Default: the wcag2a, wcag2aa,
 *  wcag21a and wcag21aa tags. `rules` runs only those rule IDs; `enable` also turns on rules the
 *  selected tags or rule IDs leave out; `include` scopes it. (axe-core 4.14 runs
 *  "label-content-name-mismatch" under wcag21a, so the default tags include it.) */
export async function axe(
  page: Page,
  options?: { include?: string; tags?: string[]; rules?: string[]; enable?: string[] },
): Promise<AxeViolation[]> {
  axeSource ??= readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  // CDP evaluation, so the page's CSP doesn't block the injected source.
  await page.evaluate(await axeSource);
  const runOnly = options?.rules
    ? { type: "rule", values: options.rules }
    : { type: "tag", values: options?.tags ?? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] };
  const runOptions = {
    iframes: false,
    resultTypes: ["violations"],
    runOnly,
    ...(options?.enable
      ? { rules: Object.fromEntries(options.enable.map((id) => [id, { enabled: true }])) }
      : {}),
  };
  const context = options?.include === undefined ? "document" : JSON.stringify(options.include);
  const result = await page.evaluate(
    `axe.run(${context}, ${JSON.stringify(runOptions)}).then((r) => JSON.stringify(r.violations))`,
  );
  return axeViolations.parse(JSON.parse(String(result)));
}

// Cleanup and the runner -------------------------------------------------------------------------

const cleanups: (() => unknown)[] = [];
/** An Android Chrome user agent for the running Chromium version (what a phone sends). */
function mobileUserAgent(version: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`;
}

/** Register cleanup; the runner runs every registered function in reverse order, even on failure. */
export function onCleanup(fn: () => unknown): void {
  cleanups.push(fn);
}
async function runCleanups(): Promise<void> {
  for (const fn of cleanups.splice(0).toReversed()) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Cleanups run in reverse order, one at a time.
      await fn();
    } catch (error) {
      console.error("cleanup failed:", error);
    }
  }
}

// A reader scenario takes less than a ViewerContext, so every scenario accepts one.
function isScenarioModule(value: unknown): value is { default: Scenario<ViewerContext> } {
  if (!value || typeof value !== "object" || !("default" in value)) return false;
  const scenario = value.default;
  return (
    !!scenario &&
    typeof scenario === "object" &&
    "name" in scenario &&
    typeof scenario.name === "string" &&
    "run" in scenario &&
    typeof scenario.run === "function"
  );
}

/** For the two runners only (scenarios never call it): runs the selected scenario files of
 *  tests/browser/<kind>/ against one Chromium (and, for the viewer, one shared writer). */
export async function runSuite(kind: "viewer" | "reader", args: string[]): Promise<void> {
  const directory = fileURLToPath(new URL(`./${kind}/`, import.meta.url));
  const stems = (await readdir(directory))
    .filter((file) => file.endsWith(".ts") && !file.startsWith("_"))
    .map((file) => file.slice(0, -3))
    .toSorted();
  const unknown = args.filter((stem) => !stems.includes(stem));
  if (unknown.length > 0) {
    console.error(`Unknown scenario: ${unknown.join(", ")}\nAvailable:\n  ${stems.join("\n  ")}`);
    process.exit(2);
  }
  const baseline = /^\d\d-/;
  // BROWSER_SHARD=i/n runs one CI shard of the suite (shards.ts): the baseline stays together.
  const shard = parseShard(process.env.BROWSER_SHARD);
  if (shard && args.length > 0) {
    console.error("BROWSER_SHARD and scenario names don't combine: pass one or the other");
    process.exit(2);
  }
  // A baseline file runs after every baseline file before it (they share state); an item alone.
  const selected = shard
    ? (assignShards(stems, SHARD_WEIGHTS[kind], shard.count)[shard.index - 1] ?? [])
    : args.length === 0
      ? stems
      : stems.filter((stem) =>
          args.some(
            (arg) => arg === stem || (baseline.test(arg) && baseline.test(stem) && stem < arg),
          ),
        );
  if (shard) console.log(`Shard ${shard.index}/${shard.count}: ${selected.join(", ") || "(none)"}`);
  const scenarios: { stem: string; scenario: Scenario<ViewerContext> }[] = [];
  const pageErrors: string[] = [];
  let writer: WriterHandle | undefined;
  let failed = false;
  try {
    // Inside the try, so a module that fails to load still runs every registered cleanup.
    for (const stem of selected) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Modules load in order, before any run.
      const module: unknown = await import(pathToFileURL(join(directory, `${stem}.ts`)).href);
      if (!isScenarioModule(module))
        throw new Error(`tests/browser/${kind}/${stem}.ts: the default export isn't a scenario`);
      scenarios.push({ stem, scenario: module.default });
    }

    // Playwright's own Chromium (`pnpm exec playwright install chromium`), or CHROME_PATH.
    const executablePath = process.env.CHROME_PATH;
    const browser =
      kind === "viewer"
        ? await chromium.launch({
            ...(executablePath ? { executablePath } : {}),
            headless: true,
            args: ["--no-sandbox"],
          })
        : await chromium.launch();
    onCleanup(() => browser.close());
    if (kind === "viewer") writer = await startWriter();
    for (const { stem, scenario } of scenarios) {
      const opened: BrowserContext[] = [];
      const watchErrors = (page: Page, label = `${stem}.ts`) =>
        page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
      const ctx: ViewerContext = {
        browser,
        pageErrors,
        async newPage(options) {
          const context = await browser.newContext({
            viewport: { width: options?.width ?? 1280, height: options?.height ?? 800 },
            hasTouch: options?.touch ?? false,
            isMobile: options?.mobile ?? false,
            // isMobile alone keeps Chromium's desktop user agent; a mobile page also needs a mobile UA.
            ...(options?.mobile ? { userAgent: mobileUserAgent(browser.version()) } : {}),
            ...(options?.colorScheme ? { colorScheme: options.colorScheme } : {}),
            ...(options?.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
            ...(options?.forcedColors ? { forcedColors: options.forcedColors } : {}),
            permissions: ["clipboard-read", "clipboard-write"],
          });
          opened.push(context);
          const page = await context.newPage();
          watchErrors(page);
          return { context, page };
        },
        watchErrors,
        get writer(): WriterHandle {
          if (!writer) throw new Error("The reader suite has no shared writer");
          return writer;
        },
      };
      const started = performance.now();
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Scenarios run one at a time, in order.
        await scenario.run(ctx);
        console.log(`✓ ${stem} — ${scenario.name} (${Math.round(performance.now() - started)} ms)`);
      } catch (error) {
        console.log(`✗ ${stem} — ${scenario.name}`);
        console.error(error);
        if (writer) console.error(`Writer logs (last 4 KB):\n${writer.logs().slice(-4096)}`);
        failed = true;
        break;
      } finally {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The scenario's own contexts close before the next runs.
        await Promise.all(opened.map((context) => context.close().catch(() => undefined)));
      }
    }
    if (!failed) {
      if (pageErrors.length > 0) throw new Error(`Script errors:\n${pageErrors.join("\n")}`);
      console.log(
        `Chromium ${kind}: ${scenarios.length} scenarios, ${assertionCount()} assertions: passed`,
      );
    }
  } catch (error) {
    console.error(error);
    if (writer) console.error(`Writer logs (last 4 KB):\n${writer.logs().slice(-4096)}`);
    failed = true;
  } finally {
    await runCleanups();
  }
  if (failed) process.exitCode = 1;
}
