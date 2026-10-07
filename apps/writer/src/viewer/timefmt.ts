// Date formatting shared by the server (UTC fallback text) and the browser (local time).
// No DOM and no Node APIs: the client bundle imports this module too.

export type TimeFormat = "clock" | "ago" | "full" | "day" | "date" | "until";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (value: number) => String(value).padStart(2, "0");

interface Parts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hours: number;
  minutes: number;
}
function parts(time: number, utc: boolean): Parts {
  const date = new Date(time);
  return utc
    ? {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
      }
    : {
        year: date.getFullYear(),
        month: date.getMonth(),
        day: date.getDate(),
        weekday: date.getDay(),
        hours: date.getHours(),
        minutes: date.getMinutes(),
      };
}
/** Days between the calendar dates of `time` and `now` (0 = same day, 1 = yesterday). */
export function dayDiff(time: number, now: number, utc: boolean): number {
  const a = parts(time, utc);
  const b = parts(now, utc);
  return Math.round((Date.UTC(b.year, b.month, b.day) - Date.UTC(a.year, a.month, a.day)) / 864e5);
}
const clock = (p: Parts) => `${pad(p.hours)}:${pad(p.minutes)}`;
const shortDate = (p: Parts, now: Parts) =>
  `${p.day} ${MONTHS[p.month] ?? ""}${p.year === now.year ? "" : ` ${p.year}`}`;
export const fullDate = (time: number, utc: boolean): string => {
  const p = parts(time, utc);
  return `${p.day} ${MONTHS[p.month] ?? ""} ${p.year}, ${clock(p)}`;
};

function agoText(time: number, now: number, utc: boolean): string {
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 6 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  const days = dayDiff(time, now, utc);
  const p = parts(time, utc);
  if (days === 0) return `today ${clock(p)}`;
  if (days === 1) return `yesterday ${clock(p)}`;
  if (days < 7) return `${days} days ago`;
  return shortDate(p, parts(now, utc));
}
function untilText(time: number, now: number): string {
  const seconds = Math.round((time - now) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 36 * 3600) {
    const hours = Math.round(seconds / 3600);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(seconds / 86400);
  return `in ${days} days`;
}

export function formatTime(time: number, format: TimeFormat, now: number, utc: boolean): string {
  const p = parts(time, utc);
  const n = parts(now, utc);
  switch (format) {
    case "clock": {
      const days = dayDiff(time, now, utc);
      if (days === 0) return clock(p);
      if (days > 0 && days < 7) return `${DAYS[p.weekday] ?? ""} ${clock(p)}`;
      return shortDate(p, n);
    }
    case "ago":
      return agoText(time, now, utc);
    case "day": {
      const days = dayDiff(time, now, utc);
      if (days === 0) return `today ${clock(p)}`;
      if (days === 1) return `yesterday ${clock(p)}`;
      return shortDate(p, n);
    }
    case "date":
      return `${p.day} ${MONTHS[p.month] ?? ""} ${p.year}`;
    case "until":
      return untilText(time, now);
    case "full":
      return fullDate(time, utc);
    default:
      return fullDate(time, utc);
  }
}

/** Day-group label for Recent: Today, Yesterday, a weekday, or a date. */
export function dayLabel(time: number, now: number, utc: boolean): string {
  const days = dayDiff(time, now, utc);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const p = parts(time, utc);
  if (days < 7)
    return (
      ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.weekday] ??
      ""
    );
  return shortDate(p, parts(now, utc));
}

export function clockOf(time: number, utc: boolean): string {
  return clock(parts(time, utc));
}
