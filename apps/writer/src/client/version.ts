declare global {
  interface Window {
    _WAYPOINT_VERSION?: string;
  }
}

/**
 * Exposes the release version to the browser console as `window._WAYPOINT_VERSION`, from the
 * layout's `<html data-waypoint-version>` (the public shell does the same in its own script).
 */
export function exposeVersion(): void {
  const version = document.documentElement.dataset.waypointVersion;
  if (version) window._WAYPOINT_VERSION = version;
}
