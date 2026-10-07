import { WaypointError } from "./errors.js";
import { validatePath } from "./paths.js";
import { encodePath, withBase } from "./urls.js";

const tokenPattern = /^wps_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const publicIdPattern = /^[0-9a-hjkmnp-tv-z]{12}$/i;

export function isShareToken(token: string): boolean {
  return tokenPattern.test(token);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A random token. Writers now derive tokens with deriveShareToken; this remains for tests. */
export function newShareToken(): string {
  return `wps_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** 32 bytes as canonical base64url: 43 characters, with one trailing "=" tolerated. */
const shareTokenKeyPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]=?$/;

/**
 * Parses WAYPOINT_SHARE_TOKEN_KEY: exactly 32 bytes, base64url-encoded (43 characters, an
 * optional single "=" of padding, no whitespace). The error message never contains the value.
 */
export function parseShareTokenKey(text: string): Uint8Array {
  if (!shareTokenKeyPattern.test(text))
    throw new WaypointError(
      "validation_failed",
      "Share token key must be 32 bytes, base64url-encoded (43 characters)",
    );
  const binary = atob(text.replace(/=$/, "").replaceAll("-", "+").replaceAll("_", "/") + "=");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const hmacKeys = new WeakMap<Uint8Array, Promise<HmacKey>>();
function hmacKey(key: Uint8Array): Promise<HmacKey> {
  let imported = hmacKeys.get(key);
  if (!imported) {
    imported = crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    hmacKeys.set(key, imported);
  }
  return imported;
}

/**
 * Domain separation for the HMAC input, so the share token key can never produce a value
 * that means something else (D50). A new version would mint different tokens.
 */
export const SHARE_TOKEN_LABEL = "waypoint/share-token/v1\n";

/**
 * The share token of a link: `wps_` + base64url(HMAC-SHA256(key, utf8(SHARE_TOKEN_LABEL +
 * shareLinkId))). Any
 * writer holding the key can reproduce a link's URL from its ID; the database stores only
 * hashShareToken(token).
 */
export async function deriveShareToken(key: Uint8Array, shareLinkId: string): Promise<string> {
  if (key.byteLength !== 32)
    throw new WaypointError("validation_failed", "Share token key must be 32 bytes");
  if (!shareLinkId) throw new WaypointError("validation_failed", "Share link ID is required");
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(key),
    new TextEncoder().encode(SHARE_TOKEN_LABEL + shareLinkId),
  );
  return `wps_${base64url(new Uint8Array(mac))}`;
}

export async function hashShareToken(token: string): Promise<string> {
  if (!isShareToken(token)) throw new WaypointError("validation_failed", "Invalid share token");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function publicId(id: string): string {
  if (!publicIdPattern.test(id)) throw new WaypointError("validation_failed", "Invalid public ID");
  return id.toLowerCase();
}

export function shareShellUrl(
  base: string,
  token: string,
  collectionPublicId: string,
  revisionPublicId?: string,
  path?: string,
): string {
  if (!isShareToken(token)) throw new WaypointError("validation_failed", "Invalid share token");
  const revision = revisionPublicId ? `r/${publicId(revisionPublicId)}/` : "";
  return withBase(
    base,
    `/s/${token}/c/${publicId(collectionPublicId)}/${revision}${encodePath(path)}`,
  );
}

export function shareRawUrl(
  base: string,
  token: string,
  revisionPublicId: string,
  path: string,
): string {
  if (!isShareToken(token)) throw new WaypointError("validation_failed", "Invalid share token");
  return withBase(base, `/s/${token}/raw/r/${publicId(revisionPublicId)}/${encodePath(path)}`);
}

export type ShareRoute =
  | {
      kind: "shell";
      token: string;
      collectionPublicId: string;
      revisionPublicId?: string;
      path?: string;
    }
  | { kind: "raw"; token: string; revisionPublicId: string; path: string };

export function parseShareUrl(input: string): ShareRoute {
  if (!URL.canParse(input, "https://waypoint.invalid")) {
    throw new WaypointError("validation_failed", "Invalid share URL");
  }
  if (!input.startsWith("/") && !/^https?:\/\//i.test(input))
    throw new WaypointError("validation_failed", "Invalid share URL");
  const pathOnly = (input.split("#", 1)[0] ?? "").split("?", 1)[0] ?? "";
  const absolute = pathOnly.match(/^https?:\/\/[^/]*(\/.*)?$/i);
  const segments = (absolute ? (absolute[1] ?? "/") : pathOnly).split("/");
  if (segments[1] !== "s" || !isShareToken(segments[2] ?? ""))
    throw new WaypointError("validation_failed", "Invalid share URL");
  const token = segments[2] ?? "";
  const decodePath = (start: number): string | undefined => {
    const encoded = segments.slice(start).join("/");
    if (!encoded) return undefined;
    if (/%(?:2f|5c)/i.test(encoded)) throw new WaypointError("path_invalid", "Encoded separator");
    let decoded: string;
    try {
      decoded = segments.slice(start).map(decodeURIComponent).join("/");
    } catch {
      throw new WaypointError("path_invalid", "Invalid encoding");
    }
    if (decoded.split("/").some((part) => part === "." || part === ".." || !part))
      throw new WaypointError("path_invalid", "Invalid path");
    return validatePath(decoded);
  };
  if (segments[3] === "raw" && segments[4] === "r") {
    const path = decodePath(6);
    if (!path) throw new WaypointError("path_invalid", "Raw URL requires a path");
    return { kind: "raw", token, revisionPublicId: publicId(segments[5] ?? ""), path };
  }
  if (segments[3] !== "c") throw new WaypointError("validation_failed", "Invalid share URL");
  const collectionPublicId = publicId(segments[4] ?? "");
  if (segments[5] === "r" && publicIdPattern.test(segments[6] ?? "")) {
    const revisionPublicId = publicId(segments[6] ?? "");
    const path = decodePath(7);
    return path
      ? { kind: "shell", token, collectionPublicId, revisionPublicId, path }
      : { kind: "shell", token, collectionPublicId, revisionPublicId };
  }
  const path = decodePath(5);
  return path
    ? { kind: "shell", token, collectionPublicId, path }
    : { kind: "shell", token, collectionPublicId };
}
