import { brand } from "./brand.js";
import { WaypointError } from "./errors.js";
import type { PublicId } from "./ids.js";
import { validatePath } from "./paths.js";

export type WriterUrl =
  | { kind: "latest"; collectionPublicId: PublicId; path?: string }
  | {
      kind: "pinned";
      collectionPublicId: PublicId;
      revisionPublicId: PublicId;
      path?: string;
    }
  | { kind: "raw"; revisionPublicId: PublicId; path: string };
const publicIdPattern = /^[0-9a-hjkmnp-tv-z]{12}$/i;
function publicId(id: string): PublicId {
  if (!publicIdPattern.test(id)) throw new WaypointError("validation_failed", "Invalid public ID");
  return brand<PublicId>(id.toLowerCase());
}
export function encodePath(path?: string): string {
  return path === undefined ? "" : validatePath(path).split("/").map(encodeURIComponent).join("/");
}
export function withBase(base: string, route: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new WaypointError("validation_failed", "Invalid writer base URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new WaypointError("validation_failed", "Invalid writer base URL");
  if (
    base.includes("?") ||
    base.includes("#") ||
    /^https?:\/\/[^/?#]*@/i.test(base) ||
    url.username ||
    url.password
  )
    throw new WaypointError(
      "validation_failed",
      "Writer base URL must not contain credentials, query, or fragment",
    );
  const prefix = url.pathname.split("/").map(decodeSegment);
  if (
    prefix.some(
      (segment, index) =>
        (segment === "c" && publicIdPattern.test(prefix[index + 1] ?? "")) ||
        (segment === "raw" && prefix[index + 1] === "r"),
    )
  )
    throw new WaypointError("validation_failed", "Ambiguous writer base URL");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${route}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
export function latestCollectionUrl(
  base: string,
  collectionPublicId: string,
  path?: string,
): string {
  return withBase(base, `/c/${publicId(collectionPublicId)}/${encodePath(path)}`);
}
export function pinnedRevisionUrl(
  base: string,
  collectionPublicId: string,
  revisionPublicId: string,
  path?: string,
): string {
  return withBase(
    base,
    `/c/${publicId(collectionPublicId)}/r/${publicId(revisionPublicId)}/${encodePath(path)}`,
  );
}
export function rawUrl(base: string, revisionPublicId: string, path: string): string {
  return withBase(base, `/raw/r/${publicId(revisionPublicId)}/${encodePath(path)}`);
}
function rawPathOf(input: string): string {
  const withoutFragment = input.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const scheme = withoutQuery.match(/^https?:\/\/[^/]*(\/.*)?$/i);
  return scheme ? (scheme[1] ?? "/") : withoutQuery;
}
function decodeSegment(segment: string): string {
  if (/%(?:2f|5c)/i.test(segment))
    throw new WaypointError("path_invalid", "Encoded separator in URL path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new WaypointError("path_invalid", "Malformed URL encoding");
  }
  if (segment.includes("%") && (decoded === "." || decoded === ".."))
    throw new WaypointError("path_invalid", "Encoded traversal segment");
  return decoded;
}
export function parseWriterUrl(input: string): WriterUrl {
  if (
    !/^https?:\/\/[^/?#\\]+(?:\/|$)/i.test(input) &&
    !(input.startsWith("/") && !input.startsWith("//") && !input.startsWith("/\\"))
  )
    throw new WaypointError("validation_failed", "Invalid writer URL form");
  let url: URL;
  try {
    url = new URL(input, "http://waypoint.invalid");
  } catch {
    throw new WaypointError("validation_failed", "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new WaypointError("validation_failed", "Invalid URL scheme");
  const rawSegments = rawPathOf(input).split("/");
  const segments = rawSegments.map(decodeSegment);
  const decodePath = (start: number): string | undefined => {
    const rest = segments.slice(start);
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return undefined;
    if (rest.some((segment) => !segment))
      throw new WaypointError("path_invalid", "Invalid URL path");
    return validatePath(rest.join("/"));
  };
  for (let i = 1; i < segments.length; i++) {
    const collectionCandidate = segments[i + 1];
    const revisionCandidate = segments[i + 3];
    if (segments[i] === "c" && collectionCandidate && publicIdPattern.test(collectionCandidate)) {
      const collectionPublicId = publicId(collectionCandidate);
      if (segments[i + 2] === "r" && revisionCandidate) {
        const revisionPublicId = publicId(revisionCandidate);
        const path = decodePath(i + 4);
        return path === undefined
          ? { kind: "pinned", collectionPublicId, revisionPublicId }
          : { kind: "pinned", collectionPublicId, revisionPublicId, path };
      }
      const path = decodePath(i + 2);
      return path === undefined
        ? { kind: "latest", collectionPublicId }
        : { kind: "latest", collectionPublicId, path };
    }
    if (segments[i] === "raw" && segments[i + 1] === "r" && segments[i + 2]) {
      const revisionPublicId = publicId(segments[i + 2] ?? "");
      const path = decodePath(i + 3);
      if (path === undefined) throw new WaypointError("path_invalid", "Raw URL requires a path");
      return { kind: "raw", revisionPublicId, path };
    }
  }
  throw new WaypointError("validation_failed", "Unrecognized writer URL");
}
