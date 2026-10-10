/**
 * The Waypoint release version, the same as the root package.json `version` (a core test checks
 * they match). release-please updates both; the annotation below marks the line it rewrites.
 * A constant, not a JSON import, so the writer, the reader Worker, the MCP server and source runs
 * all get it without bundler-specific steps.
 */
export const WAYPOINT_VERSION: string = "0.3.0"; // x-release-please-version

/** What a build reports about itself on health and status endpoints. */
export interface BuildInfo {
  version: string;
  /** The git commit the build came from (lowercase hex), or null when it wasn't recorded. */
  sha: string | null;
}

/**
 * The build's git commit from `WAYPOINT_BUILD_SHA` (a Docker build arg in the writer image, a
 * Worker variable in the reader). Anything but 7 to 40 hex digits reads as "not recorded", so a
 * stray value is never echoed on a public endpoint.
 */
export function buildInfo(rawSha: string | undefined | null): BuildInfo {
  const sha = rawSha?.trim().toLowerCase() ?? "";
  return { version: WAYPOINT_VERSION, sha: /^[0-9a-f]{7,40}$/.test(sha) ? sha : null };
}
