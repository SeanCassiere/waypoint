import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  BucketError,
  ENVIRONMENT_MARKER_KEY,
  EnvironmentCheckedBucket,
  MemoryBucket,
  R2Bucket,
  openBucket,
} from "../src/bucket.ts";
import { loadConfig } from "../src/config.ts";

const marker = (environment: string) =>
  new TextEncoder().encode(JSON.stringify({ format_version: 1, environment }));
const read = (bucket: MemoryBucket): unknown =>
  JSON.parse(new TextDecoder().decode(bucket.objects.get(ENVIRONMENT_MARKER_KEY)));

describe("bucket environment marker", () => {
  it("writes a missing marker (existing buckets have none) and then serves requests", async () => {
    const inner = new MemoryBucket();
    inner.objects.set("blobs/sha256/aa", new Uint8Array([1]));
    const bucket = new EnvironmentCheckedBucket(inner, "prod", () => 1234);
    expect(await bucket.head("blobs/sha256/aa")).toBe(true);
    expect(read(inner)).toEqual({ format_version: 1, environment: "prod", created_at: 1234 });
    await bucket.put("k", new Uint8Array([2]));
    expect(inner.objects.get("k")).toEqual(new Uint8Array([2]));
  });
  it("checks once per process after a match", async () => {
    const inner = new MemoryBucket();
    inner.objects.set(ENVIRONMENT_MARKER_KEY, marker("dev"));
    let heads = 0;
    const head = inner.head.bind(inner);
    inner.head = (key) => {
      if (key === ENVIRONMENT_MARKER_KEY) heads++;
      return head(key);
    };
    const bucket = new EnvironmentCheckedBucket(inner, "dev");
    await Promise.all([
      bucket.list("manifests/"),
      bucket.head("x"),
      bucket.put("y", new Uint8Array()),
    ]);
    await bucket.delete("y");
    expect(heads).toBe(1);
  });
  it("refuses every request against another environment's bucket", async () => {
    const inner = new MemoryBucket();
    inner.objects.set(ENVIRONMENT_MARKER_KEY, marker("prod"));
    inner.objects.set("collections/col_x.json", new Uint8Array([1]));
    const bucket = new EnvironmentCheckedBucket(inner, "dev");
    const mismatch = {
      kind: "account",
      message: "Environment mismatch: bucket is marked prod, config is dev",
    };
    await expect(bucket.put("blobs/sha256/bb", new Uint8Array([1]))).rejects.toMatchObject(
      mismatch,
    );
    await expect(bucket.get("collections/col_x.json")).rejects.toMatchObject(mismatch);
    const pages = async () => {
      const seen: string[] = [];
      for await (const page of bucket.listPages("collections/")) seen.push(...page);
      return seen;
    };
    await expect(pages()).rejects.toBeInstanceOf(BucketError);
    expect(inner.objects.has("blobs/sha256/bb")).toBe(false);
    // The marker is never overwritten.
    expect(read(inner)).toEqual({ format_version: 1, environment: "prod" });
  });
  it("treats an unreadable marker as an account error", async () => {
    const inner = new MemoryBucket();
    inner.objects.set(ENVIRONMENT_MARKER_KEY, new TextEncoder().encode("not json"));
    await expect(new EnvironmentCheckedBucket(inner, "dev").head("x")).rejects.toMatchObject({
      kind: "account",
      message: `Bucket environment marker ${ENVIRONMENT_MARKER_KEY} is unreadable`,
    });
  });
  it("retries the check after a transient failure", async () => {
    const inner = new MemoryBucket();
    const bucket = new EnvironmentCheckedBucket(inner, "dev");
    inner.fail = new BucketError("offline", "transient");
    await expect(bucket.head("x")).rejects.toMatchObject({ kind: "transient" });
    delete inner.fail;
    expect(await bucket.head("x")).toBe(false);
    expect(read(inner)).toMatchObject({ environment: "dev" });
  });
  it("lets a caller's signal stop waiting for the check without failing it for others", async () => {
    const inner = new MemoryBucket();
    inner.objects.set(ENVIRONMENT_MARKER_KEY, marker("dev"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const head = inner.head.bind(inner);
    inner.head = async (key) => {
      if (key === ENVIRONMENT_MARKER_KEY) await gate;
      return head(key);
    };
    const bucket = new EnvironmentCheckedBucket(inner, "dev");
    const controller = new AbortController();
    const stopped = bucket.put("a", new Uint8Array([1]), controller.signal);
    const other = bucket.put("b", new Uint8Array([2]));
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ kind: "transient", code: "AbortError" });
    release();
    await other;
    expect(inner.objects.has("a")).toBe(false);
    expect(inner.objects.get("b")).toEqual(new Uint8Array([2]));
    await expect(bucket.head("a", AbortSignal.abort())).rejects.toMatchObject({
      code: "AbortError",
    });
  });
  it("doesn't start a check for an already-aborted caller", async () => {
    const inner = new MemoryBucket();
    inner.fail = new BucketError("offline", "transient");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const bucket = new EnvironmentCheckedBucket(inner, "prod");
      await expect(bucket.delete("x", AbortSignal.abort())).rejects.toMatchObject({
        code: "AbortError",
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      // The next caller still runs (and sees) the check.
      await expect(bucket.delete("x")).rejects.toMatchObject({ message: "offline" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  it("lets the first of two racing environments win", async () => {
    const inner = new MemoryBucket();
    const results = await Promise.allSettled([
      new EnvironmentCheckedBucket(inner, "dev").head("x"),
      new EnvironmentCheckedBucket(inner, "prod").head("x"),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  });
});

/** A minimal S3-compatible store: path-style GET, HEAD and PUT (with If-None-Match: *). */
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});
async function fakeS3() {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; url: string; authorization: string }[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        url,
        authorization: req.headers.authorization ?? "",
      });
      const key = new URL(url, "http://s3").pathname;
      const body = objects.get(key);
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && body) {
          res.writeHead(412, { "content-type": "application/xml" });
          res.end("<Error><Code>PreconditionFailed</Code></Error>");
          return;
        }
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
        return;
      }
      if (!body) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(req.method === "GET" ? body : undefined);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { objects, requests, endpoint: `http://127.0.0.1:${address.port}` };
}

describe("S3-compatible endpoint", () => {
  it("talks path-style to WAYPOINT_S3_ENDPOINT, signs for WAYPOINT_S3_REGION, and marks the bucket", async () => {
    const s3 = await fakeS3();
    const config = loadConfig({
      WAYPOINT_ENV: "prod",
      WAYPOINT_BASE_URL: "https://writer.example.test",
      TURSO_DATABASE_URL: "libsql://db.example.test",
      TURSO_AUTH_TOKEN: "token",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "SECRETSECRET",
      R2_BUCKET: "notes",
      WAYPOINT_S3_ENDPOINT: `${s3.endpoint}/`,
      WAYPOINT_S3_REGION: "us-east-1",
    });
    const bucket = openBucket(config);
    await bucket.put("manifests/rev_x.json", new TextEncoder().encode("{}"));
    expect(s3.objects.get(`/notes/${ENVIRONMENT_MARKER_KEY}`)?.toString()).toContain(
      '"environment":"prod"',
    );
    expect(s3.objects.get("/notes/manifests/rev_x.json")?.toString()).toBe("{}");
    expect(s3.requests.map((r) => `${r.method} ${new URL(r.url, "http://s3").pathname}`)).toEqual([
      `HEAD /notes/${ENVIRONMENT_MARKER_KEY}`,
      `PUT /notes/${ENVIRONMENT_MARKER_KEY}`,
      `HEAD /notes/${ENVIRONMENT_MARKER_KEY}`,
      `GET /notes/${ENVIRONMENT_MARKER_KEY}`,
      "PUT /notes/manifests/rev_x.json",
    ]);
    expect(s3.requests.every((r) => r.authorization.includes("/us-east-1/s3/aws4_request"))).toBe(
      true,
    );
    // A dev writer pointed at the same store is refused before it reads or writes anything else.
    const dev = new EnvironmentCheckedBucket(
      new R2Bucket({ ...config, environment: "dev" }),
      "dev",
    );
    s3.requests.length = 0;
    await expect(dev.get("manifests/rev_x.json")).rejects.toMatchObject({ kind: "account" });
    expect(s3.requests.some((r) => r.url.includes("manifests/"))).toBe(false);
  });
  it("defaults to the R2 account endpoint", () => {
    const config = loadConfig({
      WAYPOINT_ENV: "dev",
      WAYPOINT_BASE_URL: "https://writer.example.test",
      TURSO_DATABASE_URL: "libsql://db.example.test",
      TURSO_AUTH_TOKEN: "token",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "SECRETSECRET",
      R2_BUCKET: "anything",
    });
    expect(config.s3Endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    const { s3Endpoint: _endpoint, r2AccountId: _account, ...bare } = config;
    expect(() => new R2Bucket(bare)).toThrow("WAYPOINT_S3_ENDPOINT or R2_ACCOUNT_ID is required");
  });
});
