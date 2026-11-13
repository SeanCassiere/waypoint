import { describe, expect, it } from "vitest";

import { formatTime, historyDay } from "../src/viewer/timefmt.ts";

// Logbook: History's day rows and time column, and the revision strip's "when" (UTC here, as the
// server draws them; the browser redraws them in its own zone).

const now = Date.UTC(2026, 10, 13, 22, 30);
const at = (day: number, hours: number, minutes: number, year = 2026, month = 10): number =>
  Date.UTC(year, month, day, hours, minutes);

describe("historyDay", () => {
  it("names today, yesterday, then the weekday, with the date", () => {
    expect(historyDay(at(13, 22, 2), now, true)).toMatchObject({
      word: "Today",
      date: "13 November",
    });
    expect(historyDay(at(12, 2, 5), now, true)).toMatchObject({
      word: "Yesterday",
      date: "12 November",
    });
    expect(historyDay(at(11, 19, 5), now, true)).toMatchObject({
      word: "Wednesday",
      date: "11 November",
    });
    expect(historyDay(at(3, 9, 0, 2025), now, true).date).toBe("3 November 2025");
  });

  it("keys rows of one calendar day alike", () => {
    expect(historyDay(at(13, 0, 1), now, true).key).toBe(historyDay(at(13, 23, 59), now, true).key);
    expect(historyDay(at(12, 23, 59), now, true).key).not.toBe(
      historyDay(at(13, 0, 1), now, true).key,
    );
  });
});

describe("the time and at formats", () => {
  it("gives the bare clock for History's time column", () => {
    expect(formatTime(at(11, 19, 5), "time", now, true)).toBe("19:05");
  });

  it("says when for the revision strip", () => {
    expect(formatTime(at(13, 22, 2), "at", now, true)).toBe("at 22:02");
    expect(formatTime(at(12, 2, 5), "at", now, true)).toBe("yesterday at 02:05");
    expect(formatTime(at(11, 19, 5), "at", now, true)).toBe("on Wednesday at 19:05");
    expect(formatTime(at(1, 8, 30), "at", now, true)).toBe("on 1 November at 08:30");
  });
});
