import type { ReaderEnv } from "./app.ts";

/**
 * The bucket's base URL for signed S3 requests, path-style (`<endpoint>/<bucket>`), so it works
 * with R2, MinIO and most S3-compatible stores. WAYPOINT_S3_ENDPOINT overrides Cloudflare R2's
 * `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, the same as the writer.
 */
export function bucketBaseUrl(env: ReaderEnv): string {
  let endpoint: string;
  if (env.WAYPOINT_S3_ENDPOINT) {
    const url = new URL(env.WAYPOINT_S3_ENDPOINT);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("WAYPOINT_S3_ENDPOINT must be an HTTP URL without credentials or query");
    endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } else {
    // An account ID is a hostname label; anything else would send the signed request elsewhere.
    if (!env.R2_ACCOUNT_ID || !/^[A-Za-z0-9-]{1,63}$/.test(env.R2_ACCOUNT_ID))
      throw new Error("R2_ACCOUNT_ID or WAYPOINT_S3_ENDPOINT is required");
    endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  return `${endpoint}/${encodeURIComponent(env.R2_BUCKET)}`;
}

/** The signed URL for a content-addressed blob, or null for anything that isn't a hash. */
export function blobUrl(env: ReaderEnv, hash: string): string | null {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) return null;
  return `${bucketBaseUrl(env)}/blobs/sha256/${hash.slice(7)}`;
}

/** A zero-key listing: proves the credentials can read the bucket, returns nothing. */
export function probeUrl(env: ReaderEnv): string {
  return `${bucketBaseUrl(env)}?list-type=2&max-keys=0`;
}
