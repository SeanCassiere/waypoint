// A11Y-AUDIT (decision 1, E1): the History tab brings the current revision into view by setting
// the panel body's scrollTop with the "nearest" arithmetic of scrollIntoView({ block: "nearest" }),
// including for a revision row taller than the panel (a long message wraps freely).
import { describe, expect, it } from "vitest";

import { nearestDelta } from "../src/client/scroll-nearest.ts";

// The panel body shows 100..200.
const TOP = 100;
const BOTTOM = 200;

describe("nearestDelta", () => {
  it("leaves a row that is whole in view, or that covers the body, alone", () => {
    expect(nearestDelta(TOP, BOTTOM, 120, 180)).toBe(0);
    expect(nearestDelta(TOP, BOTTOM, 100, 200)).toBe(0);
    expect(nearestDelta(TOP, BOTTOM, 50, 250)).toBe(0);
  });
  it("aligns the overflowing edge of a row that fits", () => {
    expect(nearestDelta(TOP, BOTTOM, 40, 80)).toBe(-60);
    expect(nearestDelta(TOP, BOTTOM, 80, 120)).toBe(-20);
    expect(nearestDelta(TOP, BOTTOM, 180, 220)).toBe(20);
    expect(nearestDelta(TOP, BOTTOM, 300, 340)).toBe(140);
    expect(nearestDelta(TOP, BOTTOM, 20, 120)).toBe(-80);
  });
  it("aligns the opposite edge of a row taller than the body, scrolling the least", () => {
    expect(nearestDelta(TOP, BOTTOM, -150, 150)).toBe(-50);
    expect(nearestDelta(TOP, BOTTOM, -400, -100)).toBe(-300);
    expect(nearestDelta(TOP, BOTTOM, 150, 450)).toBe(50);
    expect(nearestDelta(TOP, BOTTOM, 300, 600)).toBe(200);
  });
  it("leaves a tall row alone when an edge is already aligned", () => {
    expect(nearestDelta(TOP, BOTTOM, -100, 200)).toBe(0);
    expect(nearestDelta(TOP, BOTTOM, 100, 400)).toBe(0);
  });
});
