import { brand } from "./brand.ts";
import { WaypointError } from "./errors.ts";

declare const contentHashBrand: unique symbol;
export type ContentHash = string & { readonly [contentHashBrand]: true };
export async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<ContentHash> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return brand<ContentHash>(
    `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}
export function isContentHash(value: string): value is ContentHash {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
export function contentHashHex(hash: ContentHash): string {
  if (!isContentHash(hash)) throw new WaypointError("validation_failed", "Invalid content hash");
  return hash.slice(7);
}
