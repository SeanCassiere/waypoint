import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { R2Bucket, bucketError } from "../apps/writer/src/bucket.ts";
import type { Config } from "../apps/writer/src/config.ts";

let server: Server,
  bucket: R2Bucket,
  port: number,
  mode = "ok",
  requests: Array<{
    method: string;
    headers: Record<string, string | undefined>;
    url: string;
    body: Buffer;
  }>;
const config: Config = {
  environment: "dev",
  dataDir: "/tmp/unused",
  baseUrl: "http://localhost:7410",
  port: 7410,
  queueGiveUpHours: 72,
  maxBlobBytes: 1024,
  sync: true,
  tursoUrl: "http://localhost:1",
  tursoAuthToken: "test",
  r2AccountId: "acct",
  r2AccessKeyId: "AKIDEXAMPLE",
  r2SecretAccessKey: "SECRETSECRET",
  r2Bucket: "waypoint-dev",
};
function errorXml(status: number, code: string): string {
  return `<?xml version="1.0"?><Error><Code>${code}</Code><Message>test</Message></Error>`;
}
async function consume(stream: Readable): Promise<string> {
  let value = "";
  for await (const chunk of stream) value += String(chunk);
  return value;
}
beforeEach(async () => {
  mode = "ok";
  requests = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers))
        headers[key] = typeof value === "string" ? value : undefined;
      requests.push({
        method: req.method ?? "",
        headers,
        url: req.url ?? "",
        body: Buffer.concat(chunks),
      });
      if (mode === "stall") return;
      if (mode === "midbody" && req.method === "GET") {
        res.writeHead(200, { "content-length": "10" });
        res.write("hello");
        return;
      }
      const failures: Record<string, [number, string]> = {
        precondition: [412, "PreconditionFailed"],
        throttle: [429, "TooManyRequests"],
        timeout: [400, "RequestTimeout"],
        conflict: [409, "ConditionalRequestConflict"],
        denied: [403, "AccessDenied"],
        server: [503, "SlowDown"],
      };
      const failure = failures[mode];
      if (failure) {
        res.writeHead(failure[0], { "content-type": "application/xml" });
        res.end(errorXml(failure[0], failure[1]));
        if (mode === "throttle") mode = "ok";
        return;
      }
      if (req.method === "GET" && req.url?.includes("list-type=2")) {
        const token = new URL(req.url, "http://localhost").searchParams.get("continuation-token");
        const start = token ? 1000 : 0;
        const keys = Array.from(
          { length: token ? 5 : 1000 },
          (_, index) =>
            `<Contents><Key>manifests/rev_${String(start + index).padStart(26, "0")}.json</Key></Contents>`,
        ).join("");
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>${token ? "false" : "true"}</IsTruncated>${keys}${token ? "" : "<NextContinuationToken>next</NextContinuationToken>"}</ListBucketResult>`,
        );
        return;
      }
      res.writeHead(200);
      res.end(req.method === "GET" ? "hello" : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  port = address.port;
  bucket = new R2Bucket(config, {
    endpoint: `http://127.0.0.1:${port}`,
    requestTimeoutMs: 100,
    retryDelay: () => 1,
    readTimeoutMs: 80,
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe("R2 adapter over S3 HTTP", () => {
  it("sends conditional streaming PUT with SHA256 checksum and length", async () => {
    const body = Buffer.from("hello");
    const checksum = createHash("sha256").update(body).digest("base64");
    await bucket.putIfAbsent("blobs/sha256/aa", () => Readable.from([body]), {
      contentType: "application/octet-stream",
      contentLength: body.length,
      checksumSHA256: checksum,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/waypoint-dev/blobs/sha256/aa");
    expect(requests[0]?.headers["if-none-match"]).toBe("*");
    expect(requests[0]?.headers["x-amz-checksum-sha256"]).toBe(checksum);
    expect(requests[0]?.headers["content-length"]).toBe("5");
    expect(requests[0]?.body.toString()).toBe("hello");
    expect(requests[0]?.headers["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
  });
  it("accepts 412 and retries a 429 once", async () => {
    mode = "precondition";
    await expect(
      bucket.putIfAbsent("k", Buffer.from("x"), { contentType: "x", contentLength: 1 }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    mode = "throttle";
    requests = [];
    await bucket.putIfAbsent("k", Buffer.from("x"), { contentType: "x", contentLength: 1 });
    expect(requests).toHaveLength(2);
  });
  it.each([
    ["timeout", "transient"],
    ["conflict", "transient"],
    ["server", "transient"],
    ["denied", "account"],
  ] as const)("classifies %s as %s", async (m, kind) => {
    mode = m;
    await expect(bucket.put("k", Buffer.from("x"))).rejects.toMatchObject({ kind });
  });
  it("times out a stalled request", async () => {
    mode = "stall";
    await expect(bucket.put("k", Buffer.from("x"))).rejects.toMatchObject({ kind: "transient" });
  });
  it("times out a stalled GET body and permits a later read", async () => {
    mode = "midbody";
    const first = await bucket.get("k");
    await expect(consume(first)).rejects.toMatchObject({ kind: "transient" });
    mode = "ok";
    await expect(consume(await bucket.get("k"))).resolves.toBe("hello");
  });
  it.each([
    [401, "Unauthorized", "account"],
    [403, "RequestTimeTooSkewed", "account"],
    [403, "UnknownError", "account"],
    [404, "NoSuchBucket", "account"],
    [404, "NoSuchKey", "permanent"],
    [400, "BadDigest", "permanent"],
  ] as const)("classifies %s %s as %s", (status, code, kind) => {
    const error = Object.assign(new Error(code), {
      name: code,
      $metadata: { httpStatusCode: status },
    });
    expect(bucketError(error).kind).toBe(kind);
  });
  it("lists more than 1000 keys through continuation tokens", async () => {
    const keys = await bucket.list("manifests/");
    expect(keys).toHaveLength(1005);
    expect(requests).toHaveLength(2);
  });
});
