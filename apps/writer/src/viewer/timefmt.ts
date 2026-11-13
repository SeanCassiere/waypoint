// Date formatting shared by the server (UTC fallback text) and the browser (local time).
// No DOM and no Node APIs: the client bundle imports this module too.

/** `time` is the clock alone, for rows under a day heading that already names the day. */
export type TimeFormat = "clock" | "time" | "ago" | "full" | "day" | "date" | "until";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
    case "time":
      return clock(p);
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
  if (days < 7) return WEEKDAYS[p.weekday] ?? "";
  return shortDate(p, parts(now, utc));
}

/**
 * The date beside a Recent day label, where the label doesn't already say it: "Friday, 13
 * November" beside Today and Yesterday, "11 November" beside a weekday, nothing beside a date.
 */
export function dayDate(time: number, now: number, utc: boolean): string | null {
  const days = dayDiff(time, now, utc);
  if (days >= 7) return null;
  const p = parts(time, utc);
  const date = `${p.day} ${MONTHS_LONG[p.month] ?? ""}`;
  return days <= 1 ? `${WEEKDAYS[p.weekday] ?? ""}, ${date}` : date;
}

/** Day-group label for Trash: "In Trash, moved today", "… moved Monday", "… moved 3 Oct". */
export function trashDayLabel(time: number, now: number, utc: boolean): string {
  const label = dayLabel(time, now, utc);
  return `In Trash, moved ${label === "Today" || label === "Yesterday" ? label.toLowerCase() : label}`;
}

/** A day group's heading row (A11Y-04): its label, the date where the label doesn't say it
 *  (Recent and search only), and how many collections it holds. The server renders it in UTC,
 *  client/day-groups.ts again in the browser's zone. */
export interface DayHeading {
  label: string;
  date: string | null;
  count: string;
}
export function dayHeading(
  kind: string,
  time: number,
  now: number,
  utc: boolean,
  count: number,
): DayHeading {
  return {
    label: kind === "trash" ? trashDayLabel(time, now, utc) : dayLabel(time, now, utc),
    date: kind === "trash" ? null : dayDate(time, now, utc),
    count: `${count} ${count === 1 ? "collection" : "collections"}`,
  };
}

/**
 * The last-visit mark on Recent, worded the same in the lede and the "New since" divider:
 * "21:15" today, "yesterday 23:30", "Wed 23:30" this week, otherwise "3 Oct".
 */
export function sinceText(time: number, now: number, utc: boolean): string {
  const days = dayDiff(time, now, utc);
  const p = parts(time, utc);
  if (days <= 0) return clock(p);
  if (days === 1) return `yesterday ${clock(p)}`;
  if (days < 7) return `${DAYS[p.weekday] ?? ""} ${clock(p)}`;
  return shortDate(p, parts(now, utc));
}
