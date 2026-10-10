// The "nearest" scroll arithmetic for the History panel (A11Y-AUDIT, decision 1, E1). DOM-free, so
// the tests import it.

/**
 * How far to scroll a box showing `top`..`bottom` so a row at `rowTop`..`rowBottom` comes into
 * view, as `scrollIntoView({ block: "nearest" })` does (CSSOM View): nothing when the row is
 * whole in view or covers the box; otherwise the edge that overflows is aligned when the row
 * fits, and the opposite edge when it is taller than the box (so the least distance is scrolled).
 */
export function nearestDelta(
  top: number,
  bottom: number,
  rowTop: number,
  rowBottom: number,
): number {
  const above = rowTop < top;
  const below = rowBottom > bottom;
  if (above === below) return 0;
  const fits = rowBottom - rowTop <= bottom - top;
  return above === fits ? rowTop - top : rowBottom - bottom;
}
