import { formatTime, fullDate, type TimeFormat } from "../viewer/timefmt.ts";

const formats: readonly TimeFormat[] = ["clock", "ago", "full", "day", "date", "until"];
const isFormat = (value: string): value is TimeFormat => formats.some((format) => format === value);
/** Rewrites server-rendered UTC times in the browser's time zone. */
export function localizeTimes(root: ParentNode = document): void {
  const now = Date.now();
  root.querySelectorAll<HTMLTimeElement>("time[datetime]").forEach((time) => {
    const at = Date.parse(time.dateTime);
    if (Number.isNaN(at)) return;
    const fmt = time.dataset.fmt ?? "full";
    if (!isFormat(fmt)) return;
    time.textContent = formatTime(at, fmt, now, false);
    time.title = fullDate(at, false);
  });
}
