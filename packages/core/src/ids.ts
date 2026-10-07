import { TypeID, typeid } from "typeid-js";

import { brand } from "./brand.js";
import { WaypointError } from "./errors.js";

export const ID_PREFIXES = ["col", "rev", "shl", "grt", "aud", "cmt"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];
declare const collectionIdBrand: unique symbol;
declare const revisionIdBrand: unique symbol;
declare const publicIdBrand: unique symbol;
declare const shareLinkIdBrand: unique symbol;
declare const grantIdBrand: unique symbol;
declare const audienceIdBrand: unique symbol;
declare const commentIdBrand: unique symbol;
export type CollectionId = string & { readonly [collectionIdBrand]: true };
export type RevisionId = string & { readonly [revisionIdBrand]: true };
export type PublicId = string & { readonly [publicIdBrand]: true };
export type ShareLinkId = string & { readonly [shareLinkIdBrand]: true };
export type GrantId = string & { readonly [grantIdBrand]: true };
export type AudienceId = string & { readonly [audienceIdBrand]: true };
export type CommentId = string & { readonly [commentIdBrand]: true };
export type IdFor<P extends IdPrefix> = P extends "col"
  ? CollectionId
  : P extends "rev"
    ? RevisionId
    : P extends "shl"
      ? ShareLinkId
      : P extends "grt"
        ? GrantId
        : P extends "aud"
          ? AudienceId
          : CommentId;
const allowed = new Set<string>(ID_PREFIXES);
function isIdPrefix(value: string): value is IdPrefix {
  return allowed.has(value);
}
const MAX_TIMESTAMP = 0xffffffffffff;

export function newId<P extends Exclude<IdPrefix, "rev">>(prefix: P): IdFor<P>;
export function newId(prefix: IdPrefix): IdFor<Exclude<IdPrefix, "rev">> {
  if (!allowed.has(prefix) || prefix === "rev")
    throw new WaypointError("validation_failed", "Use mintRevisionId for revisions");
  return brand<IdFor<Exclude<IdPrefix, "rev">>>(typeid(prefix).toString());
}

function parsedId<P extends IdPrefix>(id: string, expectedPrefix: P): TypeID<P> {
  if (
    !allowed.has(expectedPrefix) ||
    !new RegExp(`^${expectedPrefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(id) ||
    id.length !== 30
  ) {
    throw new WaypointError("validation_failed", `Invalid ${expectedPrefix} ID`);
  }
  try {
    const parsed = TypeID.fromString(id, expectedPrefix);
    const bytes = parsed.toUUIDBytes();
    if ((bytes[6] ?? 0) >> 4 !== 7 || ((bytes[8] ?? 0) & 0xc0) !== 0x80 || parsed.toString() !== id)
      throw new Error("Invalid UUIDv7");
    return parsed;
  } catch {
    throw new WaypointError("validation_failed", `Invalid ${expectedPrefix} ID`);
  }
}
export function parseId<P extends IdPrefix>(id: string, expectedPrefix: P): IdFor<P> {
  parsedId(id, expectedPrefix);
  return brand<IdFor<P>>(id);
}
export function idTimestamp(id: string): number {
  const prefix = id.slice(0, 3);
  if (!isIdPrefix(prefix)) throw new WaypointError("validation_failed", "Unknown ID prefix");
  const bytes = parsedId(id, prefix).toUUIDBytes();
  return bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0);
}
export function mintRevisionId({ now, parentId }: { now: number; parentId?: string }): RevisionId {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP)
    throw new WaypointError("validation_failed", "Invalid revision timestamp");
  const timestamp = Math.max(
    now,
    parentId === undefined ? 0 : idTimestamp(parseId(parentId, "rev")) + 1,
  );
  if (timestamp > MAX_TIMESTAMP)
    throw new WaypointError("validation_failed", "Invalid revision timestamp");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 5, value = timestamp; i >= 0; i--) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return brand<RevisionId>(TypeID.fromUUIDBytes("rev", bytes).toString());
}
export function validateClientId(
  id: string,
  { prefix, now, parentId }: { prefix: "col" | "rev"; now: number; parentId?: string },
): void {
  if (!Number.isSafeInteger(now))
    throw new WaypointError("validation_failed", "Invalid current timestamp");
  parseId(id, prefix);
  const timestamp = idTimestamp(id);
  if (timestamp > now + 5 * 60_000)
    throw new WaypointError("clock_skew", "ID timestamp is too far in the future");
  if (timestamp < now - 7 * 24 * 60 * 60_000)
    throw new WaypointError("stale_id", "ID timestamp is too old");
  if (parentId !== undefined) {
    if (prefix !== "rev")
      throw new WaypointError("validation_failed", "Only revisions have parents");
    const parentTimestamp = idTimestamp(parseId(parentId, "rev"));
    if (id <= parentId)
      throw new WaypointError("id_before_parent", "Revision ID must sort after parent", {
        parent_timestamp: parentTimestamp,
      });
  }
}
const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
export async function publicIdFor(id: CollectionId | RevisionId): Promise<PublicId> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
  );
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
      if (result.length === 12) return brand<PublicId>(result);
    }
    value &= (1 << bits) - 1;
  }
  throw new WaypointError("validation_failed", "Failed to derive public ID");
}
export function displayNumbers(revisionIds: readonly RevisionId[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(revisionIds)].toSorted().map((id, index) => [id, index + 1]),
  );
}
