/**
 * The rendition frame reporter (spec §8) posts `{ type: "waypoint:location", href }` to its
 * parent on load and on hashchange. Shells must check `event.source` themselves; this only
 * validates the payload shape.
 */
export const FRAME_LOCATION_TYPE = "waypoint:location";

export function frameLocationHref(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  if (!("type" in data) || data.type !== FRAME_LOCATION_TYPE) return null;
  if (!("href" in data) || typeof data.href !== "string" || data.href.length > 8192) return null;
  return data.href;
}
